import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import handler, { handleMessage, startText, TOOLS, PROTOCOL_VERSIONS, SERVER_INFO } from '../server/api/mcp.js';
import { PLAYBOOK } from '../server/api/_playbook.js';
import { renderServerModule, ROOT } from '../playbook/render.mjs';

const rpc = (method, params, id = 1) => handleMessage({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

// The real handler behind a real socket, as an MCP client sees it.
async function serve(fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}
const post = (base, body, headers = {}) => fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('server: the playbook it serves is the one built from playbook/PLAYBOOK.md (no drift)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'server', 'api', '_playbook.js'), 'utf8'), renderServerModule());
  assert.equal(SERVER_INFO.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
});

test('server: initialize negotiates the protocol version and advertises tools only', () => {
  const r = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }).result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: { listChanged: false } });
  assert.equal(r.serverInfo.name, 'import-to-capy');
  assert.match(r.instructions, /import_to_capy_start/);
  assert.equal(rpc('initialize', { protocolVersion: '1999-01-01' }).result.protocolVersion, PROTOCOL_VERSIONS[0], 'unknown version: offer the latest');
});

test('server: tools/list names the two tools with descriptions that match what people say', () => {
  const { tools } = rpc('tools/list').result;
  assert.deepEqual(tools.map((t) => t.name), ['import_to_capy_start', 'import_to_capy_help']);
  const start = tools[0];
  for (const phrase of ['import from conductor', 'import from t3 code', 'move my conductor', 'bring my threads over']) assert.ok(start.description.includes(phrase), phrase);
  assert.deepEqual(start.inputSchema.properties.source.enum, ['conductor', 't3code']);
  assert.equal(start.inputSchema.required, undefined, 'every argument is optional');
  for (const t of tools) { assert.equal(t.inputSchema.type, 'object'); assert.equal(t.annotations.destructiveHint, false); }
});

test('server: tools/call import_to_capy_start returns the whole playbook, preset by source and wish', () => {
  const r = rpc('tools/call', { name: 'import_to_capy_start', arguments: {} }).result;
  assert.equal(r.isError, false);
  const t = r.content[0].text;
  assert.equal(t, startText({}));
  assert.ok(t.includes(PLAYBOOK.flow));
  assert.match(t, /npx -y -p github:HulkInTherapy\/import-to-capy import-to-capy/);
  assert.match(t, /\$run ready --json/);
  assert.match(t, /\$run prepare --source X --threads <ids from select> --consent --json/);
  assert.match(t, /tools\.thread\.create\(\{ threads:/);
  assert.match(t, /describe\("thread\.create"\)/);
  assert.match(t, /tools\.project\.list/);
  assert.doesNotMatch(t, /\$run login|\$run import |Capy API key|settings\/api/, 'the default flow needs no Capy key');
  assert.match(t, /clarify_questions/);
  assert.match(t, /capy:\/\/app\/settings\/import/);
  assert.match(t, /Never ask for computer use/);
  assert.match(t, /Conductor specifics/);
  assert.match(t, /T3 Code specifics/);
  assert.doesNotMatch(t, /\{\{|this skill's folder/, 'no unfilled placeholders, no skill-only paths');
  const c = rpc('tools/call', { name: 'import_to_capy_start', arguments: { source: 'conductor', wish: 'latest 3 from c2c-demo\u0007' } }).result.content[0].text;
  assert.match(c, /already answered: \*\*Conductor\*\*/);
  assert.match(c, /The user asked: "latest 3 from c2c-demo"/);
  assert.doesNotMatch(c, /T3 Code specifics/);
  assert.match(startText({ source: 'T3' }), /already answered: \*\*T3 Code\*\*/);
  assert.doesNotMatch(startText({ source: 'slack' }), /already answered/, 'an unknown source is ignored');
  const help = rpc('tools/call', { name: 'import_to_capy_help' }).result.content[0].text;
  assert.match(help, /Limits/);
  assert.match(help, /can't create projects/);
});

test('server: unknown tools, unknown methods and bad messages are JSON-RPC errors', () => {
  assert.equal(rpc('tools/call', { name: 'rm_rf' }).error.code, -32602);
  assert.equal(rpc('resources/list').error.code, -32601);
  assert.equal(handleMessage({ id: 1, method: 'ping' }).error.code, -32600, 'jsonrpc 2.0 only');
  assert.equal(handleMessage([1]).error.code, -32600);
  assert.deepEqual(rpc('ping').result, {});
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no reply');
});

test('server: stateless — no session, no initialize needed, same answer every time, nothing written', () => {
  const a = JSON.stringify(rpc('tools/call', { name: 'import_to_capy_start', arguments: { source: 't3code' } }, 7));
  rpc('tools/call', { name: 'import_to_capy_start', arguments: { wish: 'something else' } });
  assert.equal(JSON.stringify(rpc('tools/call', { name: 'import_to_capy_start', arguments: { source: 't3code' } }, 7)), a);
  const src = fs.readFileSync(path.join(ROOT, 'server', 'api', 'mcp.js'), 'utf8');
  assert.doesNotMatch(src, /console\.|writeFile|appendFile|localStorage|fetch\(/, 'no logging, no storage, no outbound calls');
  assert.doesNotMatch(src, /^let /m, 'no module-level mutable state');
});

test('server over HTTP: the full client handshake, CORS, notifications, GET and errors', async () => {
  await serve(async (base) => {
    const init = await post(base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-session-id'), null, 'stateless: no session id');
    assert.equal(init.headers.get('access-control-allow-origin'), '*');
    assert.match(init.headers.get('content-type'), /application\/json/);
    assert.equal((await init.json()).result.protocolVersion, '2025-11-25');
    const note = await post(base, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': '2025-11-25' });
    assert.equal(note.status, 202);
    assert.equal(await note.text(), '');
    const list = await (await post(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-protocol-version': '2025-11-25' })).json();
    assert.equal(list.result.tools.length, 2);
    const call = await (await post(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'import_to_capy_start', arguments: { source: 'conductor' } } })).json();
    assert.equal(call.id, 3);
    assert.match(call.result.content[0].text, /prepare --source X/);
    const batch = await (await post(base, [{ jsonrpc: '2.0', id: 4, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])).json();
    assert.deepEqual(batch, [{ jsonrpc: '2.0', id: 4, result: {} }]);
    assert.equal((await post(base, '{nope')).status, 400);
    assert.equal((await (await post(base, '{nope')).json()).error.code, -32700);
    assert.equal((await post(base, { jsonrpc: '2.0', id: 5, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' })).status, 400);
    const pre = await fetch(`${base}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://capy.ai', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /Mcp-Protocol-Version/);
    assert.equal((await fetch(`${base}/mcp`, { headers: { accept: 'text/event-stream' } })).status, 405, 'no SSE stream');
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Import to Capy/);
    assert.equal((await fetch(`${base}/mcp`, { method: 'DELETE' })).status, 405);
  });
});
