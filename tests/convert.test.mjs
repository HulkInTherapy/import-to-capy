import { test } from 'node:test';
import { tmpdir } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseToml, loadRepo, convert, modelFromAppRow, pickAppRow, detectInstall, portFrom,
  referencedPaths, renderChecklist, run,
} from '../lib/conductor-to-capy.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name) => loadRepo(path.join(FIX, name), { noGit: true });
const statuses = (r, s) => r.report.filter((x) => x.status === s).map((x) => x.conductor);
const silent = { log: () => {}, err: () => {} };

// ---- real fixture 1: cloudposse/docs (legacy conductor.json + a setup script file) ----
test('cloudposse-docs: setup, refresh from the script file, run command with CONDUCTOR_PORT', () => {
  const m = load('cloudposse-docs');
  assert.equal(m.source, 'conductor.json');
  const r = convert(m);
  assert.equal(r.setup.$schema, 'https://api.capy.ai/schemas/setup.v1.json');
  assert.equal(r.setup.format_version, 1);
  assert.equal(r.setup.scripts.initialize, '. ./.capy/conductor-env.sh && ./scripts/conductor-setup.sh');
  assert.equal(r.setup.scripts.refresh, 'npm install', 'install command found inside scripts/conductor-setup.sh');
  assert.deepEqual(r.setup.commands, [{ name: 'run', command: '. ./.capy/conductor-env.sh && npm start -- --port $CONDUCTOR_PORT', port: 3000 }]);
  assert.match(r.envShim, /CONDUCTOR_PORT:-3000/);
  assert.ok(statuses(r, 'changed').some((c) => c.includes('nonconcurrent')));
});

test('custom --port moves CONDUCTOR_PORT and the published port', () => {
  const r = convert(load('cloudposse-docs'), { port: 5173 });
  assert.equal(r.setup.commands[0].port, 5173);
  assert.match(r.envShim, /CONDUCTOR_PORT:-5173/);
});

// ---- real fixture 2: hicommonwealth/commonwealth (inline setup, docker, .env from root) ----
test('commonwealth: docker services become a startup entry, .env-from-root is flagged', () => {
  const r = convert(load('commonwealth'));
  assert.equal(r.setup.scripts.refresh, 'pnpm install');
  assert.ok(r.setup.scripts.initialize.startsWith('. ./.capy/conductor-env.sh && pnpm install;'));
  assert.deepEqual(r.setup.startup, [{ name: 'services', command: 'docker compose up -d --wait' }]);
  assert.ok(statuses(r, 'manual').some((c) => c.includes('.env read from CONDUCTOR_ROOT_PATH')));
  assert.deepEqual(r.scan.conductorVars, ['CONDUCTOR_ROOT_PATH']);
});

// ---- real fixture 3: ZAAI-com/Clean-Autofill (.conductor/settings.toml, named actions) ----
test('clean-autofill: named actions become commands, local-only action skipped, unknown key reported', () => {
  const m = load('clean-autofill');
  assert.equal(m.source, '.conductor/settings.toml');
  const r = convert(m);
  assert.deepEqual(r.setup.commands.map((c) => c.name), ['build', 'verify', 'test-watch']);
  assert.equal(r.setup.scripts.initialize, 'bash .conductor/scripts/setup.sh');
  assert.equal(r.setup.scripts.refresh, undefined);
  assert.equal(r.envShim, null, 'no CONDUCTOR_* use, no shim');
  assert.ok(statuses(r, 'unmapped').some((c) => c.includes('`pack` (local only)')));
  assert.ok(statuses(r, 'unmapped').some((c) => c.includes('scripts.auto_run_after_setup')));
  assert.ok(statuses(r, 'unmapped').includes('Archive script'));
  assert.equal(statuses(r, 'manual').filter((c) => c.startsWith('Referenced file')).length, 3);
});

