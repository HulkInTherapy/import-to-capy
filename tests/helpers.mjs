import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// A temp folder that is deleted when the test process exits.
export const tmpdir = (prefix) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };

export const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() } }).trim();
export const hasSqlite = (() => { try { execFileSync('sqlite3', ['-version']); return true; } catch { return false; } })();

// A realistic layout: origin, a root checkout under conductor/repos, two Conductor worktrees, one remote-only branch.
export function world() {
  const t = tmpdir('c2c-ws-');
  const origin = path.join(t, 'origin.git');
  sh(t, 'git', 'init', '-q', '--bare', '-b', 'main', origin);
  const root = path.join(t, 'conductor', 'repos', 'app');
  sh(t, 'git', 'clone', '-q', origin, root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  sh(root, 'git', 'add', '.'); sh(root, 'git', 'commit', '-qm', 'init'); sh(root, 'git', 'push', '-q', 'origin', 'main');
  sh(root, 'git', 'remote', 'set-head', 'origin', 'main');
  const ws = (name, branch) => { const p = path.join(t, 'conductor', 'workspaces', 'app', name); sh(root, 'git', 'worktree', 'add', '-q', '-b', branch, p, 'main'); return p; };
  const lisbon = ws('lisbon', 'me/lisbon');
  fs.writeFileSync(path.join(lisbon, 'b.txt'), 'b\n'); sh(lisbon, 'git', 'add', '.'); sh(lisbon, 'git', 'commit', '-qm', 'Add billing page'); sh(lisbon, 'git', 'push', '-q', '-u', 'origin', 'me/lisbon');
  const oslo = ws('oslo', 'me/oslo');
  fs.writeFileSync(path.join(oslo, 'c.txt'), 'draft\n'); // uncommitted, never pushed
  sh(root, 'git', 'checkout', '-q', '-b', 'teammate/fix', 'main'); fs.writeFileSync(path.join(root, 'd.txt'), 'd\n');
  sh(root, 'git', 'add', '.'); sh(root, 'git', 'commit', '-qm', 'Fix login'); sh(root, 'git', 'push', '-q', 'origin', 'teammate/fix');
  sh(root, 'git', 'checkout', '-q', 'main'); sh(root, 'git', 'branch', '-q', '-D', 'teammate/fix');
  return { t, root, lisbon, oslo };
}

