// "What's inside": opens one list (or a bundle of lists) and shows its domains and IP ranges.
// view.html?t=Title&p=<part label>|<kind>|<url>&p=…
import { readSrs, summarize } from './lib/srs.js?v=__BUILD__';

const $ = (s) => document.querySelector(s);
const ALLOWED = [location.host, 'raw.githubusercontent.com', 'azizkamboh.github.io'];
const PAGE = 400;      // rows shown per section before "Show more"
const MORE = 2000;

const SECTIONS = [
  ['suffix', 'Domains and their subdomains', 'example.com also covers www.example.com, m.example.com…'],
  ['domain', 'Exact domains', 'Only this exact name, not its subdomains'],
  ['keyword', 'Domain keywords', 'Any domain containing this text'],
  ['regex', 'Domain patterns', 'Regular expressions matched against the domain'],
  ['adguard', 'AdGuard rules', '||example.com^ = the domain and its subdomains; | = starts with; no ^ = also partial names'],
  ['ip', 'IP ranges', 'Connections to these addresses, whatever the domain'],
];

const params = new URLSearchParams(location.search);
const title = params.get('t') || 'List';
const parts = params.getAll('p').map((p) => {
  const [label, kind, ...rest] = p.split('|');
  return { label, kind, url: rest.join('|') };
}).filter((p) => isAllowed(p.url));

let data = null;   // { match, except } merged over all parts
const shown = {};  // section key -> rows shown

function isAllowed(url) {
  try { const u = new URL(url, location.href); return u.protocol === 'https:' && ALLOWED.includes(u.host) || u.host === location.host; } catch { return false; }
}

function sourceName(url) {
  const u = new URL(url, location.href);
  if (u.host === location.host || u.host === 'azizkamboh.github.io') return 'this site';
  const owner = u.pathname.split('/')[1];
  return { SagerNet: 'SagerNet', MetaCubeX: 'MetaCubeX', hiddify: 'Hiddify' }[owner] || owner;
}

const fmt = (n) => n.toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load(part) {
  const res = await fetch(part.url);
  if (!res.ok) throw new Error(`couldn’t download it (HTTP ${res.status})`);
  if (part.url.endsWith('.json')) return summarize(JSON.parse(await res.text()).rules || []);
  return summarize((await readSrs(await res.arrayBuffer())).rules);
}

function merge(into, from) {
  for (const side of ['match', 'except']) {
    for (const [k, v] of Object.entries(from[side])) {
      if (Array.isArray(v)) into[side][k].push(...v);
      else for (const [f, vals] of Object.entries(v)) (into[side].other[f] ||= []).push(...vals);
    }
  }
}

function emptyData() {
  const s = () => ({ domain: [], suffix: [], keyword: [], regex: [], ip: [], adguard: [], other: {} });
  return { match: s(), except: s() };
}

async function main() {
  document.title = `${title} — what’s inside`;
  $('#title').textContent = title;
  if (!parts.length) { showError('No list to show. Open this page from the eye button next to a list.'); return; }
  $('#subtitle').textContent = parts.length > 1 ? `${parts.length} lists together` : '';
  const partsEl = $('#parts');
  partsEl.innerHTML = parts.map((p, i) => `<li data-i="${i}"><span class="name">${esc(p.label)}</span>${p.kind ? `<span class="kind">${esc(p.kind)}</span>` : ''}<span class="state muted">loading…</span><a class="src" href="${esc(p.url)}" title="Download the original file" rel="noopener">${esc(sourceName(p.url))}<svg class="ic"><use href="#i-link"/></svg></a></li>`).join('');
  data = emptyData();
  await Promise.all(parts.map(async (p, i) => {
    const li = partsEl.querySelector(`[data-i="${i}"] .state`);
    try {
      const s = await load(p);
      merge(data, s);
      li.textContent = describe(s);
    } catch (err) {
      li.textContent = `couldn’t read it: ${err.message}`;
      li.classList.add('err');
    }
  }));
  for (const side of Object.values(data)) {
    for (const k of Object.keys(side)) if (Array.isArray(side[k])) side[k] = [...new Set(side[k])].sort(k === 'ip' ? ipSort : undefined);
  }
  $('#download').disabled = false;
  render();
}

