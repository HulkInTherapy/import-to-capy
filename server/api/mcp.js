// Import to Capy: a tiny remote MCP server (Streamable HTTP, stateless, no sign-in).
//
// Why it exists: Capy gives threads on the user's own computer a plugin's remote servers only, not its skills.
// The user's Conductor and T3 Code data lives on that computer, so this server hands the thread's agent the
// playbook (the same text as the skills, built from playbook/PLAYBOOK.md) and the agent runs the importer
// locally with npx. The server never sees user files, keeps no session, stores nothing and logs nothing.
//
// Deployed as a Vercel function (server/ is its own Vercel project); /mcp and / are rewritten here.
import { PLAYBOOK } from './_playbook.js';

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'import-to-capy', title: 'Import to Capy', version: PLAYBOOK.version };
const MAX_BODY = 256 * 1024;

const INSTRUCTIONS = 'When the user wants to import, move or bring over work from Conductor or T3 Code into Capy '
  + '("import from conductor", "import from t3 code", "bring my threads over"), call import_to_capy_start once and follow '
  + 'the playbook it returns. The importer runs on the user\'s computer through your shell; this server only gives you the steps.';

export const TOOLS = [
  {
    name: 'import_to_capy_start',
    title: 'Import from Conductor or T3 Code',
    description: 'Start here when the user wants to import, move, migrate, bring over or continue work from Conductor or T3 Code in Capy: '
      + '"import from conductor", "import from t3 code", "import my t3 threads", "move my conductor workspaces to capy", '
      + '"bring my threads over", "continue my conductor chat here", "switch from T3 Code". Always call this first for those '
      + 'requests. Returns the step-by-step playbook: run the importer on the user\'s computer with your shell (npx, nothing to '
      + 'install), ask only what the user didn\'t say plus one confirm card, then create each thread with your own thread.create '
      + 'tool: right project, original title, on the user\'s Mac on the same branch, conversation handed over. No key needed. '
      + 'Call it once, then follow it. Stores nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['conductor', 't3code'], description: 'The app to import from, if the user already said: conductor or t3code.' },
        wish: { type: 'string', maxLength: 500, description: 'The user\'s own words about what to import, e.g. "latest 3 threads from api". Optional.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Import from Conductor or T3 Code', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'import_to_capy_help',
    title: 'About Import to Capy',
    description: 'What Import to Capy does and what it cannot bring over. Use when the user asks how importing from Conductor or '
      + 'T3 Code into Capy works or what its limits are. To actually import, call import_to_capy_start.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'About Import to Capy', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const SOURCE_ALIASES = { conductor: 'conductor', t3code: 't3code', t3: 't3code', 't3 code': 't3code', 't3-code': 't3code' };
export const normalizeSource = (v) => (typeof v === 'string' ? SOURCE_ALIASES[v.trim().toLowerCase()] : undefined);
const cleanWish = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) : '');

// The playbook for one call. Pure: the same arguments always give the same text.
export function startText({ source, wish } = {}) {
  const src = normalizeSource(source);
  const w = cleanWish(wish);
  const head = ['# Import to Capy', 'You got this playbook from the Import to Capy plugin. Everything below runs on the user\'s computer through your shell; nothing goes through this server.'];
  if (src) head.push(PLAYBOOK.sourceNote[src]);
  if (w) head.push(`The user asked: ${JSON.stringify(w)}. Don't ask what that already answers.`);
  const specifics = (src ? [src] : Object.keys(PLAYBOOK.apps)).map((k) => `## ${PLAYBOOK.apps[k]} specifics\n\n${PLAYBOOK[k]}`);
  return [...head, PLAYBOOK.flow, ...specifics].join('\n\n') + '\n';
}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const text = (t) => ({ content: [{ type: 'text', text: t }], isError: false });

// One JSON-RPC message in, one response out (null for notifications and responses).
export function handleMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') return fail(null, -32600, 'Invalid Request');
  const isRequest = 'id' in msg && msg.id !== null && typeof msg.method === 'string';
  if (!isRequest) return typeof msg.method === 'string' || 'result' in msg || 'error' in msg ? null : fail(msg.id ?? null, -32600, 'Invalid Request');
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      if (params.name === 'import_to_capy_start') return ok(id, text(startText(args)));
      if (params.name === 'import_to_capy_help') return ok(id, text(PLAYBOOK.help + '\n'));
      return fail(id, -32602, `Unknown tool: ${String(params.name).slice(0, 100)}`);
    }
    default: return fail(id, -32601, `Method not found: ${String(method).slice(0, 100)}`);
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  res.setHeader('Cache-Control', 'no-store');
  if (body === undefined) return res.end();
  res.setHeader('Content-Type', `${type}; charset=utf-8`);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  // On Vercel req.body is a lazy parser (it throws on bad JSON); in plain Node it is undefined and we read the stream.
  let b;
  try { b = req.body; } catch { return { bad: true }; }
  if (b !== undefined && b !== null && !(typeof b === 'string' && b === '')) {
    if (typeof b === 'object' && !Buffer.isBuffer(b)) return { value: b };
    try { return { value: JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b) }; } catch { return { bad: true }; }
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return { tooBig: true }; chunks.push(c); }
  try { return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }; } catch { return { bad: true }; }
}

const ABOUT = 'Import to Capy: a remote MCP server (Streamable HTTP, no sign-in) at /mcp.\n'
  + 'It hands an agent the steps to import Conductor and T3 Code threads into Capy; the importer runs on the user\'s own computer.\n'
  + 'Stateless; stores and logs nothing about you. Source: https://github.com/HulkInTherapy/import-to-capy\n';

export default async function handler(req, res) {
  const method = req.method || 'GET';
  if (method === 'OPTIONS') return send(res, 204);
  if (method === 'GET') {
    // No server-to-client stream (stateless), so an SSE GET gets 405 as the spec asks; a browser gets a note.
    if (String(req.headers.accept || '').includes('text/event-stream')) { res.setHeader('Allow', 'POST, OPTIONS'); return send(res, 405, ABOUT, 'text/plain'); }
    return send(res, 200, ABOUT, 'text/plain');
  }
  if (method === 'DELETE') { res.setHeader('Allow', 'POST, OPTIONS'); return send(res, 405, fail(null, -32000, 'No sessions: this server is stateless.')); }
  if (method !== 'POST') { res.setHeader('Allow', 'GET, POST, OPTIONS'); return send(res, 405, fail(null, -32000, 'Method not allowed')); }
  const pv = req.headers['mcp-protocol-version'];
  if (pv && !PROTOCOL_VERSIONS.includes(pv)) return send(res, 400, fail(null, -32600, `Unsupported MCP-Protocol-Version: ${String(pv).slice(0, 40)}`));
  const body = await readBody(req);
  if (body.tooBig) return send(res, 413, fail(null, -32600, 'Request too large'));
  if (body.bad) return send(res, 400, fail(null, -32700, 'Parse error'));
  const msgs = Array.isArray(body.value) ? body.value : [body.value];
  if (!msgs.length) return send(res, 400, fail(null, -32600, 'Invalid Request'));
  const replies = msgs.map(handleMessage).filter(Boolean);
  if (!replies.length) return send(res, 202);
  return send(res, 200, Array.isArray(body.value) ? replies : replies[0]);
}
