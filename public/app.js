import {
  toJsonFile, toImportLink, toRouteRule, parseRouteRules, lint, hasCondition, BUILTIN_DEFAULTS,
} from './lib/hiddify.js';

const $ = (sel, el = document) => el.querySelector(sel);
const STORE_KEY = 'hiddify-rules-builder:v1';
const LIST_LIMIT = 250;

const KIND_LABEL = { site: 'sites', country: 'country IPs', service: 'service IPs', asn: 'network', block: 'block list', url: 'custom' };
const OUT_LABEL = { proxy: 'VPN', direct: 'Direct', direct_with_fragment: 'Direct + fragment', block: 'Block' };
const EXTRA_FIELDS = [
  ['domainSuffixes', 'Domain suffixes', 'youtube.com\n.pk'],
  ['domains', 'Exact domains', 'www.example.com'],
  ['domainKeywords', 'Domain keywords', 'googlevideo'],
  ['domainRegexes', 'Domain regex', '^ads\\.'],
  ['ipCidrs', 'IP / CIDR', '1.1.1.1/32'],
  ['portRanges', 'Ports (443 or 1000:2000)', '443'],
  ['processNames', 'Windows apps (process name)', 'chrome.exe'],
  ['packageNames', 'Android apps (package name)', 'com.google.android.youtube'],
];
const BUILTIN_INFO = {
  bypassLan: ['Bypass LAN', 'Local network and private IPs go direct', 'direct'],
  systemDirect: ['System services', 'Windows: Microsoft services · Android: Google/Android services', 'direct'],
  blockAds: ['Ads and malware', "Hiddify's ad, malware, phishing and miner lists", 'block'],
  bypassRegion: ['Bypass region', "Your Hiddify region's sites and IPs go direct", 'direct'],
};

const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (code) => { try { return regionNames?.of(code.toUpperCase()) || code; } catch { return code; } };

let index = null;
let asnList = null; // Set of every MetaCubeX ASN, loaded when needed
let siteSource = new Map();
let state = null;
let tab = 'featured';
let query = '';
let uid = 1;

// ---------- state ----------

function emptyRule(name = 'New rule', outbound = 'proxy') {
  const rule = { id: uid++, name, outbound, enabled: true, items: [] };
  for (const [key] of EXTRA_FIELDS) rule[key] = [];
  return rule;
}

function defaultState() {
  const rule = emptyRule('Through the VPN', 'proxy');
  return { builtins: { ...BUILTIN_DEFAULTS }, regionSet: false, rules: [rule], fallback: 'direct', active: rule.id };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage may be unavailable */ }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.rules)) {
      uid = Math.max(0, ...saved.rules.map((r) => r.id || 0)) + 1;
      return saved;
    }
  } catch { /* ignore */ }
  return defaultState();
}

const activeRule = () => state.rules.find((r) => r.id === state.active) || state.rules[0];
const itemKey = (item) => `${item.kind}:${item.n}`;

// ---------- lists → URLs ----------

function itemUrl(item) {
  const u = index.urls;
  const fill = (tpl) => tpl.replace('{n}', item.n);
  switch (item.kind) {
    case 'site': return fill(siteSource.get(item.n) === 'm' ? u.site_m : u.site_s);
    case 'country': return fill(u.country);
    case 'service': return fill(u.service);
    case 'asn': return fill(index.mirroredAsns.includes(Number(item.n)) ? u.asn_mirror : u.asn);
    case 'block': return fill(u.block);
    default: return item.n;
  }
}

/** Reverse of itemUrl, for rules loaded from a file. */
function urlToItem(url) {
  const u = index.urls;
  const tries = [
    ['site', u.site_s], ['site', u.site_m], ['country', u.country], ['service', u.service],
    ['asn', u.asn_mirror], ['asn', u.asn], ['block', u.block],
  ];
  for (const [kind, tpl] of tries) {
    const [pre, post] = tpl.split('{n}');
    if (url.startsWith(pre) && url.endsWith(post)) {
      const n = url.slice(pre.length, url.length - post.length);
      if (n && !n.includes('/')) return { kind, n };
    }
  }
  return { kind: 'url', n: url };
}

function itemLabel(item) {
  switch (item.kind) {
    case 'country': return `${countryName(item.n)} (${item.n})`;
    case 'service': return `${item.n} IPs`;
    case 'asn': {
      const known = index.asnGroups.flatMap((g) => g.items).find((a) => String(a.asn) === String(item.n));
      return known ? `AS${item.n} ${known.label}` : `AS${item.n}`;
    }
    case 'url': return item.n.split('/').pop();
    default: return item.n;
  }
}

