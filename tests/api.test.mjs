import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasSqlite, tmpdir, sh } from './helpers.mjs';
import { fakeHome, SECRETS } from './fakes.mjs';
import { main } from '../lib/import-to-capy.mjs';
import { apiKey, client, continueThread, deviceIdFor, resolveProject, ImportStop, KEYCHAIN_SERVICE, API_BASE, loadChoices } from '../lib/capy-api.mjs';
import { startLogin, saveKey } from '../lib/login.mjs';

const skip = !hasSqlite && 'sqlite3 not installed';
const quiet = () => { const out = []; return { log: (s) => out.push(s), err: (s) => out.push(s), out }; };
const APP = { id: 'project_app', name: 'App', code: 'APP', repos: [{ repoFullName: 'Acme/App', baseBranch: 'main', mode: 'primary' }] };
const HOME_P = { id: 'project_home', name: 'Home', code: 'HOME', repos: [] };

// A fake fetch that answers like api.capy.ai and records every call.
function fakeFetch(projects = [HOME_P, APP]) {
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const f = async (url, init = {}) => {
    const body = init.body && !Buffer.isBuffer(init.body) ? JSON.parse(init.body) : init.body;
    calls.push({ method: init.method, url, body, headers: init.headers });
    if (url.startsWith('https://upload.example/')) return res(200);
    const p = url.slice(API_BASE.length);
    if (init.method === 'GET' && p === '/projects') return res(200, { items: projects });
    if (init.method === 'POST' && p === '/threads') return res(200, { id: 'jam_NEW1' });
    if (init.method === 'POST' && p === '/files') return res(200, { targets: [{ fileId: 'file_1', url: 'https://upload.example/1', expiresAt: 'x' }] });
    if (init.method === 'POST' && /\/threads\/jam_NEW1\/message$/.test(p)) return res(200, { id: 'evt', deduped: false });
    return res(404, { _tag: 'NotFound' });
  };
  return { f, calls };
}
function worktree(home) {
  const d = path.join(home, 'conductor', 'workspaces', 'app', 'lisbon');
  fs.mkdirSync(d, { recursive: true });
  sh(d, 'git', 'init', '-q', '-b', 'main'); sh(d, 'git', 'remote', 'add', 'origin', 'https://github.com/Acme/App.git');
  return d;
}

