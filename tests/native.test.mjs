import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasSqlite, tmpdir, sh } from './helpers.mjs';
import { fakeHome, writeClaudeSession, writeCodexSession } from './fakes.mjs';
import { loadCatalog, main, questions, answerPhrase, SCOPES } from '../lib/import-to-capy.mjs';
import { readClaudeSession, readCodexSession, claudePromptTitle, repoSlug, gitRepos, encodeClaudeDir, locateSessions, nativePlan,
  formatNativeSteps, openImport, IMPORT_DEEP_LINK, projectFor } from '../lib/capy-native.mjs';
import { isT3ChildThread } from '../lib/sources.mjs';

const skip = !hasSqlite && 'sqlite3 not installed';
const quiet = () => { const out = []; return { log: (s) => out.push(s), err: (s) => out.push(s), out }; };

// A git repository with a GitHub remote, as a Conductor worktree would have.
function repo(dir, remote = 'git@github.com:Acme/App.git') {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git', 'init', '-q', '-b', 'main');
  sh(dir, 'git', 'remote', 'add', 'origin', remote);
  return dir;
}

test('Capy\'s title rules: custom title wins, tags and headings stripped, caveats and tool results skipped', () => {
  const home = tmpdir('c2c-cc-');
  const a = writeClaudeSession(home, { id: 'a1111111-0000', cwd: '/w/a', prompt: '<command-name>x</command-name>\n# Fix the login bug\nmore', at: '2026-11-15T10:00:00Z' });
  assert.equal(readClaudeSession(a).title, 'Fix the login bug');
  const b = writeClaudeSession(home, { id: 'b1111111-0000', cwd: '/w/b', prompt: 'x'.repeat(80), title: 'My named session' });
  assert.equal(readClaudeSession(b).title, 'My named session');
  assert.equal(readClaudeSession(a).cwd, '/w/a');
  assert.equal(readClaudeSession(a).gitBranch, 'main');
  assert.equal(readClaudeSession(a).startedAt, '2026-11-15T10:00:00Z');
  assert.equal(claudePromptTitle({ type: 'user', uuid: 'u', message: { content: 'Caveat: the messages below' } }), undefined);
  assert.equal(claudePromptTitle({ type: 'user', uuid: 'u', message: { content: [{ type: 'tool_result', content: 'x' }] } }), undefined);
  assert.equal(claudePromptTitle({ type: 'user', uuid: 'u', isMeta: true, message: { content: 'hi' } }), undefined);
  assert.equal(claudePromptTitle({ type: 'user', uuid: 'u', message: { content: 'y'.repeat(90) } }).length, 60);
  const empty = path.join(home, 'empty.jsonl'); fs.writeFileSync(empty, '{"type":"summary"}\n');
  assert.equal(readClaudeSession(empty).parseable, false);
});

test('Codex rollouts: id, folder, branch, title; non-interactive ones are flagged (Capy skips them)', () => {
  const home = tmpdir('c2c-cx-');
  const f = writeCodexSession(home, { id: 'cccccccc-1111', cwd: '/w/c', branch: 'me/c', prompt: 'Port the parser', remote: 'https://github.com/Acme/Parser.git' });
  const s = readCodexSession(f);
  assert.equal(s.sessionId, 'cccccccc-1111');
  assert.equal(s.title, 'Port the parser', 'skips the environment_context message like Capy does');
  assert.equal(s.kind, 'main');
  assert.equal(s.gitBranch, 'me/c');
  const g = readCodexSession(writeCodexSession(home, { id: 'dddddddd-1111', cwd: '/w/d', source: 'exec' }));
  assert.equal(g.kind, 'non-interactive');
});