function toBuilderState() {
  return {
    builtins: state.builtins,
    regionSet: state.regionSet,
    fallback: state.fallback,
    rules: state.rules.map((r) => ({ ...r, ruleSets: r.items.map(itemUrl) })),
  };
}

// ---------- featured / presets ----------

function featuredItems(f) {
  return [
    ...f.site.map((n) => ({ kind: 'site', n })),
    ...f.ip.map((n) => ({ kind: 'service', n })),
  ];
}

function applyPreset(id) {
  const preset = index.presets.find((p) => p.id === id);
  if (!preset) return;
  const rules = preset.rules.map((p) => {
    const rule = emptyRule(p.name, p.outbound);
    for (const fid of p.featured || []) {
      const f = index.featured.find((x) => x.id === fid);
      if (f) rule.items.push(...featuredItems(f));
    }
    for (const c of p.countries || []) rule.items.push({ kind: 'country', n: c });
    const group = index.asnGroups.find((g) => g.group === p.asnGroup);
    for (const a of group?.items || []) rule.items.push({ kind: 'asn', n: String(a.asn) });
    for (const [key] of EXTRA_FIELDS) if (p[key]) rule[key] = [...p[key]];
    return rule;
  });
  if (!rules.length) rules.push(emptyRule());
  state = {
    builtins: { ...BUILTIN_DEFAULTS, ...(preset.builtins || {}) },
    regionSet: state.regionSet,
    rules,
    fallback: preset.fallback,
    active: rules[0].id,
  };
  render();
  toast(`Preset loaded: ${preset.label}`);
}

// ---------- picker ----------

function allEntries() {
  // every pickable entry: { key, items[], label, meta, group, tab }
  const out = [];
  for (const f of index.featured) {
    out.push({ tab: 'featured', group: f.group, label: f.label, meta: describeFeatured(f), items: featuredItems(f), search: `${f.label} ${f.id} ${f.site.join(' ')}` });
  }
  for (const [n, src] of index.sites) {
    out.push({ tab: 'sites', label: n, meta: src === 'm' ? 'MetaCubeX' : '', items: [{ kind: 'site', n }], search: n });
  }
  for (const c of index.countries) {
    out.push({ tab: 'countries', label: `${countryName(c)}`, meta: c, items: [{ kind: 'country', n: c }], search: `${countryName(c)} ${c}` });
  }
  for (const s of index.services) {
    out.push({ tab: 'services', label: `${s}`, meta: 'IP ranges', items: [{ kind: 'service', n: s }], search: s });
  }
  for (const g of index.asnGroups) {
    for (const a of g.items) out.push({ tab: 'asn', group: g.group, label: `AS${a.asn}`, meta: a.label, items: [{ kind: 'asn', n: String(a.asn) }], search: `as${a.asn} ${a.asn} ${a.label}` });
  }
  for (const b of index.block) {
    out.push({ tab: 'block', label: b.replace(/^geo(site|ip)-/, ''), meta: b.startsWith('geoip') ? 'IP list' : 'domains', items: [{ kind: 'block', n: b }], search: b });
  }
  return out;
}

function describeFeatured(f) {
  const parts = [];
  if (f.site.length) parts.push('sites');
  if (f.ip.length) parts.push('IPs');
  return parts.join(' + ');
}

let entriesCache = null;
const TABS = [
  ['featured', 'Popular'], ['sites', 'Sites'], ['countries', 'Countries'],
  ['services', 'Service IPs'], ['asn', 'Networks'], ['block', 'Block lists'],
];

function renderTabs() {
  const counts = { featured: index.featured.length, sites: index.counts.sites, countries: index.counts.countries, services: index.counts.services, asn: index.counts.asns, block: index.counts.block };
  const el = $('#tabs');
  el.innerHTML = '';
  for (const [id, label] of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.setAttribute('aria-selected', String(tab === id && !query));
    b.innerHTML = `${label}<span class="count">${counts[id].toLocaleString()}</span>`;
    b.onclick = () => { tab = id; query = ''; $('#search').value = ''; renderPicker(); };
    el.append(b);
  }
}

function where(item) {
  // rules (other than the active one) that already hold this item
  const key = itemKey(item);
  return state.rules.filter((r) => r.id !== state.active && r.items.some((i) => itemKey(i) === key));
}

