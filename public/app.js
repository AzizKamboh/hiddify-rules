import {
  toJsonFile, toImportLink, toRouteRule, parseRouteRules, lint, hasCondition, BUILTIN_DEFAULTS,
} from './lib/hiddify.js';

// ---------- constants ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const STORE_KEY = 'hiddify-rules-builder:v1';           // saved rules (unchanged from the first version)
const THEME_KEY = 'hiddify-rules-builder:theme';        // light | dark | system
const LIST_LIMIT = 250;

const KIND_LABEL = { site: 'sites', country: 'country IPs', service: 'service IPs', asn: 'network', block: 'block list', url: 'custom' };
const OUT = {
  proxy: { label: 'VPN', icon: 'i-vpn' },
  direct: { label: 'Direct', icon: 'i-direct' },
  direct_with_fragment: { label: 'Direct + fragment', icon: 'i-fragment' },
  block: { label: 'Block', icon: 'i-block' },
};
const EXTRA_FIELDS = [
  ['domainSuffixes', 'Domain suffixes', 'youtube.com\n.pk'],
  ['domains', 'Exact domains', 'www.example.com'],
  ['domainKeywords', 'Domain keywords', 'googlevideo'],
  ['domainRegexes', 'Domain regex', '^ads\\.'],
  ['ipCidrs', 'IP / CIDR', '1.1.1.1/32'],
  ['portRanges', 'Ports', '443 or 1000:2000'],
  ['processNames', 'Windows apps', 'chrome.exe'],
  ['packageNames', 'Android apps', 'com.google.android.youtube'],
];
const BUILTIN_INFO = {
  bypassLan: ['Bypass LAN', 'Local network and private addresses', 'direct'],
  systemDirect: ['System services', 'Windows: Microsoft services · Android: Google and Android services', 'direct'],
  blockAds: ['Ads and malware', "Hiddify's ad, malware, phishing and miner lists", 'block'],
  bypassRegion: ['Bypass region', 'Sites and IPs of the region set in Hiddify', 'direct'],
};
const TABS = [
  ['featured', 'Popular', 'i-star'], ['sites', 'Sites', 'i-globe'], ['countries', 'Countries', 'i-flag'],
  ['services', 'Service IPs', 'i-server'], ['asn', 'Networks', 'i-network'], ['block', 'Block lists', 'i-shield-off'],
];

const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (code) => { try { return regionNames?.of(code.toUpperCase()) || code; } catch { return code; } };
const fmtCount = (n) => Number(n).toLocaleString('en-US');
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

let index = null;
let asnList = null;      // every MetaCubeX ASN, loaded on first use
let siteSource = new Map();
let state = null;
let tab = 'featured';
let query = '';
let uid = 1;
let entriesCache = null;
const openConditions = new Set(); // rule ids whose conditions panel is open

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
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.rules)) {
      for (const r of saved.rules) {
        r.items ||= [];
        for (const [key] of EXTRA_FIELDS) r[key] ||= [];
      }
      saved.builtins = { ...BUILTIN_DEFAULTS, ...(saved.builtins || {}) };
      uid = Math.max(0, ...saved.rules.map((r) => r.id || 0)) + 1;
      return saved;
    }
  } catch { /* ignore broken saves */ }
  return defaultState();
}

