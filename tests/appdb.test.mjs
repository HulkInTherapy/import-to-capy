// Tests against a synthetic Conductor database built from the real app's schema (tests/fixtures/conductor-db/schema.sql,
// dumped with `.schema` from Conductor 0.94.2: structure only, no data). All rows below are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sh, hasSqlite, world } from './helpers.mjs';
import { readAppRows, modelFromAppRow, convert, renderChecklist, loadRepo } from '../lib/conductor-to-capy.mjs';
import { collect, messageText } from '../lib/conductor-workspaces.mjs';

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'conductor-db', 'schema.sql');
const skip = !hasSqlite && 'sqlite3 not installed';

function buildDb(dir, root) {
  const db = path.join(dir, 'conductor.db');
  const q = (s) => s.replace(/'/g, "''");
  sh(dir, 'sqlite3', db, `.read ${SCHEMA}`);
  sh(dir, 'sqlite3', db, `PRAGMA journal_mode=WAL;
    INSERT INTO local_workspace_revision_counter (id, latest_revision) VALUES (1, 0);
    INSERT INTO repos (id, name, root_path, remote_url, setup_script, run_script, archive_script, run_script_mode, custom_prompt_code_review)
      VALUES ('r1', 'app', '${q(root)}', '', 'pnpm install', 'pnpm dev --port $CONDUCTOR_PORT', 'rm -rf .cache', 'nonconcurrent', 'Flag raw SQL.');
    INSERT INTO env_vars (key, scope, context, value) VALUES ('DATABASE_URL', 'repo', 'r1', 'SECRET-DB-VALUE');
    INSERT INTO env_vars (key, scope, context, value) VALUES ('OPENAI_API_KEY', 'user', NULL, 'SECRET-KEY-VALUE');
    INSERT INTO workspaces (local_id, id, repository_id, directory_name, branch, state, pr_title, pr_description, notes, intended_target_branch)
      VALUES ('w1', 'w1', 'r1', 'lisbon', 'me/lisbon', 'ready', 'Billing page', 'Adds the billing page.', 'Stripe webhooks left', 'main');
    INSERT INTO workspaces (local_id, id, repository_id, directory_name, branch, state) VALUES ('w2', 'w2', 'r1', 'paris', 'me/paris', 'archived');
    INSERT INTO sessions (id, workspace_id, title, status, agent_type, claude_session_id, updated_at, last_message_at)
      VALUES ('s1', 'w1', 'Old chat', 'idle', 'claude', 'cs-1', '2026-11-01 10:00:00', '2026-11-01 10:00:00');
    INSERT INTO sessions (id, workspace_id, title, status, agent_type, claude_session_id, updated_at, last_message_at)
      VALUES ('s2', 'w1', 'Stripe webhooks', 'idle', 'claude', 'cs-2', '2026-11-10 10:00:00', '2026-11-10 10:00:00');
    INSERT INTO session_messages (id, session_id, role, content, created_at) VALUES ('m1', 's2', 'user', 'SECRET-CHAT-USER please add webhooks', '2026-11-10 09:00:00');
    INSERT INTO session_messages (id, session_id, role, content, created_at)
      VALUES ('m2', 's2', 'assistant', '{"type":"assistant","message":{"content":[{"type":"text","text":"Webhooks are half done."}]}}', '2026-11-10 09:01:00');`);
  return db;
}

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('converter --from-app: scripts, prompts and env var NAMES from the app; values never read', { skip }, () => {
  const { t, root } = world();
  const db = buildDb(t, root);
  const before = hash(db);
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('conductor-db-')).length;
  const rows = readAppRows(db);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes('SECRET'), 'env values are never selected');
  const m = loadRepo(root, { fromApp: true, appDb: db, home: '' });
  const r = convert(m);
  assert.equal(r.setup.scripts.initialize, '. ./.capy/conductor-env.sh && pnpm install');
  assert.equal(r.setup.commands[0].port, 3000);
  assert.deepEqual(r.envNames.sort(), ['DATABASE_URL', 'OPENAI_API_KEY']);
  const md = renderChecklist(m, r);
  assert.match(md, /## Reviews\n\nFlag raw SQL\./);
  assert.ok(!md.includes('SECRET'));
  assert.equal(hash(db), before, 'the source database is untouched');
  assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('conductor-db-')).length, tmpBefore, 'temporary copy removed');
});

test('workspaces from the app: latest session metadata by default, message text only on request', { skip }, () => {
  const { t, root } = world();
  const db = buildDb(t, root);
  const plain = collect(root, { appDb: db });
  assert.equal(plain.appDatabase.workspaces, 1, 'archived workspace dropped');
  const lisbon = plain.items.find((i) => i.branch === 'me/lisbon');
  assert.equal(lisbon.sessionCount, 2);
  assert.equal(lisbon.latestSession.title, 'Stripe webhooks');
  assert.equal(lisbon.latestSession.messages, 2);
  assert.equal(lisbon.latestSession.claudeSessionId, 'cs-2');
  assert.equal(lisbon.pr_description, 'Adds the billing page.');
  assert.ok(!JSON.stringify(plain).includes('SECRET-CHAT'), 'no message text without --include-session-text');
  const withText = collect(root, { appDb: db, includeSessionText: true });
  const l2 = withText.items.find((i) => i.branch === 'me/lisbon');
  assert.equal(l2.latestSession.lastAssistantMessage, 'Webhooks are half done.');
  assert.match(l2.latestSession.lastUserMessage, /please add webhooks/);
  assert.ok(!l2.prompt.includes('SECRET-CHAT'), 'raw chat text never goes into the Capy prompt');
});

test('messageText', () => {
  assert.equal(messageText('{"a":[{"text":"x"},{"b":{"text":"y"}}]}'), 'x y');
  assert.equal(messageText('plain  text'), 'plain text');
  assert.equal(messageText(null), '');
});