function renderPicker() {
  renderTabs();
  const rule = activeRule();
  $('#activeTarget').innerHTML = rule
    ? `Adding to <b>${escapeHtml(rule.name)}</b> <span class="out-tag out-${rule.outbound}">${OUT_LABEL[rule.outbound]}</span>`
    : 'Add a rule first';
  entriesCache ||= allEntries();
  const q = query.trim().toLowerCase();
  let entries = q
    ? entriesCache.filter((e) => e.search.toLowerCase().includes(q.replace(/^as(?=\d)/, '')) || e.search.toLowerCase().includes(q))
    : entriesCache.filter((e) => e.tab === tab);
  if (q) {
    // exact and prefix matches first
    const score = (e) => (e.label.toLowerCase() === q ? 0 : e.label.toLowerCase().startsWith(q) ? 1 : 2);
    entries = entries.sort((a, b) => score(a) - score(b) || TABS.findIndex((t) => t[0] === a.tab) - TABS.findIndex((t) => t[0] === b.tab));
  }
  const list = $('#list');
  list.innerHTML = '';
  if ((tab === 'asn' && !q) || /^(as)?\d+$/.test(q)) list.append(asnAdder(q.replace(/^as/, '')));
  if (!entries.length && !/^(as)?\d+$/.test(q)) {
    list.insertAdjacentHTML('beforeend', `<div class="empty">Nothing matches “${escapeHtml(query)}”.</div>`);
    return;
  }
  let lastGroup = null;
  for (const e of entries.slice(0, LIST_LIMIT)) {
    const group = q ? TABS.find((t) => t[0] === e.tab)[1] : e.group;
    if (group && group !== lastGroup) {
      list.insertAdjacentHTML('beforeend', `<div class="group-title">${escapeHtml(group)}</div>`);
      lastGroup = group;
    }
    list.append(entryButton(e, rule));
  }
  if (entries.length > LIST_LIMIT) {
    list.insertAdjacentHTML('beforeend', `<div class="more">${(entries.length - LIST_LIMIT).toLocaleString()} more — type to search.</div>`);
  }
}

function entryButton(e, rule) {
  const on = rule && e.items.every((i) => rule.items.some((x) => itemKey(x) === itemKey(i)));
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `item${on ? ' on' : ''}`;
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(on));
  const others = [...new Set(e.items.flatMap(where))];
  b.innerHTML = `<span class="tick">${on ? '✓' : ''}</span><span class="name">${escapeHtml(e.label)}</span>`
    + (others.length ? `<span class="elsewhere" title="Already in another rule">in ${escapeHtml(others[0].name)}</span>` : '')
    + (e.meta ? `<span class="meta">${escapeHtml(e.meta)}</span>` : '');
  b.onclick = () => toggleItems(e.items, !on);
  return b;
}

function asnAdder(prefill) {
  const wrap = document.createElement('div');
  wrap.className = 'asn-add';
  wrap.innerHTML = `<input placeholder="Any ASN, e.g. 17557" inputmode="numeric" aria-label="ASN number"><button class="btn" type="button">Add network</button>`;
  const input = $('input', wrap);
  input.value = prefill || '';
  $('button', wrap).onclick = async () => {
    const n = input.value.trim().replace(/^as/i, '');
    if (!/^\d+$/.test(n)) return toast('Type an ASN number');
    asnList ||= await fetch('data/asns.txt').then((r) => r.text()).then((t) => new Set(t.split('\n').filter(Boolean)));
    if (!asnList.has(n)) return toast(`AS${n} has no list in MetaCubeX`);
    toggleItems([{ kind: 'asn', n }], true);
  };
  return wrap;
}

function toggleItems(items, add) {
  const rule = activeRule();
  if (!rule) return toast('Add a rule first');
  for (const item of items) {
    const key = itemKey(item);
    rule.items = rule.items.filter((i) => itemKey(i) !== key);
    if (add) rule.items.push(item);
  }
  render();
}

// ---------- rules panel ----------