test('API key: environment first, then the macOS Keychain item, never a file', () => {
  assert.equal(apiKey({ env: { CAPY_API_KEY: ' k1 ' } }), 'k1');
  const seen = [];
  assert.equal(apiKey({ env: {}, platform: 'darwin', run: (c, a) => { seen.push([c, ...a]); return 'k2\n'; } }), 'k2');
  assert.deepEqual(seen[0], ['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  assert.equal(apiKey({ env: {}, platform: 'darwin', run: () => { throw new Error('not found'); } }), null);
  assert.equal(apiKey({ env: {}, platform: 'linux' }), null);
});

test('device id comes from the desktop app\'s device-ids.json', () => {
  const home = tmpdir('c2c-dev-');
  assert.equal(deviceIdFor({ home }), null);
  const d = path.join(home, 'Library', 'Application Support', 'Capy'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'device-ids.json'), JSON.stringify({ version: 1, orgs: { org_a: 'device_A' } }));
  assert.equal(deviceIdFor({ home }), 'device_A');
  fs.writeFileSync(path.join(d, 'device-ids.json'), JSON.stringify({ version: 1, orgs: { org_a: 'device_A', org_b: 'device_B' } }));
  assert.equal(deviceIdFor({ home }), null, 'two organizations: no guessing');
  assert.equal(deviceIdFor({ home, orgId: 'org_b' }), 'device_B');
});

test('project matching: the repository\'s project, never Home by default, a click path when none exists', () => {
  assert.equal(resolveProject([HOME_P, APP], ['acme/app']).id, 'project_app');
  assert.throws(() => resolveProject([HOME_P], ['acme/app']), (e) => e instanceof ImportStop && e.code === 'no-project' && /Projects & setup/.test(e.message));
  assert.throws(() => resolveProject([HOME_P, APP], []), (e) => e.code === 'no-remote');
  assert.equal(resolveProject([HOME_P, APP], [], { project: 'home' }).id, 'project_home', 'Home only when asked');
});

test('continueThread: right project, on this computer at the worktree, handoff first, full redacted transcript attached', async () => {
  const home = tmpdir('c2c-api-');
  const wt = worktree(home);
  const { f, calls } = fakeFetch();
  const api = client('KEY', { fetchImpl: f });
  const transcript = { markdown: '# Transcript\n> all of it\n', redacted: 2 };
  const r = await continueThread(api, { thread: { id: 'w1', title: 'Billing page', branch: 'me/lisbon', worktree: wt }, source: 'Conductor',
    handoff: { markdown: '# Billing page\n## Goal\n> webhooks', redacted: 1 }, transcript, projects: await api.projects(), deviceId: 'device_A' });
  assert.equal(r.threadId, 'jam_NEW1');
  assert.equal(r.projectName, 'App');
  assert.equal(r.redacted, 3);
  const create = calls.find((c) => c.url.endsWith('/threads') && c.method === 'POST');
  assert.equal(create.body.projectId, 'project_app');
  assert.equal(create.body.requestId, 'import-to-capy:Conductor:w1', 'a retried import does not create a second thread');
  assert.deepEqual(create.body.device, { deviceId: 'device_A', workspace: { kind: 'linked', root: wt } });
  assert.match(create.body.message, /attached as a file/);
  assert.match(create.body.message, /## Goal/);
  assert.equal(create.headers.Authorization, 'Bearer KEY');
  const upload = calls.find((c) => c.url.endsWith('/files'));
  assert.equal(upload.body.files[0].sizeBytes, Buffer.byteLength(transcript.markdown));
  const put = calls.find((c) => c.url.startsWith('https://upload.example/'));
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers.Authorization, undefined, 'no API key on the presigned upload');
  const msg = calls.find((c) => /\/message$/.test(c.url));
  assert.deepEqual(msg.body.files, [{ fileId: 'file_1', name: 'Billing-page.transcript.md' }]);
  // worktree mode starts a fresh Capy worktree from the same branch instead
  const { f: f2, calls: c2 } = fakeFetch();
  await continueThread(client('KEY', { fetchImpl: f2 }), { thread: { id: 'w1', title: 'B', branch: 'me/lisbon', worktree: wt }, source: 'Conductor',
    handoff: { markdown: 'h', redacted: 0 }, transcript: { markdown: 't', redacted: 0 }, projects: [APP], deviceId: 'device_A', workspace: 'worktree' });
  assert.deepEqual(c2.find((c) => c.url.endsWith('/threads')).body.device.workspace, { kind: 'worktree', repos: ['acme/app'], base: { 'acme/app': 'me/lisbon' } });
});

test('continueThread stops before writing anything when no project uses the repository', async () => {
  const home = tmpdir('c2c-api2-');
  const wt = worktree(home);
  const { f, calls } = fakeFetch([HOME_P]);
  const api = client('KEY', { fetchImpl: f });
  await assert.rejects(continueThread(api, { thread: { id: 'w1', title: 'B', worktree: wt }, source: 'Conductor', handoff: { markdown: 'h', redacted: 0 },
    transcript: { markdown: 't', redacted: 0 }, projects: await api.projects() }), /No Capy project uses acme\/app/);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});

test('API errors surface with their status', async () => {
  const api = client('KEY', { fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"_tag":"capy/Unauthorized"}' }) });
  await assert.rejects(api.projects(), /401: capy\/Unauthorized/);
});

test('CLI continue: needs consent, explains the Keychain when there is no key, sends redacted transcripts', { skip }, async () => {
  const home = fakeHome({ t3: false });
  const wt = worktree(home);
  const db = path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');
  sh(path.dirname(db), 'sqlite3', db, `UPDATE workspaces SET workspace_path='${wt}' WHERE id='w1';`);
  const io = quiet();
  assert.equal(await main(['continue', '--source', 'conductor', '--home', home, '--threads', 'w1'], io, { api: client('K', { fetchImpl: fakeFetch().f }) }), 2);
  assert.match(io.out.join('\n'), /consent/);
  const { f, calls } = fakeFetch();
  const io2 = quiet();
  assert.equal(await main(['continue', '--source', 'conductor', '--home', home, '--threads', 'w1', '--consent', '--device', 'device_A'], io2, { api: client('K', { fetchImpl: f }) }), 0);
  assert.match(io2.out[0], /"Billing page" → App, on this computer in .*lisbon/);
  const sent = JSON.stringify(calls.map((c) => c.body).filter((b) => b && !Buffer.isBuffer(b)));
  const uploaded = calls.find((c) => c.method === 'PUT').body.toString('utf8');
  for (const s of [SECRETS.github]) { assert.ok(!sent.includes(s), 'no secret in the first message'); assert.ok(!uploaded.includes(s), 'no secret in the transcript'); }
  assert.match(uploaded, /stripe webhooks/);
  // no key anywhere: one Keychain instruction, nothing sent
  const io3 = quiet();
  assert.equal(await main(['continue', '--source', 'conductor', '--home', home, '--threads', 'w1', '--consent'], io3, { key: null }), 4);
  assert.match(io3.out[0], /import-to-capy login/);
  assert.match(io3.out[0], /Settings → API/);
});

test('login page: one-time token, localhost only, checks the key with Capy, then saves it once', async () => {
  const saved = [];
  const lg = await startLogin({ verify: async (k) => k === 'capy_GOODKEY_0123456789', save: (k) => saved.push(k), open: false });
  const base = lg.url.replace(/\/\w+$/, '');
  assert.match(lg.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}$/);
  const page = await fetch(lg.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /type="password"/);
  assert.equal((await fetch(`${base}/wrong`)).status, 404);
  const send = (key) => fetch(`${lg.url}/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
  assert.equal((await send('short')).status, 400);
  const bad = await send('capy_WRONGKEY_0123456789');
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /did not accept/);
  assert.equal((await fetch(`${lg.url}/key`, { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{"key":"capy_GOODKEY_0123456789"}' })).status, 403);
  assert.equal((await send('capy_GOODKEY_0123456789')).status, 200);
  assert.equal(await lg.result, true);
  assert.deepEqual(saved, ['capy_GOODKEY_0123456789']);
});

test('saveKey: the key reaches the Keychain on stdin, never in argv', () => {
  const calls = [];
  saveKey('capy_GOODKEY_0123456789', { run: (cmd, args, opts) => calls.push({ cmd, args, input: opts.input }) });
  assert.equal(calls[0].cmd, 'security');
  assert.deepEqual(calls[0].args, ['-i']);
  assert.match(calls[0].input, /^add-generic-password -U -s import-to-capy -a capy -w "capy_GOODKEY_0123456789"\n$/);
  assert.throws(() => saveKey('bad"key with spaces', { run: () => {} }));
});

test('CLI ready: which apps are here and this computer\'s name, no key involved', { skip }, async () => {
  const home = fakeHome({ t3: false });
  const io = quiet();
  await main(['ready', '--json', '--home', home], io, {});
  const r = JSON.parse(io.out[0]);
  assert.deepEqual(r.sources, ['conductor']);
  assert.ok(r.computerName);
  assert.equal(r.next, 'Ready.');
  assert.equal('key' in r, false);
});

test('CLI login (advanced API mode): opens the one-time page, skips it when already connected', async () => {
  const io3 = quiet();
  assert.equal(await main(['login'], io3, { key: null, startLoginInBackground: async () => 'http://127.0.0.1:1/abc' }), 0);
  assert.match(io3.out[0], /Settings → API.*http:\/\/127\.0\.0\.1:1\/abc.*Keychain/);
  const io4 = quiet();
  await main(['login'], io4, { key: 'K', api: client('K', { fetchImpl: fakeFetch().f }), startLoginInBackground: async () => { throw new Error('should not open'); } });
  assert.match(io4.out[0], /Already connected/);
});

test('CLI prepare: per-thread repo, branch, worktree and prompt, redacted files outside the repo; remember fills the project', { skip }, async () => {
  const home = fakeHome({ t3: false });
  const wt = worktree(home);
  const db = path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');
  sh(path.dirname(db), 'sqlite3', db, `UPDATE workspaces SET workspace_path='${wt}' WHERE id='w1';`);
  fs.writeFileSync(path.join(wt, 'draft.txt'), 'wip\n');
  const io = quiet();
  assert.equal(await main(['prepare', '--source', 'conductor', '--home', home, '--threads', 'w1', '--json'], io, {}), 2, 'needs consent');
  const io2 = quiet();
  assert.equal(await main(['prepare', '--source', 'conductor', '--home', home, '--threads', 'w1', '--consent', '--json'], io2, {}), 0);
  const r = JSON.parse(io2.out[0]);
  const t = r.threads[0];
  assert.equal(t.title, 'Billing page');
  assert.equal(t.repo, 'acme/app');
  assert.equal(t.worktree, wt);
  assert.equal(t.uncommitted, 1);
  assert.equal(t.rememberedProject, null);
  assert.ok(t.transcriptPath.startsWith(path.join(home, '.capy-import')), 'outside every repository');
  assert.equal(fs.statSync(t.transcriptPath).mode & 0o777, 0o600);
  assert.match(t.prompt, /Continuing "Billing page", imported from Conductor/);
  assert.ok(t.prompt.includes(t.handoffPath) && t.prompt.includes(t.transcriptPath) && t.prompt.includes(wt));
  assert.match(t.prompt, /wait for my go-ahead/);
  for (const f of [t.handoffPath, t.transcriptPath]) assert.ok(!fs.readFileSync(f, 'utf8').includes(SECRETS.github), 'redacted');
  assert.match(fs.readFileSync(t.transcriptPath, 'utf8'), /stripe webhooks/);
  assert.ok(r.redacted >= 1);
  const io3 = quiet();
  await main(['remember', '--home', home, '--key', 'acme/app', '--project', 'Sandbox'], io3, {});
  const io4 = quiet();
  await main(['prepare', '--source', 'conductor', '--home', home, '--threads', 'w1', '--consent', '--json'], io4, {});
  assert.equal(JSON.parse(io4.out[0]).threads[0].rememberedProject, 'Sandbox');
});

test('CLI plan and import: a repository without a project is asked once, then remembered', { skip }, async () => {
  const home = fakeHome({ t3: false });
  const wt = worktree(home);
  const db = path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');
  sh(path.dirname(db), 'sqlite3', db, `UPDATE workspaces SET workspace_path='${wt}' WHERE id='w1';`);
  const SANDBOX = { id: 'project_sandbox', name: 'Sandbox', code: 'SAND', repos: [{ repoFullName: 'Acme/Other', baseBranch: 'main', mode: 'primary' }] };
  const io = quiet();
  await main(['plan', '--source', 'conductor', '--home', home, '--threads', 'w1', '--json'], io, { api: client('K', { fetchImpl: fakeFetch([HOME_P, SANDBOX]).f }) });
  const plan = JSON.parse(io.out[0]);
  assert.equal(plan.threads[0].capyProject, null);
  assert.deepEqual(plan.missing, [{ repo: 'acme/app', threads: ['Billing page'] }]);
  assert.deepEqual(plan.capyProjects, ['Home', 'Sandbox']);
  const { f, calls } = fakeFetch([HOME_P, SANDBOX]);
  const io2 = quiet();
  assert.equal(await main(['import', '--source', 'conductor', '--home', home, '--threads', 'w1', '--consent', '--device', 'device_A', '--project', 'Sandbox', '--remember'], io2, { api: client('K', { fetchImpl: f }) }), 0);
  assert.equal(calls.find((c) => c.url.endsWith('/threads')).body.projectId, 'project_sandbox');
  assert.match(io2.out[0], /"Billing page" → Sandbox, on this computer/);
  assert.deepEqual(loadChoices(home), { 'acme/app': 'project_sandbox' });
  const io3 = quiet();
  await main(['plan', '--source', 'conductor', '--home', home, '--threads', 'w1', '--json'], io3, { api: client('K', { fetchImpl: fakeFetch([HOME_P, SANDBOX]).f }) });
  assert.equal(JSON.parse(io3.out[0]).threads[0].capyProject, 'Sandbox', 'remembered: no second question');
  assert.deepEqual(JSON.parse(io3.out[0]).missing, []);
});
