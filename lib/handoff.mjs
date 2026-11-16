// Build a condensed handoff (and optionally a full transcript) for one imported thread.
// Everything that leaves this module has passed through the redactor.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactor } from './redact.mjs';
import { fmtDate } from './select.mjs';

const clip = (s, n) => { const t = String(s || '').replace(/\s+\n/g, '\n').trim(); return t.length > n ? t.slice(0, n).trimEnd() + ' …' : t; };
// Quote a block so headings or rules inside a chat can't break the handoff's own structure.
const quote = (s) => String(s).split('\n').map((l) => `> ${l}`).join('\n');
const oneLine = (s, n) => clip(String(s || '').replace(/\s+/g, ' '), n);

const FILE_RE = /(?:^|[\s`'"(\[:])((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8}|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|md|json|toml|yaml|yml|css|scss|html|sql|sh))(?=$|[\s`'",):;\]])/g;

export function filesTouched(messages) {
  const seen = new Map();
  for (const m of messages) {
    const blobs = [m.text, m.raw].filter(Boolean).join('\n');
    for (const mm of blobs.matchAll(/"(?:file_path|path|filePath|filename)"\s*:\s*"([^"]{3,200})"/g)) seen.set(mm[1], (seen.get(mm[1]) || 0) + 3);
    for (const mm of String(m.text || '').matchAll(FILE_RE)) { const f = mm[1]; if (!/^https?:/.test(f) && !/^\d/.test(f)) seen.set(f, (seen.get(f) || 0) + 1); }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 15);
}

export function todos(messages) {
  const out = [];
  const recent = messages.slice(-12);
  for (const m of recent) {
    for (const line of String(m.text || '').split('\n')) {
      const l = line.trim();
      if (/^[-*]\s*\[ \]\s+/.test(l) || /^(TODO|FIXME|Next( steps?)?|Remaining|Still to do|Left to do)\b[:\s-]/i.test(l) || (/^[-*\d.]+\s+/.test(l) && /\b(todo|next|remaining|still need|left to)\b/i.test(l))) out.push(oneLine(l.replace(/^[-*]\s*(\[ \]\s*)?/, ''), 200));
    }
  }
  return [...new Set(out)].slice(-10);
}

export function decisions(messages) {
  const out = [];
  const re = /\b(decided|we'?ll go with|going with|chose|choosing|switched to|instead of|settled on|the plan is|approach:|we will use|let'?s use)\b/i;
  for (const m of messages) {
    if (m.role !== 'assistant' && m.role !== 'user') continue;
    for (const s of String(m.text || '').split(/(?<=[.!?])\s+|\n/)) if (re.test(s) && s.length > 20) out.push(oneLine(s, 220));
  }
  return [...new Set(out)].slice(-8);
}

// thread: { title, source, projectName, branch, prs, createdAt, updatedAt, native, provider }
// messages: [{ role: 'user'|'assistant'|..., text, raw?, at }]
export function buildHandoff(thread, messages, { exchanges = 3 } = {}) {
  const r = redactor();
  const said = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim());
  const firstUser = said.find((m) => m.role === 'user');
  const lastAssistant = [...said].reverse().find((m) => m.role === 'assistant');
  const tail = [];
  for (let k = said.length - 1; k >= 0 && tail.filter((m) => m.role === 'user').length < exchanges; k--) tail.unshift(said[k]);
  const pr = thread.prs?.[0];
  const L = [];
  L.push(`# ${r(thread.title || 'Untitled thread')}`, '');
  L.push(`Imported from ${thread.source} by import-to-capy on ${new Date().toISOString().slice(0, 10)}.`, '');
  L.push(`- **Project:** ${r(thread.projectName || '')}${thread.projectPath ? ` (${r(thread.projectPath)})` : ''}`);
  if (thread.branch) L.push(`- **Branch:** \`${r(thread.branch)}\``);
  if (pr) L.push(`- **Pull request:** ${pr.url ? r(pr.url) : `#${pr.number}`}${pr.state ? ` (${pr.state})` : ''}${pr.title ? `: ${r(pr.title)}` : ''}`);
  L.push(`- **Active:** ${fmtDate(thread.createdAt)} → ${fmtDate(thread.updatedAt)}; ${said.length} messages${thread.provider ? `; agent: ${thread.provider}` : ''}`);
  if (thread.native?.path) L.push(`- **Native session:** ${thread.native.kind} session \`${thread.native.id}\` is on this computer; Capy's desktop app can import Claude Code and Codex histories as threads.`);
  if (thread.notes) L.push(`- **Notes:** ${r(oneLine(thread.notes, 600))}`);
  L.push('', '## Goal', '', firstUser ? quote(r(clip(firstUser.text, 700))) : '_No user message found._');
  const dec = decisions(said);
  L.push('', '## Key decisions', '', ...(dec.length ? dec.map((d) => `- ${r(d)}`) : ['_None detected; skim the last exchanges below._']));
  const files = filesTouched(messages);
  L.push('', '## Files touched', '', ...(files.length ? files.map((f) => `- \`${r(f)}\``) : ['_None detected._']));
  const td = todos(said);
  L.push('', '## Open TODOs', '', ...(td.length ? td.map((t) => `- [ ] ${r(t)}`) : ['_None detected._']));
  L.push('', '## Last state', '', lastAssistant ? quote(r(clip(lastAssistant.text, 900))) : '_No agent reply found._');
  L.push('', `## Last ${exchanges} exchanges (verbatim, trimmed)`, '');
  for (const m of tail) L.push(`**${m.role === 'user' ? 'You' : 'Agent'}** (${fmtDate(m.at)}):`, '', quote(r(clip(m.text, 1500))), '');
  L.push('---', `Secrets redacted: ${r.total.count}. This is a draft handoff written by a script; the importing agent should tighten "Goal" and "Key decisions".`);
  return { markdown: L.join('\n') + '\n', redacted: r.total.count, kinds: r.total.kinds };
}

export function buildTranscript(thread, messages) {
  const r = redactor();
  const L = [`# Transcript: ${r(thread.title || 'Untitled thread')}`, '', `From ${thread.source}, project ${r(thread.projectName || '')}. Redacted copy; tool output trimmed.`, ''];
  for (const m of messages) {
    if (!String(m.text || '').trim()) continue;
    L.push(`### ${m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Agent' : m.role} · ${m.at || ''}`, '', quote(r(clip(m.text, 6000))), '');
  }
  L.push('---', `Secrets redacted: ${r.total.count}.`);
  return { markdown: L.join('\n') + '\n', redacted: r.total.count, kinds: r.total.kinds };
}

export const slug = (s) => String(s || 'thread').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'thread';

// A short prompt for capy.ai/new?prompt= (keeps the URL small; the full handoff goes in the thread or issue body).
export function continuePrompt(thread, handoffMd) {
  const goal = (/## Goal\n\n([\s\S]*?)\n\n## /.exec(handoffMd) || [])[1] || '';
  const state = (/## Last state\n\n([\s\S]*?)\n\n## /.exec(handoffMd) || [])[1] || '';
  const unq = (x) => x.replace(/^> ?/gm, '');
  const r = redactor();
  return r(`Continue "${thread.title || 'an imported thread'}" from ${thread.source}${thread.branch ? `, on branch \`${thread.branch}\`` : ''}. ` +
    `Goal: ${oneLine(unq(goal), 350)} Last state: ${oneLine(unq(state), 450)} Read the branch first, tell me in a few lines where it stands, and wait for my go-ahead before changing code.`);
}

// Output folder that git ignores by itself (contains a .gitignore of "*"), outside main unless the user asks.
export function outputDir(base) {
  const dir = base || path.join(process.cwd(), '.capy-import', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  fs.mkdirSync(dir, { recursive: true });
  const root = base ? dir : path.dirname(dir);
  if (!fs.existsSync(path.join(root, '.gitignore'))) fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  return dir;
}

export const homeDir = () => os.homedir();
