#!/usr/bin/env node
// A tiny stdio MCP server (JSON-RPC 2.0, one message per line, zero dependencies) for import-to-capy.
//
// Its job is the selection step, in three layers, best first:
//   1. MCP elicitation: if the client advertised `elicitation` at initialize, `choose_import` asks the user
//      through the client's own form UI (elicitation/create).
//   2. Local picker page: otherwise, if this machine has the source data, it serves a one-time page on
//      127.0.0.1 (random port + token), opens it in the browser, and waits for the user's pick.
//   3. Typed menu: otherwise it returns the numbered menu for the agent to show and parse.
// Each result says which layer was used. Read-only on the source.
import fs from 'node:fs';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { loadCatalog, exportThreads, setupSummary, SOURCES } from './import-to-capy.mjs';
import { menu, parseSelection, preview } from './select.mjs';
import { detect } from './sources.mjs';
import { startPicker } from './picker.mjs';

export const VERSION = '0.2.0';
const SCOPES = ['Latest N threads', 'Threads from the last N days', 'Last used project', 'Unfinished threads', 'Threads with open branches or PRs', 'Everything'];

export const TOOLS = [
  { name: 'scan_import_sources', description: 'Find Conductor and T3 Code data on this computer and list projects with thread counts and last-used dates. Read-only.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['conductor', 't3code'] } } } },
  { name: 'choose_import', description: 'Ask the user what to import, using the best UI available: a native form (elicitation), a local picker page, or a typed menu. Returns the selection and which method was used.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['conductor', 't3code'] }, allowPage: { type: 'boolean' }, timeoutSec: { type: 'integer' } } } },
  { name: 'preview_import', description: 'Resolve a plain-language answer ("latest 3 threads", "just api", "everything", "2 and 4") into a one-screen preview of what will be created in Capy.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['conductor', 't3code'] }, answer: { type: 'string' } }, required: ['source', 'answer'] } },
  { name: 'export_import', description: 'Write a redacted handoff (and optionally a full transcript) for each selected thread into a folder git ignores, and return Capy continue-links. Requires the user\'s consent to read chats.',
    inputSchema: { type: 'object', properties: { source: { type: 'string', enum: ['conductor', 't3code'] }, threadIds: { type: 'array', items: { type: 'string' } }, consent: { type: 'boolean' }, transcripts: { type: 'boolean' }, out: { type: 'string' } }, required: ['source', 'threadIds', 'consent'] } },
];

export function elicitationSchema(cat, sources) {
  const props = {};
  if (sources.length > 1) props.source = { type: 'string', title: 'Import from', enum: sources, enumNames: sources.map((s) => SOURCES[s]), default: sources[0] };
  const names = cat.projects.slice(0, 20).map((p) => p.name);
  props.project = { type: 'string', title: 'Project', enum: [...names, 'All projects'], default: names[0] || 'All projects' };
  props.scope = { type: 'string', title: 'Which threads', enum: SCOPES, default: SCOPES[0] };
  props.n = { type: 'integer', title: 'N (threads or days)', minimum: 1, maximum: 100, default: 3 };
  props.includeChats = { type: 'boolean', title: 'Bring chat history as handoffs (secrets are redacted)', default: true };
  return { type: 'object', properties: props, required: ['project', 'scope'] };
}

export function answerFromForm(c) {
  const n = Number(c.n) || 3;
  const proj = !c.project || c.project === 'All projects' ? '' : `project ${c.project} `;
  const scope = { [SCOPES[0]]: `latest ${n} threads`, [SCOPES[1]]: `last ${n} days`, [SCOPES[2]]: 'last used', [SCOPES[3]]: 'unfinished', [SCOPES[4]]: 'open branches', [SCOPES[5]]: 'everything' }[c.scope] || '';
  return (proj + scope).trim() || 'default';
}

export class Server {
  constructor({ send, pickerOpen = true, home } = {}) { this.send = send; this.pickerOpen = pickerOpen; this.home = home; this.caps = {}; this.pending = new Map(); this.nextId = 1; }
  request(method, params) { const id = `srv-${this.nextId++}`; this.send({ jsonrpc: '2.0', id, method, params }); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async handle(msg) {
    if (msg.id !== undefined && !msg.method && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); return msg.error ? p.rej(new Error(msg.error.message || 'client error')) : p.res(msg.result); }
    const reply = (result) => msg.id !== undefined && this.send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => msg.id !== undefined && this.send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    try {
      if (msg.method === 'initialize') { this.caps = msg.params?.capabilities || {}; return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'import-to-capy', version: VERSION } }); }
      if (msg.method === 'ping') return reply({});
      if (msg.method?.startsWith('notifications/')) return;
      if (msg.method === 'tools/list') return reply({ tools: TOOLS });
      if (msg.method === 'tools/call') { const out = await this.call(msg.params?.name, msg.params?.arguments || {}); return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] }); }
      return fail(-32601, `Method not found: ${msg.method}`);
    } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: e.message }] }); }
  }
  sources(s) { return s ? [s] : detect({ home: this.home }); }
  async call(name, a) {
    if (name === 'scan_import_sources') {
      const out = {};
      for (const s of this.sources(a.source)) { const cat = loadCatalog(s, { home: this.home }); out[s] = { projects: cat.projects.length, menu: menu(cat) }; }
      return Object.keys(out).length ? out : 'No Conductor or T3 Code data on this machine. If the data is on your Mac, run this from a thread on your Mac (Capy desktop app, Run on This Mac).';
    }
    if (name === 'preview_import') { const cat = loadCatalog(a.source, { home: this.home }); const sel = parseSelection(a.answer, cat); return sel.needsClarification ? sel : { ...sel, preview: preview(cat, sel, { setupFor: (p) => setupSummary(a.source, p) }) }; }
    if (name === 'export_import') { const cat = loadCatalog(a.source, { home: this.home }); return exportThreads(a.source, cat, a.threadIds || [], { consent: !!a.consent, transcripts: !!a.transcripts, out: a.out, home: this.home }); }
    if (name === 'choose_import') return this.choose(a);
    throw new Error(`Unknown tool ${name}`);
  }
  async choose(a) {
    const sources = this.sources(a.source);
    if (!sources.length) return { method: 'menu', note: 'No local Conductor or T3 Code data here, so there is nothing to pick from. Ask the user to run the import from a thread on their Mac.', menu: '' };
    let source = sources[0];
    let cat = loadCatalog(source, { home: this.home });
    // Layer 1: elicitation, only if the client said it supports it.
    if (this.caps.elicitation) {
      try {
        const r = await this.request('elicitation/create', { message: `What should I import into Capy? (${sources.map((s) => SOURCES[s]).join(' or ')}; nothing is changed in the source)`, requestedSchema: elicitationSchema(cat, sources) });
        if (r?.action === 'accept' && r.content) {
          if (r.content.source && r.content.source !== source) { source = r.content.source; cat = loadCatalog(source, { home: this.home }); }
          const sel = parseSelection(answerFromForm(r.content), cat);
          return { method: 'elicitation', source, includeChats: r.content.includeChats !== false, ...sel, preview: preview(cat, sel, { setupFor: (p) => setupSummary(source, p) }) };
        }
        if (r?.action === 'decline' || r?.action === 'cancel') return { method: 'elicitation', source, cancelled: true };
      } catch { /* client could not elicit: fall through */ }
    }
    // Layer 2: local picker page.
    if (a.allowPage !== false) {
      try {
        const pk = await startPicker(cat, { open: this.pickerOpen, timeoutMs: (a.timeoutSec || 600) * 1000 });
        this.lastPicker = pk;
        const sel = await pk.result;
        if (sel) return { method: 'picker', source, url: pk.url, ...sel, preview: preview(cat, sel, { setupFor: (p) => setupSummary(source, p) }) };
      } catch { /* cannot listen or open: fall through */ }
    }
    // Layer 3: typed menu.
    return { method: 'menu', source, sources, menu: menu(cat), ask: 'Show this menu and ask one question: "Which ones? You can say a number or name, everything, latest 3 threads, last 7 days, last used, only unfinished, or with open PRs. Say go for your most recent project\'s latest 3 threads." Then call preview_import with their words.' };
  }
}

export function serveStdio() {
  const server = new Server({ send: (m) => process.stdout.write(JSON.stringify(m) + '\n') });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => { if (!line.trim()) return; let msg; try { msg = JSON.parse(line); } catch { return; } server.handle(msg); });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) serveStdio();
