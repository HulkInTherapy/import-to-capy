// Turn a plain-language answer ("just api, latest 3 threads", "everything", "2 and 4", "last 7 days")
// into a concrete selection over a catalog. Same logic for Conductor and T3 Code.
//
// Catalog shape (built by the source readers):
//   { source, projects: [{ id, name, path, lastUsed, threads: [{ id, title, updatedAt, createdAt, branch,
//       prs: [{ url, number, state }], openWork, unfinished, archived, messageCount }] }] }

const DAY = 86400000;
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, a: 1, couple: 2, few: 3 };
const num = (s) => (s === undefined ? undefined : /^\d+$/.test(s) ? Number(s) : WORDNUM[s]);
const ts = (d) => (d ? Date.parse(String(d).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(d)) || String(d).includes('T') ? '' : 'Z')) || 0 : 0);

export function sortCatalog(cat) {
  for (const p of cat.projects) {
    p.threads.sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
    p.lastUsed = [p.lastUsed, ...p.threads.map((t) => t.updatedAt)].filter(Boolean).sort((a, b) => ts(b) - ts(a))[0] || '';
  }
  cat.projects.sort((a, b) => ts(b.lastUsed) - ts(a.lastUsed));
  return cat;
}

// The menu shows projects only (numbered), most recent first.
export function menu(cat, { max = 9 } = {}) {
  const lines = [];
  const shown = cat.projects.slice(0, max);
  shown.forEach((p, k) => {
    const live = p.threads.filter((t) => !t.archived);
    lines.push(`${k + 1}. ${p.name}: ${live.length} thread${live.length === 1 ? '' : 's'}, last used ${fmtDate(p.lastUsed)}`);
  });
  if (cat.projects.length > max) lines.push(`…and ${cat.projects.length - max} more (name one to include it)`);
  return lines.join('\n');
}

export const fmtDate = (d) => { const t = ts(d); return t ? new Date(t).toISOString().slice(0, 10) : 'unknown'; };

function matchProjects(text, projects) {
  const hits = new Set();
  for (const p of projects) {
    const names = [p.name, p.path ? p.path.split(/[\\/]/).filter(Boolean).pop() : ''].filter(Boolean).map((x) => x.toLowerCase());
    for (const n of names) {
      if (n.length < 2) continue;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text)) hits.add(p.id);
    }
  }
  return hits;
}

