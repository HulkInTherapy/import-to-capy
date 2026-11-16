// Real continuations through Capy's own importer.
//
// Capy's desktop app imports local Claude Code and Codex sessions as real threads, with their history,
// into the Capy project for each session's repository (Settings → Import, deep link capy://app/settings/import).
// Conductor and T3 Code run Claude Code and Codex underneath, so their chats are already such sessions:
//   Conductor: sessions.claude_session_id  → ~/.claude/projects/<encoded cwd>/<id>.jsonl
//   T3 Code:   provider thread nativeId     → ~/.claude/projects/**/<id>.jsonl or ~/.codex/sessions/**/rollout-*<id>.jsonl
// This module finds the exact session files for the threads the user picked and reads only what Capy's
// importer shows for them (title, dates, folder, branch, repository), so the user can tick exactly those.
// It never reads message bodies beyond the first prompt line Capy itself uses as the title.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

export const IMPORT_DEEP_LINK = 'capy://app/settings/import';
export const IMPORT_WEB_PATH = 'Settings → Import → Import history';
export const APP_NAME = { 'claude-code': 'Claude Code', codex: 'Codex' };
const HEAD_BYTES = 1048576; // what Capy reads to title a Claude Code session
const HEAD_LINES = 64;

export const claudeRoot = (home = os.homedir(), env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
export const codexRoot = (home = os.homedir(), env = process.env) => env.CODEX_HOME || path.join(home, '.codex');
// Claude Code names a project folder after the cwd with every non-alphanumeric character turned into "-".
export const encodeClaudeDir = (cwd) => String(cwd || '').replace(/[^A-Za-z0-9]/g, '-');

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    let text = buf.subarray(0, n).toString('utf8');
    const limited = n === bytes;
    if (limited) text = text.slice(0, Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1);
    return { text, limited };
  } finally { fs.closeSync(fd); }
}
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const str = (v) => (typeof v === 'string' && v.trim() ? v : undefined);

// Capy's title for a Claude Code session: a custom or AI title line, else the first line of the first real prompt (60 chars).
export function claudePromptTitle(line) {
  if (!line || line.type !== 'user' || line.isMeta === true || line.isSidechain === true) return undefined;
  const c = line.message?.content;
  const parts = Array.isArray(c) ? c.filter((x) => x && typeof x === 'object') : [];
  if (parts.some((p) => p.type === 'tool_result')) return undefined;
  const text = (typeof c === 'string' ? c : parts.flatMap((p) => (p.type === 'text' ? [str(p.text) || ''] : [])).join('\n'))
    .replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, '').trim().split('\n')[0].replace(/^#+\s*/, '').trim();
  if (!text || text.startsWith('Caveat: ') || text.startsWith('[Request interrupted')) return undefined;
  return text.slice(0, 60);
}

export function readClaudeSession(file) {
  const base = { source: 'claude-code', sessionId: path.basename(file).replace(/\.jsonl$/, ''), path: file };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ...base, parseable: false, reason: `stat failed: ${e.code || e.message}` }; }
  const { text, limited } = readHead(file, HEAD_BYTES);
  const lines = text.split(/\r\n|\n|\r/, HEAD_LINES + 1);
  let chain; let title;
  for (const raw of lines.slice(0, HEAD_LINES)) {
    if (!raw.trim()) continue;
    const l = json(raw.trim()); if (!l) continue;
    const named = l.type === 'custom-title' ? str(l.customTitle) : l.type === 'ai-title' ? str(l.aiTitle) : undefined;
    if (named !== undefined && chain !== undefined) { title = named; break; }
    if (typeof l.uuid === 'string') { chain ??= l; title ??= claudePromptTitle(l); }
  }
  const out = { ...base, bytes: st.size, endedAt: st.mtime.toISOString() };
  if (!chain) return { ...out, parseable: false, reason: limited || lines.length >= HEAD_LINES ? 'no conversation line near the start' : 'no conversation lines' };
  return { ...out, parseable: true, cwd: str(chain.cwd), gitBranch: str(chain.gitBranch), startedAt: str(chain.timestamp), title: title || 'Untitled session' };
}