// ---- bonus real fixture: vercel/next.js (undocumented fields) ----
test('nextjs: undocumented environment and worktree fields are used, the rest reported', () => {
  const m = load('nextjs');
  assert.equal(m.defaultBranch, 'canary');
  const r = convert(m);
  assert.deepEqual(r.envNames, ['NEXT_TELEMETRY_DISABLED', 'TURBO_TELEMETRY_DISABLED']);
  const unknown = statuses(r, 'unmapped');
  for (const k of ['name', 'description', 'recommendations']) assert.ok(unknown.includes(`Unknown key \`${k}\``));
  assert.ok(!unknown.includes('Unknown key `environment`'));
  assert.ok(!JSON.stringify(r.setup).includes('TELEMETRY'), 'variables never go into setup.json');
});

// ---- synthetic cases ----
function tmpRepo(files) {
  const dir = tmpdir('c2c-');
  for (const [p, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), body); }
  return dir;
}

test('settings.toml wins over conductor.json, settings.local.toml overrides, local env names tracked', () => {
  const dir = tmpRepo({
    'conductor.json': '{"scripts":{"setup":"npm ci"}}',
    '.conductor/settings.toml': `"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
[scripts]
setup = "pnpm install --frozen-lockfile"
[scripts.run.web]
command = "pnpm dev"
args = ["--port", "$((CONDUCTOR_PORT + 1))"]
options = { cwd = "apps/web" }
default = true
available_in = ["local", "cloud"]
[environment_variables]
NODE_ENV = "development"
[environment_variables.local]
ONLY_HERE = "1"
[prompts]
general = """
Use conventional commits.
"""
code_review = 'Flag raw SQL.'
[[preview_urls]]
name = "Web"
url = "http://localhost:$CONDUCTOR_PORT"
`,
    '.conductor/settings.local.toml': '[environment_variables]\nAPI_TOKEN = "secret-value"\n',
    '.worktreeinclude': '.env.local\n',
    'AGENTS.md': '# rules\n',
  });
  const m = loadRepo(dir, { noGit: true });
  assert.ok(m.source.includes('settings.local.toml'));
  assert.ok(m.notes.some((n) => n.includes('conductor.json is present but ignored')));
  const r = convert(m);
  assert.equal(r.setup.scripts.initialize, '. ./.capy/conductor-env.sh && pnpm install --frozen-lockfile', 'shim applies everywhere once any script uses CONDUCTOR_*');
  assert.equal(r.setup.scripts.refresh, 'pnpm install --frozen-lockfile');
  const web = r.setup.commands[0];
  assert.equal(web.command, '. ./.capy/conductor-env.sh && cd apps/web && pnpm dev --port "$((CONDUCTOR_PORT + 1))"');
  assert.equal(web.port, 3001);
  assert.deepEqual(r.envNames.sort(), ['API_TOKEN', 'NODE_ENV']);
  assert.ok(statuses(r, 'unmapped').some((c) => c.includes('ONLY_HERE')));
  const md = renderChecklist(m, r);
  assert.match(md, /## Reviews\n\nFlag raw SQL\./);
  assert.match(md, /Use conventional commits\./);
  assert.ok(!md.includes('secret-value'), 'secret values are never printed');
  assert.ok(!JSON.stringify(r).includes('secret-value'));
  assert.ok(statuses(r, 'manual').some((c) => c.includes('Files to copy')));
  assert.ok(statuses(r, 'mapped').includes('AGENTS.md'));
});

test('--write creates files, refuses to overwrite, never touches Conductor files', () => {
  const dir = tmpRepo({ 'conductor.json': '{"scripts":{"setup":"bun install","run":"bun dev --port $CONDUCTOR_PORT","archive":"rm -rf tmp"}}' });
  const before = fs.readFileSync(path.join(dir, 'conductor.json'), 'utf8');
  assert.equal(run([dir, '--write'], silent), 0);
  const setup = JSON.parse(fs.readFileSync(path.join(dir, '.capy/setup.json'), 'utf8'));
  assert.equal(setup.scripts.refresh, 'bun install');
  assert.ok(fs.existsSync(path.join(dir, '.capy/conductor-env.sh')));
  assert.ok(fs.readFileSync(path.join(dir, 'CAPY-MIGRATION.md'), 'utf8').includes('The clicks left'));
  assert.equal(run([dir, '--write'], silent), 3, 'refuses without --force');
  assert.equal(run([dir, '--write', '--force'], silent), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'conductor.json'), 'utf8'), before);
});

