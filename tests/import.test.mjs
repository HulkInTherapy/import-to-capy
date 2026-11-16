import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasSqlite, tmpdir } from './helpers.mjs';
import { fakeHome, SECRETS } from './fakes.mjs';
import { loadCatalog, exportThreads, main } from '../lib/import-to-capy.mjs';
import { t3Setup } from '../lib/sources.mjs';
import { buildHandoff } from '../lib/handoff.mjs';
import { startPicker } from '../lib/picker.mjs';
import { Server, answerFromForm, elicitationSchema } from '../lib/mcp-server.mjs';

const skip = !hasSqlite && 'sqlite3 not installed';
const quiet = () => { const out = []; return { log: (s) => out.push(s), err: (s) => out.push(s), out }; };

test('export needs consent', { skip }, () => {
  const home = fakeHome();
  const cat = loadCatalog('t3code', { home });
  assert.throws(() => exportThreads('t3code', cat, ['t1'], { home, out: tmpdir('c2c-out-') }), /consent/);
});

test('T3 Code export: condensed handoff, transcript, redaction count, continue link, git-ignored folder', { skip }, () => {
  const home = fakeHome();
  const cat = loadCatalog('t3code', { home });
  const out = path.join(tmpdir('c2c-out-'), 'imports');
  const res = exportThreads('t3code', cat, ['t1'], { consent: true, transcripts: true, out, home });
  assert.equal(res.threads.length, 1);
  const t = res.threads[0];
  const md = fs.readFileSync(t.handoffPath, 'utf8');
  for (const h of ['## Goal', '## Key decisions', '## Files touched', '## Open TODOs', '## Last state', '## Last 3 exchanges']) assert.ok(md.includes(h), h);
  assert.match(md, /Branch:\*\* `me\/login`/);
  assert.match(md, /pull\/12 \(open\)/);
  assert.match(md, /src\/auth\/session\.ts/);
  assert.match(md, /- \[ \] add a test in tests\/auth\.test\.ts/);
  assert.match(md, /I decided to fix it in src\/auth\/session\.ts instead of the middleware/);
  assert.match(md, /Native session:\*\* Claude Code session/);
  assert.ok(!/^## Plan/m.test(md), 'headings inside chats are quoted, not structure');
  const tr = fs.readFileSync(t.transcriptPath, 'utf8');
  for (const v of Object.values(SECRETS)) { const secret = v.split('=').pop(); assert.ok(!md.includes(secret) && !tr.includes(secret), `leaked ${secret}`); }
  assert.ok(res.redacted >= 5, `redacted ${res.redacted}`);
  assert.match(md, /Secrets redacted: \d+/);
  assert.ok(t.capyLink.startsWith('https://capy.ai/new?prompt='));
  const prompt = decodeURIComponent(t.capyLink.split('prompt=')[1]);
  assert.match(prompt, /wait for my go-ahead/);
  assert.ok(prompt.length < 1500);
  assert.equal(fs.readFileSync(path.join(out, '.gitignore'), 'utf8'), '*\n');
});

test('Conductor export reads Claude SDK JSON messages and redacts', { skip }, () => {
  const home = fakeHome({ t3: false });
  const cat = loadCatalog('conductor', { home });
  const res = exportThreads('conductor', cat, ['w1'], { consent: true, out: tmpdir('c2c-out-'), home });
  const md = fs.readFileSync(res.threads[0].handoffPath, 'utf8');
  assert.match(md, /Going with a queue instead of inline handling/);
  assert.match(md, /src\/billing\/queue\.ts/, 'tool_use file paths found');
  assert.ok(!md.includes(SECRETS.github));
  assert.equal(res.threads[0].messages, 2);
});

test('CLI: scan menu, select preview, setup', { skip }, async () => {
  const home = fakeHome();
  let io = quiet();
  await main(['scan', '--source', 't3code', '--home', home], io);
  assert.match(io.out[0], /1\. api: 3 threads/);
  io = quiet();
  await main(['select', '--source', 't3code', '--home', home, 'just', 'web'], io);
  assert.match(io.out[0], /Project "web"/);
  io = quiet();
  await main(['setup', '--source', 't3code', '--home', home, '--project', 'api'], io);
  const s = JSON.parse(io.out[0]);
  assert.equal(s.setup.scripts.initialize, 'pnpm install');
  assert.equal(s.setup.scripts.refresh, 'pnpm install');
  assert.deepEqual(s.setup.commands, [{ name: 'dev', command: 'pnpm dev --port 4000', port: 4000 }]);
});

test('t3Setup with no scripts says so', () => {
  assert.equal(t3Setup([]).empty, true);
});

test('handoff without messages still renders', () => {
  const h = buildHandoff({ title: 'Empty', source: 'T3 Code' }, []);
  assert.match(h.markdown, /No user message found/);
});

// ---- Layer 2: picker page ----
test('picker: page needs the token, bad token rejected, one submit then closed', { skip }, async () => {
  const cat = loadCatalog('t3code', { home: fakeHome() });
  const pk = await startPicker(cat, { open: false, timeoutMs: 5000 });
  const base = `http://127.0.0.1:${pk.port}`;
  assert.equal((await fetch(`${base}/`)).status, 403);
  const page = await fetch(pk.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Import into Capy/);
  assert.ok(!html.includes(SECRETS.openai), 'page holds metadata only, never message text');
  const bad = await fetch(`${base}/submit?t=wrong`, { method: 'POST', body: JSON.stringify({ threadIds: ['t1'] }) });
  assert.equal(bad.status, 403);
  const good = await fetch(`${base}/submit?t=${pk.token}`, { method: 'POST', body: JSON.stringify({ threadIds: ['t1', 'nope'], projectIds: ['p-api'], includeChats: true, chip: 'Latest 3' }) });
  assert.equal(good.status, 204);
  const sel = await pk.result;
  assert.deepEqual(sel.threadIds, ['t1'], 'unknown ids dropped');
  assert.equal(sel.method, 'picker');
  await assert.rejects(fetch(`${base}/submit?t=${pk.token}`, { method: 'POST', body: '{}' }), 'server closed after one submit');
});

test('picker: timeout resolves null', { skip }, async () => {
  const pk = await startPicker(loadCatalog('t3code', { home: fakeHome() }), { open: false, timeoutMs: 50 });
  assert.equal(await pk.result, null);
});

// ---- MCP server: elicitation -> picker -> menu ----
function client(server) { const sent = []; server.send = (m) => sent.push(m); return sent; }
const init = (s, caps) => s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: caps } });
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout'); };
const toolResult = (sent, id) => JSON.parse(sent.find((m) => m.id === id).result.content[0].text);

