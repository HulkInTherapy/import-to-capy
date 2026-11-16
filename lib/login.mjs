// One-time sign-in: the user pastes a Capy API key once into a tiny page on 127.0.0.1, and it goes straight
// into the macOS Keychain (service "import-to-capy"). Every later import reads it from there, silently.
// The key never touches a file, the chat, a log, argv (it reaches `security` on stdin) or any server but api.capy.ai.
//
// `import-to-capy login` starts the page in a background process and returns at once (agent shells time out);
// `ready --json` tells the agent when the key is in. `login --wait` blocks until the key is saved.
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KEYCHAIN_SERVICE } from './capy-api.mjs';
import { openUrl } from './picker.mjs';

export const API_SETTINGS_URL = 'https://capy.ai/settings/api';
export const looksLikeKey = (k) => typeof k === 'string' && /^[\x21-\x7e]{16,512}$/.test(k) && !/["\\]/.test(k);

// Store the key in the Keychain through `security -i`, so it never appears in the process list.
export function saveKey(key, { run = execFileSync } = {}) {
  if (!looksLikeKey(key)) throw new Error('That does not look like a Capy API key.');
  run('security', ['-i'], { input: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a capy -w "${key}"\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function loginPage(token, note = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Import to Capy</title><style>
:root{--paper:#FBF8F1;--card:#fff;--ink:#1A1A2E;--body:#3E3E3E;--faded:#7A7066;--rule:#E3D9CB;--accent:#C4623A}
@media (prefers-color-scheme:dark){:root{--paper:#1C1B18;--card:#252420;--ink:#EDE6DA;--body:#D4CFC6;--faded:#9B9286;--rule:#3A372F;--accent:#E8A87C}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--body);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:30rem;margin:12vh auto;padding:0 16px}h1{color:var(--ink);font-size:1.4rem;margin:0 0 .5rem}p{margin:.25rem 0 1rem}
a{color:var(--accent)}input{width:100%;font:inherit;padding:.6rem .7rem;border:1px solid var(--rule);border-radius:6px;background:var(--card);color:var(--ink)}
button{margin-top:.75rem;font:inherit;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:.55rem 1.2rem;cursor:pointer}
small{color:var(--faded);display:block;margin-top:1rem}.err{color:#b3261e}</style></head><body><main id="app">
<h1>Connect Import to Capy</h1>
<p>Create a key in <a href="${API_SETTINGS_URL}" target="_blank" rel="noopener">Capy → Settings → API</a> (it opened in another tab), then paste it here once.</p>
<form id="f"><input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="Capy API key" autofocus required><button>Save key</button></form>
<p class="err" id="e">${esc(note)}</p>
<small>It goes into your Mac's Keychain only. Imports use it from now on; nothing else stores it.</small></main>
<script>
document.getElementById('f').onsubmit=async(ev)=>{ev.preventDefault();const k=document.getElementById('k').value.trim();
 const r=await fetch(location.pathname+'/key',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})});
 const t=await r.text();
 if(r.ok){document.getElementById('app').innerHTML='<h1>Connected</h1><p>Your key is in the Keychain. Go back to your Capy thread; you can close this tab.</p>'}
 else{document.getElementById('e').textContent=t||'That did not work. Try again.'}};
</script></body></html>`;
}

// The page server. verify(key) -> true/false (asks api.capy.ai); save(key) stores it. Resolves `result` once saved,
// or with null on timeout. Only 127.0.0.1, only with the one-time token in the path, one successful save.
export function startLogin({ verify, save, open = true, timeoutMs = 15 * 60 * 1000, host = '127.0.0.1' } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  let finish;
  const result = new Promise((res) => { finish = res; });
  let saved = false;
  let port = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const plain = (status, text) => { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }); res.end(text); };
    if (req.headers.host !== `${host}:${port}` || saved) return plain(403, 'Forbidden');
    if (req.method === 'GET' && u.pathname === `/${token}`) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
      return res.end(loginPage(token));
    }
    if (req.method === 'POST' && u.pathname === `/${token}/key`) {
      if (req.headers.origin && req.headers.origin !== `http://${host}:${port}`) return plain(403, 'Forbidden');
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', async () => {
        let key = '';
        try { key = String(JSON.parse(body).key || '').trim(); } catch { return plain(400, 'Bad request'); }
        if (!looksLikeKey(key)) return plain(400, 'That does not look like a Capy API key. Copy it again from Settings → API.');
        let good = false;
        try { good = await verify(key); } catch { good = false; }
        if (!good) return plain(400, 'Capy did not accept that key. Create a new one in Settings → API and paste it again.');
        try { await save(key); } catch { return plain(500, 'Could not save it in the Keychain. Try again.'); }
        saved = true;
        plain(200, 'Saved');
        done(true);
      });
      return;
    }
    plain(404, 'Not found');
  });
  const timer = setTimeout(() => done(null), timeoutMs);
  function done(v) { clearTimeout(timer); setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 200); finish(v); }
  return new Promise((res, rej) => { server.once('error', rej); server.listen(0, host, () => res()); }).then(() => {
    port = server.address().port;
    const url = `http://${host}:${port}/${token}`;
    if (open) { openUrl(API_SETTINGS_URL); openUrl(url); }
    return { url, port, result, close: () => done(null) };
  });
}

// Run the page in a detached background process and return its URL (the process exits after saving or 15 minutes).
export function startLoginInBackground({ script = fileURLToPath(new URL('./import-to-capy.mjs', import.meta.url)) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'login', '--serve'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const fail = setTimeout(() => { reject(new Error('The sign-in page did not start.')); }, 10000);
    child.on('error', (e) => { clearTimeout(fail); reject(e); });
    child.stdout.on('data', (c) => {
      out += c;
      const m = /^(http:\/\/127\.0\.0\.1:\d+\/\w+)$/m.exec(out);
      if (m) { clearTimeout(fail); child.stdout.destroy(); child.unref(); resolve(m[1]); }
    });
  });
}