test('no config returns exit code 2 and suggests --from-app', () => {
  let msg = '';
  assert.equal(run([tmpRepo({ 'README.md': 'x' })], { log: () => {}, err: (s) => { msg += s; } }), 2);
  assert.match(msg, /--from-app/);
});

test('app database rows: matched by folder or remote, JSON run scripts understood', () => {
  const rows = [
    { id: 'a', hidden: 1, root_path: '/x/repo', remote_url: '' },
    { id: 'b', hidden: 0, root_path: '/Users/me/conductor/repos/app', remote_url: 'git@github.com:acme/app.git',
      setup_script: 'npm ci', run_script: '{"web":{"command":"npm run dev","default":true}}', run_script_mode: 'concurrent',
      archive_script: '', custom_prompt_general: 'Be brief.', default_branch: 'main' },
  ];
  assert.equal(pickAppRow(rows, { root: '/somewhere/else', remote: 'https://github.com/acme/app' }).id, 'b');
  assert.equal(pickAppRow(rows, { root: '/x/repo', remote: '' }), null, 'hidden rows are ignored');
  const m = modelFromAppRow(rows[1]);
  m.scripts = {}; m.agentFiles = []; m.repoName = 'app';
  const r = convert(m);
  assert.equal(r.setup.scripts.refresh, 'npm ci');
  assert.deepEqual(r.setup.commands, [{ name: 'web', command: 'npm run dev' }]);
  assert.ok(statuses(r, 'manual').includes('Prompt: general'));
});

test('TOML reader handles the shapes Conductor documents', () => {
  const t = parseToml(`# comment
"$schema" = "x"
enterprise_data_privacy = true
[scripts]
setup = 'echo "hi"' # trailing comment
run_mode = "nonconcurrent"
[scripts.run.dev]
command = "npm run dev"
icon = "play"
hide = false
[git]
delete_branch_on_archive = true
[[preview_urls]]
url = "http://localhost:$CONDUCTOR_PORT"
[[preview_urls]]
name = "API"
url = "http://localhost:$((CONDUCTOR_PORT + 1))"
numbers = [1, 2,
  3]
a.b.c = "\\u00e9\\n"
`);
  assert.equal(t.$schema, 'x');
  assert.equal(t.scripts.setup, 'echo "hi"');
  assert.equal(t.scripts.run.dev.command, 'npm run dev');
  assert.equal(t.preview_urls.length, 2);
  assert.deepEqual(t.preview_urls[1].numbers, [1, 2, 3]);
  assert.equal(t.preview_urls[1].a.b.c, 'é\n');
  assert.throws(() => parseToml('a = "unterminated'), /TOML line 1/);
});

test('helpers', () => {
  assert.equal(detectInstall('npm init -y'), '');
  assert.equal(detectInstall('corepack enable && yarn install --immutable'), 'corepack enable && yarn install --immutable');
  assert.equal(portFrom('vite --port $((CONDUCTOR_PORT + 2))', 3000), 3002);
  assert.equal(portFrom('rails s -p 4000', 3000), 4000);
  assert.equal(portFrom('npm test', 3000), null);
  assert.deepEqual(referencedPaths('chmod +x ./scripts/a.sh && ./scripts/a.sh; bash .conductor/run.sh build').sort(), ['.conductor/run.sh', 'scripts/a.sh']);
});
