// Pattern-based secret redaction for anything written out of an import (handoffs, transcripts, prompts).
// It errs on the side of redacting: a false positive costs a word, a miss costs a leaked key.

const RULES = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ['Stripe key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['API key (known prefix)', /\b(?:tvly-(?:dev-|prod-)?|hf_|r8_|gsk_|xai-|pplx-|sk_live_|sk_test_|whsec_|shpat_|shpss_|SG\.|key-|lin_api_|dop_v1_|doo_v1_|figd_|ntn_|secret_)[A-Za-z0-9_.-]{20,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['bearer token', /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, (m, p1) => `${p1} [REDACTED]`],
  ['URL credentials', /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, (m, scheme, user) => `${scheme}${user}:[REDACTED]@`],
  // KEY=value and key: value where the name says secret (covers .env lines and config snippets)
  ['secret assignment', /\b([A-Za-z0-9_.-]*(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH|CREDENTIALS?|DATABASE_URL|DSN|CONNECTION_STRING)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;}]{6,})\3/gi,
    (m, k, sep, q) => `${k}${sep}${q}[REDACTED]${q}`],
];

export function redact(input) {
  if (input === null || input === undefined) return { text: '', count: 0, kinds: {} };
  let text = String(input);
  let count = 0;
  const kinds = {};
  for (const [kind, re, fn] of RULES) {
    text = text.replace(re, (...args) => {
      const m = args[0];
      if (m.includes('[REDACTED]')) return m;
      count++; kinds[kind] = (kinds[kind] || 0) + 1;
      return fn ? fn(...args) : '[REDACTED]';
    });
  }
  return { text, count, kinds };
}

// Redact many strings, summing counts.
export function redactor() {
  const total = { count: 0, kinds: {} };
  const r = (s) => {
    const out = redact(s);
    total.count += out.count;
    for (const [k, v] of Object.entries(out.kinds)) total.kinds[k] = (total.kinds[k] || 0) + v;
    return out.text;
  };
  r.total = total;
  return r;
}