test('MCP layer 1: client with elicitation gets a form; its answer becomes a selection', { skip }, async () => {
  const s = new Server({ home: fakeHome(), pickerOpen: false });
  const sent = client(s);
  await init(s, { elicitation: {} });
  const call = s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 't3code' } } });
  const req = await waitFor(() => sent.find((m) => m.method === 'elicitation/create'));
  assert.deepEqual(req.params.requestedSchema.properties.scope.enum.slice(0, 2), ['Latest N threads', 'Threads from the last N days']);
  assert.equal(req.params.requestedSchema.properties.project.default, 'api');
  await s.handle({ jsonrpc: '2.0', id: req.id, result: { action: 'accept', content: { project: 'api', scope: 'Latest N threads', n: 2, includeChats: false } } });
  await call;
  const r = toolResult(sent, 2);
  assert.equal(r.method, 'elicitation');
  assert.deepEqual(r.threadIds, ['t1', 't2']);
  assert.equal(r.includeChats, false);
});

test('MCP layer 1 -> 2: elicitation error falls through to the picker page', { skip }, async () => {
  const s = new Server({ home: fakeHome(), pickerOpen: false });
  const sent = client(s);
  await init(s, { elicitation: {} });
  const call = s.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 't3code' } } });
  const req = await waitFor(() => sent.find((m) => m.method === 'elicitation/create'));
  await s.handle({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not supported' } });
  const pk = await waitFor(() => s.lastPicker);
  await fetch(`http://127.0.0.1:${pk.port}/submit?t=${pk.token}`, { method: 'POST', body: JSON.stringify({ threadIds: ['t6'], projectIds: ['p-web'] }) });
  await call;
  const r = toolResult(sent, 3);
  assert.equal(r.method, 'picker');
  assert.deepEqual(r.threadIds, ['t6']);
});