const activeRule = () => state.rules.find((r) => r.id === state.active) || state.rules[0];
const ruleNumber = (rule) => state.rules.indexOf(rule) + 1;
const itemKey = (item) => `${item.kind}:${item.n}`;
const extraCount = (rule) => EXTRA_FIELDS.reduce((n, [k]) => n + (rule[k]?.length ? 1 : 0), 0);
const ruleHasContent = (rule) => rule.items.length > 0 || extraCount(rule) > 0;

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
    case 'asn': {
      const known = index.asnGroups.flatMap((g) => g.items).find((a) => String(a.asn) === String(item.n));
      return known ? `AS${item.n} · ${known.label}` : `AS${item.n}`;
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

// ---------- presets ----------

function featuredItems(f) {
  return [...f.site.map((n) => ({ kind: 'site', n })), ...f.ip.map((n) => ({ kind: 'service', n }))];
}

async function applyPreset(id) {
  const preset = index.presets.find((p) => p.id === id);
  if (!preset) return;
  if (state.rules.some(ruleHasContent) && !(await confirmDialog('Replace your rules?', `“${preset.label}” replaces the rules you have now.`, 'Replace'))) return;
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
    if (EXTRA_FIELDS.some(([k]) => p[k])) openConditions.add(rule.id);
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
  if (preset.builtins) $('#managed').open = true;
  render();
  setView('rules');
  toast(`Preset loaded: ${preset.label}`, 'ok');
}

// ---------- library ----------

function describeFeatured(f) {
  return [f.site.length && 'sites', f.ip.length && 'IPs'].filter(Boolean).join(' + ');
}

function allEntries() {
  const out = [];
  for (const f of index.featured) {
    out.push({ tab: 'featured', group: f.group, label: f.label, meta: describeFeatured(f), items: featuredItems(f), search: `${f.label} ${f.id} ${f.site.join(' ')}` });
  }
  for (const [n, src] of index.sites) {
    out.push({ tab: 'sites', label: n, mono: true, meta: src === 'm' ? 'MetaCubeX' : '', items: [{ kind: 'site', n }], search: n });
  }
  for (const c of index.countries) {
    out.push({ tab: 'countries', label: countryName(c), meta: c.toUpperCase(), items: [{ kind: 'country', n: c }], search: `${countryName(c)} ${c}` });
  }
  for (const s of index.services) {
    out.push({ tab: 'services', label: s, mono: true, meta: 'IP ranges', items: [{ kind: 'service', n: s }], search: s });
  }
  for (const g of index.asnGroups) {
    for (const a of g.items) out.push({ tab: 'asn', group: g.group, label: `AS${a.asn}`, mono: true, meta: a.label, items: [{ kind: 'asn', n: String(a.asn) }], search: `as${a.asn} ${a.asn} ${a.label}` });
  }
  for (const b of index.block) {
    out.push({ tab: 'block', label: b.replace(/^geo(site|ip)-/, ''), mono: true, meta: b.startsWith('geoip') ? 'IP list' : 'domains', items: [{ kind: 'block', n: b }], search: b });
  }
  return out;
}

function renderTabs() {
  const counts = { featured: index.featured.length, sites: index.counts.sites, countries: index.counts.countries, services: index.counts.services, asn: index.counts.asns, block: index.counts.block };
  const el = $('#tabs');
  const focused = document.activeElement?.closest?.('#tabs') ? document.activeElement.dataset.tab : null;
  el.innerHTML = '';
  for (const [id, label, ic] of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    const selected = tab === id && !query;
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = (query ? id === 'featured' : selected) ? 0 : -1;
    b.dataset.tab = id;
    b.innerHTML = `${icon(ic)}${label}<span class="count">${fmtCount(counts[id])}</span>`;
    b.onclick = () => { tab = id; query = ''; $('#search').value = ''; renderLibrary(); };
    el.append(b);
  }
  if (focused) $(`.tab[data-tab="${focused}"]`)?.focus();
}

function where(item) {
  const key = itemKey(item);
  return state.rules.filter((r) => r.id !== state.active && r.items.some((i) => itemKey(i) === key));
}

function renderTarget() {
  const rule = activeRule();
  $('#activeTarget').innerHTML = rule
    ? `${icon('i-target')}<span>Adding to</span><span class="step-num">${ruleNumber(rule)}</span><b>${escapeHtml(rule.name || 'Untitled rule')}</b>${outBadge(rule.outbound)}`
    : `${icon('i-target')}<span>Add a rule to start picking lists.</span>`;
}

function renderLibrary() {
  renderTabs();
  renderTarget();
  const rule = activeRule();
  entriesCache ||= allEntries();
  const q = query.trim().toLowerCase();
  const qNum = q.replace(/^as(?=\d)/, '');
  let entries = q
    ? entriesCache.filter((e) => e.search.toLowerCase().includes(q) || (qNum !== q && e.search.toLowerCase().includes(qNum)))
    : entriesCache.filter((e) => e.tab === tab);
  if (q) {
    const score = (e) => (e.label.toLowerCase() === q ? 0 : e.label.toLowerCase().startsWith(q) ? 1 : 2);
    const tabOrder = (e) => TABS.findIndex((t) => t[0] === e.tab);
    entries = entries.sort((a, b) => tabOrder(a) - tabOrder(b) || score(a) - score(b));
  }
  const list = $('#list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const isAsnQuery = /^(as)?\d+$/.test(q);
  if ((tab === 'asn' && !q) || isAsnQuery) list.append(asnAdder(isAsnQuery ? qNum : ''));
  if (!entries.length && !isAsnQuery) {
    list.insertAdjacentHTML('beforeend', `<div class="empty"><b>No lists match “${escapeHtml(query)}”</b>Try a service, a country code or an ASN.</div>`);
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
    list.insertAdjacentHTML('beforeend', `<div class="more">${fmtCount(entries.length - LIST_LIMIT)} more — search to narrow the list.</div>`);
  }
  list.scrollTop = scroll;
}

function entryButton(e, rule) {
  const on = Boolean(rule) && e.items.every((i) => rule.items.some((x) => itemKey(x) === itemKey(i)));
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item';
  b.dataset.fk = `lib:${e.tab}:${e.label}`;
  b.setAttribute('aria-pressed', String(on));
  const others = [...new Set(e.items.flatMap(where))];
  b.innerHTML = `<span class="check">${icon('i-check')}</span>`
    + `<span class="name${e.mono ? ' mono' : ''}">${escapeHtml(e.label)}</span>`
    + (others.length ? `<span class="elsewhere" title="Already in rule ${ruleNumber(others[0])}: ${escapeHtml(others[0].name)}"><span class="step-num">${ruleNumber(others[0])}</span>${escapeHtml(others[0].name)}</span>` : '')
    + (e.meta ? `<span class="meta">${escapeHtml(e.meta)}</span>` : '');
  if (rule) b.title = on ? `Remove from “${rule.name}”` : `Add to “${rule.name}”`;
  b.onclick = () => toggleItems(e.items, !on);
  return b;
}

function asnAdder(prefill) {
  const wrap = document.createElement('div');
  wrap.className = 'asn-add';
  wrap.innerHTML = `<label class="sr-only" for="asnInput">ASN number</label><input id="asnInput" class="input" placeholder="Any network, e.g. 17557" inputmode="numeric" autocomplete="off"><button class="btn btn-secondary" type="button">${icon('i-plus')}Add network</button>`;
  const input = $('input', wrap);
  input.value = prefill || '';
  const add = async () => {
    const n = input.value.trim().replace(/^as/i, '');
    if (!/^\d+$/.test(n)) return toast('Type an ASN number, like 17557', 'err');
    try {
      asnList ||= await fetch('data/asns.txt').then((r) => r.text()).then((t) => new Set(t.split('\n').filter(Boolean)));
    } catch {
      return toast("Couldn't load the network list", 'err');
    }
    if (!asnList.has(n)) return toast(`AS${n} has no list in MetaCubeX`, 'err');
    toggleItems([{ kind: 'asn', n }], true);
    toast(`AS${n} added`, 'ok');
  };
  $('button', wrap).onclick = add;
  input.onkeydown = (ev) => { if (ev.key === 'Enter') add(); };
  return wrap;
}

function toggleItems(items, add) {
  const rule = activeRule();
  if (!rule) return toast('Add a rule first', 'err');
  for (const item of items) {
    const key = itemKey(item);
    rule.items = rule.items.filter((i) => itemKey(i) !== key);
    if (add) rule.items.push(item);
  }
  render();
}

// ---------- rules ----------

function outBadge(out) {
  return `<span class="out-badge out-${out}">${icon(OUT[out].icon)}${OUT[out].label}</span>`;
}

function renderBuiltins() {
  const keys = ['bypassLan', 'systemDirect', 'blockAds', ...(state.regionSet ? ['bypassRegion'] : [])];
  const short = { bypassLan: 'LAN', systemDirect: 'System', blockAds: 'Ads', bypassRegion: 'Region' };
  $('#managedSummary').innerHTML = keys
    .map((k) => `<span class="${state.builtins[k] ? 'on' : ''}">${short[k]} ${state.builtins[k] ? 'on' : 'off'}</span>`)
    .join(' · ');
  const el = $('#builtins');
  el.innerHTML = '<p class="managed-note">Hiddify fills these in itself — Windows and Android differ — and checks them before your rules. The file only switches them on or off.</p>';
  for (const key of keys) {
    const [name, desc, out] = BUILTIN_INFO[key];
    const row = document.createElement('div');
    row.className = 'builtin';
    row.innerHTML = `<div class="builtin-text"><span class="builtin-name">${name}</span><span class="builtin-desc">${desc}</span></div>
      ${outBadge(out)}
      <label class="switch"><input type="checkbox" role="switch" data-fk="b:${key}" aria-label="${name}"><span class="track"></span></label>`;
    const box = $('input', row);
    box.checked = Boolean(state.builtins[key]);
    box.onchange = () => { state.builtins[key] = box.checked; render(); };
    el.append(row);
  }
  const region = document.createElement('label');
  region.className = 'region';
  region.innerHTML = '<input type="checkbox" data-fk="b:region"><span>A region is selected in Hiddify (Iran, China, Russia…). Leave this off if Hiddify’s region is <b>Other</b> — Pakistan isn’t one of its regions.</span>';
  const rbox = $('input', region);
  rbox.checked = Boolean(state.regionSet);
  rbox.onchange = () => { state.regionSet = rbox.checked; render(); };
  el.append(region);
}

function ruleCard(rule, i) {
  const li = document.createElement('li');
  li.className = 'rule';
  li.classList.toggle('active', rule.id === state.active);
  li.classList.toggle('off', !rule.enabled);
  li.dataset.id = rule.id;
  const n = state.rules.length;
  li.innerHTML = `
    <div class="rule-head">
      <span class="step-num" title="Checked ${ordinal(i + 1)}, after Hiddify's own rules">${i + 1}</span>
      <input class="rule-name" data-fk="${rule.id}:name" aria-label="Rule ${i + 1} name" maxlength="80" placeholder="Untitled rule">
      <div class="rule-controls">
        <span class="outbound" data-out="${rule.outbound}">${icon(OUT[rule.outbound].icon)}
          <select class="select select-sm" data-fk="${rule.id}:out" aria-label="Rule ${i + 1} sends matching traffic to">
            ${Object.entries(OUT).map(([v, o]) => `<option value="${v}"${v === rule.outbound ? ' selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </span>
        <label class="switch" title="${rule.enabled ? 'Rule is on' : 'Rule is off'}"><input type="checkbox" role="switch" data-fk="${rule.id}:on" aria-label="Rule ${i + 1} on"><span class="track"></span></label>
        <span class="rule-tools">
          <button type="button" class="iconbtn up" data-fk="${rule.id}:up" aria-label="Move rule ${i + 1} up" title="Move up (Alt+↑)" ${i === 0 ? 'disabled' : ''}>${icon('i-up')}</button>
          <button type="button" class="iconbtn down" data-fk="${rule.id}:down" aria-label="Move rule ${i + 1} down" title="Move down (Alt+↓)" ${i === n - 1 ? 'disabled' : ''}>${icon('i-down')}</button>
          <button type="button" class="iconbtn danger del" data-fk="${rule.id}:del" aria-label="Delete rule ${i + 1}" title="Delete rule">${icon('i-trash')}</button>
        </span>
      </div>
    </div>
    <div class="rule-main">
      <div class="chips"></div>
      <details class="conditions">
        <summary data-fk="${rule.id}:cond">${icon('i-sliders')}Domains, IPs, ports and apps</summary>
        <div class="cond-grid"></div>
      </details>
    </div>`;

  const name = $('.rule-name', li);
  name.value = rule.name;
  name.oninput = () => { rule.name = name.value; renderLibrary(); renderOutput(); save(); };
  const sel = $('select', li);
  sel.onchange = () => { rule.outbound = sel.value; render(); };
  const on = $('.switch input', li);
  on.checked = rule.enabled;
  on.onchange = () => { rule.enabled = on.checked; render(); };
  $('.up', li).onclick = () => move(rule, -1);
  $('.down', li).onclick = () => move(rule, 1);
  $('.del', li).onclick = () => removeRule(rule);

  const chips = $('.chips', li);
  if (!rule.items.length) {
    const p = document.createElement('p');
    p.className = 'rule-empty';
    p.innerHTML = rule.id === state.active
      ? 'No lists yet — pick some from the library.'
      : `No lists yet. <button type="button" class="linkbtn" data-fk="${rule.id}:pick">Add lists to this rule</button>`;
    chips.replaceWith(p);
    const pick = $('.linkbtn', p);
    if (pick) pick.onclick = () => { setActive(rule.id); setView('library'); };
  } else {
    for (const item of rule.items) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.title = itemUrl(item);
      chip.innerHTML = `<span class="label">${escapeHtml(itemLabel(item))}</span><span class="kind">${KIND_LABEL[item.kind]}</span><button type="button" aria-label="Remove ${escapeHtml(itemLabel(item))}">${icon('i-x')}</button>`;
      $('button', chip).onclick = () => { rule.items = rule.items.filter((x) => x !== item); render(`${rule.id}:name`); };
      chips.append(chip);
    }
  }

  const details = $('.conditions', li);
  const count = extraCount(rule);
  if (count) $('summary', details).insertAdjacentHTML('beforeend', `<span class="cond-count">${count}</span>`);
  details.open = openConditions.has(rule.id);
  details.ontoggle = () => { if (details.open) openConditions.add(rule.id); else openConditions.delete(rule.id); };
  const grid = $('.cond-grid', details);
  for (const [key, label, placeholder] of EXTRA_FIELDS) {
    const lab = document.createElement('label');
    lab.innerHTML = `<span>${label}</span><textarea spellcheck="false" data-fk="${rule.id}:${key}" placeholder="${escapeHtml(placeholder)}"></textarea>`;
    const ta = $('textarea', lab);
    ta.value = (rule[key] || []).join('\n');
    ta.rows = 1;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 160)}px`; ta.style.overflowY = ta.scrollHeight > 158 ? 'auto' : 'hidden'; };
    ta.addEventListener('input', grow);
    requestAnimationFrame(grow);
    details.addEventListener('toggle', grow);
    ta.onchange = () => {
      rule[key] = ta.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      render();
    };
    grid.append(lab);
  }
  grid.insertAdjacentHTML('beforeend', '<p class="cond-note">One per line. Lists, IPs and domains match if any of them match; ports and apps narrow the rule further. App rules need VPN (TUN) mode.</p>');

  // clicking the card makes it the target for new lists
  li.addEventListener('click', (ev) => {
    if (state.active !== rule.id && !ev.target.closest('button, input, select, textarea, summary, a, label')) setActive(rule.id);
  });
  li.addEventListener('focusin', (ev) => {
    if (state.active !== rule.id && ev.target.matches('.rule-name, select, textarea')) { state.active = rule.id; refreshActive(); }
  });
  // Alt+↑ / Alt+↓ moves the rule from anywhere inside it
  li.addEventListener('keydown', (ev) => {
    if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      move(rule, ev.key === 'ArrowUp' ? -1 : 1, document.activeElement?.dataset.fk);
    }
  });
  return li;
}

