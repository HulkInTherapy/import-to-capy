#!/usr/bin/env node
// import-to-capy: bring Conductor or T3 Code projects and threads into Capy. Read-only on the source.
//
//   import-to-capy detect
//   import-to-capy scan    --source conductor|t3code [--json]           numbered menu of projects
//   import-to-capy select  --source ... "<plain-language answer>"        resolve an answer, print the preview
//   import-to-capy pick    --source ... [--no-open] [--timeout <s>]      local picker page (127.0.0.1, one-time token)
//   import-to-capy setup   --source t3code --project <id|name>           T3 Code project scripts -> .capy/setup.json
//   import-to-capy export  --source ... (--threads a,b | --answer "...") --consent [--transcripts] [--out <dir>]
//
// Chats are read only with --consent. Everything written is redacted. Output goes to a folder git ignores.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { menu, parseSelection, preview } from './select.mjs';
import { t3Catalog, t3Messages, t3Setup, conductorCatalog, conductorMessages, detect, t3DefaultDb, conductorDefaultDb } from './sources.mjs';
import { buildHandoff, buildTranscript, continuePrompt, slug, outputDir } from './handoff.mjs';
import { startPicker } from './picker.mjs';

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
  const L = [`Imported ${res.threads.length} thread(s). Handoffs in ${res.dir} (git ignores this folder). Secrets redacted: ${res.redacted}.`];
  for (const r of res.threads) L.push(`- ${r.project} / "${r.thread}": ${r.messages} messages${r.native ? `; native ${r.native.kind} session available` : ''}\n  Continue in Capy: ${r.capyLink}`);
  return L.join('\n');
}

function args(argv) {
  const o = { _: [] };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('--')) { const key = a.slice(2); const nxt = argv[k + 1]; if (nxt === undefined || nxt.startsWith('--')) o[key] = true; else { o[key] = nxt; k++; } }
    else o._.push(a);
  }
  return o;
}

export async function main(argv, io = { log: console.log, err: console.error }) {
  const o = args(argv);
  const cmd = o._[0];
  const source = o.source === 't3' ? 't3code' : o.source;
  const opts = { db: o.db, home: o.home };
  if (!cmd || cmd === 'help' || o.help) { io.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (cmd === 'detect') { const d = detect({ home: o.home }); io.log(o.json ? JSON.stringify(d) : d.length ? `Found: ${d.map((s) => SOURCES[s]).join(', ')}` : 'Found neither Conductor nor T3 Code data on this computer.'); return 0; }
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
  if (cmd === 'export') {
    let ids = o.threads ? String(o.threads).split(',').map((s) => s.trim()).filter(Boolean) : null;
    if (!ids) { const sel = parseSelection(o.answer === true ? '' : o.answer || '', cat); if (sel.needsClarification) { io.err(sel.question); return 2; } ids = sel.threadIds; }
    const res = exportThreads(source, cat, ids, { consent: !!o.consent, transcripts: !!o.transcripts, out: o.out, db: o.db, home: o.home });
    io.log(o.json ? JSON.stringify(res, null, 2) : summary(res));
    return 0;
  }
  io.err(`Unknown command ${cmd}`); return 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`import-to-capy: ${e.message}`); process.exitCode = 1; });
