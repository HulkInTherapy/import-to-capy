// Read-only source readers for Conductor and T3 Code. Both produce the same catalog shape (see select.mjs)
// and the same message shape ({ role, text, raw, at }).
//
// Conductor: conductor.db is small, so it is copied (with -wal/-shm) to a temp folder, read, and deleted.
// T3 Code:   statev2.sqlite can be gigabytes and is live, so it is NEVER copied. It is opened with
//            `file:...?immutable=1` (no locks, no writes, no -shm/-wal use) and queried selectively.
//            Immutable mode ignores the write-ahead log, so the last few minutes of activity may be missing.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { withDbCopy, detectInstall, portFrom } from './conductor-to-capy.mjs';
import { messageText } from './conductor-workspaces.mjs';
import { findNative } from './native.mjs';
import { sortCatalog } from './select.mjs';

export const t3DefaultDb = (home = os.homedir()) => path.join(home, '.t3', 'userdata', 'statev2.sqlite');
export const conductorDefaultDb = (home = os.homedir()) => path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

export function immutableQuery(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`No database at ${dbPath}`);
  const uri = `file:${dbPath}?immutable=1`;
  const q = (sql) => {
    const out = execFileSync('sqlite3', ['-json', uri, sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
    return out ? JSON.parse(out) : [];
  };
  q.columns = (t) => q(`PRAGMA table_info(${t});`).map((c) => c.name);
  return q;
}
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const parse = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'canary']);