function renderRules() {
  const el = $('#ruleList');
  el.innerHTML = '';
  state.rules.forEach((rule, i) => el.append(ruleCard(rule, i)));
  $('#ruleCount').textContent = state.rules.length || '';
}

/** Light update when only the target rule changed (keeps focus and typing intact). */
function refreshActive() {
  for (const li of $$('#ruleList .rule')) li.classList.toggle('active', Number(li.dataset.id) === state.active);
  renderLibrary();
  save();
}

function setActive(id) {
  if (state.active === id) return;
  state.active = id;
  render();
}

function move(rule, dir, keepFocus) {
  const i = state.rules.indexOf(rule);
  const j = i + dir;
  if (j < 0 || j >= state.rules.length) return;
  state.rules.splice(i, 1);
  state.rules.splice(j, 0, rule);
  render(keepFocus || `${rule.id}:${dir < 0 ? 'up' : 'down'}`);
  $(`#ruleList .rule[data-id="${rule.id}"]`)?.classList.add('flash');
  announce(`Rule moved to position ${j + 1}`);
}

async function removeRule(rule) {
  if (ruleHasContent(rule) && !(await confirmDialog(`Delete “${rule.name || 'Untitled rule'}”?`, 'Its lists and conditions will be removed.', 'Delete'))) return;
  const i = state.rules.indexOf(rule);
  state.rules = state.rules.filter((r) => r !== rule);
  if (state.active === rule.id) state.active = state.rules[Math.max(0, i - 1)]?.id;
  render();
  toast('Rule deleted');
}

