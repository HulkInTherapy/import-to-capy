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
