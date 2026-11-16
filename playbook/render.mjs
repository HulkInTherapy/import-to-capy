// Builds every copy of the import playbook from playbook/PLAYBOOK.md, the one source:
// the three skills (for cloud threads, where Capy copies plugin skills) and server/api/_playbook.js
// (what the remote MCP server hands to threads on the user's own computer, which get remote servers only).
// tools/sync.mjs writes the files; tests/plugin.test.mjs fails if any of them drift.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const SOURCE_FILE = path.join(HERE, 'PLAYBOOK.md');
const PKG = 'github:HulkInTherapy/import-to-capy';
const NOTE = 'Generated from playbook/PLAYBOOK.md by `npm run sync`. Edit there, not here.';

export const APPS = { conductor: 'Conductor', t3code: 'T3 Code' };
export const sourceNote = (source) => `The source is already answered: **${APPS[source]}**. Skip the source question.`;

export function sections(text = fs.readFileSync(SOURCE_FILE, 'utf8')) {
  const out = {};
  const parts = text.split(/^<!-- @section ([\w:-]+) -->\n/m);
  for (let k = 1; k < parts.length; k += 2) out[parts[k]] = parts[k + 1].trim();
  for (const need of ['flow', 'conductor', 't3code', 'help', 'description:import']) if (!out[need]) throw new Error(`PLAYBOOK.md has no "${need}" section`);
  return out;
}

// The lines that set $run and $c2c. A skill prefers the scripts bundled next to it; a server thread uses npx.
export function runLines(scripts) {
  const npx = [`run="npx -y -p ${PKG} import-to-capy"`, `c2c="npx -y -p ${PKG} conductor-to-capy"`];
  if (!scripts) return npx.join('\n');
  return [`S="${scripts}/import-to-capy.mjs"     # bundled with this skill; npx is the fallback`,
    `if [ -f "$S" ]; then run="node $S"; c2c="node \${S%/*}/conductor-to-capy.mjs"`,
    `else ${npx.join('; ')}; fi`].join('\n');
}

const fill = (text, scripts) => text.replaceAll('{{RUN}}', runLines(scripts));

export const SKILLS = {
  import: { title: 'Import from Conductor or T3 Code', scripts: "<this skill's folder>/scripts" },
  'import-from-conductor': { title: 'Import from Conductor', source: 'conductor', scripts: "<this skill's folder>/../import/scripts",
    extra: 'Rules for converting setup by hand are in `REFERENCE.md` next to this file.' },
  'import-from-t3code': { title: 'Import from T3 Code', source: 't3code', scripts: "<this skill's folder>/../import/scripts" },
};

export function renderSkill(name, s = sections()) {
  const k = SKILLS[name];
  const desc = s[`description:${name}`];
  const body = [`# ${k.title}`];
  if (k.source) body.push(sourceNote(k.source));
  body.push(fill(s.flow, k.scripts));
  for (const src of k.source ? [k.source] : Object.keys(APPS)) body.push(`## ${APPS[src]}${k.source ? ' specifics' : ''}\n\n${fill(s[src], k.scripts)}`);
  if (k.extra) body.push(k.extra);
  return `---\nname: ${name}\ndescription: ${desc}\n---\n\n<!-- ${NOTE} -->\n\n${body.join('\n\n')}\n`;
}

export function renderServerModule(s = sections(), version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version) {
  const data = { version, flow: fill(s.flow), conductor: fill(s.conductor), t3code: fill(s.t3code), help: s.help,
    sourceNote: Object.fromEntries(Object.keys(APPS).map((k) => [k, sourceNote(k)])), apps: APPS };
  return `// ${NOTE}\nexport const PLAYBOOK = ${JSON.stringify(data, null, 2)};\n`;
}

export const OUTPUTS = {
  ...Object.fromEntries(Object.keys(SKILLS).map((n) => [path.join('skills', n, 'SKILL.md'), () => renderSkill(n)])),
  [path.join('server', 'api', '_playbook.js')]: () => renderServerModule(),
};