function renderFallback() {
  for (const b of $$('#fallback button')) {
    const on = b.dataset.value === state.fallback;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('#fallbackNote').textContent = state.fallback === 'direct'
    ? 'Traffic no rule matched connects directly through your ISP. Two catch-all rules are added at the end for this, since Hiddify can’t set its default to Direct.'
    : 'Traffic no rule matched goes through the VPN — Hiddify’s default.';
}

// ---------- output ----------

function renderOutput() {
  const built = toBuilderState();
  const started = state.rules.some(ruleHasContent);
  const notes = started ? lint(built) : [];
  if (started && state.rules.some((r) => r.enabled && r.items.some((i) => i.kind === 'asn' && !index.mirroredAsns.includes(Number(i.n)))))
    notes.unshift({ level: 'info', text: 'Networks outside the popular list link straight to MetaCubeX; Hiddify also uses them in DNS rules, which is harmless but a little slower.' });
  if (started && state.fallback === 'direct' && !state.rules.some((r) => r.enabled && r.outbound === 'proxy' && hasCondition({ ...r, ruleSets: r.items.map(itemUrl) })))
    notes.unshift({ level: 'warn', text: 'No rule sends anything through the VPN, so all traffic would connect directly.' });
  $('#notes').innerHTML = notes.map((n) => `<div class="note ${n.level}">${icon(n.level === 'warn' ? 'i-alert' : 'i-info')}<span>${escapeHtml(n.text)}</span></div>`).join('');
  $('#openHiddify').href = toImportLink(built);
}

function highlightJson(text) {
  return escapeHtml(text).replace(
    /(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)|([{}[\],])/g,
    (m, str, colon, bool, num, punct) => {
      if (str) return colon ? `<span class="k">${str}</span><span class="p">${colon}</span>` : `<span class="s">${str}</span>`;
      if (bool) return `<span class="b">${bool}</span>`;
      if (num) return `<span class="n">${num}</span>`;
      return `<span class="p">${punct}</span>`;
    },
  );
}

function openPreview() {
  const obj = toRouteRule(toBuilderState());
  $('#preview').innerHTML = highlightJson(JSON.stringify(obj, null, 2));
  const n = obj['1'].length;
  $('#previewMeta').textContent = `${n} rule${n === 1 ? '' : 's'} · ${fmtCount(toJsonFile(toBuilderState()).length)} bytes · numbered fields, as Hiddify writes them`;
  $('#previewDialog').showModal();
}

function renderSources() {
  const s = index.sources;
  const rows = [
    ['sn_site', `${fmtCount(index.counts.sites)} site lists`],
    ['sn_ip', `${index.counts.countries} country IP lists`],
    ['mc', `${index.counts.services} service IP lists · ${fmtCount(index.counts.asns)} networks`],
    ['hg', `${index.counts.block} block lists`],
  ];
  $('#sourcesBody').innerHTML = `<ul class="sources">${rows.map(([k, what]) => `
      <li><span><a href="https://github.com/${s[k].repo}/tree/${s[k].branch}" target="_blank" rel="noopener">${s[k].name}</a><span class="what">${what}</span></span>
      <time datetime="${s[k].updated}">updated ${fmtDate(s[k].updated)}</time></li>`).join('')}
    </ul>
    <p class="sources-foot">This page re-reads the lists every day; it last did so ${fmtDate(index.generated)}. Hiddify downloads the lists from these sources and keeps them current itself. <a href="https://github.com/AzizKamboh/hiddify-rules" target="_blank" rel="noopener">Source code on GitHub</a>.</p>`;
  $('#syncLine').textContent = `Lists synced ${fmtDate(index.generated)}`;
  const total = index.counts.sites + index.counts.countries + index.counts.services + index.counts.asns + index.counts.block;
  $('#libCounts').textContent = `${fmtCount(total)} lists`;
}

// ---------- render ----------

function render(focusKey) {
  const fk = focusKey || document.activeElement?.dataset?.fk;
  if (!state.rules.find((r) => r.id === state.active)) state.active = state.rules[0]?.id;
  renderBuiltins();
  renderRules();
  renderFallback();
  renderLibrary();
  renderOutput();
  save();
  if (fk) {
    let el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    if (!el || el.disabled) el = document.querySelector(`[data-fk="${CSS.escape(fk.replace(/:[^:]+$/, ':name'))}"]`);
    el?.focus({ preventScroll: false });
  }
}

// ---------- actions ----------

function download() {
  const blob = new Blob([toJsonFile(toBuilderState())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'route_rules.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('route_rules.json downloaded', 'ok');
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage, 'ok');
  } catch {
    toast("Couldn't reach the clipboard — copy it from the preview instead", 'err');
  }
}

async function loadFile(file) {
  let parsed;
  try {
    parsed = parseRouteRules(await file.text());
  } catch (err) {
    console.warn(err);
    return toast(`“${file.name}” isn't a Hiddify route_rules.json`, 'err');
  }
  if (state.rules.some(ruleHasContent) && !(await confirmDialog('Replace your rules?', `Loading “${file.name}” replaces the rules you have now.`, 'Replace'))) return;
  const rules = parsed.rules.map((r) => {
    const rule = emptyRule(r.name, r.outbound);
    rule.enabled = r.enabled;
    rule.items = (r.ruleSets || []).map(urlToItem);
    for (const [key] of EXTRA_FIELDS) rule[key] = r[key] || [];
    if (extraCount(rule)) openConditions.add(rule.id);
    return rule;
  });
  if (!rules.length) rules.push(emptyRule());
  state = { builtins: parsed.builtins, regionSet: parsed.regionSet, rules, fallback: parsed.fallback, active: rules[0].id };
  render();
  setView('rules');
  toast(`Loaded ${parsed.rules.length} rule${parsed.rules.length === 1 ? '' : 's'} from ${file.name}`, 'ok');
}

// ---------- dialogs, toasts ----------

function confirmDialog(title, text, okLabel = 'Confirm') {
  const dlg = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  $('#confirmOk').focus();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
  });
}

