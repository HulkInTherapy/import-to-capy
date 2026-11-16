#!/usr/bin/env node
// conductor-workspaces: list the work still in flight from Conductor, so each piece can continue as a Capy thread.
//
// Read-only. Runs only `git` read commands, plus queries against a temporary COPY of the Conductor Mac app's
// database (the live file is never opened, written or locked; the copy is deleted afterwards).
// From the database it reads workspace names, branches, PR titles and descriptions, the user's notes, and
// metadata about each workspace's latest chat (title, status, agent, message count). It reads message text
// only with --include-session-text, and then only the last user and assistant message, cut to 500 characters,
// so an agent can write a one-line summary. Environment values are never read. Nothing is pushed or changed.
//
// Where it looks:
//   1. `git worktree list` from the main checkout: Conductor workspaces are plain git worktrees, usually under
//      ~/conductor/workspaces/<repo>/<name> (older versions: a .conductor/ folder inside the repo).
//   2. Remote branches not merged into the base branch: what a cloud machine can see.
//   3. On a Mac where it exists (or with --app-db): ~/Library/Application Support/com.conductor.app/conductor.db
//
// Usage: conductor-workspaces [repo-dir] [--json] [--no-app] [--app-db <path>] [--remote-only] [--limit <n>] [--include-session-text]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withDbCopy } from './conductor-to-capy.mjs';

const git = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

export function defaultAppDb() { return path.join(os.homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db'); }

export function baseBranch(dir) {
  const head = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master', 'canary', 'develop']) if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]) !== null) return b;
  return 'main';
}

export function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of (porcelain || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: '', head: '', detached: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

export const looksLikeConductor = (p) => /[\\/]conductor[\\/]workspaces[\\/]|[\\/]\.conductor[\\/]/.test(p);

function branchFacts(dir, branch, base) {
  const ref = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null ? branch : `origin/${branch}`;
  const baseRef = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]) !== null ? `origin/${base}` : base;
  const ahead = Number(git(dir, ['rev-list', '--count', `${baseRef}..${ref}`]) || 0);
  const upstream = git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
  const remoteExists = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) !== null;
  const unpushed = remoteExists ? Number(git(dir, ['rev-list', '--count', `origin/${branch}..${ref}`]) || 0) : ahead;
  const last = (git(dir, ['log', '-1', '--format=%cs%x09%s', ref]) || '').split('\t');
  return { ahead, pushed: remoteExists, upstream: upstream || '', unpushedCommits: unpushed, lastCommitDate: last[0] || '', lastCommit: last[1] || '' };
}

