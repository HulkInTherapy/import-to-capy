import { test } from 'node:test';
import { tmpdir } from './helpers.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validate, check, ROOT } from './validate.mjs';

test('this folder is a valid Capy plugin', () => {
  const r = validate();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.skills.sort(), ['import', 'import-from-conductor', 'import-from-t3code']);
});

test('the validator catches what Capy rejects', () => {
  const t = tmpdir('c2c-plugin-');
  fs.cpSync(path.join(ROOT, 'skills'), path.join(t, 'skills'), { recursive: true });
  fs.renameSync(path.join(t, 'skills', 'import-from-conductor'), path.join(t, 'skills', 'Bad_Name'));
  fs.writeFileSync(path.join(t, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'Bad--name', extra: 1 }));
  fs.writeFileSync(path.join(t, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json', mcpServers: { x: { type: 'streamable-http', url: 'https://x', headers: { Authorization: 'Bearer y' } } } }));
  const errs = validate(t).errors.join('\n');
  assert.match(errs, /unexpected property extra/);
  assert.match(errs, /name: does not match/);
  assert.match(errs, /\$schema version must match/);
  assert.match(errs, /credential header/);
  assert.match(errs, /skill folder Bad_Name/);
});

test('schema checker: stdio server shape', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'schemas', 'mcp.schema.json'), 'utf8'));
  const ok = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { s: { type: 'stdio', command: 'node', args: ['./x.mjs'], cwd: './' } } };
  assert.deepEqual(check(schema, ok), []);
  ok.mcpServers.s.cwd = '/abs';
  assert.ok(check(schema, ok).length > 0);
});

test('skills/import carries an identical copy of lib/ (run npm run sync after editing lib)', () => {
  const lib = path.join(ROOT, 'lib');
  for (const f of fs.readdirSync(lib)) {
    const copy = path.join(ROOT, 'skills', 'import', 'scripts', f);
    assert.ok(fs.existsSync(copy), `skills/import is missing ${f}`);
    assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(lib, f), 'utf8'), `skills/import/scripts/${f} drifted`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'skills', 'import', 'scripts'))) assert.ok(fs.existsSync(path.join(lib, f)), `stale script ${f}`);
});

test('skill-only plugin: no MCP server (a local server never reaches Mac threads and shows "Not checked")', () => {
  const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers, {});
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'schemas', 'mcp.schema.json'), 'utf8'));
  assert.deepEqual(check(schema, mcp), []);
  assert.ok(!fs.existsSync(path.join(ROOT, 'lib', 'mcp-server.mjs')));
});

const skillText = (n) => fs.readFileSync(path.join(ROOT, 'skills', n, 'SKILL.md'), 'utf8');
const descOf = (n) => /description: (.*)/.exec(skillText(n))[1];

test('descriptions start with when to use them and name what people actually type', () => {
  for (const n of ['import', 'import-from-conductor', 'import-from-t3code']) {
    assert.match(descOf(n), /^Use when/);
    assert.ok(descOf(n).length <= 1024);
  }
  const all = ['import', 'import-from-conductor', 'import-from-t3code'].map(descOf).join(' ').toLowerCase();
  for (const phrase of ['import from conductor', 'import from t3 code', 'bring my threads over', 'move my conductor', 'import my t3 threads']) assert.ok(all.includes(phrase), phrase);
});

test('skills ask with question cards and rule out the detours from the first test', () => {
  for (const n of ['import', 'import-from-conductor', 'import-from-t3code']) {
    const s = skillText(n);
    assert.match(s, /clarify_questions/, `${n} names the question tool`);
    assert.match(s, /capy:\/\/app\/settings\/import|native --source/, `${n} uses Capy's own import`);
    assert.match(s, /never ask for computer use|no computer use/i);
    assert.match(s, /npx -y -p github:HulkInTherapy\/import-to-capy/, `${n} works without bundled scripts`);
  }
  assert.match(skillText('import'), /Never look for MCP tools/);
  assert.match(skillText('import'), /never send the user to Settings/);
});
