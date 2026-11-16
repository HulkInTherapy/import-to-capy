import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, menu, preview, sortCatalog } from '../lib/select.mjs';
import { redact } from '../lib/redact.mjs';
import { hasSqlite } from './helpers.mjs';
import { fakeHome, NOW, SECRETS } from './fakes.mjs';
import { loadCatalog } from '../lib/import-to-capy.mjs';

// A plain catalog (no database) for the phrase tests.
const d = (days) => new Date(NOW - days * 864e5).toISOString();
const T = (id, days, x = {}) => ({ id, title: id, updatedAt: d(days), createdAt: d(days + 1), branch: '', prs: [], openWork: false, unfinished: true, archived: false, messageCount: 5, ...x });
const CAT = () => sortCatalog({ source: 'Test', projects: [
  { id: 'api', name: 'api', path: '/src/api', threads: [T('a1', 0.5, { openWork: true, branch: 'me/a1' }), T('a2', 2, { unfinished: false }), T('a3', 4), T('a4', 9), T('a5', 40, { archived: true, unfinished: false })] },
  { id: 'web', name: 'web-app', path: '/src/web-app', threads: [T('w1', 1, { openWork: true, prs: [{ number: 3, state: 'open' }] }), T('w2', 8, { unfinished: false })] },
  { id: 'docs', name: 'docs', path: '/src/docs', threads: [T('d1', 20)] },
] });
const pick = (answer) => parseSelection(answer, CAT(), { now: NOW });

test('menu: projects by last use with thread counts and dates', () => {
  const m = menu(CAT());
  assert.match(m, /^1\. api: 4 threads, last used 2026-11-1\d/m);
  assert.match(m, /^2\. web-app: 2 threads/m);
  assert.match(m, /^3\. docs: 1 thread,/m);
});

test('default with zero thinking: most recent project, its latest 3 threads', () => {
  for (const a of ['', 'go', 'ok', 'yes', 'you pick', 'sounds good']) {
    const s = pick(a);
    assert.deepEqual(s.projectIds, ['api'], a);
    assert.deepEqual(s.threadIds, ['a1', 'a2', 'a3'], a);
    assert.ok(s.defaulted);
  }
});

test('"everything"', () => {
  const s = pick('everything');
  assert.deepEqual(s.projectIds.sort(), ['api', 'docs', 'web']);
  assert.equal(s.threadIds.length, 7, 'archived left out');
  assert.equal(pick('everything including archived').threadIds.length, 8);
});

test('"just project X" and several projects by name', () => {
  assert.deepEqual(pick('just project docs').threadIds, ['d1']);
  assert.deepEqual(pick('only web-app').projectIds, ['web']);
  assert.deepEqual(pick('api and docs').projectIds.sort(), ['api', 'docs']);
});

test('picks by number, lists and ranges', () => {
  assert.deepEqual(pick('2').projectIds, ['web']);
  assert.deepEqual(pick('1 and 3').projectIds, ['api', 'docs']);
  assert.deepEqual(pick('1, 3').projectIds, ['api', 'docs']);
  assert.deepEqual(pick('2-3').projectIds, ['web', 'docs']);
  assert.deepEqual(pick('#3').projectIds, ['docs']);
});

test('"the latest 3 threads" across projects, and "latest 2 threads from api"', () => {
  assert.deepEqual(pick('the latest 3 threads').threadIds, ['a1', 'w1', 'a2']);
  assert.deepEqual(pick('latest 2 threads from api').threadIds, ['a1', 'a2']);
  assert.deepEqual(pick('three most recent').threadIds, ['a1', 'w1', 'a2']);
  assert.deepEqual(pick('just the latest thread').threadIds, ['a1']);
});

test('"threads from the last 7 days" and other windows', () => {
  assert.deepEqual(pick('threads from the last 7 days').threadIds, ['a1', 'w1', 'a2', 'a3']);
  assert.deepEqual(pick('past week').threadIds, ['a1', 'w1', 'a2', 'a3']);
  assert.deepEqual(pick('today').threadIds, ['a1']);
  assert.equal(pick('last month').threadIds.length, 7);
  assert.deepEqual(pick('web-app, last 7 days').threadIds, ['w1']);
});

test('"last used"', () => {
  const s = pick('last used');
  assert.deepEqual(s.projectIds, ['api']);
  assert.deepEqual(s.threadIds, ['a1', 'a2', 'a3', 'a4']);
});

