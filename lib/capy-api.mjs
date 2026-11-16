// Fallback for threads that have no Claude Code / Codex session file (so Capy's own import can't bring them):
// create a continuation thread through Capy's public API (https://api.capy.ai, docs.capy.ai/api) in the Capy
// project for the workspace's repository, on the user's own computer at the original worktree, with a redacted
// handoff as the first message and the full redacted transcript attached as a file.
//
// The API key comes from CAPY_API_KEY or the macOS Keychain item "import-to-capy" (never a file, never chat).
// Never the Home project unless the user asks for it (--project home).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectFor, projectRepos, gitRepos } from './capy-native.mjs';

export const API_BASE = 'https://api.capy.ai/api/v1';
export const KEYCHAIN_SERVICE = 'import-to-capy';
export const SAVE_KEY_HELP = `Create a key in Capy → Settings → API, then run this once in Terminal and paste the key when asked (it goes into your Keychain, not a file):\n  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a capy -w`;
export const NEW_PROJECT_HELP = (repo) => `No Capy project uses ${repo} yet. Create one: Capy → Settings → Projects & setup (capy.ai/settings/projects) → create a project with the ${repo} repository. Then say "continue" and I'll import into it.`;

export class ImportStop extends Error { constructor(message, code) { super(message); this.code = code; } }

export function apiKey({ env = process.env, run = execFileSync, platform = process.platform } = {}) {
  if (env.CAPY_API_KEY) return env.CAPY_API_KEY.trim();
  if (platform !== 'darwin') return null;
  try { return String(run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim() || null; } catch { return null; }
}

// The desktop app records which device it paired as, per organization (no secrets in this file).
export function deviceIdFor({ home = os.homedir(), orgId } = {}) {
  const f = path.join(home, 'Library', 'Application Support', 'Capy', 'device-ids.json');
  let d;
  try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  const orgs = d?.orgs || {};
  if (orgId && orgs[orgId]) return orgs[orgId];
  const ids = [...new Set(Object.values(orgs))];
  return ids.length === 1 ? ids[0] : null;
}

export function client(key, { base = API_BASE, fetchImpl = globalThis.fetch } = {}) {
  const call = async (method, p, body) => {
    const res = await fetchImpl(`${base}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; } })() : {};
    if (!res.ok) throw new ImportStop(`Capy API ${method} ${p} answered ${res.status}: ${data?.message || data?._tag || data?.raw || ''}`.trim(), res.status);
    return data;
  };
  return {
    projects: async () => (await call('GET', '/projects')).items || [],
    createThread: (body) => call('POST', '/threads', body),
    send: (threadId, body) => call('POST', `/threads/${threadId}/message`, body),
    upload: async (name, content, mediaType = 'text/markdown') => {
      const bytes = Buffer.from(content, 'utf8');
      const { targets } = await call('POST', '/files', { files: [{ name, mediaType, sizeBytes: bytes.length }] });
      const t = targets[0];
      const put = await fetchImpl(t.url, { method: 'PUT', headers: { 'Content-Type': mediaType, 'Content-Length': String(bytes.length) }, body: bytes });
      if (!put.ok) throw new ImportStop(`Upload of ${name} failed: ${put.status}`, put.status);
      return { fileId: t.fileId, name };
    },
  };
}

// Which Capy project a picked thread belongs to: the project whose repositories include the workspace's git remote.
export function resolveProject(projects, repos, { project } = {}) {
  if (project) {
    const p = projects.find((x) => x.id === project || x.name.toLowerCase() === String(project).toLowerCase() || x.code?.toLowerCase() === String(project).toLowerCase());
    if (!p) throw new ImportStop(`There is no Capy project called "${project}".`, 'no-project');
    return p;
  }
  if (!repos.length) throw new ImportStop('This workspace has no GitHub remote, so I can\'t tell which Capy project it belongs to. Name a project (or "home").', 'no-remote');
  const p = projectFor(repos, projects);
  if (!p) throw new ImportStop(NEW_PROJECT_HELP(repos[0]), 'no-project');
  return p;
}

export function firstMessage({ thread, source, handoff, worktree }) {
  return [`Continuing "${thread.title}" imported from ${source}${thread.branch ? ` (branch \`${thread.branch}\`)` : ''}.`,
    worktree ? `The work is in ${worktree} on this computer, exactly as it was left; uncommitted files are the user's, keep them.` : '',
    'The full redacted transcript is attached as a file in the next message. Read the handoff below (and the transcript where you need detail), check git status, then tell me in a few lines where it stands and wait for my go-ahead before changing code.',
    '', handoff].filter((x) => x !== '').join('\n');
}

// One continuation thread. `api` is a client(); returns { threadId, projectName, redacted }.
export async function continueThread(api, { thread, source, handoff, transcript, projects, project, deviceId, workspace = 'linked', home = os.homedir() }) {
  const worktree = [thread.worktree, thread.path].find((d) => d && fs.existsSync(d)) || '';
  const repos = worktree ? gitRepos(worktree) : [];
  const proj = resolveProject(projects, repos, { project });
  if (proj.name === 'Home' && !project) throw new ImportStop('Refusing to use the Home project unless you ask for it.', 'home');
  const body = { requestId: `import-to-capy:${source}:${thread.id}`.slice(0, 191), projectId: proj.id, title: thread.title,
    message: firstMessage({ thread, source, handoff: handoff.markdown, worktree }) };
  if (deviceId && worktree) {
    body.device = { deviceId, workspace: workspace === 'worktree' && repos[0]
      ? { kind: 'worktree', repos: [repos[0]], ...(thread.branch ? { base: { [repos[0]]: thread.branch } } : {}) }
      : { kind: 'linked', root: worktree } };
  }
  const created = await api.createThread(body);
  const file = await api.upload(`${String(thread.title || 'thread').replace(/[^\w.-]+/g, '-').slice(0, 60)}.transcript.md`, transcript.markdown);
  await api.send(created.id, { text: `Full redacted transcript of "${thread.title}" from ${source} (${transcript.redacted} secret(s) redacted).`, files: [file], delivery: 'steer',
    clientKey: `import-to-capy-transcript-${String(thread.id).slice(0, 40)}` });
  return { threadId: created.id, projectId: proj.id, projectName: proj.name, onDevice: !!body.device, worktree, repos, redacted: handoff.redacted + transcript.redacted, home };
}

export { projectRepos };
