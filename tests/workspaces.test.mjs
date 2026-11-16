import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sh, hasSqlite, world } from './helpers.mjs';
import { collect, parseWorktrees, looksLikeConductor, deepLink, render } from '../lib/conductor-workspaces.mjs';

test('lists Conductor worktrees and unmerged remote branches, flags what is not on GitHub', () => {
  const { root } = world();
  const r = collect(root, { noApp: true });
  assert.equal(r.base, 'main');
  const by = Object.fromEntries(r.items.map((i) => [i.branch, i]));
  assert.deepEqual(Object.keys(by).sort(), ['me/lisbon', 'me/oslo', 'teammate/fix']);
  assert.equal(by['me/lisbon'].conductor, true);
  assert.equal(by['me/lisbon'].ahead, 1);
  assert.equal(by['me/lisbon'].needsPush, false);
  assert.equal(by['me/oslo'].uncommittedFiles, 1);
  assert.equal(by['me/oslo'].needsPush, true);
  assert.equal(by['teammate/fix'].source, 'remote');
  assert.equal(by['teammate/fix'].lastCommit, 'Fix login');
  assert.ok(by['me/lisbon'].capyLink.startsWith('https://capy.ai/new?prompt='));
  assert.match(decodeURIComponent(by['me/lisbon'].capyLink), /Wait for my go-ahead/);
  assert.match(render(r), /NOT on GitHub yet/);
});

test('--remote-only is what a cloud machine sees', () => {
  const { root } = world();
  const r = collect(root, { noApp: true, remoteOnly: true });
  assert.deepEqual(r.items.map((i) => i.branch).sort(), ['me/lisbon', 'teammate/fix']);
});

test('enriches from a Conductor app database without reading chats', { skip: !hasSqlite && 'sqlite3 not installed' }, () => {
  const { t, root } = world();
  const db = path.join(t, 'conductor.db');
  // Same column names as the Mac app's `repos` and `workspaces` tables (subset), plus a chat table that must never be read.
  sh(t, 'sqlite3', db, `CREATE TABLE repos (id TEXT, root_path TEXT, remote_url TEXT, hidden INTEGER);
    CREATE TABLE workspaces (id TEXT, repository_id TEXT, directory_name TEXT, branch TEXT, state TEXT, pr_title TEXT, notes TEXT, intended_target_branch TEXT, DEPRECATED_archived INTEGER);
    CREATE TABLE session_messages (id TEXT, content TEXT);
    INSERT INTO repos VALUES ('r1', '${root}', '', 0);
    INSERT INTO workspaces VALUES ('w1','r1','lisbon','me/lisbon','ready','Billing page','Halfway: Stripe webhooks left','main',0);
    INSERT INTO workspaces VALUES ('w2','r1','paris','me/paris','archived','Old','', 'main',0);
    INSERT INTO workspaces VALUES ('w3','r1','rome','me/rome','ready','','', 'main',0);
    INSERT INTO session_messages VALUES ('m1','SECRET CHAT CONTENT');`);
  const r = collect(root, { appDb: db });
  assert.equal(r.appDatabase.workspaces, 2, 'archived workspace dropped');
  const lisbon = r.items.find((i) => i.branch === 'me/lisbon');
  assert.equal(lisbon.pr_title, 'Billing page');
  assert.match(lisbon.prompt, /Stripe webhooks left/);
  const rome = r.items.find((i) => i.branch === 'me/rome');
  assert.equal(rome.missing, true);
  assert.ok(!JSON.stringify(r).includes('SECRET CHAT CONTENT'));
});

test('helpers', () => {
  const w = parseWorktrees('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b/conductor/workspaces/app/x\nHEAD 2\nbranch refs/heads/me/x\n\nworktree /c\nHEAD 3\ndetached\n');
  assert.equal(w.length, 3); assert.equal(w[1].branch, 'me/x'); assert.equal(w[2].detached, true);
  assert.ok(looksLikeConductor('/Users/me/conductor/workspaces/app/lisbon'));
  assert.ok(looksLikeConductor('/repo/.conductor/lisbon'));
  assert.ok(!looksLikeConductor('/Users/me/src/app'));
  assert.equal(deepLink('a b&c'), 'https://capy.ai/new?prompt=a%20b%26c');
});