test('MCP layer 2: client without elicitation goes straight to the picker', { skip }, async () => {
  const s = new Server({ home: fakeHome(), pickerOpen: false });
  const sent = client(s);
  await init(s, {});
  const call = s.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 'conductor' } } });
  const pk = await waitFor(() => s.lastPicker);
  assert.ok(!sent.some((m) => m.method === 'elicitation/create'));
  await fetch(`http://127.0.0.1:${pk.port}/submit?t=${pk.token}`, { method: 'POST', body: JSON.stringify({ threadIds: ['w1'] }) });
  await call;
  assert.equal(toolResult(sent, 4).method, 'picker');
});

test('MCP layer 3: no page allowed (or it times out) returns the typed menu', { skip }, async () => {
  const s = new Server({ home: fakeHome(), pickerOpen: false });
  const sent = client(s);
  await init(s, {});
  await s.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 't3code', allowPage: false } } });
  const r = toolResult(sent, 5);
  assert.equal(r.method, 'menu');
  assert.match(r.menu, /1\. api/);
  await s.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 't3code', timeoutSec: 0.05 } } });
  assert.equal(toolResult(sent, 6).method, 'menu', 'picker timeout falls back to the menu');
});

test('MCP: tools/list and preview_import', { skip }, async () => {
  const s = new Server({ home: fakeHome(), pickerOpen: false });
  const sent = client(s);
  await init(s, {});
  await s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.deepEqual(sent.find((m) => m.id === 7).result.tools.map((t) => t.name), ['scan_import_sources', 'choose_import', 'preview_import', 'export_import']);
  await s.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'preview_import', arguments: { source: 't3code', answer: 'only unfinished' } } });
  assert.match(toolResult(sent, 8).preview, /Will create in Capy \(unfinished\)/);
});

test('form answers map to the same phrases', () => {
  assert.equal(answerFromForm({ project: 'All projects', scope: 'Everything' }), 'everything');
  assert.equal(answerFromForm({ project: 'web', scope: 'Threads from the last N days', n: 7 }), 'project web last 7 days');
  const schema = elicitationSchema({ projects: [{ name: 'a' }, { name: 'b' }] }, ['conductor', 't3code']);
  assert.deepEqual(schema.properties.source.enum, ['conductor', 't3code']);
  for (const p of Object.values(schema.properties)) assert.ok(['string', 'integer', 'boolean'].includes(p.type), 'only flat primitive fields, as elicitation requires');
});

test('MCP over real stdio: initialize, tools/list, menu fallback', { skip }, async () => {
  const { spawn } = await import('node:child_process');
  const home = fakeHome();
  const p = spawn(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'lib', 'mcp-server.mjs')], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, k))); buf = buf.slice(k + 1); } });
  const send = (m) => p.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'choose_import', arguments: { source: 't3code', allowPage: false } } });
  await waitFor(() => lines.find((l) => l.id === 3), 5000);
  p.kill();
  assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'import-to-capy');
  assert.equal(lines.find((l) => l.id === 2).result.tools.length, 4);
  assert.equal(JSON.parse(lines.find((l) => l.id === 3).result.content[0].text).method, 'menu');
});