function renderBuiltins() {
  const el = $('#builtins');
  el.innerHTML = '';
  for (const key of ['bypassLan', 'systemDirect', 'blockAds', ...(state.regionSet ? ['bypassRegion'] : [])]) {
    const [name, desc, out] = BUILTIN_INFO[key];
    const row = document.createElement('div');
    row.className = 'builtin';
    row.innerHTML = `<span class="lock" title="Built into Hiddify">🔒</span>
      <span class="bname">${name}<span class="bdesc">${desc}</span></span>
      <span class="out-tag out-${out}">${OUT_LABEL[out]}</span>
      <label class="switch"><input type="checkbox" aria-label="${name}"><span></span></label>`;
    const box = $('input', row);
    box.checked = Boolean(state.builtins[key]);
    box.onchange = () => { state.builtins[key] = box.checked; render(); };
    el.append(row);
  }
  const region = document.createElement('label');
  region.className = 'region-row';
  region.innerHTML = `<input type="checkbox"> <span>A region is selected in Hiddify (Iran, China, Russia…). Leave unticked if your region is <b>Other</b>; Pakistan isn't one of Hiddify's regions.</span>`;
  const rbox = $('input', region);
  rbox.checked = state.regionSet;
  rbox.onchange = () => { state.regionSet = rbox.checked; render(); };
  el.append(region);
}

function renderRules() {
  const el = $('#ruleList');
  el.innerHTML = '';
  const tpl = $('#ruleTpl');
  state.rules.forEach((rule, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.classList.toggle('active', rule.id === state.active);
    node.classList.toggle('off', !rule.enabled);
    node.onclick = (ev) => {
      if (state.active !== rule.id && !ev.target.closest('button, input, select, textarea, summary')) setActive(rule.id);
    };
    const name = $('.rule-name', node);
    name.value = rule.name;
    name.oninput = () => { rule.name = name.value; renderPicker(); renderOutput(); save(); };
    const out = $('.rule-out', node);
    out.value = rule.outbound;
    out.className = `rule-out ${rule.outbound}`;
    out.onchange = () => { rule.outbound = out.value; render(); };
    const on = $('.rule-on', node);
    on.checked = rule.enabled;
    on.onchange = () => { rule.enabled = on.checked; render(); };
    $('.up', node).disabled = i === 0;
    $('.down', node).disabled = i === state.rules.length - 1;
    $('.up', node).onclick = () => move(i, -1);
    $('.down', node).onclick = () => move(i, 1);
    $('.del', node).onclick = () => removeRule(rule);
    $('.target-btn', node).onclick = () => setActive(rule.id);

    const chips = $('.chips', node);
    if (!rule.items.length) chips.innerHTML = '<span class="none">No lists yet — pick some on the left.</span>';
    for (const item of rule.items) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = itemUrl(item);
      chip.innerHTML = `${escapeHtml(itemLabel(item))} <span class="kind">${KIND_LABEL[item.kind]}</span><button type="button" aria-label="Remove">×</button>`;
      $('button', chip).onclick = () => { rule.items = rule.items.filter((x) => x !== item); render(); };
      chips.append(chip);
    }

    const grid = $('.extra-grid', node);
    let filled = 0;
    for (const [key, label, placeholder] of EXTRA_FIELDS) {
      const lab = document.createElement('label');
      lab.innerHTML = `<span>${label}</span><textarea spellcheck="false" placeholder="${escapeHtml(placeholder)}"></textarea>`;
      const ta = $('textarea', lab);
      ta.value = (rule[key] || []).join('\n');
      if (ta.value) filled++;
      ta.onchange = () => { rule[key] = ta.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean); renderOutput(); save(); };
      grid.append(lab);
    }
    if (filled) $('.extra', node).open = true;
    el.append(node);
  });
}

function setActive(id) { state.active = id; render(); }

function move(i, dir) {
  const [r] = state.rules.splice(i, 1);
  state.rules.splice(i + dir, 0, r);
  render();
}

function removeRule(rule) {
  if ((rule.items.length || EXTRA_FIELDS.some(([k]) => rule[k]?.length)) && !confirm(`Delete "${rule.name}"?`)) return;
  state.rules = state.rules.filter((r) => r !== rule);
  if (state.active === rule.id) state.active = state.rules[0]?.id;
  render();
}

function renderFallback() {
  for (const r of document.querySelectorAll('input[name=fallback]')) {
    r.checked = r.value === state.fallback;
    r.onchange = () => { state.fallback = r.value; render(); };
  }
  $('#fallbackNote').textContent = state.fallback === 'direct'
    ? 'Adds two catch-all rules at the end ("all other domains" and "everything else" → Direct), because Hiddify can\'t set its default to Direct.'
    : 'Anything your rules don\'t match goes through the VPN.';
}

