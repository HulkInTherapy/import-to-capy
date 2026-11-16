// Find the native Claude Code or Codex session file behind an imported thread, if it is on this computer.
// Capy's desktop app can import Claude Code and Codex histories as threads (changelog 0.2.0), so when a file
// exists, that native import is the better path and our handoff is the fallback.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function findClaudeSession(id, home = os.homedir()) {
  if (!id || !/^[\w-]{8,}$/.test(id)) return null;
  const root = path.join(home, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return { kind: 'Claude Code', id, path: f }; }
  return null;
}

export function findCodexSession(id, home = os.homedir(), { maxFiles = 20000 } = {}) {
  if (!id || !/^[\w-]{8,}$/.test(id)) return null;
  const root = path.join(home, '.codex', 'sessions');
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < maxFiles) {
    const dir = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.jsonl') && e.name.includes(id)) return { kind: 'Codex', id, path: p };
    }
  }
  return null;
}

export function findNative(provider, id, home) {
  const p = String(provider || '').toLowerCase();
  if (p.includes('codex')) return findCodexSession(id, home);
  if (p.includes('claude') || !p) return findClaudeSession(id, home);
  return null;
}
