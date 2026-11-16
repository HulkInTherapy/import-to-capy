#!/usr/bin/env node
// import-to-capy: bring Conductor workspaces and T3 Code threads into Capy as real threads. Read-only on the source.
//
//   import-to-capy ready     [--json]                                         which apps are here, this computer's name
//   import-to-capy questions --source conductor|t3code [--project <name>]   choices for Capy's question card (JSON)
//   import-to-capy select    --source ... "<answer>" [--json]               resolve an answer ("latest 3 threads"), print the preview
//   import-to-capy prepare   --source ... --threads a,b --consent [--json]  per thread: repo, branch, folder, a continuation prompt,
//                                                                            redacted handoff + transcript files (for Capy's thread.create)
//   import-to-capy remember  --key <owner/repo|folder:/path> --project <name>   remember where a repo with no Capy project goes
//   import-to-capy native    --source ... (--threads a,b | --answer "...") [--open] [--json]   steps for Capy's own Import (optional)
//   import-to-capy export    --source ... (--threads a,b | --answer "...") --consent [--transcripts]       handoff files only
//   import-to-capy setup     --source t3code --project <name>               T3 Code project scripts -> .capy/setup.json
//   import-to-capy detect | scan | pick                                      which apps are here; numbered menu; a local picker page
//   Advanced (automation, needs a Capy API key; not used by the plugin's default flow):
//   import-to-capy login [--wait] | plan | import --source ... --threads a,b --consent [--project <name> --remember]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { menu, parseSelection, preview } from './select.mjs';
import { t3Catalog, t3Messages, t3Setup, conductorCatalog, conductorMessages, detect, t3DefaultDb, conductorDefaultDb } from './sources.mjs';
import { buildHandoff, buildTranscript, continuePrompt, slug, outputDir } from './handoff.mjs';
import { startPicker } from './picker.mjs';
import { nativePlan, formatNativeSteps, openImport, IMPORT_DEEP_LINK } from './capy-native.mjs';
import { apiKey, client, continueThread, deviceIdFor, ImportStop, SAVE_KEY_HELP, planImport, loadChoices, rememberChoice } from './capy-api.mjs';
import { startLogin, startLoginInBackground, saveKey } from './login.mjs';
import { gitRepos } from './capy-native.mjs';
import { execFileSync } from 'node:child_process';

export const SOURCES = { conductor: 'Conductor', t3code: 'T3 Code' };

export function loadCatalog(source, opts = {}) {
  if (source === 't3code') return t3Catalog({ db: opts.db || t3DefaultDb(opts.home), home: opts.home, native: opts.native !== false });
  if (source === 'conductor') return conductorCatalog({ db: opts.db || conductorDefaultDb(opts.home), home: opts.home, native: opts.native !== false });
  throw new Error(`Unknown source "${source}". Use conductor or t3code.`);
}

export function setupSummary(source, p) {
  if (source === 't3code') { const s = t3Setup(p.scripts); return s.empty ? 'no project scripts to convert' : s.report.join('; '); }
  return 'setup converted from its Conductor scripts';
}

export function exportThreads(source, cat, threadIds, { consent = false, transcripts = false, out, db, home } = {}) {
  if (!consent) throw new Error('Reading chats needs the user\'s consent. Ask once, then pass --consent.');
  const dir = outputDir(out);
  const results = [];
  let redacted = 0;
  for (const p of cat.projects) {
    for (const t of p.threads.filter((x) => threadIds.includes(x.id))) {
      const meta = { ...t, source: cat.source, projectName: p.name, projectPath: p.path };
      const msgs = source === 't3code' ? t3Messages(t.id, { db: db || t3DefaultDb(home) }) : conductorMessages(t, { db: db || conductorDefaultDb(home) });
      const h = buildHandoff(meta, msgs);
      const base = `${slug(p.name)}--${slug(t.title)}-${String(t.id).slice(0, 6)}`;
      const handoffPath = path.join(dir, `${base}.handoff.md`);
      fs.writeFileSync(handoffPath, h.markdown);
      let transcriptPath = '';
      redacted += h.redacted;
      if (transcripts) { const tr = buildTranscript(meta, msgs); transcriptPath = path.join(dir, `${base}.transcript.md`); fs.writeFileSync(transcriptPath, tr.markdown); redacted += tr.redacted; }
      const prompt = continuePrompt(meta, h.markdown);
      results.push({ project: p.name, projectPath: p.path, thread: t.title, threadId: t.id, branch: t.branch, messages: msgs.length,
        handoffPath, transcriptPath, native: t.native ? { kind: t.native.kind, id: t.native.id } : null, redacted: h.redacted,
        capyLink: `https://capy.ai/new?prompt=${encodeURIComponent(prompt)}` });
    }
  }
  return { dir, threads: results, redacted };
}

