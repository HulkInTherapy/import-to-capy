#!/usr/bin/env node
// conductor-to-capy: read a repository's Conductor configuration and write the Capy equivalent.
//
// Zero dependencies. Node 18+. One file, so it can be copied into a skill or plugin as-is.
//
// Reads (in Conductor's own order of precedence):
//   .conductor/settings.toml (+ .conductor/settings.local.toml on top)   current file format
//   conductor.json                                                       legacy, ignored when settings.toml exists
//   .worktreeinclude                                                     Files to copy patterns
//   Conductor's app database (only with --from-app; read-only)           settings saved in the app
// Writes (only with --write):
//   .capy/setup.json          Capy's documented repository setup file (docs.capy.ai/environment)
//   .capy/conductor-env.sh    only when your scripts use CONDUCTOR_* variables
//   CAPY-MIGRATION.md         what was mapped, what was not, and the clicks left for a human
// It never deletes or edits Conductor files, and never reads or prints secret values.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const VERSION = '0.1.0';
const CAPY_SCHEMA = 'https://api.capy.ai/schemas/setup.v1.json'; // as shown in docs.capy.ai/environment

// ---------------------------------------------------------------------------
// Minimal TOML reader: enough for Conductor's repository settings files.
// Supports tables, arrays of tables, dotted and quoted keys, basic/literal/multiline
// strings, integers, floats, booleans, arrays and inline tables.
// ---------------------------------------------------------------------------
export function parseToml(src) {
  const root = {};
  let cur = root;
  let i = 0;
  const n = src.length;
  const err = (m) => { const line = src.slice(0, i).split('\n').length; throw new Error(`TOML line ${line}: ${m}`); };
  const ws = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  const wsnl = () => {
    for (;;) {
      ws();
      if (src[i] === '#') { while (i < n && src[i] !== '\n') i++; }
      if (src[i] === '\n' || src[i] === '\r') { i++; continue; }
      break;
    }
  };
  const bareKey = () => { const s = i; while (i < n && /[A-Za-z0-9_-]/.test(src[i])) i++; if (s === i) err('expected a key'); return src.slice(s, i); };
  const key = () => {
    const parts = [];
    for (;;) {
      ws();
      if (src[i] === '"' || src[i] === "'") parts.push(str()); else parts.push(bareKey());
      ws();
      if (src[i] === '.') { i++; continue; }
      return parts;
    }
  };
  const esc = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const str = () => {
    if (src.startsWith('"""', i)) {
      i += 3; if (src[i] === '\r') i++; if (src[i] === '\n') i++;
      let out = '';
      while (i < n && !src.startsWith('"""', i)) {
        if (src[i] === '\\') {
          i++;
          if (src[i] === '\n' || src[i] === '\r' || src[i] === ' ' || src[i] === '\t') { while (i < n && /[\s]/.test(src[i])) i++; continue; }
          out += unescape1();
        } else out += src[i++];
      }
      if (i >= n) err('unterminated """ string');
      i += 3; while (src[i] === '"') { out += '"'; i++; }
      return out;
    }
    if (src.startsWith("'''", i)) {
      i += 3; if (src[i] === '\r') i++; if (src[i] === '\n') i++;
      const e = src.indexOf("'''", i); if (e < 0) err("unterminated ''' string");
      let out = src.slice(i, e); i = e + 3; while (src[i] === "'") { out += "'"; i++; }
      return out;
    }
    if (src[i] === "'") { const e = src.indexOf("'", i + 1); if (e < 0) err('unterminated string'); const out = src.slice(i + 1, e); i = e + 1; return out; }
    i++; let out = '';
    while (i < n && src[i] !== '"') {
      if (src[i] === '\n') err('newline in string');
      if (src[i] === '\\') { i++; out += unescape1(); } else out += src[i++];
    }
    if (i >= n) err('unterminated string');
    i++; return out;
  };
  const unescape1 = () => {
    const c = src[i++];
    if (c in esc) return esc[c];
    if (c === 'u' || c === 'U') { const len = c === 'u' ? 4 : 8; const h = src.slice(i, i + len); i += len; return String.fromCodePoint(parseInt(h, 16)); }
    err(`bad escape \\${c}`);
  };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '"' || c === "'") return str();
    if (c === '[') {
      i++; const arr = [];
      for (;;) { wsnl(); if (src[i] === ']') { i++; return arr; } arr.push(value()); wsnl(); if (src[i] === ',') { i++; continue; } wsnl(); if (src[i] === ']') { i++; return arr; } err('expected , or ] in array'); }
    }
    if (c === '{') {
      i++; const obj = {}; ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) { const k = key(); ws(); if (src[i] !== '=') err('expected ='); i++; setPath(obj, k, value()); ws(); if (src[i] === ',') { i++; continue; } if (src[i] === '}') { i++; return obj; } err('expected , or } in inline table'); }
    }
    if (src.startsWith('true', i)) { i += 4; return true; }
    if (src.startsWith('false', i)) { i += 5; return false; }
    const m = /^[+-]?[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 64));
    if (m) { i += m[0].length; const v = m[0].replace(/_/g, ''); return m[1] || m[2] ? parseFloat(v) : parseInt(v, 10); }
    err('unsupported value');
  };
  const setPath = (obj, parts, v) => {
    let o = obj;
    for (const p of parts.slice(0, -1)) { if (o[p] === undefined) o[p] = {}; o = o[p]; if (typeof o !== 'object' || Array.isArray(o)) err(`key ${parts.join('.')} conflicts`); }
    const last = parts[parts.length - 1];
    if (o[last] !== undefined && typeof o[last] !== 'object') err(`duplicate key ${parts.join('.')}`);
    o[last] = v;
  };
  const table = (parts, isArray) => {
    let o = root;
    parts.forEach((p, idx) => {
      const last = idx === parts.length - 1;
      if (last && isArray) { if (o[p] === undefined) o[p] = []; if (!Array.isArray(o[p])) err(`${p} is not an array`); const t = {}; o[p].push(t); o = t; return; }
      if (o[p] === undefined) o[p] = {};
      o = Array.isArray(o[p]) ? o[p][o[p].length - 1] : o[p];
    });
    return o;
  };
  for (;;) {
    wsnl();
    if (i >= n) break;
    if (src[i] === '[') {
      const isArray = src[i + 1] === '['; i += isArray ? 2 : 1;
      const parts = key();
      if (isArray) { if (!src.startsWith(']]', i)) err('expected ]]'); i += 2; } else { if (src[i] !== ']') err('expected ]'); i++; }
      cur = table(parts, isArray);
    } else {
      const k = key(); ws(); if (src[i] !== '=') err('expected ='); i++;
      setPath(cur, k, value());
    }
    ws();
    if (src[i] === '#') { while (i < n && src[i] !== '\n') i++; }
    if (i < n && src[i] !== '\n' && src[i] !== '\r') err('expected end of line');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Conductor config -> one normalized model
// ---------------------------------------------------------------------------
const KNOWN_REPO_KEYS = new Set(['$schema', 'scripts', 'enterprise_data_privacy', 'spotlight_testing', 'file_include_globs', 'preview_urls',
  'environment_variables', 'prompts', 'claude_code_executable_path', 'codex_executable_path', 'claude_provider', 'codex_provider',
  'bedrock_region', 'vertex_project_id', 'ssh_key_path', 'git']);
const KNOWN_LEGACY_KEYS = new Set(['scripts', 'runScriptMode', 'enterpriseDataPrivacy']);

function emptyModel(source) {
  return { source, setup: '', archive: '', runMode: '', actions: [], env: { shared: {}, local: {}, cloud: {} }, envFromLocalFile: new Set(),
    prompts: {}, previewUrls: [], git: {}, harness: {}, enterpriseDataPrivacy: undefined, spotlight: undefined, fileIncludeGlobs: '',
    defaultBranch: '', unknown: [], notes: [] };
}

function deepMerge(a, b) {
  if (b === undefined) return a;
  if (a === undefined || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

function actionsFromRun(run) {
  if (run === undefined || run === null || run === '') return [];
  if (typeof run === 'string') return [{ name: 'run', command: run, default: true }];
  if (typeof run !== 'object') return [];
  return Object.entries(run).filter(([, a]) => a && typeof a === 'object').map(([name, a]) => ({
    name, command: a.command ?? '', args: Array.isArray(a.args) ? a.args : [], cwd: a.options?.cwd ?? '',
    default: !!a.default, icon: a.icon ?? '', hide: !!a.hide,
    availableIn: a.available_in === undefined ? ['local', 'cloud'] : [].concat(a.available_in),
  }));
}

export function modelFromSettingsToml(shared, local) {
  const m = emptyModel('.conductor/settings.toml' + (local ? ' + settings.local.toml' : ''));
  const t = deepMerge(shared || {}, local || {});
  for (const k of Object.keys(t)) if (!KNOWN_REPO_KEYS.has(k)) m.unknown.push(k);
  const s = t.scripts || {};
  m.setup = s.setup || '';
  m.archive = s.archive || '';
  m.runMode = s.run_mode || '';
  for (const k of Object.keys(s)) if (!['setup', 'archive', 'run_mode', 'run'].includes(k)) m.unknown.push(`scripts.${k}`);
  m.actions = actionsFromRun(s.run);
  const ev = t.environment_variables || {};
  for (const [k, v] of Object.entries(ev)) {
    if (k === 'local' || k === 'cloud') { if (v && typeof v === 'object') Object.assign(m.env[k], v); } else m.env.shared[k] = v;
  }
  if (local?.environment_variables) {
    const lev = local.environment_variables;
    for (const [k, v] of Object.entries(lev)) { if ((k === 'local' || k === 'cloud') && v && typeof v === 'object') Object.keys(v).forEach((x) => m.envFromLocalFile.add(x)); else m.envFromLocalFile.add(k); }
  }
  m.prompts = t.prompts || {};
  m.previewUrls = Array.isArray(t.preview_urls) ? t.preview_urls : [];
  m.git = t.git || {};
  for (const k of ['claude_code_executable_path', 'codex_executable_path', 'claude_provider', 'codex_provider', 'bedrock_region', 'vertex_project_id', 'ssh_key_path']) if (t[k] !== undefined) m.harness[k] = t[k];
  m.enterpriseDataPrivacy = t.enterprise_data_privacy;
  m.spotlight = t.spotlight_testing;
  m.fileIncludeGlobs = t.file_include_globs || '';
  return m;
}

export function modelFromConductorJson(j) {
  const m = emptyModel('conductor.json');
  for (const k of Object.keys(j)) if (!KNOWN_LEGACY_KEYS.has(k) && !(k === 'environment' && typeof j.environment === 'object') && !(k === 'worktree' && j.worktree?.default_branch)) m.unknown.push(k);
  const s = j.scripts || {};
  m.setup = s.setup || '';
  m.archive = s.archive || '';
  m.runMode = j.runScriptMode || '';
  m.actions = actionsFromRun(s.run);
  for (const k of Object.keys(s)) if (!['setup', 'archive', 'run'].includes(k)) m.unknown.push(`scripts.${k}`);
  m.enterpriseDataPrivacy = j.enterpriseDataPrivacy;
  // Fields some teams added that are not in Conductor's documented schema (vercel/next.js does this).
  if (j.environment && typeof j.environment === 'object') { Object.assign(m.env.shared, j.environment); m.notes.push('`environment` is not a documented Conductor field; treated as environment variables.'); }
  if (j.worktree?.default_branch) { m.defaultBranch = j.worktree.default_branch; m.notes.push('`worktree.default_branch` is not a documented Conductor field; used as the base branch hint.'); }
  return m;
}

// A row of the `repos` table in Conductor's app database (conductor.db). Column names come from the
// installed app's schema; newer versions add columns, older ones lack some. Anything missing is skipped.
export function modelFromAppRow(row) {
  const m = emptyModel('Conductor app settings (conductor.db, read-only)');
  m.setup = row.setup_script || '';
  m.archive = row.archive_script || '';
  m.runMode = row.run_script_mode || '';
  let run = row.run_script || '';
  if (typeof run === 'string' && run.trim().startsWith('{')) { try { run = JSON.parse(run); } catch { /* keep as text */ } }
  m.actions = actionsFromRun(run);
  for (const [col, key] of [['custom_prompt_general', 'general'], ['custom_prompt_code_review', 'code_review'], ['custom_prompt_create_pr', 'create_pr'],
    ['custom_prompt_fix_errors', 'fix_errors'], ['custom_prompt_resolve_merge_conflicts', 'resolve_merge_conflicts'], ['custom_prompt_rename_branch', 'rename_branch']]) {
    if (row[col]) m.prompts[key] = row[col];
  }
  m.fileIncludeGlobs = row.file_include_globs || '';
  if (row.spotlight_testing) m.spotlight = !!row.spotlight_testing;
  m.defaultBranch = row.default_branch || '';
  if (row.conductor_config) {
    try {
      const cfg = JSON.parse(row.conductor_config);
      const extra = cfg && typeof cfg === 'object' ? (cfg.scripts || cfg.runScriptMode ? modelFromConductorJson(cfg) : modelFromSettingsToml(cfg, null)) : null;
      if (extra) {
        if (!m.setup) m.setup = extra.setup; if (!m.archive) m.archive = extra.archive; if (!m.runMode) m.runMode = extra.runMode;
        if (!m.actions.length) m.actions = extra.actions;
        Object.assign(m.env.shared, extra.env.shared); Object.assign(m.env.cloud, extra.env.cloud); Object.assign(m.env.local, extra.env.local);
        m.notes.push('Merged the repository config Conductor stored in the app (conductor_config).');
      }
    } catch { m.notes.push('conductor_config in the app is not JSON; skipped.'); }
  }
  for (const e of row.env_var_names || []) m.env.shared[e.name] = '';
  m.notes.push(row.env_var_names?.length
    ? `Found ${row.env_var_names.length} environment variable name(s) in the Conductor app. Values were not read: re-enter them in Capy.`
    : 'No environment variables found in the Conductor app (values are never read; only names).');
  return m;
}

// ---------------------------------------------------------------------------
// Repository inspection
// ---------------------------------------------------------------------------
const readIf = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function gitOut(dir, args) { try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

export function defaultAppDbPath() { return path.join(os.homedir(), 'Library', 'Application Support', 'com.conductor.app', 'conductor.db'); }

// Conductor keeps conductor.db open in WAL mode. Never open the live file: copy it (with -wal and -shm)
// to a private temp folder, query the copy, delete the copy. The live database is never written or locked.
export function withDbCopy(dbPath, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-db-'));
  try {
    for (const suffix of ['-wal', '-shm', '']) {
      const src = dbPath + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'conductor.db' + suffix));
    }
    const copy = path.join(tmp, 'conductor.db');
    const q = (sqlText) => {
      const out = execFileSync('sqlite3', ['-json', copy, sqlText], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
      return out ? JSON.parse(out) : [];
    };
    q.columns = (table) => q(`PRAGMA table_info(${table});`).map((c) => c.name);
    return fn(q);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// Only these columns are ever read from `repos`. Env var VALUES are never selected.
const REPO_COLS = ['id', 'remote_url', 'name', 'default_branch', 'root_path', 'hidden', 'setup_script', 'run_script', 'run_script_mode', 'archive_script',
  'conductor_config', 'custom_prompt_general', 'custom_prompt_code_review', 'custom_prompt_create_pr', 'custom_prompt_fix_errors',
  'custom_prompt_resolve_merge_conflicts', 'custom_prompt_rename_branch', 'file_include_globs', 'spotlight_testing'];

export function readAppRows(dbPath) {
  return withDbCopy(dbPath, (q) => {
    const have = q.columns('repos');
    const rows = q(`SELECT ${REPO_COLS.filter((c) => have.includes(c)).join(', ')} FROM repos;`);
    const envCols = q.columns('env_vars');
    const env = envCols.includes('key') ? q(`SELECT key${envCols.includes('scope') ? ', scope' : ''}${envCols.includes('context') ? ', context' : ''} FROM env_vars;`) : [];
    for (const r of rows) r.env_var_names = env.filter((e) => !e.context || e.context === r.id || e.context === r.root_path).map((e) => ({ name: e.key, scope: e.scope || '' }));
    return rows;
  });
}

function normRemote(u) { return (u || '').trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@/, 'https://').replace(/\/+$/, '').toLowerCase(); }

export function pickAppRow(rows, { root, remote }) {
  const r = rows.filter((x) => !x.hidden);
  const roots = [].concat(root).filter(Boolean).map((x) => path.resolve(x));
  const byPath = r.find((x) => x.root_path && roots.includes(path.resolve(x.root_path)));
  if (byPath) return byPath;
  if (remote) return r.find((x) => normRemote(x.remote_url) === normRemote(remote)) || null;
  return null;
}

export function loadRepo(dir, opts = {}) {
  const files = {};
  const toml = readIf(path.join(dir, '.conductor', 'settings.toml'));
  const tomlLocal = readIf(path.join(dir, '.conductor', 'settings.local.toml'));
  const json = readIf(path.join(dir, 'conductor.json'));
  let model = null;
  const notes = [];
  if (opts.fromApp) {
    const db = opts.appDb || defaultAppDbPath();
    if (!fs.existsSync(db)) throw new Error(`No Conductor database at ${db}. Pass --app-db <path>.`);
    const rows = readAppRows(db);
    // A Conductor workspace is a worktree; the app stores the main checkout (the parent of git's common dir).
    const common = opts.noGit ? '' : gitOut(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const row = pickAppRow(rows, { root: [dir, common ? path.dirname(common) : ''], remote: opts.noGit ? '' : gitOut(dir, ['remote', 'get-url', 'origin']) });
    if (!row) throw new Error(`Conductor's database has no repository for ${dir} (matched by folder and by origin remote).`);
    model = modelFromAppRow(row);
    files.app = db;
  } else if (toml !== null || tomlLocal !== null) {
    model = modelFromSettingsToml(toml ? parseToml(toml) : {}, tomlLocal ? parseToml(tomlLocal) : null);
    files.toml = true; files.tomlLocal = tomlLocal !== null;
    if (json !== null) notes.push('conductor.json is present but ignored, because .conductor/settings.toml exists (Conductor does the same).');
  } else if (json !== null) {
    model = modelFromConductorJson(JSON.parse(json));
    files.json = true;
  }
  if (!model) return null;
  model.notes.push(...notes);
  model.worktreeinclude = readIf(path.join(dir, '.worktreeinclude'));
  if (!model.defaultBranch && !opts.noGit) model.defaultBranch = (gitOut(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')) || '';
  model.repoName = path.basename(path.resolve(dir));
  model.scripts = collectScripts(dir, model);
  model.agentFiles = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules', '.claude/skills', '.agents/skills', '.mcp.json', '.env.example'].filter((f) => fs.existsSync(path.join(dir, f)));
  model.files = files;
  const home = opts.home ?? (opts.noGit ? null : os.homedir());
  const userToml = home ? readIf(path.join(home, '.conductor', 'settings.toml')) : null;
  if (userToml) { try { const u = parseToml(userToml); model.userDefaults = { model: u.models?.default || '', branchPrefix: u.git?.branch_prefix || u.git?.branch_prefix_type || '' }; } catch { /* ignore */ } }
  return model;
}

// Find repository script files a command calls (./x.sh, bin/x, bash path/x.sh), so their contents can be scanned.
export function referencedPaths(cmd) {
  const out = new Set();
  for (const tok of (cmd || '').split(/[\s;&|()]+/)) {
    const t = tok.replace(/^["']|["']$/g, '');
    if (!t || t.startsWith('-') || t.includes('$') || t.includes('=')) continue;
    if (/^(\.\/|\.\.\/)?[\w.-]+(\/[\w.-]+)+$/.test(t) || /^\.\/[\w.-]+$/.test(t)) out.add(t.replace(/^\.\//, ''));
  }
  return [...out];
}

function collectScripts(dir, model) {
  const cmds = [model.setup, model.archive, ...model.actions.map((a) => a.command)];
  const seen = {};
  const queue = cmds.flatMap(referencedPaths);
  while (queue.length) {
    const rel = queue.shift();
    if (seen[rel] !== undefined) continue;
    const p = path.join(dir, rel);
    let body = null;
    try { if (fs.statSync(p).isFile() && fs.statSync(p).size < 512 * 1024) body = fs.readFileSync(p, 'utf8'); } catch { /* missing */ }
    seen[rel] = body;
    if (body) {
      // follow `. ./lib.sh` / `source x` style includes relative to the script's folder
      for (const m of body.matchAll(/(?:^|\s)(?:source|\.)\s+["']?([\w./${}()-]+\.sh)["']?/g)) {
        const inc = m[1].replace(/^.*\)\/?/, '').replace(/^\$\{?\w+\}?\//, '');
        if (!inc.includes('$')) queue.push(path.join(path.dirname(rel), path.basename(inc)));
      }
    }
  }
  return seen; // { relPath: contents | null }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------
const INSTALL_RE = /(?:^|[;&|(\s])((?:corepack enable\s*&&\s*)?(?:pnpm install|pnpm i|npm ci|npm install|npm i|yarn install|yarn|bun install|bun i|bundle install|uv sync|poetry install|pip install -r [\w./-]+|composer install|mix deps\.get|go mod download|cargo fetch)(?=$|[\s;&|)])(?:\s+--?[\w-]+(?:=\S+)?)*)/m;
export function detectInstall(cmd) {
  const m = INSTALL_RE.exec(cmd || '');
  if (!m) return '';
  const c = m[1].trim();
  return c === 'yarn' ? 'yarn install' : c;
}

export function portFrom(cmd, base) {
  const s = cmd || '';
  const off = /\$\(\(\s*CONDUCTOR_PORT\s*\+\s*(\d+)\s*\)\)/.exec(s);
  if (off) return base + Number(off[1]);
  if (/\$\{?CONDUCTOR_PORT\}?/.test(s)) return base;
  const lit = /(?:--port[ =]|-p\s+|PORT=)(\d{2,5})\b/.exec(s);
  return lit ? Number(lit[1]) : null;
}

const MAC_ONLY = /\b(brew |xcode-select|xcrun|osascript|launchctl|open -a|security find-|defaults write|pod install|sw_vers)\b/;

export function scan(model) {
  const texts = { setup: model.setup, archive: model.archive };
  model.actions.forEach((a) => { texts[`action:${a.name}`] = [a.command, ...(a.args || [])].join(' '); });
  for (const [rel, body] of Object.entries(model.scripts || {})) if (body) texts[`file:${rel}`] = body;
  const all = Object.values(texts).join('\n');
  const vars = [...new Set([...all.matchAll(/CONDUCTOR_[A-Z_]+/g)].map((m) => m[0]))].sort();
  const hits = (re) => Object.entries(texts).filter(([, t]) => re.test(t || '')).map(([k]) => k);
  return {
    conductorVars: vars,
    usesVars: vars.length > 0,
    envFromRoot: hits(/CONDUCTOR_ROOT_PATH[^\n]*\.env/),
    macOnly: hits(MAC_ONLY),
    docker: /(docker compose|docker-compose|\$\{?COMPOSE\}?)\s+up\b/.test(model.setup + '\n' + Object.values(model.scripts || {}).join('\n')),
    dockerCmd: /docker-compose\s+up/.test(model.setup) && !/docker compose\s+up/.test(model.setup) ? 'docker-compose' : 'docker compose',
    missingScripts: Object.entries(model.scripts || {}).filter(([, b]) => b === null).map(([k]) => k),
  };
}

// ---------------------------------------------------------------------------
// Convert
// ---------------------------------------------------------------------------
export function convert(model, opts = {}) {
  const basePort = Number(opts.port || 3000);
  const s = scan(model);
  const prefix = s.usesVars ? '. ./.capy/conductor-env.sh && ' : '';
  const report = []; // { status, conductor, capy, note }
  const add = (status, conductor, capy, note = '') => report.push({ status, conductor, capy, note });

  const setup = { $schema: CAPY_SCHEMA, format_version: 1, scripts: {}, startup: [], commands: [] };

  if (model.setup) {
    setup.scripts.initialize = prefix + model.setup;
    add('mapped', 'Setup script', 'scripts.initialize', 'Runs once on a fresh clone and while building a snapshot.');
    const inst = detectInstall(model.setup) || Object.values(model.scripts || {}).map((b) => detectInstall(b || '')).find(Boolean) || '';
    if (inst) {
      setup.scripts.refresh = inst;
      add('mapped', `Dependency install inside setup (\`${inst}\`)`, 'scripts.refresh', 'Re-syncs dependencies when a snapshot checkout moves to a newer commit. Keep it fast; edit if wrong.');
    } else {
      add('manual', 'Setup script', 'scripts.refresh (left empty)', 'Capy runs refresh when a snapshot checkout moves forward. Add your dependency sync command if you have one.');
    }
  } else {
    add('manual', 'Setup script (none found)', 'scripts.initialize', 'Nothing to copy. In Capy, "Ask Capy to set up" can write one for you.');
  }

  for (const a of model.actions) {
    const full = [a.command, ...(a.args || []).map(shq)].filter(Boolean).join(' ');
    const cmd = prefix + (a.cwd ? `cd ${shq(a.cwd)} && ` : '') + full;
    const where = a.availableIn || ['local', 'cloud'];
    if (!where.includes('cloud')) {
      add('unmapped', `Action \`${a.name}\` (local only)`, '-', 'Marked "local only" in Conductor, so it is left out of the cloud setup. Run it on your own computer, or add it as a command if it works on Linux.');
      continue;
    }
    const entry = { name: a.name, command: cmd };
    const port = portFrom(full, basePort);
    if (port) entry.port = port;
    setup.commands.push(entry);
    let note = 'On demand, like the Run button. Capy can launch it by name.';
    if (port) note += ` Port ${port} is published as a preview.`;
    else if (/\b(dev|start|serve|server)\b/.test(a.command)) note += ' If it serves HTTP, add "port" so Capy publishes a preview.';
    if (a.hide) note += ' (Hidden in Conductor; included anyway.)';
    if (a.icon) note += ` Conductor icon "${a.icon}" dropped (Capy's icon names are not documented beyond two examples).`;
    add('mapped', `Action \`${a.name}\`${a.default ? ' (default)' : ''}`, `commands: "${a.name}"`, note);
    if (opts.startDefault && a.default) {
      setup.startup.push({ ...entry });
      add('mapped', `Action \`${a.name}\``, `startup: "${a.name}"`, 'Also starts on every boot (--start-default).');
    }
  }

  if (s.docker) {
    setup.startup.unshift({ name: 'services', command: `${s.dockerCmd} up -d --wait` });
    add('changed', 'docker compose up inside setup', 'startup: "services"', 'Capy machines stop containers when they sleep, so services start again on every boot. Capy docs recommend exactly this.');
  }

  if (model.archive) add('unmapped', 'Archive script', '-', 'Capy has no archive hook. Cloud machines sleep and are deleted. If the script cleans something outside the repo, run it by hand or keep it for local use.');
  if (model.runMode === 'nonconcurrent') add('changed', 'Run mode: nonconcurrent', '-', 'Not needed in the cloud: every Capy thread gets its own VM, so ports and databases do not collide. On your own computer, several local threads can still collide.');
  else if (model.runMode) add('changed', `Run mode: ${model.runMode}`, '-', 'No setting needed in Capy.');

  if (s.usesVars) add('changed', `CONDUCTOR_* variables (${s.conductorVars.join(', ')})`, '.capy/conductor-env.sh', `Capy does not set these. The shim sets them the way Conductor Cloud did (root = workspace, CONDUCTOR_IS_LOCAL=0, CONDUCTOR_PORT=${basePort}).`);
  for (const k of s.envFromRoot) add('manual', `.env read from CONDUCTOR_ROOT_PATH (${k})`, 'Project → Environment variables', 'On Capy there is no separate main checkout holding your .env. With the shim, that path points at the workspace itself, so `ln -s` would link .env to itself. Put the values in Capy environment variables (they load into every shell), or guard the line with `[ "$CONDUCTOR_IS_LOCAL" = 1 ]`.');
  for (const k of s.macOnly) add('manual', `macOS-only command in ${k}`, '-', 'Capy cloud machines run Ubuntu 24.04. Guard Mac-only steps or use a Linux equivalent.');
  for (const k of s.missingScripts) add('manual', `Referenced file ${k}`, '-', 'Not found in this folder, so it was not scanned. Check it exists on your base branch.');

  const envNames = { ...model.env.shared, ...model.env.cloud };
  const localOnlyEnv = Object.keys(model.env.local);
  if (Object.keys(envNames).length) add('manual', `Environment variables: ${Object.keys(envNames).join(', ')}`, 'Project → Environment variables (Shared)', '.capy/setup.json has no field for variables. Add each in the app or with the API (PUT /api/v1/projects/{id}/environment-variables).');
  if (localOnlyEnv.length) add('unmapped', `Local-only variables: ${localOnlyEnv.join(', ')}`, '-', 'Conductor only passed these to local agents. Skipped.');

  if (model.worktreeinclude !== null && model.worktreeinclude !== undefined || model.fileIncludeGlobs) add('manual', 'Files to copy (.worktreeinclude / file_include_globs)', 'Environment variables, or "Current checkout" on the desktop app', 'Capy cloud machines clone from GitHub and never see files on your Mac. Move secrets into variables. On the desktop app, "Current checkout" works in your own folder with its gitignored files.');

  for (const [k, v] of Object.entries(model.prompts || {})) {
    if (!v) continue;
    const target = k === 'code_review' ? 'AGENTS.md, under "## Reviews" (Capy\'s review agent reads it)' : 'AGENTS.md';
    add('manual', `Prompt: ${k}`, target, 'Capy has no per-action prompt slots. Paste the text into AGENTS.md (shown in CAPY-MIGRATION.md).');
  }
  if (model.previewUrls.length) add('changed', 'Preview URLs', 'port on startup entries and commands', 'Capy publishes a preview for every entry with a "port".');
  if (model.spotlight) add('unmapped', 'Spotlight testing', '-', 'No Capy equivalent. Closest: run a thread on your computer with "Current checkout", or "Continue on" to move a thread to your machine.');
  if (model.enterpriseDataPrivacy) add('manual', 'Enterprise data privacy', 'Enterprise plan: zero data retention on request', 'Capy cloud stores thread data. Ask Capy about ZDR, or run threads on your own computer.');
  if (Object.keys(model.git || {}).length) add('changed', `Git settings (${Object.keys(model.git).join(', ')})`, '-', 'Capy uses capy/… branches, never pushes to main/master/develop/release/*, and never merges unless you ask.');
  if (Object.keys(model.harness || {}).length) add('manual', `Agent settings (${Object.keys(model.harness).join(', ')})`, 'Settings → Models', 'Connect your Claude Code subscription (claude setup-token), Codex (device code), or a key/gateway such as Bedrock.');
  if (model.defaultBranch) add('manual', `Base branch: ${model.defaultBranch}`, 'Project → Dev environment → repository branch', 'The file never carries the branch. Capy reads .capy/setup.json from GitHub on the branch your setup names.');
  for (const k of model.unknown) add('unmapped', `Unknown key \`${k}\``, '-', 'Not in Conductor\'s documented schema, so not converted.');
  for (const f of model.agentFiles || []) {
    const map = { 'AGENTS.md': 'Read by every Capy agent as-is.', 'CLAUDE.md': 'Read as a fallback when there is no AGENTS.md.', '.cursor/rules': 'Read natively, including globs and alwaysApply.',
      '.claude/skills': 'Read as repository skills.', '.agents/skills': 'Read as repository skills.', '.mcp.json': 'Paste into Settings → MCP & plugins → Advanced to import (secret references are not imported).',
      '.env.example': 'Use it as the list of variable names to add in Capy.' };
    add(f === '.mcp.json' || f === '.env.example' ? 'manual' : 'mapped', f, f === '.mcp.json' ? 'Settings → MCP & plugins' : f === '.env.example' ? 'Project → Environment variables' : 'works as-is', map[f]);
  }
  if (model.userDefaults?.model) add('manual', `Default model in Conductor: ${model.userDefaults.model}`, 'Capy model picker', 'Pick the same model in Capy. Models with no subscription icon bill Capy credits.');
  for (const note of model.notes) add('note', note, '', '');

  if (!setup.startup.length) delete setup.startup;
  if (!setup.commands.length) delete setup.commands;
  if (!setup.scripts.initialize && !setup.scripts.refresh) delete setup.scripts;

  const envShim = s.usesVars ? conductorEnvShim(model, basePort) : null;
  return { setup, envShim, report, scan: s, envNames: Object.keys(envNames) };
}

// Quote one argument for bash. Arguments that use $VARS or $((math)) stay expandable, as they would in Conductor's shell.
const shq = (x) => {
  const v = String(x);
  if (/^[\w@%+=:,./-]+$/.test(v)) return v;
  if (v.includes('$') && !/["`\\]/.test(v)) return `"${v}"`;
  return `'${v.replace(/'/g, `'\\''`)}'`;
};

export function conductorEnvShim(model, basePort) {
  const br = model.defaultBranch || 'main';
  return `# Generated by conductor-to-capy ${VERSION}. Safe to delete once your scripts no longer use CONDUCTOR_*.
# Capy does not set Conductor's variables. This sets them the way Conductor Cloud did:
# no separate root checkout (root = this workspace), no port range (each Capy thread has its own VM).
export CONDUCTOR_WORKSPACE_PATH="\${CONDUCTOR_WORKSPACE_PATH:-$PWD}"
export CONDUCTOR_ROOT_PATH="\${CONDUCTOR_ROOT_PATH:-$PWD}"
export CONDUCTOR_WORKSPACE_NAME="\${CONDUCTOR_WORKSPACE_NAME:-$(basename "$PWD")}"
export CONDUCTOR_DEFAULT_BRANCH="\${CONDUCTOR_DEFAULT_BRANCH:-${br}}"
export CONDUCTOR_IS_LOCAL="\${CONDUCTOR_IS_LOCAL:-0}"
export CONDUCTOR_PORT="\${CONDUCTOR_PORT:-${basePort}}"
`;
}

// ---------------------------------------------------------------------------
// Human-facing output
// ---------------------------------------------------------------------------
const ICON = { mapped: 'OK  ', changed: 'DIFF', manual: 'TODO', unmapped: 'SKIP', note: 'NOTE' };

export function renderReport(model, result) {
  const lines = [`Source: ${model.source}`, ''];
  for (const r of result.report) lines.push(`[${ICON[r.status]}] ${r.conductor}${r.capy ? `  ->  ${r.capy}` : ''}${r.note ? `\n        ${r.note}` : ''}`);
  return lines.join('\n');
}

export function renderChecklist(model, result) {
  const todo = result.report.filter((r) => r.status === 'manual' || r.status === 'unmapped');
  const prompts = Object.entries(model.prompts || {}).filter(([, v]) => v);
  const out = [];
  out.push(`# Moving ${model.repoName} from Conductor to Capy`, '');
  out.push(`Generated by conductor-to-capy ${VERSION} from ${model.source}. Nothing in your Conductor setup was changed or deleted.`, '');
  out.push('## What was converted', '');
  for (const r of result.report.filter((x) => x.status === 'mapped' || x.status === 'changed')) out.push(`- ${r.conductor} → ${r.capy}. ${r.note}`);
  out.push('', '## What needs you', '');
  for (const r of todo) out.push(`- **${r.conductor}** → ${r.capy}. ${r.note}`);
  if (prompts.length) {
    out.push('', '### Text to paste into AGENTS.md', '');
    for (const [k, v] of prompts) out.push(k === 'code_review' ? '## Reviews' : `## From Conductor: ${k.replace(/_/g, ' ')}`, '', String(v).trim(), '');
  }
  if (result.envNames.length) out.push('', '### Variable names to add in Capy (Project → Environment variables)', '', ...result.envNames.map((n) => `- \`${n}\``));
  out.push('', '## The clicks left (about 10 minutes)', '',
    '1. **Keep your work.** Push every branch you care about. Conductor workspaces are plain git worktrees, so nothing moves until you push.',
    '2. **Commit `.capy/setup.json`** (and `.capy/conductor-env.sh` if it was written) to your base branch' + (model.defaultBranch ? ` (\`${model.defaultBranch}\`)` : '') + '. Capy reads the file from GitHub, not from your laptop.',
    '3. **Connect GitHub** in Capy: install the Capy GitHub App on this repository.',
    '4. **Create a project** with this repository and pick the base branch. The repository shows as owned by `.capy/setup.json`.',
    '5. **Connect your subscription** in Settings → Models: Claude Code (run `claude setup-token`, paste the token, then pick models under the "Claude Code" tab), or Codex (device code; enable device code sign-in in ChatGPT settings first).',
    '6. **Add environment variables** listed above. Values never go in the file.',
    '7. **Start one small thread** ("run the test command and tell me what fails") to check the setup. Turn on snapshots once it works.',
    '8. **Cloud costs credits.** Your subscription pays for the model; cloud machine time, reviews and phones bill Capy credits. Threads on your own computer through the desktop app cost no machine time.',
    '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = `conductor-to-capy ${VERSION}
Read a repository's Conductor config and print (or write) the Capy equivalent.

Usage: conductor-to-capy [repo-dir] [options]

  --write            write .capy/setup.json, .capy/conductor-env.sh (if needed) and CAPY-MIGRATION.md
  --force            overwrite an existing .capy/setup.json
  --from-app         read the settings saved in the Conductor Mac app (read-only) instead of repo files
  --app-db <path>    path to conductor.db (default: ~/Library/Application Support/com.conductor.app/conductor.db)
  --port <n>         port to use for CONDUCTOR_PORT (default 3000)
  --start-default    also start the default action on every boot
  --json             print machine-readable output
  -h, --help         this help

Without --write nothing is written. Conductor files are never changed.`;

export function parseArgs(argv) {
  const o = { dir: '.', write: false, force: false, fromApp: false, appDb: '', port: 3000, startDefault: false, json: false, help: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--write') o.write = true; else if (a === '--force') o.force = true;
    else if (a === '--from-app') o.fromApp = true; else if (a === '--app-db') { o.appDb = argv[++k]; o.fromApp = true; }
    else if (a === '--port') o.port = Number(argv[++k]); else if (a === '--start-default') o.startDefault = true;
    else if (a === '--json') o.json = true; else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`); else o.dir = a;
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be 1-65535');
  return o;
}

export function run(argv, io = { log: console.log, err: console.error }) {
  const o = parseArgs(argv);
  if (o.help) { io.log(HELP); return 0; }
  const dir = path.resolve(o.dir);
  const model = loadRepo(dir, o);
  if (!model) {
    io.err(`No Conductor config in ${dir} (looked for .conductor/settings.toml, .conductor/settings.local.toml, conductor.json).\n` +
      'If you set your scripts up inside the Conductor app, run again with --from-app.');
    return 2;
  }
  const result = convert(model, o);
  const setupText = JSON.stringify(result.setup, null, 2) + '\n';
  const checklist = renderChecklist(model, result);
  if (o.json) io.log(JSON.stringify({ source: model.source, setup: result.setup, envShim: result.envShim, report: result.report }, null, 2));
  else {
    io.log('--- .capy/setup.json ---\n' + setupText);
    if (result.envShim) io.log('--- .capy/conductor-env.sh ---\n' + result.envShim);
    io.log('--- report ---\n' + renderReport(model, result) + '\n');
  }
  if (o.write) {
    const capyDir = path.join(dir, '.capy');
    const target = path.join(capyDir, 'setup.json');
    if (fs.existsSync(target) && !o.force) { io.err(`${target} already exists. Re-run with --force to overwrite it.`); return 3; }
    fs.mkdirSync(capyDir, { recursive: true });
    fs.writeFileSync(target, setupText);
    if (result.envShim) fs.writeFileSync(path.join(capyDir, 'conductor-env.sh'), result.envShim);
    fs.writeFileSync(path.join(dir, 'CAPY-MIGRATION.md'), checklist);
    if (!o.json) io.log(`Wrote ${path.relative(process.cwd(), target) || target}${result.envShim ? ', .capy/conductor-env.sh' : ''} and CAPY-MIGRATION.md. Review, then commit them on a branch.`);
  } else if (!o.json) io.log('Dry run. Add --write to create the files.');
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isMain) {
  try { process.exitCode = run(process.argv.slice(2)); } catch (e) { console.error(`conductor-to-capy: ${e.message}`); process.exitCode = 1; }
}
