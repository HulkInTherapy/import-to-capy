// Synthetic source databases built from the real apps' schemas (structure only, dumped with `.schema`).
// Every row here is made up. A fake home folder holds them where the importer looks by default.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh, tmpdir } from './helpers.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const q = (s) => String(s).replace(/'/g, "''");
export const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (days) => new Date(NOW - days * 864e5).toISOString().replace('T', ' ').slice(0, 19);

export const SECRETS = {
  openai: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX123456',
  github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  tavily: 'tvly-dev-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  envline: 'DATABASE_PASSWORD=hunter2hunter2',
};

// T3 Code: 3 projects (api, web, docs), threads with branches, PRs, settled/archived states.
export function fakeT3(home) {
  const dir = path.join(home, '.t3', 'userdata');
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'statev2.sqlite');
  sh(dir, 'sqlite3', db, `.read ${path.join(FIX, 't3code-db', 'schema.sql')}`);
  const P = (id, title, root, scripts, upd) => `INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('${id}','${title}','${root}','${q(JSON.stringify(scripts))}','${ago(60)}','${ago(upd)}');`;
  const T = (id, pid, title, days, extra = {}) => {
    const payload = { id, projectId: pid, title, branch: extra.branch || 'main', worktreePath: extra.worktree || null, pullRequests: extra.prs || [], branchPullRequest: null, linkedPullRequest: null,
      settledAt: extra.settled ? ago(days) : null, archivedAt: extra.archived ? ago(days) : null, createdAt: ago(days + 1), updatedAt: ago(days) };
    return `INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, archived_at, deleted_at, payload_json)
      VALUES ('${id}','${pid}','${q(title)}','claudeAgent','full-access','default','${ago(days + 1)}','${ago(days)}',${extra.archived ? `'${ago(days)}'` : 'NULL'},${extra.deleted ? `'${ago(days)}'` : 'NULL'},'${q(JSON.stringify(payload))}');`;
  };
  const M = (id, tid, role, text, mins) => `INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES ('${id}','${tid}','${role}',0,'${ago(1 - mins / 1440)}','${ago(1 - mins / 1440)}','${q(JSON.stringify({ id, threadId: tid, role, text }))}');`;
  const PT = (tid, nid) => `INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
      VALUES ('pt-${tid}','${tid}','claudeAgent','idle','${ago(1)}','${q(JSON.stringify({ nativeThreadRef: { driver: 'claudeAgent', nativeId: nid, strength: 'strong' } }))}');`;
  const pr = (n, state) => [{ host: 'github.com', repository: 'acme/api', number: n, url: `https://github.com/acme/api/pull/${n}`, snapshot: { state, title: `PR ${n}` } }];
  sh(dir, 'sqlite3', db, [
    P('p-api', 'api', '/src/api', [{ id: 's1', name: 'Install', command: 'pnpm install', icon: 'x', runOnWorktreeCreate: true }, { id: 's2', name: 'Dev', command: 'pnpm dev --port 4000', runOnWorktreeCreate: false }], 0.5),
    P('p-web', 'web', '/src/web', [], 3),
    P('p-docs', 'docs', '/src/docs', [], 20),
    T('t1', 'p-api', 'Fix login bug', 0.5, { branch: 'me/login', prs: pr(12, 'OPEN') }),
    T('t2', 'p-api', 'Add rate limits', 2, { branch: 'me/rate', settled: true }),
    T('t3', 'p-api', 'Refactor db layer', 4, { branch: 'me/db' }),
    T('t4', 'p-api', 'Old spike', 30, { archived: true }),
    T('t5', 'p-api', 'Deleted thread', 1, { deleted: true }),
    T('t6', 'p-web', 'Landing page', 3, { branch: 'me/landing', prs: pr(7, 'MERGED') }),
    T('t7', 'p-web', 'Dark mode', 10, { settled: true }),
    T('t8', 'p-docs', 'Docs rewrite', 20),
    M('m1', 't1', 'user', `Login fails for SSO users. My key is ${SECRETS.openai} and token ${SECRETS.github}.`, 1),
    M('m2', 't1', 'assistant', 'I decided to fix it in src/auth/session.ts instead of the middleware.\n## Plan\n- [ ] add a test in tests/auth.test.ts\nTODO: update docs', 2),
    M('m3', 't1', 'user', `Here is the .env:\n${SECRETS.envline}\nAWS ${SECRETS.aws} tavily ${SECRETS.tavily}`, 3),
    M('m4', 't1', 'assistant', 'Fixed the session refresh; tests pass. Next: review the PR.', 4),
    PT('t1', 'aaaaaaaa-1111-2222-3333-444444444444'),
  ].join('\n'));
  return db;
}

