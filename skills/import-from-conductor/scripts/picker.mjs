// Layer 2 of the selection flow: a one-time picker page on 127.0.0.1.
// Random port, random one-time token, metadata only (project names, thread titles, dates, counts; never message
// text). One submit, then the server closes. Never listens beyond localhost.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function pickerData(cat) {
  return { source: cat.source, projects: cat.projects.map((p) => ({ id: p.id, name: p.name, lastUsed: p.lastUsed || '',
    threads: p.threads.filter((t) => !t.archived).map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt || '', branch: t.branch || '',
      messages: t.messageCount || 0, unfinished: !!t.unfinished, openWork: !!t.openWork, native: !!t.native })) })) };
}

export function pageHtml(cat, token) {
  const data = JSON.stringify(pickerData(cat)).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Import into Capy</title><style>
:root{--paper:#FBF8F1;--card:#fff;--ink:#1A1A2E;--body:#3E3E3E;--faded:#7A7066;--rule:#E3D9CB;--accent:#C4623A}
@media (prefers-color-scheme:dark){:root{--paper:#1C1B18;--card:#252420;--ink:#EDE6DA;--body:#D4CFC6;--faded:#9B9286;--rule:#3A372F;--accent:#E8A87C}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--body);font:16px/1.5 Georgia,"Times New Roman",serif}
main{max-width:46rem;margin:0 auto;padding:2rem 16px 6rem}h1{color:var(--ink);font-size:1.6rem;margin:0 0 .25rem}p.sub{color:var(--faded);margin:0 0 1.25rem}
.chips{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.25rem}.chip{font:inherit;font-size:.9rem;border:1px solid var(--rule);background:var(--card);color:var(--ink);border-radius:999px;padding:.3rem .8rem;cursor:pointer}
.chip.on{border-color:var(--accent);color:var(--accent)}.proj{background:var(--card);border:1px solid var(--rule);border-radius:8px;margin:0 0 .75rem;padding:.6rem .9rem}
.proj h2{font-size:1.05rem;margin:0;color:var(--ink);display:flex;gap:.6rem;align-items:baseline}.proj h2 small{color:var(--faded);font-weight:normal;font-size:.85rem}
label.t{display:flex;gap:.6rem;align-items:baseline;padding:.25rem 0;border-top:1px solid var(--rule);font-size:.95rem}label.t:first-of-type{border-top:0}
label.t small{color:var(--faded);margin-left:auto;white-space:nowrap;font-size:.8rem}.more{font-size:.85rem;color:var(--accent);background:none;border:0;padding:.25rem 0;cursor:pointer;font-family:inherit}
footer{position:fixed;left:0;right:0;bottom:0;background:var(--paper);border-top:1px solid var(--rule);padding:.75rem 16px}footer div{max-width:46rem;margin:0 auto;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
#count{flex:1;color:var(--ink)}button.go{font:inherit;background:var(--accent);color:#fff;border:0;border-radius:6px;padding:.5rem 1.2rem;cursor:pointer}button.go:disabled{opacity:.4}
.done{text-align:center;padding:4rem 0;color:var(--ink)}</style></head><body><main id="app">
<h1>Import into Capy</h1><p class="sub" id="sub"></p>
<div class="chips" id="chips"></div><div id="list"></div></main>
<footer><div><span id="count"></span><label><input type="checkbox" id="chats" checked> include chat handoffs</label><button class="go" id="go">Import</button></div></footer>
<script>
const D=${data},TOKEN=${JSON.stringify(token)},DAY=864e5,sel=new Set(),open=new Set();
const t=(d)=>{const x=Date.parse(String(d).replace(' ','T'));return isNaN(x)?0:x};
const all=()=>D.projects.flatMap(p=>p.threads.map(x=>({...x,pid:p.id})));
const byNew=(a)=>a.sort((a,b)=>t(b.updatedAt)-t(a.updatedAt));
const CH={"Latest 3":()=>byNew(D.projects[0]?D.projects[0].threads.slice():[]).slice(0,3),"Last 7 days":()=>all().filter(x=>t(x.updatedAt)>=Date.now()-7*DAY),
"Last used":()=>D.projects[0]?D.projects[0].threads:[],"Unfinished":()=>all().filter(x=>x.unfinished),"Open branches/PRs":()=>all().filter(x=>x.openWork),"Everything":()=>all()};
let chip="Latest 3";
function apply(name){chip=name;sel.clear();CH[name]().forEach(x=>sel.add(x.id));render()}
function render(){
 document.getElementById('sub').textContent='From '+D.source+'. Pick a quick option or tick threads. Nothing is imported until you press Import.';
 const c=document.getElementById('chips');c.innerHTML='';
 for(const k of Object.keys(CH)){const b=document.createElement('button');b.className='chip'+(k===chip?' on':'');b.textContent=k;b.onclick=()=>apply(k);c.appendChild(b)}
 const L=document.getElementById('list');L.innerHTML='';
 D.projects.forEach((p,i)=>{const d=document.createElement('section');d.className='proj';
  const n=p.threads.filter(x=>sel.has(x.id)).length;
  d.innerHTML='<h2><input type="checkbox" '+(n&&n===p.threads.length?'checked':'')+'> '+esc(p.name)+' <small>'+p.threads.length+' threads · last used '+(p.lastUsed||'').slice(0,10)+(n?' · '+n+' picked':'')+'</small></h2>';
  d.querySelector('h2 input').onchange=(e)=>{p.threads.forEach(x=>e.target.checked?sel.add(x.id):sel.delete(x.id));chip='';render()};
  const show=open.has(p.id)?p.threads:p.threads.slice(0,5);
  show.forEach(x=>{const l=document.createElement('label');l.className='t';
   l.innerHTML='<input type="checkbox" '+(sel.has(x.id)?'checked':'')+'> <span>'+esc(x.title)+(x.branch?' <small style="margin:0">'+esc(x.branch)+'</small>':'')+'</span><small>'+x.messages+' msgs · '+String(x.updatedAt).slice(0,10)+'</small>';
   l.querySelector('input').onchange=(e)=>{e.target.checked?sel.add(x.id):sel.delete(x.id);chip='';render()};d.appendChild(l)});
  if(p.threads.length>5&&!open.has(p.id)){const m=document.createElement('button');m.className='more';m.textContent='Show all '+p.threads.length;m.onclick=()=>{open.add(p.id);render()};d.appendChild(m)}
  L.appendChild(d)});
 const ps=new Set(all().filter(x=>sel.has(x.id)).map(x=>x.pid));
 document.getElementById('count').textContent=sel.size+' thread'+(sel.size===1?'':'s')+' from '+ps.size+' project'+(ps.size===1?'':'s');
 document.getElementById('go').disabled=!sel.size;
}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
document.getElementById('go').onclick=async()=>{
 const ids=[...sel],pids=[...new Set(all().filter(x=>sel.has(x.id)).map(x=>x.pid))];
 const r=await fetch('/submit?t='+encodeURIComponent(TOKEN),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({threadIds:ids,projectIds:pids,includeChats:document.getElementById('chats').checked,chip})});
 document.getElementById('app').innerHTML='<div class="done">'+(r.ok?'Got it. Back to your thread; you can close this tab.':'That link has expired. Ask the agent for a new one.')+'</div>';
 document.querySelector('footer').remove()};
apply(chip);
</script></body></html>`;
}

// Returns { url, token, port, result: Promise<selection|null>, close() }. result resolves on submit, timeout or close.
export function startPicker(cat, { open = true, timeoutMs = 10 * 60 * 1000, host = '127.0.0.1' } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  let finish;
  const result = new Promise((res) => { finish = res; });
  let used = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const ok = u.searchParams.get('t') === token && !used;
    if (req.method === 'GET' && u.pathname === '/') {
      if (!ok) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Forbidden'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
      return res.end(pageHtml(cat, token));
    }
    if (req.method === 'POST' && u.pathname === '/submit') {
      if (!ok) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end('Forbidden'); }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let sel = null;
        try { sel = JSON.parse(body); } catch { res.writeHead(400); return res.end('Bad request'); }
        const known = new Set(cat.projects.flatMap((p) => p.threads.map((t) => t.id)));
        const threadIds = (sel.threadIds || []).filter((id) => known.has(id));
        used = true;
        res.writeHead(204); res.end();
        done({ method: 'picker', threadIds, projectIds: (sel.projectIds || []).filter((id) => cat.projects.some((p) => p.id === id)), includeChats: !!sel.includeChats, explain: sel.chip ? `picked "${sel.chip}" on the page` : 'picked on the page' });
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  const timer = setTimeout(() => done(null), timeoutMs);
  function done(v) { clearTimeout(timer); server.close(); server.closeAllConnections?.(); finish(v); }
  const ready = new Promise((res, rej) => { server.once('error', rej); server.listen(0, host, () => res()); });
  return ready.then(() => {
    const port = server.address().port;
    const url = `http://${host}:${port}/?t=${token}`;
    if (open) openUrl(url);
    return { url, token, port, result, close: () => done(null) };
  });
}

export function openUrl(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); return true; } catch { return false; }
}