test('"threads with open branches/PRs" and "only unfinished"', () => {
  assert.deepEqual(pick('threads with open branches/PRs').threadIds, ['a1', 'w1']);
  assert.deepEqual(pick('open PRs').threadIds, ['a1', 'w1']);
  assert.deepEqual(pick('only unfinished').threadIds, ['a1', 'w1', 'a3', 'a4', 'd1']);
  assert.deepEqual(pick('unfinished in api, last 7 days').threadIds, ['a1', 'a3']);
});

test('unclear answers ask one question', () => {
  const s = pick('hmm maybe the purple ones');
  assert.ok(s.needsClarification);
  assert.match(s.question, /^Which projects\?/);
});

test('preview is one screen', () => {
  const p = preview(CAT(), pick('go'));
  assert.match(p, /Will create in Capy \(your most recent project "api", its latest 3 threads\)/);
  assert.match(p, /1 project\(s\), 3 thread\(s\)\./);
  assert.ok(p.split('\n').length < 25);
});

test('redaction: every pattern, with counts', () => {
  const text = [
    `openai ${SECRETS.openai}`, `gh ${SECRETS.github}`, `aws ${SECRETS.aws}`, `tavily ${SECRETS.tavily}`, SECRETS.envline,
    'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'slack xoxb-1234567890-abcdefghij', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123',
    'postgres://admin:s3cretpass@db.example.com/app', '{"api_key": "abcdef123456"}', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----', 'stripe sk_live_ABCDEFGHIJKLMNOPQRST',
  ].join('\n');
  const r = redact(text);
  for (const v of Object.values(SECRETS)) assert.ok(!r.text.includes(v.split('=').pop()), v);
  for (const leak of ['sk-ant-api03', 'xoxb-1234567890', 'abcdefghijklmnopqrstuvwxyz123', 's3cretpass', 'abcdef123456', 'AAAAB3NzaC1yc2E', 'sk_live_ABCD', 'eyJzdWIi']) assert.ok(!r.text.includes(leak), leak);
  assert.ok(r.text.includes('postgres://admin:[REDACTED]@db.example.com'));
  assert.ok(r.count >= 13, `count ${r.count}`);
  assert.equal(redact('Edit src/app.ts and run pnpm test; the token budget is fine.').count, 0, 'ordinary text untouched');
});

test('real-shaped catalogs from both synthetic databases', { skip: !hasSqlite && 'sqlite3 not installed' }, () => {
  const home = fakeHome();
  const t3 = loadCatalog('t3code', { home });
  assert.deepEqual(t3.projects.map((p) => p.name), ['api', 'web', 'docs']);
  const api = t3.projects[0];
  assert.deepEqual(api.threads.map((t) => t.id), ['t1', 't2', 't3', 't4'], 'deleted thread hidden, newest first');
  const t1 = api.threads[0];
  assert.equal(t1.messageCount, 4); assert.equal(t1.prs[0].state, 'open'); assert.ok(t1.openWork); assert.ok(t1.unfinished);
  assert.equal(t1.native.kind, 'Claude Code', 'native Claude Code session found under ~/.claude/projects');
  assert.equal(api.threads.find((t) => t.id === 't2').unfinished, false, 'settled = finished');
  assert.equal(t3.projects[1].threads.find((t) => t.id === 't6').openWork, false, 'merged PR is not open work');
  assert.deepEqual(parseSelection('go', t3, { now: NOW }).threadIds, ['t1', 't2', 't3']);
  assert.deepEqual(parseSelection('with open PRs', t3, { now: NOW }).threadIds, ['t1', 't2', 't3'], 'unmerged branches count, even when the thread is settled');
  const c = loadCatalog('conductor', { home });
  assert.deepEqual(c.projects.map((p) => p.name), ['app', 'site']);
  assert.equal(c.projects[0].threads.length, 3);
  assert.equal(c.projects[0].threads.find((t) => t.id === 'w1').messageCount, 2);
  assert.deepEqual(parseSelection('latest 3 threads', c, { now: NOW }).threadIds, ['w1', 'w3', 'w2']);
  assert.deepEqual(parseSelection('only unfinished', c, { now: NOW }).threadIds.sort(), ['w1', 'w2', 'w3']);
});