export function detect({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const found = [];
  if (fs.existsSync(conductorDefaultDb(home)) || fs.existsSync(path.join(home, 'conductor', 'workspaces'))
    || ['conductor.json', '.conductor/settings.toml'].some((f) => fs.existsSync(path.join(cwd, f)))) found.push('conductor');
  if (fs.existsSync(t3DefaultDb(home))) found.push('t3code');
  return found;
}

// ---------------------------------------------------------------- T3 Code
export function t3Catalog({ db = t3DefaultDb(), home = os.homedir(), native = true } = {}) {
  const q = immutableQuery(db);
  const pcols = q.columns('projection_projects');
  const projects = q(`SELECT project_id, title, workspace_root, ${pcols.includes('scripts_json') ? 'scripts_json' : 'NULL AS scripts_json'}, updated_at, ${pcols.includes('archived_at') ? 'archived_at' : 'NULL AS archived_at'}
    FROM projection_projects WHERE deleted_at IS NULL;`);
  const threads = q(`SELECT thread_id, project_id, title, default_provider, created_at, updated_at, archived_at,
      json_extract(payload_json, '$.branch') AS branch, json_extract(payload_json, '$.worktreePath') AS worktree,
      json_extract(payload_json, '$.settledAt') AS settled_at, json_extract(payload_json, '$.pullRequests') AS prs,
      json_extract(payload_json, '$.branchPullRequest') AS branch_pr, json_extract(payload_json, '$.linkedPullRequest') AS linked_pr
    FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL;`);
  const counts = new Map(q('SELECT thread_id, COUNT(*) AS n FROM orchestration_v2_projection_messages GROUP BY thread_id;').map((r) => [r.thread_id, r.n]));
  const prov = new Map();
  for (const r of q(`SELECT thread_id, provider, json_extract(payload_json, '$.nativeThreadRef.nativeId') AS native_id, updated_at
      FROM orchestration_v2_projection_provider_threads ORDER BY updated_at;`)) prov.set(r.thread_id, r);
  const cat = { source: 'T3 Code', projects: projects.map((p) => ({ id: p.project_id, name: p.title || path.basename(p.workspace_root || '') || p.project_id,
    path: p.workspace_root || '', lastUsed: p.updated_at, scripts: parse(p.scripts_json, []), archived: !!p.archived_at, threads: [] })) };
  const byId = new Map(cat.projects.map((p) => [p.id, p]));
  for (const t of threads) {
    const p = byId.get(t.project_id); if (!p) continue;
    const prs = [...(parse(t.prs, []) || []), parse(t.branch_pr), parse(t.linked_pr)].filter(Boolean)
      .map((x) => ({ url: x.url || '', number: x.number, state: (x.snapshot?.state || x.state || '').toLowerCase(), title: x.snapshot?.title || '' }));
    const merged = prs.some((x) => x.state === 'merged' || x.state === 'closed');
    const pv = prov.get(t.thread_id);
    const branch = t.branch && !DEFAULT_BRANCHES.has(t.branch) ? t.branch : '';
    p.threads.push({ id: t.thread_id, title: t.title || 'Untitled', createdAt: t.created_at, updatedAt: t.updated_at, branch,
      worktree: t.worktree || '', prs, archived: !!t.archived_at,
      unfinished: !t.settled_at && !t.archived_at, openWork: !t.archived_at && (prs.some((x) => x.state === 'open') || (!!branch && !merged)),
      messageCount: counts.get(t.thread_id) || 0, provider: pv?.provider || t.default_provider || '',
      native: native && pv?.native_id ? findNative(pv.provider, pv.native_id, home) : null, nativeId: pv?.native_id || '' });
  }
  return sortCatalog(cat);
}

export function t3Messages(threadId, { db = t3DefaultDb(), limit = 5000 } = {}) {
  const q = immutableQuery(db);
  return q(`SELECT role, created_at, json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
    WHERE thread_id = ${lit(threadId)} ORDER BY created_at LIMIT ${Number(limit)};`).map((m) => ({ role: m.role, text: m.text || '', at: m.created_at }));
}

// T3 Code project scripts ([{ name, command, icon, runOnWorktreeCreate }]) -> .capy/setup.json
export function t3Setup(scripts, { port = 3000 } = {}) {
  const setup = { $schema: 'https://api.capy.ai/schemas/setup.v1.json', format_version: 1, scripts: {}, commands: [] };
  const report = [];
  const init = (scripts || []).filter((s) => s.runOnWorktreeCreate && s.command);
  if (init.length) {
    setup.scripts.initialize = init.map((s) => s.command).join(' && ');
    report.push(`setup: ${init.map((s) => s.name).join(', ')} → scripts.initialize`);
    const inst = init.map((s) => detectInstall(s.command)).find(Boolean);
    if (inst) { setup.scripts.refresh = inst; report.push(`${inst} → scripts.refresh`); }
  }
  for (const s of (scripts || []).filter((x) => !x.runOnWorktreeCreate && x.command)) {
    const e = { name: String(s.name || 'run').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'run', command: s.command };
    const p = portFrom(s.command, port); if (p) e.port = p;
    setup.commands.push(e); report.push(`action "${s.name}" → commands: "${e.name}"`);
  }
  if (!setup.commands.length) delete setup.commands;
  if (!Object.keys(setup.scripts).length) delete setup.scripts;
  return { setup, report, empty: !setup.scripts && !setup.commands };
}

// ---------------------------------------------------------------- Conductor
export function conductorCatalog({ home = os.homedir(), db = conductorDefaultDb(home), native = true } = {}) {
  if (!fs.existsSync(db)) throw new Error(`No Conductor database at ${db}`);
  return withDbCopy(db, (q) => {
    const rc = q.columns('repos');
    const repos = q(`SELECT id, name, root_path, ${rc.includes('hidden') ? 'hidden' : '0 AS hidden'}, ${rc.includes('updated_at') ? 'updated_at' : 'NULL AS updated_at'} FROM repos;`).filter((r) => !r.hidden);
    const wc = q.columns('workspaces');
    const want = ['id', 'local_id', 'repository_id', 'directory_name', 'workspace_name', 'branch', 'state', 'pr_title', 'notes', 'manual_status', 'derived_status',
      'created_at', 'updated_at', 'last_activity_at', 'workspace_path', 'DEPRECATED_archived'].filter((c) => wc.includes(c));
    const wss = q(`SELECT ${want.join(', ')} FROM workspaces;`);
    const sc = q.columns('sessions');
    const sessions = sc.includes('workspace_id') ? q(`SELECT ${['id', 'workspace_id', 'title', 'agent_type', 'model', 'claude_session_id', 'updated_at', 'last_message_at'].filter((c) => sc.includes(c)).join(', ')} FROM sessions;`) : [];
    const counts = new Map(q('SELECT session_id, COUNT(*) AS n FROM session_messages GROUP BY session_id;').map((r) => [r.session_id, r.n]));
    const cat = { source: 'Conductor', projects: repos.map((r) => ({ id: r.id, name: r.name || path.basename(r.root_path || ''), path: r.root_path || '', lastUsed: r.updated_at, threads: [] })) };
    const byId = new Map(cat.projects.map((p) => [p.id, p]));
    for (const w of wss) {
      const p = byId.get(w.repository_id); if (!p) continue;
      const ids = [w.id, w.local_id].filter(Boolean);
      const ss = sessions.filter((s) => ids.includes(s.workspace_id)).sort((a, b) => String(b.last_message_at || b.updated_at).localeCompare(String(a.last_message_at || a.updated_at)));
      const archived = w.state === 'archived' || !!w.DEPRECATED_archived;
      const status = `${w.manual_status || ''} ${w.derived_status || ''}`.toLowerCase();
      // updated_at changes on any write (triggers), so real activity comes first.
      const tsOf = (x) => Date.parse(String(x).replace(' ', 'T') + (String(x).includes('T') ? '' : 'Z')) || 0;
      const last = [w.last_activity_at, ss[0]?.last_message_at].filter(Boolean).sort((a, b) => tsOf(b) - tsOf(a))[0] || w.updated_at || ss[0]?.updated_at;
      const nativeId = ss[0]?.claude_session_id || '';
      p.threads.push({ id: w.local_id || w.id, title: w.pr_title || w.workspace_name || w.directory_name || w.branch || 'Untitled', createdAt: w.created_at, updatedAt: last,
        branch: w.branch && !DEFAULT_BRANCHES.has(w.branch) ? w.branch : '', workspaceName: w.workspace_name || w.directory_name || '', path: w.workspace_path || '',
        prs: w.pr_title ? [{ title: w.pr_title, state: '' }] : [], notes: w.notes || '', archived,
        unfinished: !archived && !/\b(done|merged|closed|complete)/.test(status), openWork: !archived && !!w.branch && !DEFAULT_BRANCHES.has(w.branch),
        messageCount: ss.reduce((n, s) => n + (counts.get(s.id) || 0), 0), sessionIds: ss.map((s) => s.id), provider: ss[0]?.agent_type || ss[0]?.model || '',
        native: native && nativeId ? findNative('claude', nativeId, home) : null, nativeId });
    }
    return sortCatalog(cat);
  });
}

export function conductorMessages(thread, { db = conductorDefaultDb() } = {}) {
  if (!thread.sessionIds?.length) return [];
  return withDbCopy(db, (q) => {
    const mc = q.columns('session_messages');
    const rows = q(`SELECT role, content, created_at FROM session_messages WHERE session_id IN (${thread.sessionIds.map(lit).join(', ')}) ORDER BY created_at;`);
    return rows.map((m) => ({ role: m.role, text: messageText(m.content), raw: mc.includes('content') ? String(m.content || '').slice(0, 20000) : '', at: m.created_at }));
  });
}
