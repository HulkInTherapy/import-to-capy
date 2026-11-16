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

test('every skill carries an identical copy of lib/ (run npm run sync after editing lib)', () => {
  const lib = path.join(ROOT, 'lib');
  for (const skill of fs.readdirSync(path.join(ROOT, 'skills'))) {
    for (const f of fs.readdirSync(lib)) {
      const copy = path.join(ROOT, 'skills', skill, 'scripts', f);
      assert.ok(fs.existsSync(copy), `${skill} is missing ${f}`);
      assert.equal(fs.readFileSync(copy, 'utf8'), fs.readFileSync(path.join(lib, f), 'utf8'), `${skill}/scripts/${f} drifted`);
    }
  }
});
