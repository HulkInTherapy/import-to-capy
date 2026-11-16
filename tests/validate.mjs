#!/usr/bin/env node
// Validate this folder as a Capy plugin: the Agent Plugins 1.0.0 JSON schemas (copied unchanged from
// https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and .../mcp.schema.json on 15 Nov 2026)
// plus the extra rules in Capy's plugin docs (https://docs.capy.ai/integrations/plugins).
// Zero dependencies: a small JSON Schema checker covering the keywords these two schemas use.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export function check(schema, value, root = schema, at = '$') {
  const errs = [];
  const s = schema.$ref ? root.$defs[schema.$ref.replace('#/$defs/', '')] : schema;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (s.type && s.type !== type) return [`${at}: expected ${s.type}, got ${type}`];
  if ('const' in s && value !== s.const) errs.push(`${at}: must equal ${JSON.stringify(s.const)}`);
  if (type === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && value.length > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) errs.push(`${at}: does not match ${s.pattern}`);
  }
  if (type === 'object') {
    for (const r of s.required || []) if (!(r in value)) errs.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (s.propertyNames?.not?.enum?.includes(k)) errs.push(`${at}: property name ${k} not allowed`);
      if (s.properties && k in s.properties) errs.push(...check(s.properties[k], v, root, `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unexpected property ${k}`);
      else if (typeof s.additionalProperties === 'object') errs.push(...check(s.additionalProperties, v, root, `${at}.${k}`));
    }
  }
  if (type === 'array' && s.items) value.forEach((v, idx) => errs.push(...check(s.items, v, root, `${at}[${idx}]`)));
  if (s.oneOf) {
    const ok = s.oneOf.filter((o) => check(o, value, root, at).length === 0).length;
    if (ok !== 1) errs.push(`${at}: must match exactly one server shape (matched ${ok})`);
  }
  return errs;
}

function frontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) { const k = /^([\w-]+):\s*(.*)$/.exec(line); if (k) out[k[1]] = k[2].replace(/^["']|["']$/g, ''); }
  return out;
}

function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === '.git' || e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])); }

export function validate(root = ROOT) {
  const errors = [];
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const pluginSchema = JSON.parse(fs.readFileSync(path.join(HERE, 'schemas', 'plugin.schema.json'), 'utf8'));
  const mcpSchema = JSON.parse(fs.readFileSync(path.join(HERE, 'schemas', 'mcp.schema.json'), 'utf8'));
  const plugin = read('plugin.json');
  errors.push(...check(pluginSchema, plugin).map((e) => `plugin.json ${e}`));
  const version = /schemas\/(\d+\.\d+\.\d+)\//.exec(plugin.$schema || '')?.[1];
  if (!['1.0.0', '1.1.0'].includes(version)) errors.push('plugin.json: Capy accepts Agent Plugins 1.0.0 or 1.1.0');
  if (fs.existsSync(path.join(root, 'mcp.json'))) {
    const mcp = read('mcp.json');
    errors.push(...check(mcpSchema, mcp).map((e) => `mcp.json ${e}`));
    if (/schemas\/(\d+\.\d+\.\d+)\//.exec(mcp.$schema || '')?.[1] !== version) errors.push('mcp.json: $schema version must match plugin.json');
    for (const [name, srv] of Object.entries(mcp.mcpServers || {})) {
      if (srv.headers && Object.keys(srv.headers).some((h) => /authorization|api[-_]?key|token/i.test(h))) errors.push(`mcp.json: server ${name} carries a credential header (Capy skips it; use secrets)`);
      if (!plugin.extensions?.['ai.capy']?.recipes?.[name] && srv.type !== 'stdio') errors.push(`plugin.json: remote server ${name} has no ai.capy recipe (it would default to OAuth)`);
    }
  }
  const capy = plugin.extensions?.['ai.capy'];
  if (capy?.icon) {
    const p = path.join(root, capy.icon);
    if (!fs.existsSync(p)) errors.push(`icon ${capy.icon} missing`);
    else if (fs.statSync(p).size > 256 * 1024) errors.push('icon larger than 256 KiB');
  }
  const skillsDir = path.join(root, 'skills');
  const skills = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  if (!skills.length) errors.push('no skills found');
  for (const d of skills) {
    if (!/^[a-z0-9-]{1,64}$/.test(d.name)) errors.push(`skill folder ${d.name}: lowercase letters, digits and hyphens, up to 64 characters`);
    const f = path.join(skillsDir, d.name, 'SKILL.md');
    if (!fs.existsSync(f)) { errors.push(`skills/${d.name}: missing SKILL.md`); continue; }
    const fm = frontmatter(fs.readFileSync(f, 'utf8'));
    if (!fm?.description) errors.push(`skills/${d.name}: frontmatter needs a description`);
    else if (fm.description.length > 1024) errors.push(`skills/${d.name}: description is ${fm.description.length} characters (max 1,024)`);
    if (fm?.name && fm.name !== d.name) errors.push(`skills/${d.name}: frontmatter name "${fm.name}" differs from the folder name`);
  }
  const files = walk(root);
  const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  if (files.length > 2000) errors.push(`${files.length} files (max 2,000)`);
  if (bytes > 20 * 1024 * 1024) errors.push(`${bytes} bytes (max 20 MiB)`);
  return { errors, skills: skills.map((d) => d.name), files: files.length, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const r = validate();
  if (r.errors.length) { console.error(r.errors.map((e) => `✗ ${e}`).join('\n')); process.exitCode = 1; }
  else console.log(`✓ Valid Capy plugin: ${r.skills.length} skill(s) [${r.skills.join(', ')}], ${r.files} files, ${(r.bytes / 1024).toFixed(1)} KiB`);
}