function toast(text, kind = '') {
  const wrap = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  const ic = kind === 'ok' ? 'i-check' : kind === 'err' ? 'i-alert' : 'i-info';
  t.innerHTML = `${icon(ic)}<span>${escapeHtml(text)}</span>`;
  wrap.append(t);
  while ($$('.toast', wrap).length > 3) $('.toast', wrap).remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, kind === 'err' ? 4000 : 2800);
}

function announce(text) {
  const s = document.createElement('span');
  s.className = 'sr-only';
  s.textContent = text;
  $('#toasts').append(s);
  setTimeout(() => s.remove(), 1500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------- theme & view ----------

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function themePref() {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}

function applyTheme(pref, animate) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark.matches);
  const root = document.documentElement;
  if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 260);
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.themePref = pref;
  for (const b of $$('.theme-switch button')) {
    const on = b.dataset.themePref === pref;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
}

function setView(view) {
  document.body.dataset.view = view;
  for (const b of $$('.viewswitch button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  try { sessionStorage.setItem('hiddify-rules-builder:view', view); } catch { /* ignore */ }
}

/** Arrow keys move between the options of a radiogroup made of buttons. */
function radioKeys(group, pick) {
  group.addEventListener('keydown', (ev) => {
    const buttons = $$('[role="radio"]', group);
    const i = buttons.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (i < 0 || !step) return;
    ev.preventDefault();
    const next = buttons[(i + step + buttons.length) % buttons.length];
    pick(next);
    group.querySelector(`[role="radio"][data-value="${next.dataset.value}"], [role="radio"][data-theme-pref="${next.dataset.themePref}"]`)?.focus();
  });
}

// ---------- start ----------

async function start() {
  applyTheme(themePref(), false);
  for (const b of $$('.theme-switch button')) {
    b.onclick = () => {
      try { localStorage.setItem(THEME_KEY, b.dataset.themePref); } catch { /* ignore */ }
      applyTheme(b.dataset.themePref, true);
    };
  }
  radioKeys($('.theme-switch'), (b) => b.click());
  systemDark.addEventListener('change', () => { if (themePref() === 'system') applyTheme('system', true); });

  for (const b of $$('.viewswitch button')) b.onclick = () => setView(b.dataset.view);
  let view = 'library';
  try { view = sessionStorage.getItem('hiddify-rules-builder:view') || 'library'; } catch { /* ignore */ }
  setView(view);

  try {
    index = await fetch('data/index.json', { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  } catch (err) {
    console.warn(err);
    $('#list').innerHTML = '<div class="empty"><b>The list index couldn’t be loaded</b>Reload the page, or run <code>node scripts/build-index.mjs</code> when working locally.</div>';
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
  presetSel.onchange = async () => {
    const id = presetSel.value;
    presetSel.value = '';
    if (id) await applyPreset(id);
  };

  let searchTimer;
  $('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = e.target.value; renderLibrary(); }, 80);
  };
  $('#search').onkeydown = (e) => {
    if (e.key === 'Escape' && e.target.value) { e.target.value = ''; query = ''; renderLibrary(); }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select') && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      setView('library');
      $('#search').focus();
    }
  });
  $('#tabs').addEventListener('keydown', (ev) => {
    const tabs = $$('.tab');
    const i = tabs.indexOf(document.activeElement);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (i < 0 || !step) return;
    ev.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.click();
    $(`.tab[data-tab="${next.dataset.tab}"]`)?.focus();
  });

  $('#addRule').onclick = () => {
    const rule = emptyRule(`Rule ${state.rules.length + 1}`, 'proxy');
    state.rules.push(rule);
    state.active = rule.id;
    render(`${rule.id}:name`);
    $(`[data-fk="${rule.id}:name"]`)?.select();
  };
  $('#reset').onclick = async () => {
    if (await confirmDialog('Start over?', 'This clears your rules and sets everything back to the defaults.', 'Reset')) {
      state = defaultState();
      openConditions.clear();
      render();
      toast('Started over');
    }
  };
  $('#fallback').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) { state.fallback = b.dataset.value; render(); }
  };
  radioKeys($('#fallback'), (b) => { state.fallback = b.dataset.value; render(); });

  $('#download').onclick = download;
  $('#copyLink').onclick = () => copyText(toImportLink(toBuilderState()), 'Import link copied — in Hiddify use ⋮ → Import from clipboard');
  $('#openHiddify').addEventListener('click', () => toast('Opening Hiddify… If nothing happens, download the file instead.'));
  $('#copyJson').onclick = () => copyText(toJsonFile(toBuilderState()), 'JSON copied');
  $('#previewBtn').onclick = openPreview;
  $('#howtoBtn').onclick = () => $('#howtoDialog').showModal();
  $('#sourcesBtn').onclick = () => $('#sourcesDialog').showModal();
  $('#loadFile').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  }

  renderSources();
  render();
}

start();
