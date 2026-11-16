#!/usr/bin/env node
// 1. Copy lib/*.mjs into skills/import/scripts/, so the skill works on its own wherever a host copies it
//    (a Capy cloud machine, a Drive skill folder, ~/.claude/skills). The other two skills use ../import/scripts/.
// 2. Build the three SKILL.md files and the remote server's playbook from playbook/PLAYBOOK.md.
// lib/ and playbook/ are the sources of truth; a test fails if a copy drifts. Run: npm run sync
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTPUTS } from '../playbook/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(ROOT, 'lib');
const files = fs.readdirSync(lib).filter((f) => f.endsWith('.mjs'));
const dst = path.join(ROOT, 'skills', 'import', 'scripts');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of files) { fs.copyFileSync(path.join(lib, f), path.join(dst, f)); fs.chmodSync(path.join(dst, f), 0o755); }
for (const [rel, build] of Object.entries(OUTPUTS)) { fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true }); fs.writeFileSync(path.join(ROOT, rel), build()); }
console.log(`Synced ${files.length} scripts into skills/import/scripts and built ${Object.keys(OUTPUTS).join(', ')} from playbook/PLAYBOOK.md.`);
