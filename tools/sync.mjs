#!/usr/bin/env node
// Copy lib/*.mjs into every skill's scripts/ folder, so each skill works on its own wherever a host copies it.
// lib/ is the source of truth; tests fail if a copy drifts. Run: npm run sync
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(ROOT, 'lib');
const files = fs.readdirSync(lib).filter((f) => f.endsWith('.mjs'));
for (const skill of fs.readdirSync(path.join(ROOT, 'skills'))) {
  const dst = path.join(ROOT, 'skills', skill, 'scripts');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of files) { fs.copyFileSync(path.join(lib, f), path.join(dst, f)); fs.chmodSync(path.join(dst, f), 0o755); }
}
console.log(`Synced ${files.length} scripts into ${fs.readdirSync(path.join(ROOT, 'skills')).length} skills.`);