export function localWorkspaces(dir, base) {
  const wts = parseWorktrees(git(dir, ['worktree', 'list', '--porcelain']));
  const main = wts[0]?.path;
  return wts.filter((w) => w.path !== main && !w.prunable && w.branch).map((w) => {
    const dirty = (git(w.path, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    return { source: 'worktree', name: path.basename(w.path), path: w.path, branch: w.branch, conductor: looksLikeConductor(w.path), uncommittedFiles: dirty, ...branchFacts(dir, w.branch, base) };
  });
}

export function remoteBranches(dir, base, limit = 30) {
  const baseRef = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]) !== null ? `origin/${base}` : base;
  const rows = (git(dir, ['for-each-ref', '--sort=-committerdate', `--no-merged=${baseRef}`, '--format=%(refname:short)', 'refs/remotes/origin']) || '')
    .split('\n').filter((r) => r && r !== 'origin/HEAD' && r !== 'origin' && r !== `origin/${base}`).slice(0, limit);
  return rows.map((r) => { const branch = r.replace(/^origin\//, ''); return { source: 'remote', name: branch, branch, conductor: null, uncommittedFiles: null, ...branchFacts(dir, branch, base) }; });
}

// Read workspace metadata from the Conductor app, through a temporary copy of its database (never the live file).
// Only these columns are selected, and only those that exist in the installed version.
const WANTED = ['id', 'local_id', 'directory_name', 'workspace_name', 'branch', 'state', 'pr_title', 'pr_description', 'description', 'notes',
  'intended_target_branch', 'manual_status', 'derived_status', 'workspace_path', 'last_activity_at', 'DEPRECATED_archived'];
const SESSION_COLS = ['id', 'workspace_id', 'title', 'status', 'model', 'agent_type', 'claude_session_id', 'updated_at', 'last_message_at'];
const normRemote = (u) => (u || '').trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\/+$/, '').toLowerCase();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

// Pull plain text out of a stored message (plain text, or JSON with `text` fields). Used only with includeSessionText.
export function messageText(content) {
  if (!content) return '';
  try {
    const out = [];
    const walk = (o) => { if (!o || typeof o !== 'object') return; if (typeof o.text === 'string') out.push(o.text); for (const v of Object.values(o)) walk(v); };
    walk(JSON.parse(content));
    return out.join(' ').replace(/\s+/g, ' ').trim();
  } catch { return String(content).replace(/\s+/g, ' ').trim(); }
}

export function appWorkspaces(db, { root, remote, includeSessionText = false }) {
  return withDbCopy(db, (q) => {
    const repos = q('SELECT id, root_path, remote_url, hidden FROM repos;');
    const roots = [].concat(root).filter(Boolean).map((x) => path.resolve(x));
    const repo = repos.find((r) => !r.hidden && r.root_path && roots.includes(path.resolve(r.root_path)))
      || repos.find((r) => !r.hidden && remote && normRemote(r.remote_url) === normRemote(remote));
    if (!repo) return { matched: false, rows: [] };
    const cols = q.columns('workspaces').filter((c) => WANTED.includes(c));
    if (!cols.includes('branch')) return { matched: true, rows: [] };
    const rows = q(`SELECT ${cols.join(', ')} FROM workspaces WHERE repository_id = ${lit(repo.id)};`)
      .filter((w) => w.state !== 'archived' && !w.DEPRECATED_archived);
    const sCols = q.columns('sessions');
    const mCols = q.columns('session_messages');
    for (const w of rows) {
      const ids = [w.id, w.local_id].filter(Boolean);
      if (!ids.length || !sCols.includes('workspace_id')) continue;
      const order = sCols.includes('last_message_at') ? 'COALESCE(last_message_at, updated_at)' : 'updated_at';
      const sessions = q(`SELECT ${SESSION_COLS.filter((c) => sCols.includes(c)).join(', ')} FROM sessions WHERE workspace_id IN (${ids.map(lit).join(', ')}) ORDER BY ${order} DESC;`);
      w.sessionCount = sessions.length;
      const last = sessions[0];
      if (last) {
        const count = mCols.includes('session_id') ? q(`SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ${lit(last.id)};`)[0]?.n ?? 0 : 0;
        w.latestSession = { title: last.title || '', status: last.status || '', model: last.model || '', agent: last.agent_type || '',
          claudeSessionId: last.claude_session_id || '', lastMessageAt: last.last_message_at || last.updated_at || '', messages: count };
        // Message text is read only when the user agreed (includeSessionText), and only the last user and assistant
        // messages, cut short, so the agent can write a one-line summary. It is never stored.
        if (includeSessionText && mCols.includes('content') && mCols.includes('role')) {
          const msgs = q(`SELECT role, content FROM session_messages WHERE session_id = ${lit(last.id)} ORDER BY created_at DESC LIMIT 20;`);
          const pick = (role) => messageText(msgs.find((m) => m.role === role && messageText(m.content))?.content).slice(0, 500);
          w.latestSession.lastUserMessage = pick('user');
          w.latestSession.lastAssistantMessage = pick('assistant');
        }
      }
    }
    return { matched: true, rows: rows.map(({ DEPRECATED_archived, local_id, id, ...w }) => w) };
  });
}

export function capyPrompt(w, base) {
  const parts = [`Continue work moved over from Conductor on branch \`${w.branch}\`${w.name && w.name !== w.branch ? ` (Conductor workspace "${w.name}")` : ''}.`];
  if (w.pr_title) parts.push(`Its PR title was: "${w.pr_title}".`);
  if (w.pr_description) parts.push(`PR description: ${String(w.pr_description).slice(0, 400)}`);
  if (w.notes) parts.push(`My notes on it: ${String(w.notes).slice(0, 600)}`);
  if (w.summary) parts.push(`Where the last Conductor session left off: ${String(w.summary).slice(0, 400)}`);
  else if (w.latestSession?.title) parts.push(`The last Conductor chat on it was titled "${w.latestSession.title}".`);
  parts.push(`Check out \`${w.branch}\`, read its diff against \`${w.intended_target_branch || base}\`, and tell me in a few lines where it stands and what is left. Wait for my go-ahead before changing anything.`);
  return parts.join(' ');
}

export const deepLink = (prompt) => `https://capy.ai/new?prompt=${encodeURIComponent(prompt)}`;

export function collect(dir, opts = {}) {
  const base = baseBranch(dir);
  const remote = git(dir, ['remote', 'get-url', 'origin']) || '';
  let items = opts.remoteOnly ? [] : localWorkspaces(dir, base);
  const seen = new Set(items.map((i) => i.branch));
  for (const r of remoteBranches(dir, base, opts.limit || 30)) if (!seen.has(r.branch)) { items.push(r); seen.add(r.branch); }
  const warnings = [];
  let app = { matched: false, rows: [], used: false };
  const db = opts.appDb || (process.platform === 'darwin' ? defaultAppDb() : '');
  if (!opts.noApp && db && fs.existsSync(db)) {
    const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    try { app = { ...appWorkspaces(db, { root: [dir, common ? path.dirname(common) : ''], remote, includeSessionText: !!opts.includeSessionText }), used: true }; } catch (e) { warnings.push(`Could not read Conductor's app database (${e.message.split('\n')[0]}). Skipped.`); }
  }
  for (const w of app.rows) {
    const hit = items.find((i) => i.branch === w.branch);
    const meta = { conductor: true, name: w.workspace_name || w.directory_name || w.branch, pr_title: w.pr_title || '', pr_description: w.pr_description || '',
      notes: w.notes || '', description: w.description || '', intended_target_branch: w.intended_target_branch || '', state: w.state || '',
      sessionCount: w.sessionCount || 0, latestSession: w.latestSession || null };
    if (hit) Object.assign(hit, meta);
    else if (w.branch) items.push({ source: 'conductor-app', branch: w.branch, path: w.workspace_path || '', ...meta, missing: true });
  }
  items = items.map((i) => {
    const needsPush = i.uncommittedFiles > 0 || (i.unpushedCommits || 0) > 0 || (i.source === 'worktree' && !i.pushed);
    const prompt = capyPrompt(i, base);
    return { ...i, needsPush, prompt, capyLink: deepLink(prompt) };
  });
  return { repo: dir, base, remote, appDatabase: app.used ? { path: db, matchedRepo: app.matched, workspaces: app.rows.length } : null, items, warnings };
}

export function render(r) {
  const out = [`Base branch: ${r.base}`];
  if (r.appDatabase) out.push(`Conductor app database: ${r.appDatabase.matchedRepo ? `${r.appDatabase.workspaces} open workspace(s) for this repo` : 'no matching repository'}`);
  if (!r.items.length) out.push('', 'Nothing in flight: no extra worktrees and no unmerged remote branches.');
  r.items.forEach((i, k) => {
    out.push('', `${k + 1}. ${i.branch}${i.conductor ? '  [Conductor]' : ''}  (${i.source})`);
    if (i.name && i.name !== i.branch) out.push(`   workspace: ${i.name}`);
    if (i.pr_title) out.push(`   PR title: ${i.pr_title}`);
    if (i.ahead !== undefined) out.push(`   ${i.ahead} commit(s) ahead of ${r.base}; last: ${i.lastCommitDate} ${i.lastCommit}`);
    if (i.latestSession) out.push(`   last Conductor chat: "${i.latestSession.title || 'untitled'}" (${i.latestSession.messages} messages, ${i.latestSession.agent || i.latestSession.model || 'agent'})`);
    if (i.uncommittedFiles) out.push(`   ${i.uncommittedFiles} uncommitted file(s) in ${i.path}`);
    if (i.missing) out.push('   listed in Conductor, but no worktree or remote branch found here');
    if (i.needsPush) out.push('   NOT on GitHub yet: commit and push before a cloud thread can see it (ask the human first)');
    out.push(`   Continue in Capy: ${i.capyLink}`);
  });
  for (const w of r.warnings) out.push('', `Warning: ${w}`);
  return out.join('\n');
}

export function main(argv, io = { log: console.log, err: console.error }) {
  const o = { dir: '.', json: false, noApp: false, appDb: '', remoteOnly: false, limit: 30 };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--json') o.json = true; else if (a === '--no-app') o.noApp = true; else if (a === '--app-db') o.appDb = argv[++k];
    else if (a === '--remote-only') o.remoteOnly = true; else if (a === '--include-session-text') o.includeSessionText = true; else if (a === '--limit') o.limit = Number(argv[++k]);
    else if (a === '-h' || a === '--help') { io.log('Usage: conductor-workspaces [repo-dir] [--json] [--no-app] [--app-db <path>] [--remote-only] [--limit <n>] [--include-session-text]'); return 0; }
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`); else o.dir = a;
  }
  const dir = path.resolve(o.dir);
  if (git(dir, ['rev-parse', '--show-toplevel']) === null) { io.err(`${dir} is not a git repository.`); return 2; }
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const mainRoot = common && path.basename(common) === '.git' ? path.dirname(common) : git(dir, ['rev-parse', '--show-toplevel']);
  const r = collect(mainRoot, o);
  io.log(o.json ? JSON.stringify(r, null, 2) : render(r));
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(`conductor-workspaces: ${e.message}`); process.exitCode = 1; } }