// Conductor: 2 repos, 3 live workspaces + 1 archived, sessions and messages (Claude SDK JSON).
export function fakeConductor(home) {
  const dir = path.join(home, 'Library', 'Application Support', 'com.conductor.app');
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, 'conductor.db');
  sh(dir, 'sqlite3', db, `.read ${path.join(FIX, 'conductor-db', 'schema.sql')}`);
  const W = (id, rid, name, branch, state, days, pr = '') => `INSERT INTO workspaces (local_id, id, repository_id, directory_name, workspace_name, branch, state, pr_title, last_activity_at, created_at, updated_at)
      VALUES ('${id}','${id}','${rid}','${name}','${name}','${branch}','${state}','${pr}','${ago(days)}','${ago(days + 2)}','${ago(days)}');`;
  const S = (id, wid, title, days, csid) => `INSERT INTO sessions (id, workspace_id, title, agent_type, claude_session_id, updated_at, last_message_at) VALUES ('${id}','${wid}','${title}','claude','${csid}','${ago(days)}','${ago(days)}');`;
  const M = (id, sid, role, content, days) => `INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('${id}','${sid}','${role}','${q(content)}','${ago(days)}');`;
  sh(dir, 'sqlite3', db, [
    "INSERT INTO local_workspace_revision_counter (id, latest_revision) VALUES (1, 0);",
    `INSERT INTO repos (id, name, root_path, setup_script, updated_at) VALUES ('r-app','app','/src/app','npm ci','${ago(1)}');`,
    `INSERT INTO repos (id, name, root_path, updated_at) VALUES ('r-site','site','/src/site','${ago(5)}');`,
    W('w1', 'r-app', 'lisbon', 'me/lisbon', 'ready', 1, 'Billing page'),
    W('w2', 'r-app', 'oslo', 'me/oslo', 'ready', 6),
    W('w3', 'r-site', 'rome', 'me/rome', 'ready', 5),
    W('w4', 'r-app', 'paris', 'me/paris', 'archived', 2),
    S('s1', 'w1', 'Stripe webhooks', 1, 'bbbbbbbb-1111-2222-3333-444444444444'),
    M('m1', 's1', 'user', `add stripe webhooks, secret is ${SECRETS.github}`, 1.01),
    M('m2', 's1', 'assistant', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Going with a queue instead of inline handling. Edited src/billing/webhooks.ts.' }, { type: 'tool_use', input: { file_path: 'src/billing/queue.ts' } }] } }), 1),
  ].join('\n'));
  return db;
}

export function fakeHome({ t3 = true, conductor = true, claudeSession = true } = {}) {
  const home = tmpdir('c2c-home-');
  if (t3) fakeT3(home);
  if (conductor) fakeConductor(home);
  if (claudeSession) writeClaudeSession(home, { id: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: '/src/api', branch: 'me/login', prompt: 'Login fails for SSO users', at: '2026-11-15T11:00:00.000Z' });
  return home;
}

// A Claude Code session file shaped like the real ones (first line has no uuid; the chain starts on line 2).
export function writeClaudeSession(home, { id, cwd, branch = 'main', prompt = 'Do the thing', at = '2026-11-15T11:00:00.000Z', title, extra = [] }) {
  const d = path.join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  const lines = [{ type: 'queue-operation', sessionId: id },
    { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, cwd, gitBranch: branch, version: '2.1.0', timestamp: at, message: { role: 'user', content: prompt } },
    ...(title ? [{ type: 'custom-title', customTitle: title, sessionId: id }] : []),
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, cwd, timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } },
    ...extra];
  const f = path.join(d, `${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

// A Codex rollout shaped like the real ones.
export function writeCodexSession(home, { id, cwd, branch = 'main', prompt = 'Do the thing', at = '2026-11-15T11:00:00.000Z', source = 'vscode', remote }) {
  const d = path.join(home, '.codex', 'sessions', '2026', '11', '15');
  fs.mkdirSync(d, { recursive: true });
  const lines = [{ type: 'session_meta', timestamp: at, payload: { id, cwd, timestamp: at, source, originator: 'T3 Code', cli_version: '0.60.0', git: { branch, ...(remote ? { repository_url: remote } : {}) } } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    { type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }];
  const f = path.join(d, `rollout-2026-11-15T11-00-00-${id}.jsonl`);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}