// Capy lists Codex sessions whose session_meta.source is one of these; others count as non-interactive and are skipped.
const CODEX_INTERACTIVE = new Set(['cli', 'vscode', 'custom:atlas', 'custom:chatgpt']);
function codexKind(meta) {
  const s = meta.source;
  const name = s === undefined ? 'vscode' : typeof s === 'string' ? s : s?.custom ? `custom:${s.custom}` : s?.subagent ? 'subagent' : 'internal';
  if (meta.thread_source === 'subagent' || s?.subagent !== undefined) return 'subagent';
  return CODEX_INTERACTIVE.has(name) ? 'main' : 'non-interactive';
}
function codexTitle(text) {
  for (const raw of text.split('\n').slice(1, HEAD_LINES)) {
    const l = json(raw.trim()); const p = l?.payload;
    if (l?.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') continue;
    const t = (Array.isArray(p.content) ? p.content : []).flatMap((c) => (c?.type === 'input_text' ? [str(c.text) || ''] : [])).join('\n')
      .trim().replace(/<[a-z_-]+>[\s\S]*?<\/[a-z_-]+>/g, '').trim().split('\n')[0].replace(/^#+\s*/, '').trim();
    if (t && !t.startsWith('AGENTS.md instructions') && !t.startsWith('<')) return t.slice(0, 60);
  }
  return undefined;
}
export function readCodexSession(file, { names = new Map() } = {}) {
  const base = { source: 'codex', sessionId: '', path: file };
  let st;
  try { st = fs.statSync(file); } catch (e) { return { ...base, parseable: false, reason: `stat failed: ${e.code || e.message}` }; }
  if (file.endsWith('.zst')) return { ...base, parseable: false, reason: 'compressed rollout (Capy reads it; this tool does not)' };
  const { text } = readHead(file, 262144);
  const first = json(text.split('\n')[0]);
  if (first?.type !== 'session_meta' || !str(first.payload?.id)) return { ...base, parseable: false, reason: 'first line is not session_meta' };
  const m = first.payload;
  return { ...base, sessionId: m.id, parseable: true, kind: codexKind(m), bytes: st.size, endedAt: st.mtime.toISOString(),
    cwd: str(m.cwd), gitBranch: str(m.git?.branch), gitRemote: str(m.git?.repository_url), startedAt: str(m.timestamp) || str(first.timestamp),
    title: names.get(m.id) || codexTitle(text) || 'Untitled session' };
}
function codexNames(root) {
  const names = new Map();
  try { for (const l of fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8').split('\n')) { const j = json(l.trim()); if (str(j?.id) && str(j?.thread_name)) names.set(j.id, j.thread_name); } } catch { /* no index */ }
  return names;
}

// "git@github.com:Owner/Repo.git" or "https://github.com/Owner/Repo" -> "owner/repo" (how Capy keys repositories).
export function repoSlug(url) {
  const u = String(url || '').trim().replace(/\.git$/, '');
  const p = /^[^/]+@[^/:]+:(.+)$/.exec(u)?.[1] ?? (() => { try { return new URL(u).pathname; } catch { return undefined; } })();
  const parts = (p || '').split('/').filter(Boolean);
  return parts.length < 2 ? undefined : `${parts.at(-2)}/${parts.at(-1)}`.toLowerCase();
}
export function gitRepos(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  let out = '';
  try { out = execFileSync('git', ['-C', dir, 'remote', '-v'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); } catch { return []; }
  const rows = out.split('\n').flatMap((l) => { const m = /^(\S+)\t(.+) \(fetch\)$/.exec(l); return m ? [{ name: m[1], url: m[2] }] : []; })
    .sort((a, b) => (b.name === 'origin') - (a.name === 'origin'));
  return [...new Set(rows.map((r) => repoSlug(r.url)).filter(Boolean))];
}

// ---------------------------------------------------------------- finding the files
const tsOf = (d) => (d ? Date.parse(String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(d)) || String(d).includes('T') ? '' : 'Z')) || 0 : 0);

export function findClaudeFile(id, { home, env } = {}) {
  if (!id || !/^[\w-]{8,}$/.test(id)) return null;
  const root = path.join(claudeRoot(home, env), 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f; }
  return null;
}
export function findCodexFile(id, { home, env, maxFiles = 50000 } = {}) {
  if (!id || !/^[\w-]{8,}$/.test(id)) return null;
  const root = codexRoot(home, env);
  const stack = [path.join(root, 'sessions'), path.join(root, 'archived_sessions')];
  let seen = 0;
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/^rollout-.*\.jsonl(\.zst)?$/.test(e.name) && e.name.includes(id)) return p;
    }
  }
  return null;
}