export function summary(res) {
  const L = [`Last resort: wrote ${res.threads.length} handoff summary file(s), not the real conversations. In ${res.dir} (git ignores this folder). Secrets redacted: ${res.redacted}.`];
  for (const r of res.threads) L.push(`- ${r.project} / "${r.thread}": ${r.messages} messages${r.native ? `; it has a ${r.native.kind} session file, so prefer Capy's own import (import-to-capy native)` : ''}\n  Start a summary thread in Capy: ${r.capyLink}`);
  return L.join('\n');
}

const git = (dir, ...args) => { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
export function computerName() {
  if (process.platform === 'darwin') { try { return execFileSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* fall through */ } }
  return os.hostname();
}

// The default path: everything Capy's own agent needs to create each thread with its built-in thread.create tool.
// Writes a redacted handoff and the full redacted transcript per thread under ~/.capy-import/<source>/ (outside every
// repository, readable by the new thread on this same computer) and returns a short continuation prompt for each.
export function prepareThreads(source, cat, threadIds, { home = os.homedir(), db, out } = {}) {
  const dir = outputDir(out || path.join(home, '.capy-import', slug(cat.source)));
  const remembered = loadChoices(home);
  const threads = [];
  let redacted = 0;
  for (const p of cat.projects) {
    for (const t of p.threads.filter((x) => threadIds.includes(x.id))) {
      const meta = { ...t, source: cat.source, projectName: p.name, projectPath: p.path };
      const msgs = source === 't3code' ? t3Messages(t.id, { db: db || t3DefaultDb(home) }) : conductorMessages(t, { db: db || conductorDefaultDb(home) });
      const h = buildHandoff(meta, msgs);
      const tr = buildTranscript(meta, msgs);
      const base = `${slug(p.name)}--${slug(t.title)}-${String(t.id).slice(0, 6)}`;
      const handoffPath = path.join(dir, `${base}.handoff.md`);
      const transcriptPath = path.join(dir, `${base}.transcript.md`);
      fs.writeFileSync(handoffPath, h.markdown, { mode: 0o600 });
      fs.writeFileSync(transcriptPath, tr.markdown, { mode: 0o600 });
      redacted += h.redacted + tr.redacted;
      const worktree = [t.worktree, t.path].find((d) => d && fs.existsSync(d)) || '';
      const repo = worktree ? gitRepos(worktree)[0] || '' : '';
      const branch = t.branch || (worktree && git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')) || '';
      const uncommitted = worktree ? (git(worktree, 'status', '--porcelain') || '').split('\n').filter(Boolean).length : 0;
      const branchOnOrigin = !!(worktree && branch && branch !== 'HEAD' && git(worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`));
      const key = repo || `folder:${p.path}`;
      const prompt = [`Continuing "${t.title}", imported from ${cat.source}${branch && branch !== 'HEAD' ? ` (branch \`${branch}\`)` : ''}.`,
        worktree ? `The original work is on this computer in ${worktree}${uncommitted ? ` with ${uncommitted} uncommitted file(s) (\`git -C ${worktree} status\`)` : ''}; leave that folder as it is.` : '',
        `Read the handoff at ${handoffPath}, and the full redacted transcript at ${transcriptPath} where you need detail.`,
        'Then tell me in a few lines where it stands and wait for my go-ahead before changing code.'].filter(Boolean).join(' ');
      threads.push({ id: t.id, title: t.title, from: p.name, fromFolder: p.path, repo, key, rememberedProject: remembered[key.toLowerCase()] || remembered[key] || null,
        branch: branch === 'HEAD' ? '' : branch, branchOnOrigin, worktree, uncommitted, handoffPath, transcriptPath, prompt, redacted: h.redacted + tr.redacted });
    }
  }
  return { source: cat.source, computerName: computerName(), dir, threads, redacted };
}

// Plain-language phrase for the selection parser from the question-card answers.
export const SCOPES = ['Latest 3 threads (recommended)', 'Last 7 days', 'Last used project', 'Everything', 'Let me pick threads'];
export function answerPhrase({ project, scope } = {}) {
  const proj = !project || /^all projects/i.test(project) ? '' : `project ${project} `;
  const sc = { [SCOPES[0]]: 'latest 3 threads', [SCOPES[1]]: 'last 7 days', [SCOPES[2]]: 'last used', [SCOPES[3]]: 'everything' }[scope] ?? String(scope || '');
  return (proj + sc).trim() || 'default';
}

// The question cards the skill asks, one at a time, with ready-made options (labels carry no chat text).
export function questions(cat, { project } = {}) {
  const live = (p) => p.threads.filter((t) => !t.archived);
  const top = cat.projects.filter((p) => live(p).length).slice(0, 4);
  const label = (p) => `${p.name} · ${live(p).length} thread${live(p).length === 1 ? '' : 's'} · last used ${fmtDay(p.lastUsed)}`;
  const out = { source: cat.source,
    project: { question: `Which ${cat.source} project?`, options: [...top.map(label), 'All projects'], values: [...top.map((p) => p.name), 'All projects'] },
    threads: { question: 'Which threads?', options: SCOPES } };
  // One card that answers project and threads together, so most imports need only this card and the confirm.
  const plural = (n) => `${n} thread${n === 1 ? '' : 's'}`;
  out.what = { question: `What should I bring over from ${cat.source}?`,
    options: [...top.slice(0, 3).map((x, k) => `${x.name}: latest ${plural(Math.min(3, live(x).length))}${k === 0 ? ' (recommended)' : ''}`), 'Everything from the last 7 days', 'Let me pick threads'],
    values: [...top.slice(0, 3).map((x) => `project ${x.name} latest 3 threads`), 'last 7 days', 'pick'] };
  const when = (d) => Date.parse(String(d || '').replace(' ', 'T')) || 0;
  const latest = cat.projects.flatMap((x) => live(x).map((t) => ({ x, t }))).sort((a, b) => when(b.t.updatedAt) - when(a.t.updatedAt)).slice(0, 12);
  out.pickAny = { question: 'Which threads? (pick any)', multiple: true, options: latest.map(({ x, t }) => `${x.name} / ${t.title} · ${fmtDay(t.updatedAt)}`), values: latest.map(({ t }) => t.id) };
  const p = project && cat.projects.find((x) => x.name === project || x.id === project);
  if (p) out.pick = { question: `Which ${p.name} threads? (pick any)`, multiple: true, options: live(p).slice(0, 10).map((t) => `${t.title} · ${fmtDay(t.updatedAt)}${t.native ? '' : ' · no session file'}`), values: live(p).slice(0, 10).map((t) => t.id) };
  return out;
}
const fmtDay = (d) => { const t = Date.parse(String(d || '').replace(' ', 'T') + (String(d).includes('T') || /Z$/.test(String(d)) ? '' : 'Z')); return t ? new Date(t).toUTCString().slice(5, 11) : 'unknown'; };

function args(argv) {
  const o = { _: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('--')) { const key = a.slice(2); const nxt = argv[k + 1]; if (nxt === undefined || nxt.startsWith('--')) o[key] = true; else { o[key] = nxt; k++; } }
    else o._.push(a);
  }
  return o;
}

export async function main(argv, io = { log: console.log, err: console.error }, deps = {}) {
  const o = args(argv);
  const cmd = o._[0];
  const source = o.source === 't3' ? 't3code' : o.source;
  const opts = { db: o.db, home: o.home };
  if (!cmd || cmd === 'help' || o.help) { io.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1).filter((l, k, a) => a.slice(0, k + 1).every((x) => x.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (cmd === 'detect') { const d = detect({ home: o.home }); io.log(o.json ? JSON.stringify(d) : d.length ? `Found: ${d.map((s) => SOURCES[s]).join(', ')}` : 'Found neither Conductor nor T3 Code data on this computer.'); return 0; }
  if (cmd === 'open') { io.log(openImport(deps.run ? { run: deps.run } : {}) ? `Opened ${IMPORT_DEEP_LINK}` : `Open Capy → Settings → Import (${IMPORT_DEEP_LINK})`); return 0; }
  const home = o.home || os.homedir();
  const keyWorks = async (key) => { try { await (deps.api || client(key)).projects(); return true; } catch (e) { return e instanceof ImportStop && (e.code === 401 || e.code === 403) ? false : null; } };
  if (cmd === 'ready') {
    const r = { sources: detect({ home: o.home }), computerName: computerName(), onThisMac: !!(o.device || deviceIdFor({ home })) };
    r.next = r.sources.length ? 'Ready.' : 'Not on the computer with Conductor or T3 Code: start a thread on This Mac.';
    io.log(o.json ? JSON.stringify(r) : `${r.sources.length ? `Found: ${r.sources.map((s) => SOURCES[s]).join(', ')}` : 'Found neither Conductor nor T3 Code here.'} This computer: ${r.computerName}.`);
    return 0;
  }
  if (cmd === 'remember') {
    if (!o.key || !o.project || o.key === true || o.project === true) { io.err('Pass --key <owner/repo or folder:/path> --project <Capy project name or id>.'); return 2; }
    rememberChoice(home, [String(o.key)], String(o.project));
    io.log(`Remembered: ${o.key} → ${o.project}.`);
    return 0;
  }
  if (cmd === 'login') {
    const verify = async (k) => (await keyWorks(k)) === true;
    const start = deps.startLogin || startLogin;
    if (o.serve || o.wait) {
      const lg = await start({ verify, save: (k) => saveKey(k), open: !o['no-open'] });
      if (o.serve) io.log(lg.url); else io.err(`Paste your Capy API key at ${lg.url} (Capy → Settings → API opened too).`);
      const ok = await lg.result;
      if (!o.serve) io.log(ok ? 'Saved your Capy API key in the Keychain. Imports use it from now on.' : 'Timed out; run login again.');
      return ok ? 0 : 3;
    }
    const existing = 'key' in deps ? deps.key : apiKey();
    if (existing && !o.force && (await keyWorks(existing)) === true) { io.log('Already connected: your Capy API key is in the Keychain.'); return 0; }
    const url = await (deps.startLoginInBackground || startLoginInBackground)();
    io.log(`Opened Capy → Settings → API and a page on this Mac where you paste the key once (${url}). It goes into your Keychain, nowhere else. When it says Connected, run: import-to-capy ready --json`);
    return 0;
  }
  if (!SOURCES[source]) { io.err('Pass --source conductor or --source t3code.'); return 2; }
  const cat = loadCatalog(source, opts);
  if (cmd === 'scan') {
    if (o.json) io.log(JSON.stringify({ source: cat.source, projects: cat.projects.map((p) => ({ id: p.id, name: p.name, path: p.path, lastUsed: p.lastUsed, threads: p.threads.length, open: p.threads.filter((t) => !t.archived).length })) }, null, 2));
    else io.log(`${cat.source}: ${cat.projects.length} project(s)\n${menu(cat)}\n\nReply with numbers, names, "everything", or e.g. "latest 3 threads", "last 7 days", "only unfinished". Just say "go" for your most recent project's latest 3 threads.`);
    return 0;
  }
  if (cmd === 'select') {
    const sel = parseSelection(o._.slice(1).join(' '), cat);
    if (sel.needsClarification) { io.log(o.json ? JSON.stringify(sel) : sel.question); return 0; }
    io.log(o.json ? JSON.stringify({ ...sel, preview: preview(cat, sel, { setupFor: (p) => setupSummary(source, p) }) }, null, 2) : preview(cat, sel, { setupFor: (p) => setupSummary(source, p) }));
    return 0;
  }
  if (cmd === 'pick') {
    const pk = await startPicker(cat, { open: !o['no-open'], timeoutMs: Number(o.timeout || 600) * 1000 });
    io.err(`Picker open at ${pk.url} (one-time link; closes after Import or ${Number(o.timeout || 600)}s).`);
    const sel = await pk.result;
    io.log(JSON.stringify(sel ? { ...sel, preview: preview(cat, { ...sel, explain: sel.explain }, { setupFor: (p) => setupSummary(source, p) }) } : { method: 'picker', timedOut: true }));
    return sel ? 0 : 3;
  }
  if (cmd === 'setup') {
    const p = cat.projects.find((x) => x.id === o.project || x.name === o.project) || (o.project ? null : cat.projects[0]);
    if (!p) { io.err(`No project ${o.project}.`); return 2; }
    if (source !== 't3code') { io.err('For Conductor, run conductor-to-capy (same package) in the repository.'); return 2; }
    const s = t3Setup(p.scripts);
    io.log(JSON.stringify({ project: p.name, path: p.path, setup: s.setup, report: s.report, empty: s.empty }, null, 2));
    return 0;
  }
  if (cmd === 'questions') { io.log(JSON.stringify(questions(cat, { project: o.project }), null, 2)); return 0; }
  const idsFrom = () => {
    if (o.threads) return String(o.threads).split(',').map((x) => x.trim()).filter(Boolean);
    const sel = parseSelection(o.answer === true || o.answer === undefined ? '' : o.answer, cat);
    if (sel.needsClarification) { io.err(sel.question); return null; }
    return sel.threadIds;
  };
  if (cmd === 'native') {
    const ids = idsFrom(); if (!ids) return 2;
    let projects = null;
    const key = o['no-api'] ? null : deps.api ? 'injected' : apiKey();
    if (key) { try { projects = await (deps.api || client(key)).projects(); } catch { projects = null; } }
    const plan = nativePlan(cat, ids, { home: o.home, projects });
    const opened = o.open && plan.groups.length ? openImport(deps.run ? { run: deps.run } : {}) : false;
    const steps = formatNativeSteps(plan, { projectsKnown: !!projects, opened });
    io.log(o.json ? JSON.stringify({ ...plan, opened, steps }, null, 2) : steps
      + (plan.missing.length ? `\n\nNo session file on this computer for: ${plan.missing.map((m) => `${m.project} / ${m.thread}`).join('; ')}.` : '')
      + (o.open && !opened && plan.groups.length ? `\n(Couldn't open ${IMPORT_DEEP_LINK} here; open Capy → Settings → Import yourself.)` : ''));
    return 0;
  }
  if (cmd === 'prepare') {
    const ids = idsFrom(); if (!ids) return 2;
    if (!o.consent) { io.err('Reading chats needs the user\'s consent. Ask once, then pass --consent.'); return 2; }
    const res = prepareThreads(source, cat, ids, { home, db: o.db, out: o.out });
    io.log(o.json ? JSON.stringify(res, null, 2) : res.threads.map((t) => `- ${t.from} / "${t.title}" (${t.repo || 'no remote'}${t.branch ? `, ${t.branch}` : ''}): ${t.transcriptPath}`).join('\n'));
    return 0;
  }
  if (cmd === 'plan') {
    const ids = idsFrom(); if (!ids) return 2;
    const key = deps.api ? 'injected' : 'key' in deps ? deps.key : apiKey();
    if (!key) { io.err(SAVE_KEY_HELP); return 4; }
    const plan = planImport(cat, ids, await (deps.api || client(key)).projects(), { remembered: loadChoices(home), deviceId: o.device || deviceIdFor({ home }) });
    io.log(o.json ? JSON.stringify(plan, null, 2) : [...plan.threads.map((t) => `- ${t.from} / "${t.title}" → ${t.capyProject || `no Capy project for ${t.repo || 'its repository'}`}`),
      ...plan.missing.map((m) => `No Capy project uses ${m.repo} (${m.threads.length} thread(s)). Pick one of: ${plan.capyProjects.join(', ')}; or create it at ${plan.createProjectUrl}.`)].join('\n'));
    return 0;
  }
  if (cmd === 'continue' || cmd === 'import') {
    const ids = idsFrom(); if (!ids) return 2;
    if (!o.consent) { io.err('Reading chats needs the user\'s consent. Ask once, then pass --consent.'); return 2; }
    const key = deps.api ? 'injected' : 'key' in deps ? deps.key : apiKey();
    if (!key && !o['dry-run']) { io.err(SAVE_KEY_HELP); return 4; }
    const api = o['dry-run'] ? dryClient(io) : (deps.api || client(key));
    const projects = await api.projects();
    const deviceId = o.device || deviceIdFor({ home: o.home || os.homedir() });
    const results = [];
    for (const p of cat.projects) for (const t of p.threads.filter((x) => ids.includes(x.id))) {
      const meta = { ...t, source: cat.source, projectName: p.name, projectPath: p.path };
      const msgs = source === 't3code' ? t3Messages(t.id, { db: o.db || t3DefaultDb(o.home) }) : conductorMessages(t, { db: o.db || conductorDefaultDb(o.home) });
      try {
        const r = await continueThread(api, { thread: meta, source: cat.source, handoff: buildHandoff(meta, msgs), transcript: buildTranscript(meta, msgs), projects, project: o.project, remembered: loadChoices(home), deviceId, workspace: o.workspace });
        if (o.remember && o.project && !o['dry-run']) rememberChoice(home, r.repos, r.projectId);
        results.push({ thread: t.title, ...r });
      } catch (e) {
        if (!(e instanceof ImportStop)) throw e;
        results.push({ thread: t.title, stopped: e.message, code: e.code });
        if (e.code === 'no-project' || e.code === 'home') break;
      }
    }
    io.log(o.json ? JSON.stringify(results, null, 2) : results.map((r) => (r.stopped ? `- "${r.thread}": not imported. ${r.stopped}`
      : `- "${r.thread}" → ${r.projectName}${r.onDevice ? `, on this computer in ${r.worktree}` : ''} (thread ${r.threadId}; ${r.redacted} secret(s) redacted)`)).join('\n')
      + (results.some((r) => r.threadId) ? '\nThey are in Capy now, under their projects (capy.ai/threads).' : ''));
    return results.some((r) => r.stopped) ? 5 : 0;
  }
  if (cmd === 'export') {
    let ids = o.threads ? String(o.threads).split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!ids) { const sel = parseSelection(o.answer === true ? '' : o.answer || '', cat); if (sel.needsClarification) { io.err(sel.question); return 2; } ids = sel.threadIds; }
    const res = exportThreads(source, cat, ids, { consent: !!o.consent, transcripts: !!o.transcripts, out: o.out, db: o.db, home: o.home });
    io.log(o.json ? JSON.stringify(res, null, 2) : summary(res));
    return 0;
  }
  io.err(`Unknown command ${cmd}`); return 2;
}

// --dry-run: prints what would be sent, sends nothing.
function dryClient(io) {
  return {
    projects: async () => [],
    createThread: async (b) => { io.err(`[dry-run] POST /threads project=${b.projectId} device=${b.device ? b.device.workspace.kind : 'none'} message=${b.message.length} chars`); return { id: 'jam_DRYRUN' }; },
    upload: async (name, content) => { io.err(`[dry-run] POST /files ${name} (${Buffer.byteLength(content)} bytes)`); return { fileId: 'file_DRYRUN', name }; },
    send: async () => ({}),
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`import-to-capy: ${e.message}`); process.exitCode = 1; });