test('repositories are keyed like Capy keys them', () => {
  assert.equal(repoSlug('git@github.com:HulkInTherapy/c2c-demo.git'), 'hulkintherapy/c2c-demo');
  assert.equal(repoSlug('https://github.com/HulkInTherapy/c2c-demo'), 'hulkintherapy/c2c-demo');
  assert.equal(repoSlug('nope'), undefined);
  assert.equal(encodeClaudeDir('/Users/me/.t3/worktrees/a_b'), '-Users-me--t3-worktrees-a-b');
  const d = repo(path.join(tmpdir('c2c-git-'), 'ws'));
  assert.deepEqual(gitRepos(d), ['acme/app']);
  assert.deepEqual(gitRepos('/definitely/not/here'), []);
  assert.equal(projectFor(['acme/app'], [{ id: 'h', name: 'Home', repos: [] }, { id: 'p', name: 'App', repos: [{ repoFullName: 'Acme/App', baseBranch: 'main', mode: 'primary' }] }]).id, 'p');
  assert.equal(projectFor(['acme/other'], [{ id: 'p', name: 'App', repos: [{ repoFullName: 'Acme/App' }] }]), null);
});

test('locateSessions: by stored id (Claude and Codex), else the one session started with the thread in its folder', () => {
  const home = tmpdir('c2c-loc-');
  writeClaudeSession(home, { id: 'eeeeeeee-1111', cwd: '/w/e' });
  writeClaudeSession(home, { id: 'ffffffff-2222', cwd: '/w/e', at: '2026-11-15T12:00:00Z' });
  writeCodexSession(home, { id: '99999999-1111', cwd: '/w/x' });
  assert.deepEqual(locateSessions({ nativeIds: ['eeeeeeee-1111', 'ffffffff-2222'] }, { home, env: {} }).map((s) => s.sessionId), ['eeeeeeee-1111', 'ffffffff-2222']);
  assert.equal(locateSessions({ nativeId: '99999999-1111', provider: 'codex' }, { home, env: {} })[0].source, 'codex');
  const byFolder = locateSessions({ worktree: '/w/e', createdAt: '2026-11-15T12:01:00Z' }, { home, env: {} });
  assert.deepEqual(byFolder.map((s) => [s.sessionId, s.match]), [['ffffffff-2222', 'folder+time']]);
  assert.deepEqual(locateSessions({ worktree: '/w/e', createdAt: '2026-11-15T15:00:00Z' }, { home, env: {} }), [], 'no session near the thread: nothing guessed');
});

test('T3 Code subagent and provider-internal runs are not listed as threads', () => {
  assert.ok(isT3ChildThread('thread:subagent:7c6b452d'));
  assert.ok(isT3ChildThread('thread:provider:claudeAgent:native-thread:x'));
  assert.ok(!isT3ChildThread('63a932b8-5056-4fd7-ba43-46ad64598df9'));
});

test('native plan for Conductor: exact sessions per workspace, grouped by repository, mapped to the existing project', { skip }, () => {
  const home = fakeHome({ t3: false });
  const ws = repo(path.join(home, 'conductor', 'workspaces', 'app', 'lisbon'));
  writeClaudeSession(home, { id: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: ws, branch: 'me/lisbon', prompt: 'add stripe webhooks' });
  sh(path.dirname(path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db')), 'sqlite3', path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db'),
    `UPDATE workspaces SET workspace_path='${ws}' WHERE id='w1';`);
  const cat = loadCatalog('conductor', { home });
  const lisbon = cat.projects.flatMap((p) => p.threads).find((t) => t.id === 'w1');
  assert.equal(lisbon.worktree, ws);
  assert.deepEqual(lisbon.nativeIds, ['bbbbbbbb-1111-2222-3333-444444444444']);
  const projects = [{ id: 'project_app', name: 'App', repos: [{ repoFullName: 'Acme/App', baseBranch: 'main', mode: 'primary' }] }];
  const plan = nativePlan(cat, ['w1', 'w2'], { home, env: {}, projects });
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].repository, 'acme/app');
  assert.equal(plan.groups[0].capyProject.name, 'App');
  assert.equal(plan.groups[0].sessions[0].title, 'add stripe webhooks');
  assert.equal(plan.groups[0].sessions[0].thread, 'Billing page');
  assert.deepEqual(plan.missing.map((m) => m.threadId), ['w2'], 'oslo has no session file: it goes to the fallback');
  const steps = formatNativeSteps(plan, { projectsKnown: true, opened: true });
  assert.match(steps, /Click \*\*Claude Code\*\*/);
  assert.match(steps, /acme\/app/);
  assert.match(steps, /"add stripe webhooks"/);
  assert.match(steps, /acme\/app → "App"/);
  assert.doesNotMatch(steps, /create/i, 'project exists: nothing to create');
  const none = formatNativeSteps(nativePlan(cat, ['w1'], { home, env: {}, projects: [] }), { projectsKnown: true });
  assert.match(none, /^1\. First create the Capy project/m, 'no project for the repository: create it first so the sessions stay together');
  assert.match(none, /capy\.ai\/settings\/projects/);
});

