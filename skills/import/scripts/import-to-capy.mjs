#!/usr/bin/env node
// import-to-capy: bring Conductor workspaces and T3 Code threads into Capy as real threads. Read-only on the source.
//
//   import-to-capy detect [--json]
//   import-to-capy questions --source conductor|t3code [--project <name>]   choices for Capy's question card (JSON)
//   import-to-capy scan      --source ... [--json]                          numbered menu of projects
//   import-to-capy select    --source ... "<answer>" [--json]               resolve an answer ("latest 3 threads"), print the preview
//   import-to-capy native    --source ... (--threads a,b | --answer "...") [--open] [--json]   steps for Capy's own import
//   import-to-capy continue  --source ... --threads a,b --consent [--project <name|home>] [--dry-run]   API fallback
//   import-to-capy export    --source ... (--threads a,b | --answer "...") --consent [--transcripts]       handoff files only
//   import-to-capy setup     --source t3code --project <name>               T3 Code project scripts -> .capy/setup.json
//   import-to-capy pick      --source ... [--no-open]                       terminal users: a local picker page
//
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { menu, parseSelection, preview } from './select.mjs';
import { t3Catalog, t3Messages, t3Setup, conductorCatalog, conductorMessages, detect, t3DefaultDb, conductorDefaultDb } from './sources.mjs';
import { buildHandoff, buildTranscript, continuePrompt, slug, outputDir } from './handoff.mjs';
import { startPicker } from './picker.mjs';
import { nativePlan, formatNativeSteps, openImport, IMPORT_DEEP_LINK } from './capy-native.mjs';
import { apiKey, client, continueThread, deviceIdFor, ImportStop, SAVE_KEY_HELP } from './capy-api.mjs';

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
  if (!cmd || cmd === 'help' || o.help) { io.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (cmd === 'detect') { const d = detect({ home: o.home }); io.log(o.json ? JSON.stringify(d) : d.length ? `Found: ${d.map((s) => SOURCES[s]).join(', ')}` : 'Found neither Conductor nor T3 Code data on this computer.'); return 0; }
  if (cmd === 'open') { io.log(openImport(deps.run ? { run: deps.run } : {}) ? `Opened ${IMPORT_DEEP_LINK}` : `Open Capy → Settings → Import (${IMPORT_DEEP_LINK})`); return 0; }
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
  if (cmd === 'continue') {
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
        const r = await continueThread(api, { thread: meta, source: cat.source, handoff: buildHandoff(meta, msgs), transcript: buildTranscript(meta, msgs), projects, project: o.project, deviceId, workspace: o.workspace });
        results.push({ thread: t.title, ...r });
      } catch (e) {
        if (!(e instanceof ImportStop)) throw e;
        results.push({ thread: t.title, stopped: e.message, code: e.code });
        if (e.code === 'no-project' || e.code === 'home') break;
      }
    }
    io.log(o.json ? JSON.stringify(results, null, 2) : results.map((r) => (r.stopped ? `- "${r.thread}": not imported. ${r.stopped}`
      : `- "${r.thread}" → ${r.projectName}${r.onDevice ? `, on this computer in ${r.worktree}` : ''} (thread ${r.threadId}; ${r.redacted} secret(s) redacted)`)).join('\n'));
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