function describe(s) {
  const d = s.match.domain.length + s.match.suffix.length + s.match.keyword.length + s.match.regex.length + s.match.adguard.length;
  const ip = s.match.ip.length;
  return [d && `${fmt(d)} domain ${d === 1 ? 'rule' : 'rules'}`, ip && `${fmt(ip)} IP ${ip === 1 ? 'range' : 'ranges'}`].filter(Boolean).join(' · ') || 'empty';
}

function ipSort(a, b) {
  const v6 = (x) => x.includes(':');
  if (v6(a) !== v6(b)) return v6(a) ? 1 : -1;
  if (!v6(a)) {
    const n = (x) => x.split('/')[0].split('.').reduce((s, o) => s * 256 + Number(o), 0);
    return n(a) - n(b);
  }
  return a < b ? -1 : 1;
}

function render() {
  const q = $('#q').value.trim().toLowerCase();
  const root = $('#sections');
  root.innerHTML = '';
  const answer = $('#answer');
  answer.hidden = !q;
  if (q) answer.innerHTML = check(q);

  const blocks = [
    ...SECTIONS.map(([k, name, help]) => ({ key: k, name, help, rows: data.match[k] })),
    ...Object.entries(data.match.other).map(([f, rows]) => ({ key: `o:${f}`, name: fieldName(f), help: '', rows })),
    ...SECTIONS.map(([k, name]) => ({ key: `x:${k}`, name: `Exceptions — ${name.toLowerCase()}`, help: 'Not matched by this list', rows: data.except[k] })),
  ].filter((b) => b.rows.length);

  if (!blocks.length) { root.innerHTML = '<div class="empty"><b>Nothing inside</b>This list is empty.</div>'; return; }
  for (const b of blocks) {
    const rows = q ? b.rows.filter((r) => r.toLowerCase().includes(q)) : b.rows;
    if (q && !rows.length) continue;
    const limit = shown[b.key] || PAGE;
    const sec = document.createElement('section');
    sec.className = 'view-sec';
    sec.innerHTML = `<header><h2>${esc(b.name)} <span class="count">${fmt(rows.length)}${q ? ` of ${fmt(b.rows.length)}` : ''}</span></h2>`
      + `${b.help ? `<p class="muted">${esc(b.help)}</p>` : ''}`
      + `<button type="button" class="btn btn-ghost btn-xs copy"><svg class="ic"><use href="#i-copy"/></svg>Copy</button></header>`
      + `<ul class="view-rows">${rows.slice(0, limit).map((r) => `<li>${mark(r, q)}</li>`).join('')}</ul>`
      + (rows.length > limit ? `<button type="button" class="btn btn-secondary btn-xs more">Show ${fmt(Math.min(MORE, rows.length - limit))} more of ${fmt(rows.length - limit)}</button>` : '');
    sec.querySelector('.copy').onclick = (e) => copy(rows.join('\n'), e.currentTarget);
    const more = sec.querySelector('.more');
    if (more) more.onclick = () => { shown[b.key] = limit + MORE; render(); };
    root.append(sec);
  }
  if (!root.children.length) root.innerHTML = `<div class="empty"><b>Nothing matches “${esc(q)}”</b>Try part of a domain, or an IP address.</div>`;
}