export function parseSelection(answer, cat, { now = Date.now() } = {}) {
  const raw = String(answer || '').trim();
  const text = ` ${raw.toLowerCase().replace(/[“”"']/g, '')} `;
  const projects = cat.projects;
  const why = [];
  const out = { projectIds: [], threadIds: [], explain: '', needsClarification: false, question: '' };
  if (!projects.length) return { ...out, explain: 'Nothing to import.' };

  const includeArchived = /\b(including|incl\.?|with|and) archived\b|\barchived too\b/.test(text);
  let pool = projects;
  let threadFilter = (t) => includeArchived || !t.archived;
  let limit = null;
  let defaulted = false;

  const isDefault = /^\s*(|default|defaults|you pick|whatever|sure|ok|okay|yes|y|go|go ahead|sounds good|fine|start|recommended)\s*$/.test(text);
  const everything = /\b(everything|all of it|all projects|all threads|import all|the lot|all)\b/.test(text) && !/\ball (my )?(unfinished|open)\b/.test(text);

  // 1. Projects: numbers from the menu, or names.
  const named = matchProjects(text, projects);
  const numbers = new Set();
  const stripped = text.replace(/\b(latest|last|recent|newest|most recent|top|first)\s+(\d+|\w+)\s+(threads?|chats?|workspaces?|sessions?|days?|weeks?)\b/g, ' ')
    .replace(/\b(\d+)\s+(days?|weeks?|threads?|chats?|workspaces?|most recent)\b/g, ' ');
  for (const m of stripped.matchAll(/\b(\d+)\s*(?:-|to|–)\s*(\d+)\b/g)) for (let k = Number(m[1]); k <= Number(m[2]); k++) numbers.add(k);
  for (const m of stripped.replace(/\b(\d+)\s*(?:-|to|–)\s*(\d+)\b/g, ' ').matchAll(/(?:^|[\s,#(]|and|&)(\d{1,2})(?=$|[\s,.)&]|and)/g)) numbers.add(Number(m[1]));
  const byNumber = [...numbers].filter((k) => k >= 1 && k <= projects.length).map((k) => projects[k - 1].id);
  const chosen = new Set([...named, ...byNumber]);
  if (chosen.size) { pool = projects.filter((p) => chosen.has(p.id)); why.push(pool.map((p) => `"${p.name}"`).join(', ')); }
  else if (/\b(last used|most recent(ly used)? project|latest project|current project|this project|recent project)\b/.test(text) || (/\blast used\b/.test(text))) {
    pool = [projects[0]]; why.push(`your last used project "${projects[0].name}"`);
  } else if (everything) { why.push('all projects'); }

  // 2. Time window.
  let since = null;
  const days = /\b(?:last|past|previous)\s+(\d+|\w+)\s+days?\b/.exec(text) || /\b(\d+)\s+days?\b/.exec(text);
  const weeks = /\b(?:last|past|previous)\s+(\d+|\w+)\s+weeks?\b/.exec(text);
  if (days && num(days[1])) since = now - num(days[1]) * DAY, why.push(`active in the last ${num(days[1])} days`);
  else if (weeks && num(weeks[1])) since = now - num(weeks[1]) * 7 * DAY, why.push(`active in the last ${num(weeks[1])} weeks`);
  else if (/\b(this|last|past) week\b/.test(text)) since = now - 7 * DAY, why.push('active in the last 7 days');
  else if (/\b(this|last|past) month\b/.test(text)) since = now - 30 * DAY, why.push('active in the last 30 days');
  else if (/\btoday\b/.test(text)) since = new Date(now).setUTCHours(0, 0, 0, 0), why.push('active today');
  else if (/\byesterday\b/.test(text)) since = now - 2 * DAY, why.push('active since yesterday');
  if (since !== null) { const f = threadFilter; threadFilter = (t) => f(t) && ts(t.updatedAt) >= since; }

  // 3. State.
  if (/\b(open (branch|branches|pr|prs|pull requests?)|with (a |an )?(open )?(branch|branches|pr|prs|pull requests?)|branches?\/prs?|unmerged)\b/.test(text)) {
    const f = threadFilter; threadFilter = (t) => f(t) && !!t.openWork; why.push('with open branches or PRs');
  }
  if (/\b(unfinished|not done|not finished|in progress|incomplete|still open|open ones|ongoing)\b/.test(text)) {
    const f = threadFilter; threadFilter = (t) => f(t) && !!t.unfinished; why.push('unfinished');
  }

  // 4. Count.
  const cnt = /\b(?:latest|last|recent|newest|most recent|top|first)\s+(\d+|\w+)\s*(?:threads?|chats?|workspaces?|sessions?|ones?)?\b/.exec(text)
    || /\b(\d+|\w+)\s+(?:most recent|latest|newest)\b/.exec(text) || /\b(\d+)\s+(?:threads?|chats?|workspaces?)\b/.exec(text);
  if (cnt && num(cnt[1]) && !/^\s*(days?|weeks?|months?)/.test(text.slice(cnt.index + cnt[0].length))) { limit = num(cnt[1]); why.push(`latest ${limit} thread${limit === 1 ? '' : 's'}`); }
  else if (/\b(latest|last|most recent|newest) (thread|chat|workspace|one)\b/.test(text)) { limit = 1; why.push('latest thread'); }

  const understood = chosen.size || everything || since !== null || limit !== null || why.length;
  if (isDefault || (!understood && !raw)) {
    pool = [projects[0]]; limit = 3; defaulted = true;
    why.splice(0, why.length, `your most recent project "${projects[0].name}"`, 'its latest 3 threads');
  } else if (!understood) {
    return { ...out, needsClarification: true, question: 'Which projects? Answer with a number or name, "everything", or something like "latest 3 threads" or "last 7 days".' };
  }

  // A count with no project named means "across everything", newest first.
  let threads = pool.flatMap((p) => p.threads.filter(threadFilter).map((t) => ({ ...t, projectId: p.id })));
  threads.sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt));
  if (limit !== null) threads = threads.slice(0, limit);
  const pids = chosen.size || defaulted || pool.length === 1 ? pool.map((p) => p.id) : [...new Set(threads.map((t) => t.projectId))];
  if (everything && !chosen.size && since === null && limit === null) pids.splice(0, pids.length, ...projects.map((p) => p.id));
  return { ...out, projectIds: pids, threadIds: threads.map((t) => t.id), explain: why.join(', ') || 'your selection', defaulted };
}

export function preview(cat, sel, { setupFor } = {}) {
  const byId = new Map(cat.projects.map((p) => [p.id, p]));
  const lines = [`Will create in Capy (${sel.explain}):`];
  let total = 0;
  for (const pid of sel.projectIds) {
    const p = byId.get(pid); if (!p) continue;
    const ts2 = p.threads.filter((t) => sel.threadIds.includes(t.id));
    total += ts2.length;
    lines.push(`- Project "${p.name}"${p.path ? ` (${p.path})` : ''}${setupFor ? `: ${setupFor(p)}` : ''}`);
    for (const t of ts2) lines.push(`    - "${t.title || 'Untitled'}"${t.branch ? ` on ${t.branch}` : ''}${t.prs?.length ? `, PR #${t.prs[0].number || '?'} ${t.prs[0].state || ''}`.trimEnd() : ''}, ${t.messageCount ?? '?'} messages, last ${fmtDate(t.updatedAt)}`);
  }
  lines.push(`${sel.projectIds.length} project(s), ${total} thread(s).`);
  return lines.join('\n');
}