// For threads with no stored session id: the session in the Claude Code folder for `cwd` that started closest to
// the thread's creation (within a few minutes). One thread, one session; a shared folder never pulls in strangers.
const dirCache = new Map();
function sessionsInDir(dir) {
  if (!dirCache.has(dir)) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && !n.startsWith('agent-')); } catch { /* none */ }
    dirCache.set(dir, names.map((n) => readClaudeSession(path.join(dir, n))).filter((x) => x.parseable));
  }
  return dirCache.get(dir);
}
export function claudeFileByFolder(cwd, createdAt, { home, env, windowMs = 5 * 60000 } = {}) {
  const at = tsOf(createdAt);
  if (!cwd || !at) return null;
  const near = sessionsInDir(path.join(claudeRoot(home, env), 'projects', encodeClaudeDir(cwd)))
    .filter((s) => s.cwd === cwd && Math.abs(tsOf(s.startedAt) - at) <= windowMs)
    .sort((a, b) => Math.abs(tsOf(a.startedAt) - at) - Math.abs(tsOf(b.startedAt) - at));
  return near[0] || null;
}

// Every session file behind one picked Conductor workspace or T3 Code thread.
export function locateSessions(thread, { home = os.homedir(), env = process.env, codexIndex } = {}) {
  const found = new Map();
  const add = (s, match) => { if (s && s.path && !found.has(s.path)) found.set(s.path, { ...s, match }); };
  const ids = [...new Set([...(thread.nativeIds || []), thread.nativeId].filter(Boolean))];
  const codex = /codex/i.test(thread.provider || '');
  for (const id of ids) {
    if (codex) { const f = findCodexFile(id, { home, env }); if (f) add(readCodexSession(f, { names: codexIndex || codexNames(codexRoot(home, env)) }), 'id'); }
    const f = findClaudeFile(id, { home, env }); if (f) add(readClaudeSession(f), 'id');
    if (!codex && !f) { const c = findCodexFile(id, { home, env }); if (c) add(readCodexSession(c, { names: codexIndex || codexNames(codexRoot(home, env)) }), 'id'); }
  }
  if (!found.size && !codex) {
    for (const dir of [...new Set([thread.worktree, thread.path].filter(Boolean))]) {
      const s = claudeFileByFolder(dir, thread.createdAt, { home, env });
      if (s) { add(s, 'folder+time'); break; }
    }
  }
  return [...found.values()].sort((a, b) => tsOf(a.startedAt) - tsOf(b.startedAt));
}

// ---------------------------------------------------------------- the plan the user follows in Capy
// projects: optional Capy projects (GET /api/v1/projects: { id, name, repos: [{ repoFullName }] }) to say where each repository lands.
export const projectRepos = (p) => (p.repos || []).map((r) => (typeof r === 'string' ? r : r.repoFullName || r.fullName || (r.owner && r.name ? `${r.owner}/${r.name}` : r.name || '')).toLowerCase()).filter(Boolean);
export function projectFor(repos, projects) {
  if (!projects || !repos?.length) return null;
  const want = new Set(repos.map((r) => r.toLowerCase()));
  return projects.find((p) => p.name !== 'Home' && projectRepos(p).some((r) => want.has(r))) || null;
}

export function nativePlan(cat, threadIds, { home = os.homedir(), env = process.env, projects = null } = {}) {
  const codexIndex = codexNames(codexRoot(home, env));
  const groups = new Map();
  const ready = []; const missing = []; const skipped = [];
  const repoCache = new Map();
  const reposOf = (dir) => { if (!repoCache.has(dir)) repoCache.set(dir, gitRepos(dir)); return repoCache.get(dir); };
  for (const p of cat.projects) {
    for (const t of p.threads.filter((x) => threadIds.includes(x.id))) {
      const sessions = locateSessions(t, { home, env, codexIndex });
      const usable = sessions.filter((s) => s.parseable && (s.source !== 'codex' || s.kind === 'main'));
      for (const s of sessions.filter((x) => !usable.includes(x))) skipped.push({ project: p.name, thread: t.title, path: s.path, reason: s.reason || `Codex ${s.kind} session` });
      if (!usable.length) { missing.push({ project: p.name, projectPath: p.path, threadId: t.id, thread: t.title, branch: t.branch, worktree: t.worktree || t.path || '' }); continue; }
      for (const s of usable) {
        const folder = s.cwd || t.worktree || t.path || p.path || '';
        const repos = (fs.existsSync(folder) ? reposOf(folder) : []).length ? reposOf(folder) : s.gitRemote ? [repoSlug(s.gitRemote)].filter(Boolean) : reposOf(p.path);
        const key = `${s.source}\0${repos[0] || folder}`;
        if (!groups.has(key)) {
          const proj = projectFor(repos, projects);
          groups.set(key, { app: APP_NAME[s.source], source: s.source, repository: repos[0] || null, folder: repos[0] ? null : folder,
            capyProject: proj ? { id: proj.id, name: proj.name } : null, sessions: [] });
        }
        groups.get(key).sessions.push({ thread: t.title, project: p.name, title: s.title, sessionId: s.sessionId, path: s.path,
          startedAt: s.startedAt || '', endedAt: s.endedAt || '', cwd: s.cwd || '', branch: t.branch || (s.gitBranch !== 'HEAD' ? s.gitBranch : '') || '', match: s.match });
      }
      ready.push(t.id);
    }
  }
  return { deepLink: IMPORT_DEEP_LINK, groups: [...groups.values()], ready, missing, skipped };
}