function fieldName(f) {
  return f.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function mark(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

// ---------- "is this in the list?" ----------

/** A plain answer for a full domain or IP typed in the search box. */
function check(q) {
  const ip = parseIp(q);
  if (ip) {
    const hit = data.match.ip.find((c) => inCidr(ip, c));
    const miss = data.except.ip.find((c) => inCidr(ip, c));
    if (hit && !miss) return `<b>${esc(q)}</b> is in this list (range ${esc(hit)}).`;
    return `<b>${esc(q)}</b> isn’t in this list’s IP ranges.`;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(q)) return 'Showing entries that contain this text.';
  const hit = domainHit(q, data.match);
  const except = domainHit(q, data.except);
  if (hit && !except) return `<b>${esc(q)}</b> is in this list — ${esc(hit)}.`;
  if (hit && except) return `<b>${esc(q)}</b> is listed, but an exception leaves it out (${esc(except)}).`;
  const subs = [...data.match.suffix, ...data.match.domain].filter((x) => x.endsWith(`.${q}`)).length;
  if (subs) return `<b>${esc(q)}</b> itself isn’t in this list, but ${fmt(subs)} of its subdomains ${subs === 1 ? 'is' : 'are'}.`;
  return `<b>${esc(q)}</b> isn’t matched by this list’s domain rules${data.match.ip.length ? ' (it may still be reached through the IP ranges)' : ''}.`;
}

function domainHit(d, s) {
  if (s.domain.includes(d)) return 'exact domain';
  const labels = d.split('.');
  for (let i = 0; i < labels.length; i++) {
    const x = labels.slice(i).join('.');
    if (s.suffix.includes(x)) return i ? `via ${x}` : 'listed domain';
    if (i && s.suffix.includes(`.${x}`)) return `via .${x}`;
  }
  const kw = s.keyword.find((k) => d.includes(k));
  if (kw) return `keyword “${kw}”`;
  const re = s.regex.find((r) => { try { return new RegExp(r).test(d); } catch { return false; } });
  if (re) return `pattern ${re}`;
  const ag = s.adguard.find((r) => adguardMatch(r, d));
  if (ag) return `rule ${ag}`;
  return '';
}

function adguardMatch(rule, d) {
  let r = rule, anchored = false, sub = false, end = false;
  if (r.startsWith('||')) { sub = true; r = r.slice(2); } else if (r.startsWith('|')) { anchored = true; r = r.slice(1); }
  if (r.endsWith('^')) { end = true; r = r.slice(0, -1); }
  const body = r.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  const start = sub ? '(^|\\.)' : anchored ? '^' : '';
  try { return new RegExp(`${start}${body}${end ? '$' : ''}`).test(d); } catch { return false; }
}

function parseIp(s) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return { v: 4, n: BigInt(s.split('.').reduce((a, o) => a * 256 + Number(o), 0)) };
  if (/^[0-9a-f:]+$/.test(s) && s.includes(':')) {
    const [a, b = ''] = s.split('::');
    const left = a ? a.split(':') : [], right = b ? b.split(':') : [];
    if (!s.includes('::') && left.length !== 8) return null;
    const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n) };
  }
  return null;
}

function inCidr(ip, cidr) {
  const [addr, len] = cidr.split('/');
  const net = parseIp(addr);
  if (!net || net.v !== ip.v) return false;
  const bits = ip.v === 4 ? 32n : 128n;
  const shift = bits - BigInt(len);
  return (net.n >> shift) === (ip.n >> shift);
}

// ---------- copy / download ----------

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const old = btn.lastChild.textContent;
  btn.lastChild.textContent = 'Copied';
  setTimeout(() => { btn.lastChild.textContent = old; }, 1500);
}

$('#download').onclick = () => {
  const lines = [`# ${title}`, ...parts.map((p) => `# ${p.label}: ${p.url}`), ''];
  const add = (head, rows) => { if (rows.length) lines.push(`# ${head}`, ...rows, ''); };
  for (const [k, name] of SECTIONS) add(name, data.match[k]);
  for (const [f, rows] of Object.entries(data.match.other)) add(fieldName(f), rows);
  for (const [k, name] of SECTIONS) add(`Exceptions — ${name.toLowerCase()}`, data.except[k]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
  a.download = `${title.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'list'}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

let timer;
$('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { if (data) render(); }, 120); });

function showError(text) {
  $('#sections').innerHTML = `<div class="empty"><b>${esc(text)}</b></div>`;
}

main().catch((err) => showError(`Couldn’t open this list: ${err.message}`));
