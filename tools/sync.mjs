#!/usr/bin/env node
// Copy lib/*.mjs into skills/import/scripts/, so the skill works on its own wherever a host copies it
// (a Capy plugin, a Drive skill folder, ~/.claude/skills). The other two skills use ../import/scripts/.
// lib/ is the source of truth; a test fails if the copy drifts. Run: npm run sync
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(ROOT, 'lib');
const files = fs.readdirSync(lib).filter((f) => f.endsWith('.mjs'));
const dst = path.join(ROOT, 'skills', 'import', 'scripts');
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of files) { fs.copyFileSync(path.join(lib, f), path.join(dst, f)); fs.chmodSync(path.join(dst, f), 0o755); }
console.log(`Synced ${files.length} scripts into skills/import/scripts.`);