const day = (d) => (d ? new Date(tsOf(d)).toISOString().slice(0, 16).replace('T', ' ') : '');
export const NEW_PROJECT_STEPS = (repo) => `Capy → Settings → **Projects & setup** → create a project with the repository **${repo}** (capy.ai/settings/projects)`;
export function formatNativeSteps(plan, { projectsKnown = false, opened = false } = {}) {
  if (!plan.groups.length) return 'None of the picked threads has a Claude Code or Codex session file on this Mac, so Capy\'s own import can\'t bring them.';
  const L = [];
  const apps = [...new Set(plan.groups.map((g) => g.app))];
  const needProject = [...new Set(plan.groups.filter((g) => g.repository && !g.capyProject).map((g) => g.repository))];
  L.push(`Capy's own import brings these over as real threads with their full history (${plan.groups.reduce((n, g) => n + g.sessions.length, 0)} session(s)), into the project for each repository:`, '');
  let step = 1;
  // With no project for a repository, Capy lists its sessions by folder and each folder would get its own new project.
  // Creating the project first keeps every session of one repository together.
  if (projectsKnown && needProject.length) L.push(`${step++}. First create the Capy project${needProject.length > 1 ? 's' : ''} (one time): ${needProject.map(NEW_PROJECT_STEPS).join('; then ')}.`);
  L.push(`${step++}. ${opened ? 'In the Capy window I just opened (Settings → Import)' : `Open Capy → ${IMPORT_WEB_PATH} (or ${IMPORT_DEEP_LINK})`}.`);
  for (const app of apps) {
    L.push(`${step++}. Click **${app}**. Open each group below (under Repositories, or Folders when it has no GitHub remote) and tick only these sessions:`);
    for (const g of plan.groups.filter((x) => x.app === app)) {
      L.push(`   - **${g.repository || path.basename(g.folder || '')}**${g.repository ? '' : ` (Folders: ${g.folder})`}`);
      for (const s of g.sessions) L.push(`     - "${s.title}" · ${day(s.endedAt)}  ← ${s.project} / ${s.thread}${s.branch ? ` (${s.branch})` : ''}`);
    }
    L.push(`${step++}. Click **Next**, check where each goes, then **Import**:`);
    for (const g of plan.groups.filter((x) => x.app === app)) {
      const dest = g.capyProject ? `"${g.capyProject.name}"` : g.repository && projectsKnown ? 'the project you just created' : g.repository
        ? 'its project under "Linked to this repository" (if there is none, cancel, create it: ' + NEW_PROJECT_STEPS(g.repository) + ', and reopen Import)'
        : 'the project you want (Home only if you mean it)';
      L.push(`   - ${g.repository || g.folder} → ${dest}`);
    }
  }
  L.push('', 'Your original sessions stay where they are, and Conductor and T3 Code keep working. Each imported thread opens in its project with the whole conversation, ready to continue.');
  return L.join('\n');
}

// Opens Capy's Import page in the desktop app (macOS `open`, Linux `xdg-open`, Windows `start`).
export function openImport({ run = spawn, platform = process.platform } = {}) {
  const [cmd, args] = platform === 'darwin' ? ['open', [IMPORT_DEEP_LINK]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', IMPORT_DEEP_LINK]] : ['xdg-open', [IMPORT_DEEP_LINK]];
  try { const p = run(cmd, args, { stdio: 'ignore', detached: true }); p.on?.('error', () => {}); p.unref?.(); return true; } catch { return false; }
}