test('native plan for T3 Code: the Claude Code session of each thread by its stored id; threads without one go to the fallback', { skip }, () => {
  const home = fakeHome({ conductor: false, claudeSession: false });
  const api = repo(path.join(home, 'src', 'api'));
  writeClaudeSession(home, { id: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: api, prompt: 'Login fails for SSO users' });
  const cat = loadCatalog('t3code', { home });
  const plan = nativePlan(cat, ['t1', 't2'], { home, env: {} });
  assert.equal(plan.groups[0].app, 'Claude Code');
  assert.equal(plan.groups[0].sessions[0].thread, 'Fix login bug');
  assert.deepEqual(plan.missing.map((m) => m.threadId), ['t2']);
  assert.match(formatNativeSteps(plan), /Linked to this repository/);
});

test('openImport opens the deep link to Capy\'s Import page', () => {
  const calls = [];
  assert.equal(openImport({ platform: 'darwin', run: (c, a) => { calls.push([c, ...a]); return { on() {}, unref() {} }; } }), true);
  assert.deepEqual(calls, [['open', IMPORT_DEEP_LINK]]);
  assert.equal(IMPORT_DEEP_LINK, 'capy://app/settings/import');
  assert.equal(openImport({ platform: 'darwin', run: () => { throw new Error('no'); } }), false);
});

test('question cards: recent projects first, the five thread choices, answers become selection phrases', { skip }, () => {
  const cat = loadCatalog('t3code', { home: fakeHome() });
  const q = questions(cat);
  assert.equal(q.project.options.at(-1), 'All projects');
  assert.match(q.project.options[0], /^api · 3 threads · last used/);
  assert.deepEqual(q.threads.options, SCOPES);
  assert.equal(SCOPES[0], 'Latest 3 threads (recommended)');
  const pick = questions(cat, { project: 'api' }).pick;
  assert.equal(pick.multiple, true);
  assert.deepEqual(pick.values, ['t1', 't2', 't3']);
  assert.equal(answerPhrase({ project: 'api', scope: SCOPES[0] }), 'project api latest 3 threads');
  assert.equal(answerPhrase({ project: 'All projects', scope: SCOPES[3] }), 'everything');
  assert.equal(answerPhrase({ project: 'web', scope: SCOPES[1] }), 'project web last 7 days');
  assert.equal(answerPhrase({ project: 'All projects', scope: SCOPES[2] }), 'last used');
});

test('CLI: questions, native --open (no API key), open', { skip }, async () => {
  const home = fakeHome({ conductor: false });
  const io = quiet();
  assert.equal(await main(['questions', '--source', 't3code', '--home', home], io), 0);
  assert.equal(JSON.parse(io.out[0]).threads.options.length, 5);
  const runs = [];
  const run = (c, a) => { runs.push([c, ...a]); return { on() {}, unref() {} }; };
  const io2 = quiet();
  assert.equal(await main(['native', '--source', 't3code', '--home', home, '--threads', 't1,t2', '--open', '--no-api', '--json'], io2, { run }), 0);
  const out = JSON.parse(io2.out[0]);
  assert.equal(out.opened, process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32');
  assert.equal(out.groups[0].sessions[0].sessionId, 'aaaaaaaa-1111-2222-3333-444444444444');
  assert.match(out.steps, /Settings → Import/);
  assert.equal(runs.length, 1);
  const io3 = quiet();
  assert.equal(await main(['open'], io3, { run }), 0);
  assert.match(io3.out[0], /capy:\/\/app\/settings\/import/);
});