function renderOutput() {
  const built = toBuilderState();
  const notes = lint(built).map((n) => ({ ...n }));
  if (state.rules.some((r) => r.enabled && r.items.some((i) => i.kind === 'asn' && !index.mirroredAsns.includes(Number(i.n)))))
    notes.unshift({ level: 'info', text: 'Networks outside the popular list link straight to MetaCubeX; Hiddify will also use them in DNS rules, which is harmless but a little slower.' });
  if (!state.rules.some((r) => r.enabled && r.outbound === 'proxy' && hasCondition({ ...r, ruleSets: r.items.map(itemUrl) })) && state.fallback === 'direct')
    notes.unshift({ level: 'warn', text: 'No rule sends anything through the VPN yet, so everything would go direct.' });
  $('#notes').innerHTML = notes.map((n) => `<div class="n ${n.level}">${escapeHtml(n.text)}</div>`).join('');
  $('#preview').textContent = JSON.stringify(toRouteRule(built), null, 2);
  $('#openHiddify').href = toImportLink(built);
}

function renderFoot() {
  const fmt = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const s = index.sources;
  const link = (k) => `<a href="https://github.com/${s[k].repo}/tree/${s[k].branch}" target="_blank" rel="noopener">${s[k].name}</a> (${fmt(s[k].updated)})`;
  $('#foot').innerHTML = `Lists synced ${fmt(index.generated)} from ${link('sn_site')}, ${link('sn_ip')}, ${link('mc')} and ${link('hg')}.
    ${index.counts.sites.toLocaleString()} site lists · ${index.counts.countries} countries · ${index.counts.services} service IP lists · ${index.counts.asns.toLocaleString()} networks.
    <a href="https://github.com/AzizKamboh/hiddify-rules" target="_blank" rel="noopener">Source on GitHub</a>.`;
}

function render() {
  if (!state.rules.find((r) => r.id === state.active)) state.active = state.rules[0]?.id;
  renderBuiltins();
  renderRules();
  renderFallback();
  renderPicker();
  renderOutput();
  save();
}

// ---------- actions ----------

function download() {
  const blob = new Blob([toJsonFile(toBuilderState())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'route_rules.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Saved route_rules.json');
}

async function copyLink() {
  const link = toImportLink(toBuilderState());
  try {
    await navigator.clipboard.writeText(link);
    toast('Import link copied — in Hiddify use ⋮ → import from clipboard');
  } catch {
    prompt('Copy this link:', link);
  }
}

async function loadFile(file) {
  try {
    const parsed = parseRouteRules(await file.text());
    const rules = parsed.rules.map((r) => {
      const rule = emptyRule(r.name, r.outbound);
      rule.enabled = r.enabled;
      rule.items = (r.ruleSets || []).map(urlToItem);
      for (const [key] of EXTRA_FIELDS) rule[key] = r[key] || [];
      return rule;
    });
    if (!rules.length) rules.push(emptyRule());
    state = { builtins: parsed.builtins, regionSet: parsed.regionSet, rules, fallback: parsed.fallback, active: rules[0].id };
    render();
    toast(`Loaded ${parsed.rules.length} rule${parsed.rules.length === 1 ? '' : 's'}`);
  } catch (err) {
    console.error(err);
    toast("That file isn't a Hiddify route_rules.json");
  }
}

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- start ----------

async function start() {
  try {
    index = await fetch('data/index.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    });
  } catch {
    document.body.innerHTML = '<p style="padding:24px">The list index is missing. Run <code>node scripts/build-index.mjs</code> first.</p>';
    return;
  }
  siteSource = new Map(index.sites);
  state = load();

  const presetSel = $('#preset');
  for (const p of index.presets) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    o.title = p.description;
    presetSel.append(o);
  }
  presetSel.onchange = () => {
    if (presetSel.value) applyPreset(presetSel.value);
    presetSel.value = '';
  };
  $('#search').oninput = (e) => { query = e.target.value; renderPicker(); };
  $('#addRule').onclick = () => {
    const rule = emptyRule(`Rule ${state.rules.length + 1}`, 'proxy');
    state.rules.push(rule);
    state.active = rule.id;
    render();
  };
  $('#reset').onclick = () => { if (confirm('Start over with an empty list?')) { state = defaultState(); render(); } };
  $('#download').onclick = download;
  $('#copyLink').onclick = copyLink;
  $('#loadFile').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  renderFoot();
  render();
}

start();
