import { toRouteRule, BUILTIN_DEFAULTS } from './lib/hiddify.js?v=__BUILD__';
import {
  itemKey, groupPicks as groupPicksWith, neededByOthers as neededWith, withoutPicks, splitUpload, fileText as fileTextWith,
} from './lib/picks.js?v=__BUILD__';

// ---------- constants ----------

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const STORE_KEY = 'hiddify-rules-builder:v1';           // saved state (older saves are converted on load)
const THEME_KEY = 'hiddify-rules-builder:theme';        // light | dark | system
const LIST_LIMIT = 250;

const KIND_LABEL = { pk: 'sites', site: 'sites', country: 'country', service: 'IP ranges', asn: 'network', block: 'block list', url: 'custom' };
const OUT = {
  proxy: { label: 'VPN', icon: 'i-vpn', plain: 'through the VPN' },
  direct: { label: 'Direct', icon: 'i-direct', plain: 'direct via your ISP' },
  direct_with_fragment: { label: 'Direct + fragment', icon: 'i-fragment', plain: 'direct, with fragmented TLS' },
  block: { label: 'Block', icon: 'i-block', plain: 'blocked' },
};
const MODES = {
  exclude: { desc: 'What you pick bypasses the VPN and connects directly through your ISP. Everything else uses the VPN — like Hiddify’s default, where only your local network bypasses it.', row: 'Bypass VPN', out: 'direct' },
  include: { desc: 'Only what you pick uses the VPN. Everything else — your local network included — connects directly through your ISP.', row: 'Use VPN', out: 'proxy' },
};
const BUILTIN_INFO = {
  bypassLan: ['Bypass LAN', 'Local network and private addresses connect directly.', 'direct'],
  systemDirect: ['System services', 'Updates, app store, push and cloud sync connect directly. Windows: Microsoft · Android: Google/Android · iOS & macOS: Apple · Linux: distro mirrors.', 'direct'],
  blockAds: ['Ads and malware', "Hiddify's ad, malware, phishing and miner lists are blocked.", 'block'],
  bypassRegion: ['Bypass region', 'Sites and IPs of the region set in Hiddify connect directly.', 'direct'],
};
const TABS = [
  ['services', 'Services', 'i-star'], ['countries', 'Countries', 'i-flag'], ['sites', 'Websites', 'i-globe'],
  ['asn', 'Networks', 'i-network'], ['block', 'AdBlock', 'i-shield-off'],
];
const IP_GROUP = 'IP ranges';

const icon = (id, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const regionNames = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
const countryName = (code) => { try { return regionNames?.of(code.toUpperCase()) || code; } catch { return code; } };
const fmtCount = (n) => Number(n).toLocaleString('en-US');
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const az = (a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' });

let index = null;
let asnList = null;      // every MetaCubeX ASN number (Set), loaded on first use
let asnNames = null;     // Map asn -> { cc, name }, loaded on first use
let asnNamesLoading = null;
let siteSource = new Map();
let siteDomains = new Map();
let state = null;
let tab = 'services';
let query = '';
let entriesCache = null;
let shownEntries = [];   // lists on screen in the library, for Select all

// ---------- state ----------

/** Hiddify's own defaults: built-ins as shipped, nothing split, everything through the VPN. */
function defaultState() {
  return { builtins: { ...BUILTIN_DEFAULTS }, regionSet: false, mode: 'exclude', picks: [], blocked: [], kept: [] };
}

/** Turns a list of rules (from an old save or an uploaded file) into Include or Exclude picks. */
function fromRules({ builtins, regionSet, rules, fallback }) {
  const base = { ...defaultState(), builtins: { ...BUILTIN_DEFAULTS, ...(builtins || {}) }, regionSet: Boolean(regionSet) };
  const real = (rules || []).filter((r) => r.enabled !== false && (r.items || []).length);
  const blocked = real.filter((r) => r.outbound === 'block').flatMap((r) => r.items);
  const others = real.filter((r) => r.outbound !== 'block');
  // Include when everything else goes direct, otherwise Exclude (Hiddify's default direction)
  const mode = fallback === 'direct' ? 'include' : 'exclude';
  const want = mode === 'include' ? 'proxy' : 'direct';
  const picks = others.filter((r) => (r.outbound === 'direct_with_fragment' ? 'direct' : r.outbound) === want).flatMap((r) => r.items);
  return { ...base, mode, picks, blocked };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && saved.mode === 'advanced') return fromRules(saved);
    if (saved && saved.mode) {
      const d = defaultState();
      const s = { builtins: { ...BUILTIN_DEFAULTS, ...(saved.builtins || {}) }, regionSet: Boolean(saved.regionSet), mode: MODES[saved.mode] ? saved.mode : d.mode, picks: saved.picks || [], blocked: saved.blocked || [], kept: Array.isArray(saved.kept) ? saved.kept : [] };
      return s;
    }
    // a save from before split tunneling: numbered rules + "everything else"
    if (saved && Array.isArray(saved.rules)) return fromRules(saved);
  } catch { /* ignore broken saves */ }
  return defaultState();
}

/** How many tags the picks show: a popular service picked whole (sites + IPs) counts once. */
function tagCount(items) {
  return groupPicks(items).length;
}

/**
 * Picks as rows: each popular service picked whole is one row (services may share a list, e.g.
 * WhatsApp and Instagram both use the Facebook IP list), every other list is a row of its own.
 */
/**
 * Groups of lists picked together as one choice: the popular services, and "Everything in Pakistan"
 * (Pakistani websites, the Pakistan country IP list and the Pakistan networks).
 */
let bundleCache = null;
function bundles() {
  if (bundleCache) return bundleCache;
  bundleCache = index.featured.map((f) => ({
    cat: 'services', label: f.label, kind: describeFeatured(f), visual: visual({ domain: f.domain, letter: f.label }), items: featuredItems(f),
  }));
  if ((index.pakistan || []).length) bundleCache.push({ cat: 'services', label: PK_BUNDLE, kind: 'sites + country + networks', visual: visual({ flag: 'pk' }), items: pkBundleItems() });
  return bundleCache;
}
const PK_BUNDLE = 'Everything in Pakistan';
function pkBundleItems() {
  return [
    { kind: 'pk', n: 'all' }, { kind: 'country', n: 'pk' },
    ...index.asnGroups.flatMap((g) => g.items.map((a) => ({ kind: 'asn', n: String(a.asn), label: a.label, cc: 'PK' }))),
  ];
}

function groupPicks(items) {
  return groupPicksWith(items, bundles());
}


/** Removes picks; when they make up a popular service, lists another picked service shares stay. */
function removePicks(bucketKey, members) {
  state[bucketKey] = withoutPicks(state[bucketKey], members, bundles());
  render();
}
const pickCount = () => tagCount(state.picks) + tagCount(state.blocked) + state.kept.length;

// ---------- lists → URLs ----------

function itemUrl(item) {
  const u = index.urls;
  const fill = (tpl) => tpl.replace('{n}', item.n);
  switch (item.kind) {
    case 'site': return fill(siteSource.get(item.n) === 'm' ? u.site_m : u.site_s);
    case 'country': return fill(u.country);
    case 'service': return fill(u.service);
    case 'pk': return fill(u.pk);
    case 'asn': return fill(index.allAsnsMirrored || index.mirroredAsns.includes(Number(item.n)) ? u.asn_mirror : u.asn);
    case 'block': return fill(u.block);
    default: return item.n;
  }
}

function urlToItem(url) {
  const u = index.urls;
  const tries = [
    ['site', u.site_s], ['site', u.site_m], ['country', u.country], ['service', u.service],
    ['asn', u.asn_mirror], ['asn', u.asn], ['block', u.block], ['pk', u.pk],
  ];
  for (const [kind, tpl] of tries) {
    if (!tpl) continue;
    const [pre, post] = tpl.split('{n}');
    if (url.startsWith(pre) && url.endsWith(post)) {
      const n = url.slice(pre.length, url.length - post.length);
      if (n && !n.includes('/')) return { kind, n };
    }
  }
  return { kind: 'url', n: url };
}

function asnLabel(n) {
  const known = index.asnGroups.flatMap((g) => g.items).find((a) => String(a.asn) === String(n));
  if (known) return known.label;
  return asnNames?.get(String(n))?.name || '';
}

function itemLabel(item) {
  switch (item.kind) {
    case 'country': return countryName(item.n);
    case 'asn': {
      const name = item.label || asnLabel(item.n);
      return name ? `${name} · AS${item.n}` : `AS${item.n}`;
    }
    case 'service': return `${item.n[0].toUpperCase()}${item.n.slice(1)} IPs`;
    case 'block': return `${blockName(item.n)}${item.n.startsWith('geoip') ? ' IPs' : ''}`;
    case 'url': return item.n.split('/').pop();
    case 'pk': {
      const label = (index.pakistan || []).find((l) => l.id === item.n)?.label || item.n;
      return label.startsWith('Pakistan') ? label : `Pakistani ${label[0].toLowerCase()}${label.slice(1)}`;
    }
    default: {
      const f = index.featured.find((x) => x.site[0] === item.n);
      return f ? f.label : siteLabel(item.n);
    }
  }
}

/** What the generator gets: the simple modes become at most two rules plus "everything else". */
function toBuilderState() {
  const rules = [];
  const mk = (name, outbound, items) => ({ name, outbound, enabled: true, items, ruleSets: items.map(itemUrl) });
  if (state.blocked.length) rules.push(mk('AdBlock', 'block', state.blocked));
  if (state.picks.length) rules.push(mk(MODES[state.mode].row, MODES[state.mode].out, state.picks));
  return { builtins: state.builtins, regionSet: state.regionSet, fallback: state.mode === 'include' ? 'direct' : 'proxy', rules };
}

// ---------- icons: service favicons and country flags ----------

const FAVICON = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
const FAVICON_2 = (domain) => `https://icons.duckduckgo.com/ip3/${domain}.ico`;
// website lists shown under a friendlier name, and logos for lists no service covers
const SITE_LABEL = { wikimedia: 'Wikipedia' };
const SITE_TAG = { cn: 'China', '!cn': 'outside China', ads: 'ads', telemetry: 'telemetry' };
const titleWords = (s) => s.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
/** Website list names for people: youtube -> YouTube (the service's name), google-play@cn -> Google Play (China). */
function siteLabel(n) {
  if (SITE_LABEL[n]) return SITE_LABEL[n];
  const f = index.featured.find((x) => x.site.length === 1 && x.site[0] === n);
  if (f) return f.label;
  const [base, tag] = n.split('@');
  const name = titleWords(base.replace(/^category-/, '').replace(/-all$/, ''));
  return tag ? `${name} (${SITE_TAG[tag] || tag})` : name;
}
/** iptoasn names for people: 'WATEEN-IMS-PK-AS-AP Wateen Telecom' -> 'Wateen Telecom'. */
function networkLabel(raw) {
  let s = raw.trim();
  const dash = s.indexOf(' - ');
  if (dash > 0) s = s.slice(dash + 3);
  else {
    const [first, ...rest] = s.split(' ');
    if (rest.length && /^[A-Z0-9._-]+$/.test(first) && /[a-z]/.test(rest.join(' '))) s = rest.join(' ');
  }
  // names written all in capitals get normal case, short words (LLC, AB) stay as they are
  if (!/[a-z]/.test(s)) s = s.split(' ').map((w) => (w.length > 3 ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
  return s || raw;
}
const SITE_DOMAIN = { wikimedia: 'wikipedia.org' };
const BLOCK_ICON = (n) => (n.includes('ads') ? 'i-megaphone' : n.includes('malware') ? 'i-bug' : n.includes('phishing') ? 'i-hook' : n.includes('crypto') ? 'i-cpu' : 'i-shield-off');

function itemDomain(item) {
  if (item.kind === 'service') return index.serviceDomains?.[item.n];
  if (item.kind === 'site') return siteDomains.get(item.n);
  return null;
}

function visual({ flag, domain, letter }) {
  if (flag) return `<img class="flag" src="flags/${flag}.svg" alt="" loading="lazy" decoding="async" data-letter="${escapeHtml(flag.toUpperCase())}">`;
  if (domain) return `<img class="favicon" src="${FAVICON(domain)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${FAVICON_2(domain)}" data-letter="${escapeHtml((letter || domain)[0].toUpperCase())}">`;
  return `<span class="letter" aria-hidden="true">${escapeHtml((letter || '?')[0].toUpperCase())}</span>`;
}

/** AdBlock lists by a readable name: geosite-category-ads-all -> Ads, geoip-malware -> Malware. */
const blockName = (n) => { const b = n.replace(/^geo(site|ip)-/, '').replace(/^category-/, '').replace(/-all$/, ''); return b[0].toUpperCase() + b.slice(1); };
const blockVisual = (n) => `<span class="letter block-ic" aria-hidden="true">${icon(BLOCK_ICON(n))}</span>`;

function itemVisual(item) {
  if (item.kind === 'country') return visual({ flag: item.n });
  if (item.kind === 'block') return blockVisual(item.n);
  if (item.kind === 'pk') return visual({ flag: 'pk' });
  if (item.kind === 'asn') {
    const cc = asnNames?.get(String(item.n))?.cc || item.cc;
    return cc ? visual({ flag: cc.toLowerCase() }) : visual({ letter: 'N' });
  }
  const domain = itemDomain(item);
  return domain ? visual({ domain, letter: itemLabel(item) }) : visual({ letter: itemLabel(item) });
}

document.addEventListener('load', (ev) => {
  const img = ev.target;
  if (img instanceof HTMLImageElement && img.classList.contains('favicon') && img.dataset.fallback && img.naturalWidth <= 1) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
  }
}, true);

document.addEventListener('error', (ev) => {
  const img = ev.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.letter) return;
  if (img.dataset.fallback) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
    return;
  }
  const span = document.createElement('span');
  span.className = 'letter';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = img.dataset.letter.slice(0, 2);
  img.replaceWith(span);
}, true);

// ---------- network names (iptoasn.com, loaded on first use) ----------

function loadAsnNames() {
  if (asnNames || !index.asnNames) return Promise.resolve();
  asnNamesLoading ||= fetch(index.asnNames)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))
    .then((text) => {
      const map = new Map();
      for (const line of text.split('\n')) {
        const [asn, cc, name] = line.split('\t');
        if (asn && name) map.set(asn, { cc: cc || '', name: networkLabel(name), raw: name });
      }
      asnNames = map;
      entriesCache = null;
      render();
    })
    .catch(() => { asnNamesLoading = null; });
  return asnNamesLoading;
}

function loadAsnList() {
  if (asnList) return;
  fetch('data/asns.txt').then((r) => r.text()).then((t) => { asnList = new Set(t.split('\n').filter(Boolean)); renderLibrary(); }).catch(() => {});
}

// ---------- library ----------

function featuredItems(f) {
  return [...f.site.map((n) => ({ kind: 'site', n })), ...f.ip.map((n) => ({ kind: 'service', n }))];
}

function describeFeatured(f) {
  return [f.site.length && 'sites', f.ip.length && 'IPs'].filter(Boolean).join(' + ');
}

function allEntries() {
  const out = [];
  const services = [];
  for (const f of index.featured) {
    services.push({ tab: 'services', group: f.group, visual: visual({ domain: f.domain, letter: f.label }), label: f.label, meta: describeFeatured(f), items: featuredItems(f), search: `${f.label} ${f.id} ${f.site.join(' ')}` });
  }
  for (const s of index.services) {
    services.push({ tab: 'services', group: IP_GROUP, visual: visual({ domain: index.serviceDomains?.[s], letter: s }), label: `${s[0].toUpperCase()}${s.slice(1)} IP ranges`, meta: 'IPs only', items: [{ kind: 'service', n: s }], search: `${s} ip` });
  }
  services.sort((a, b) => az(a.group, b.group) || az(a.label, b.label));
  // Pakistan first: the page is mostly used from Pakistan
  for (const [i, l] of (index.pakistan || []).entries()) {
    if (i === 0) {
      out.push({ tab: 'services', group: 'Pakistan', visual: visual({ flag: 'pk' }), label: PK_BUNDLE, meta: 'sites + country + networks', items: pkBundleItems(),
        title: 'Pakistani websites, Pakistan’s country IP list and the Pakistan networks together', search: `${PK_BUNDLE} pakistan pk local` });
    }
    out.push({ tab: 'services', group: 'Pakistan', visual: visual({ flag: 'pk' }), label: l.label,
      meta: l.allPk ? `.pk + ${fmtCount(l.count)} sites` : `${fmtCount(l.count)} sites`, items: [{ kind: 'pk', n: l.id }],
      title: `For example: ${l.examples.join(', ')} — full lists: github.com/AzizKamboh/hiddify-rules/blob/main/data/pakistan.txt`, search: `${l.label} pakistan pk ${l.examples.join(' ')}` });
  }
  out.push(...services);
  for (const [n, src] of index.sites) {
    const label = siteLabel(n);
    out.push({ tab: 'sites', label, meta: src === 'm' ? 'MetaCubeX' : '', visual: siteDomains.has(n) ? visual({ domain: siteDomains.get(n), letter: label }) : visual({ letter: label }), items: [{ kind: 'site', n }], search: `${label} ${n}` });
  }
  const countries = [...index.countries].sort((a, b) => az(countryName(a), countryName(b)));
  for (const c of countries) {
    out.push({ tab: 'countries', visual: visual({ flag: c }), label: countryName(c), meta: c.toUpperCase(), items: [{ kind: 'country', n: c }], search: `${countryName(c)} ${c}` });
  }
  for (const g of index.asnGroups) {
    for (const a of g.items) {
      out.push({ tab: 'asn', group: g.group, visual: visual({ flag: 'pk' }), label: a.label, meta: `AS${a.asn}`, items: [{ kind: 'asn', n: String(a.asn), label: a.label, cc: 'PK' }], search: `as${a.asn} ${a.asn} ${a.label}` });
    }
  }
  const blocks = [...index.block].sort((a, b) => az(blockName(a), blockName(b)) || (a.startsWith('geoip') ? 1 : -1));
  for (const b of blocks) {
    out.push({ tab: 'block', visual: blockVisual(b), label: `${blockName(b)}${b.startsWith('geoip') ? ' IPs' : ''}`, meta: b.startsWith('geoip') ? 'IP list' : 'domains', items: [{ kind: 'block', n: b }], search: `${blockName(b)} ${b}` });
  }
  return out;
}

/** Networks matching a search, from the name list (only searched, never listed in full). */
function networkMatches(q) {
  if (!asnNames || q.length < 2) return [];
  const qNum = q.replace(/^as(?=\d)/, '');
  const ccQuery = q.length === 2 ? q.toUpperCase() : null;
  const country = !ccQuery && q.length >= 4 ? index.countries.find((c) => countryName(c).toLowerCase() === q) : null;
  const pinned = new Set(index.asnGroups.flatMap((g) => g.items.map((a) => String(a.asn))));
  const out = [];
  for (const [asn, { cc, name, raw }] of asnNames) {
    if (pinned.has(asn)) continue;
    const hit = /^\d+$/.test(qNum) ? asn.startsWith(qNum)
      : (ccQuery && cc === ccQuery) || (country && cc === country.toUpperCase()) || `${name} ${raw}`.toLowerCase().includes(q);
    if (!hit) continue;
    out.push({ tab: 'asn', group: cc ? countryName(cc) : 'Other', visual: cc ? visual({ flag: cc.toLowerCase() }) : '', label: name, meta: `AS${asn}`, items: [{ kind: 'asn', n: asn, label: name, cc }], search: '' });
    if (out.length >= 200) break;
  }
  return out;
}

function renderTabs() {
  const counts = { services: index.featured.length + (index.pakistan || []).length + 1 + index.counts.services, sites: index.counts.sites, countries: index.counts.countries, asn: index.counts.asns, block: index.counts.block };
  const el = $('#tabs');
  const focused = document.activeElement?.closest?.('#tabs') ? document.activeElement.dataset.tab : null;
  el.innerHTML = '';
  for (const [id, label, ic] of TABS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab';
    b.setAttribute('role', 'tab');
    const selected = tab === id;
    b.setAttribute('aria-selected', String(selected));
    b.tabIndex = selected ? 0 : -1;
    if (selected) $('#search').placeholder = `Search ${label.toLowerCase()}…`;
    b.dataset.tab = id;
    b.innerHTML = `${icon(ic)}<span>${label}</span><span class="count">${fmtCount(counts[id])}</span>`;
    b.onclick = () => { tab = id; $('#list').scrollTop = 0; if (id === 'asn') { loadAsnNames(); loadAsnList(); } renderLibrary(); };
    el.append(b);
  }
  if (focused) $(`.tab[data-tab="${focused}"]`)?.focus();
}

/** Where a tick in the library lands, given the mode and the kind of list. */
function bucketFor(items) {
  return items.every((i) => i.kind === 'block') ? state.blocked : state.picks;
}

function isPicked(items) {
  const bucket = bucketFor(items);
  return Boolean(bucket) && items.every((i) => bucket.some((x) => itemKey(x) === itemKey(i)));
}

function renderLibrary() {
  renderTabs();
  entriesCache ||= allEntries();
  const q = query.trim().toLowerCase();
  const qNum = q.replace(/^as(?=\d)/, '');
  // search stays inside the selected category
  let entries = entriesCache.filter((e) => e.tab === tab
    && (!q || e.search.toLowerCase().includes(q) || (qNum !== q && e.search.toLowerCase().includes(qNum))));
  if (q) {
    const score = (e) => (e.label.toLowerCase() === q ? 0 : e.label.toLowerCase().startsWith(q) ? 1 : 2);
    const ipOnly = (e) => (e.group === IP_GROUP ? 1 : 0);
    entries = entries.sort((a, b) => score(a) - score(b) || ipOnly(a) - ipOnly(b));
    if (tab === 'asn') entries.push(...networkMatches(q));
  } else if (tab === 'sites') {
    entries = POPULAR_SITES.map((n) => entries.find((e) => e.items[0].n === n)).filter(Boolean);
  }
  const list = $('#list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  const isAsnQuery = tab === 'asn' && /^(as)?\d+$/.test(q);
  if (isAsnQuery) {
    if (!asnList) loadAsnList();
    else if (!entries.some((e) => e.items.some((i) => i.kind === 'asn' && String(i.n) === qNum))) {
      const shown = new Set(entries.flatMap((e) => e.items.filter((i) => i.kind === 'asn').map((i) => String(i.n))));
      const nums = [...asnList].filter((a) => a.startsWith(qNum) && !shown.has(a)).sort((a, b) => a.length - b.length || a - b).slice(0, 200);
      for (const a of nums) {
        const info = asnNames?.get(a);
        entries[a === qNum ? 'unshift' : 'push']({ tab: 'asn', group: info?.cc ? countryName(info.cc) : '', label: info?.name || `AS${a}`, meta: info?.name ? `AS${a}` : 'network', visual: info?.cc ? visual({ flag: info.cc.toLowerCase() }) : visual({ letter: 'N' }), items: [{ kind: 'asn', n: a, label: info?.name, cc: info?.cc }], search: '' });
      }
      if (!nums.length) list.insertAdjacentHTML('beforeend', `<div class="empty"><b>No list for AS${escapeHtml(qNum)}</b>MetaCubeX has no list for this network.</div>`);
    }
  }
  if (tab === 'asn' && !q) {
    list.insertAdjacentHTML('beforeend', `<p class="list-hint">Search ${fmtCount(index.counts.asns)} networks by name, number or country, e.g. “Wateen”, “17557”, “PK”.</p>`);
  }
  if (tab === 'sites' && !q) {
    list.insertAdjacentHTML('beforeend', `<p class="list-hint">Search ${fmtCount(index.counts.sites)} websites by name, e.g. “youtube”, “netflix”, “github”.</p>`);
  }
  shownEntries = entries.slice(0, LIST_LIMIT);
  const picked = tagCount(picksInCategory(state.picks, tab)) + tagCount(picksInCategory(state.blocked, tab));
  $('#selectAll').disabled = !shownEntries.length || shownEntries.every((e) => isPicked(e.items));
  $('#clearCat').disabled = !picked;
  $('#pickedHere').textContent = picked ? `${fmtCount(picked)} picked here` : '';
  if (!entries.length && !isAsnQuery) {
    list.insertAdjacentHTML('beforeend', `<div class="empty"><b>No ${escapeHtml(TABS.find((t) => t[0] === tab)[1].toLowerCase())} match “${escapeHtml(query)}”</b>Try another name, or another category above.</div>`);
    return;
  }
  let lastGroup = null;
  for (const e of shownEntries) {
    const group = tab === 'sites' && !q ? 'Popular websites' : e.group || (tab === 'asn' ? 'Other networks' : '');
    if (group && group !== lastGroup) {
      list.insertAdjacentHTML('beforeend', `<div class="group-title">${escapeHtml(group)}</div>`);
      lastGroup = group;
    }
    list.append(entryButton(e));
  }
  if (entries.length > LIST_LIMIT) {
    list.insertAdjacentHTML('beforeend', `<div class="more">${fmtCount(entries.length - LIST_LIMIT)} more — search to narrow the list.</div>`);
  }
  list.scrollTop = scroll;
}

function entryButton(e) {
  const on = isPicked(e.items);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'item';
  b.setAttribute('aria-pressed', String(on));
  b.innerHTML = `<span class="check">${icon('i-check')}</span>${e.visual || ''}<span class="name">${escapeHtml(e.label)}</span>`
    + (e.meta ? `<span class="meta">${escapeHtml(e.meta)}</span>` : '');
  if (e.title) b.title = e.title;
  b.onclick = () => toggleItems(e.items, !on);
  return b;
}

function toggleItems(items, add) {
  const isBlock = items.every((i) => i.kind === 'block');
  const bucket = bucketFor(items);
  const keep = !add && items.length > 1 ? neededWith(bucket, items, bundles()) : new Set();
  for (const item of items) {
    if (keep.has(itemKey(item))) continue;
    const i = bucket.findIndex((x) => itemKey(x) === itemKey(item));
    if (i >= 0) bucket.splice(i, 1);
    if (add) bucket.push(item);
  }
  render();
  flash(isBlock ? 'blocked' : 'picks');
}

function flash(key) {
  const el = $(`#route [data-row="${key}"]`);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- split tunneling panel ----------

function outBadge(out) {
  return `<span class="out-badge out-${out}">${icon(OUT[out].icon)}${OUT[out].label}</span>`;
}

const POPULAR_SITES = ['youtube', 'google', 'facebook', 'instagram', 'whatsapp', 'tiktok', 'netflix', 'twitter', 'telegram', 'wikimedia'];

const CATEGORY_ORDER = [['services', 'Services'], ['countries', 'Countries'], ['sites', 'Websites'], ['asn', 'Networks'], ['block', 'AdBlock'], ['url', 'Other']];
const KIND_CATEGORY = { pk: 'services', service: 'services', country: 'countries', site: 'sites', asn: 'asn', block: 'block', url: 'url' };

/** Picked items of a category, for its count and Clear (a whole popular service counts as Services). */
function picksInCategory(items, cat) {
  const bundleCat = new Map(groupPicks(items).filter((r) => r.featured).flatMap((r) => r.members.map((m) => [itemKey(m), r.featured.cat])));
  // a website list stays a Websites pick even when it also completes a service
  if (cat === 'sites') return items.filter((i) => i.kind === 'site');
  return items.filter((i) => (bundleCat.get(itemKey(i)) || KIND_CATEGORY[i.kind] || 'url') === cat);
}

/** Select all: ticks every list shown in the category (search results when searching). */
function selectShown() {
  for (const e of shownEntries) {
    const bucket = bucketFor(e.items);
    if (!bucket) continue;
    for (const item of e.items) if (!bucket.some((x) => itemKey(x) === itemKey(item))) bucket.push(item);
  }
  render();
}

/** Clear: unticks everything picked in the selected category. */
function clearCategory() {
  for (const key of ['picks', 'blocked']) {
    const gone = new Set(picksInCategory(state[key], tab).map(itemKey));
    state[key] = state[key].filter((i) => !gone.has(itemKey(i)));
  }
  render();
}

/** Picks as a list grouped by category; a popular service picked whole counts as one Services row. */
function groupedList(items, remove, lead, flat = false) {
  const rows = groupPicks(items).map(({ featured: f, members }) => (f
    ? { cat: f.cat, label: f.label, kind: f.kind, visual: f.visual, members }
    : (([item]) => ({ cat: KIND_CATEGORY[item.kind] || 'url', label: itemLabel(item), kind: item.kind === 'service' ? 'IP ranges' : item.kind === 'block' ? (item.n.startsWith('geoip') ? 'IP list' : 'domains') : '', visual: itemVisual(item), members }))(members)));
  const wrap = document.createElement('div');
  wrap.className = 'picks';
  if (lead) wrap.append(lead);
  for (const [cat, title] of CATEGORY_ORDER) {
    const inCat = rows.filter((r) => r.cat === cat).sort((a, b) => az(a.label, b.label));
    if (!inCat.length) continue;
    const group = document.createElement('div');
    group.className = 'pick-group';
    group.innerHTML = `${flat ? '' : `<div class="pick-cat">${title}<span class="pick-n">${inCat.length}</span></div>`}<ul class="pick-list"></ul>`;
    for (const r of inCat) {
      const li = document.createElement('li');
      li.className = 'pick';
      li.title = r.members.map(itemUrl).join('\n');
      li.innerHTML = `${r.visual}<span class="label">${escapeHtml(r.label)}</span>${r.kind ? `<span class="kind">${escapeHtml(r.kind)}</span>` : ''}<button type="button" class="iconbtn" aria-label="Remove ${escapeHtml(r.label)}">${icon('i-x')}</button>`;
      $('button', li).onclick = () => remove(r.members);
      $('ul', group).append(li);
    }
    wrap.append(group);
  }
  return wrap;
}

function routeRow({ n, title, desc, out, key, on, toggle, muted, body, right }) {
  const li = document.createElement('li');
  li.className = `route-row${muted ? ' is-off' : ''}`;
  if (key) li.dataset.row = key;
  li.innerHTML = `<div class="route-head">
      <span class="step-num">${n}</span>
      <span class="route-title">${title}${desc ? `<button type="button" class="tip" title="${escapeHtml(desc)}" aria-label="More about this">${icon('i-info')}</button>` : ''}</span>
      <span class="route-right"></span>
    </div>`;
  const rightEl = $('.route-right', li);
  if (right) rightEl.append(right);
  else if (out) rightEl.insertAdjacentHTML('beforeend', outBadge(out));
  if (toggle) {
    const sw = document.createElement('label');
    sw.className = 'switch';
    sw.innerHTML = `<input type="checkbox" role="switch" data-fk="b:${key}" aria-label="${escapeHtml(title)}"><span class="track"></span>`;
    $('input', sw).checked = on;
    $('input', sw).onchange = (e) => toggle(e.target.checked);
    rightEl.append(sw);
  }
  if (body) li.append(body);
  return li;
}

function renderRoute() {
  const ol = $('#route');
  ol.innerHTML = '';
  let n = 0;
  // Hiddify's own rules, always checked first
  const builtins = ['bypassLan', 'systemDirect', 'blockAds', ...(state.regionSet ? ['bypassRegion'] : [])];
  const section = document.createElement('li');
  section.className = 'route-row builtins-section';
  section.innerHTML = `<div class="route-head"><span class="step-num">${++n}</span><span class="route-title">Hiddify built-ins</span></div><div class="builtins-body"></div>`;
  for (const key of builtins) {
    const [name, desc, out] = BUILTIN_INFO[key];
    const row = document.createElement('div');
    row.className = 'builtin-line';
    row.innerHTML = `<span class="route-title">${escapeHtml(name)}<button type="button" class="tip" title="${escapeHtml(desc)}" aria-label="More about this">${icon('i-info')}</button></span>${outBadge(out)}<label class="switch"><input type="checkbox" role="switch" data-fk="b:${key}" aria-label="${escapeHtml(name)}"><span class="track"></span></label>`;
    $('input', row).checked = Boolean(state.builtins[key]);
    $('input', row).onchange = (e) => { state.builtins[key] = e.target.checked; render(`b:${key}`); };
    $('.builtins-body', section).append(row);
  }
  // Bypass region only exists in Hiddify when a region other than "Other" is set there (Pakistan is Other).
  // Unticked, the file leaves the rule out and Hiddify keeps its own default for it.
  const region = document.createElement('label');
  region.className = 'region-line';
  region.innerHTML = `<input type="checkbox" data-fk="b:region"><span>My Hiddify region isn’t “Other”</span><button type="button" class="tip" title="Tick if Hiddify’s Region setting is Iran, China, Russia, Afghanistan, Indonesia, Turkey or Brazil, to switch its Bypass region rule. Pakistan is “Other”: leave it unticked." aria-label="More about this">${icon('i-info')}</button>`;
  $('input', region).checked = state.regionSet;
  $('input', region).onchange = (e) => { state.regionSet = e.target.checked; if (state.regionSet) state.builtins.bypassRegion ??= true; render('b:region'); };
  $('.builtins-body', section).append(region);
  ol.append(section);

  // rules from an uploaded file that Include/Exclude can't show; written back exactly as they were
  if (state.kept.length) {
    const list = document.createElement('ul');
    list.className = 'pick-list';
    state.kept.forEach((raw, i) => {
      const out = KEPT_OUT[raw['4'] ?? 0] || 'proxy';
      const li = document.createElement('li');
      li.className = `pick${raw['2'] === false ? ' is-off' : ''}`;
      li.innerHTML = `<span class="label">${escapeHtml(raw['3'] || 'Rule')}</span><span class="kind">${escapeHtml(keptSummary(raw))}</span>${outBadge(out)}<button type="button" class="iconbtn" aria-label="Remove ${escapeHtml(raw['3'] || 'rule')}">${icon('i-x')}</button>`;
      $('button', li).onclick = () => { state.kept.splice(i, 1); render(); };
      list.append(li);
    });
    const body = document.createElement('div');
    body.className = 'picks';
    body.append(list);
    ol.append(routeRow({
      n: ++n, title: 'From your file', key: 'kept', body,
      desc: 'Rules from the uploaded file that can’t be shown as picks (typed domains, IPs, ports or apps, other directions, switched-off rules, fragment). They are kept exactly as they were.',
    }));
  }

  if (state.blocked.length) {
    ol.append(routeRow({
      n: ++n, title: 'AdBlock', out: 'block', key: 'blocked',
      body: groupedList(state.blocked, (gone) => removePicks('blocked', gone), null, true),
    }));
  }
  const m = MODES[state.mode];
  const body = document.createElement('div');
  if (state.picks.length) {
    body.append(groupedList(state.picks, (gone) => removePicks('picks', gone)));
  } else {
    const p = document.createElement('p');
    p.className = 'route-empty';
    p.textContent = state.mode === 'include'
      ? 'Nothing picked yet — tick what should use the VPN on the left.'
      : 'Nothing picked yet — tick what should skip the VPN on the left.';
    body.append(p);
  }
  ol.append(routeRow({ n: ++n, title: m.row, out: m.out, key: 'picks', body }));
}

function renderMode() {
  for (const b of $$('#mode button')) {
    const on = b.dataset.value === state.mode;
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const box = state.mode === 'exclude'
    ? `${icon('i-direct')}<span><b>Picked items skip the VPN</b></span>`
    : `${icon('i-vpn')}<span><b>Picked items use the VPN</b></span>`;
  $('#modeBox').innerHTML = box;
  $('#modeBox').title = MODES[state.mode].desc;
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  render();
}

// ---------- output ----------

function renderOutput() {
  $('#ruleCount').textContent = pickCount() || '';
}

function renderSources() {
  const s = index.sources;
  const rows = [
    ['sn_site', `${fmtCount(index.counts.sites)} site lists`],
    ['sn_ip', `${index.counts.countries} country IP lists`],
    ['mc', `${index.counts.services} service IP lists · ${fmtCount(index.counts.asns)} networks`],
    ['hg', `${index.counts.block} block lists`],
  ];
  const names = index.asnNamesSource
    ? `<li><span><a href="https://iptoasn.com/" target="_blank" rel="noopener">iptoasn.com</a><span class="what">Network names and countries (public domain)</span></span><time datetime="${index.asnNamesSource.updated}">fetched ${fmtDate(index.asnNamesSource.updated)}</time></li>`
    : '';
  $('#sourcesBody').innerHTML = `<ul class="sources">${rows.map(([k, what]) => `
      <li><span><a href="https://github.com/${s[k].repo}/tree/${s[k].branch}" target="_blank" rel="noopener">${s[k].name}</a><span class="what">${what}</span></span>
      <time datetime="${s[k].updated}">updated ${fmtDate(s[k].updated)}</time></li>`).join('')}${names}
    </ul>
    <p class="sources-foot">Flags: <a href="https://github.com/lipis/flag-icons" target="_blank" rel="noopener">flag-icons</a> (MIT). Service icons: Google, with DuckDuckGo as a fallback. This page re-reads the lists every day; it last did so ${fmtDate(index.generated)}. <a href="https://github.com/AzizKamboh/hiddify-rules" target="_blank" rel="noopener">Source code on GitHub</a>.</p>`;
  $('#syncLine').textContent = `Last synced ${fmtDate(index.generated)}`;
}

// ---------- render ----------

function render(focusKey) {
  const fk = focusKey || document.activeElement?.dataset?.fk;
  renderMode();
  renderRoute();
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
  const blob = new Blob([fileText()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'route_rules.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('route_rules.json downloaded', 'ok');
}

const KEPT_OUT = ['proxy', 'direct', 'direct_with_fragment', 'block'];
// rule fields besides rule-set lists: 6 Android apps, 7 Windows apps, 8 app paths, 10 ports,
// 13 IPs, 15–18 domains; anything else (network, source…) also means "keep as it was"
const RAW_NAMES = { '5': 'list', '9': 'protocol', '6': 'app', '7': 'app', '8': 'app', '10': 'port', '13': 'IP', '15': 'domain', '16': 'domain', '17': 'domain', '18': 'domain' };

function keptSummary(raw) {
  const counts = {};
  for (const [k, v] of Object.entries(raw)) {
    if (['1', '2', '3', '4'].includes(k)) continue;
    const name = RAW_NAMES[k] || 'condition';
    counts[name] = (counts[name] || 0) + (Array.isArray(v) ? v.length : 1);
  }
  const parts = Object.entries(counts).map(([name, c]) => `${c} ${name}${c === 1 ? '' : 's'}`);
  return [raw['2'] === false ? 'off' : '', ...parts].filter(Boolean).join(' · ');
}

/** The file to download: the generator's rules, with kept rules right after Hiddify's built-ins. */
const fileText = () => fileTextWith(toBuilderState(), state.kept);

async function loadFile(file) {
  let split;
  try {
    split = splitUpload(await file.text(), urlToItem);
  } catch (err) {
    console.warn(err);
    return toast(`“${file.name}” isn't a Hiddify route_rules.json`, 'err');
  }
  // rules Include/Exclude can show become picks; every other rule is kept exactly as it was
  const { parsed, simple, kept } = split;
  state = { ...fromRules({ ...parsed, rules: simple }), kept };
  render();
  setView('rules');
  toast(`Loaded ${file.name} — split tunneling: ${state.mode}`, 'ok');
  if (kept.length) showNote(`${kept.length} rule${kept.length === 1 ? '' : 's'} from ${file.name} kept exactly as ${kept.length === 1 ? 'it was' : 'they were'} — see “From your file”.`);
}

// ---------- dialogs, toasts ----------

/** No pop-ups: errors appear as a line in the panel for a few seconds; other messages only go to screen readers. */
function toast(text, kind = '') {
  if (kind !== 'err') { announce(text); return; }
  showNote(text, 'warn');
}

function showNote(text, level = 'info') {
  const el = document.createElement('div');
  el.className = `note ${level} transient`;
  el.innerHTML = `${icon(level === 'warn' ? 'i-alert' : 'i-info')}<span>${escapeHtml(text)}</span>`;
  $('#notes').prepend(el);
  setTimeout(() => el.remove(), 6000);
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
    const sel = next.dataset.value ? `[data-value="${next.dataset.value}"]` : `[data-theme-pref="${next.dataset.themePref}"]`;
    const id = group.id;
    Promise.resolve(pick(next)).then(() => {
      const fresh = id ? document.getElementById(id) : group;
      fresh?.querySelector(`[role="radio"]${sel}`)?.focus();
    });
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
  siteDomains = new Map([...Object.entries(SITE_DOMAIN), ...index.featured.filter((f) => f.domain).flatMap((f) => f.site.map((n) => [n, f.domain]))]);
  state = load();

  let searchTimer;
  $('#search').oninput = (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = e.target.value;
      if (query.trim().length >= 2) loadAsnNames();
      renderLibrary();
    }, 80);
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

  $('#mode').onclick = (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.value); };
  radioKeys($('#mode'), (b) => setMode(b.dataset.value));

  $('#reset').onclick = () => {
    state = defaultState();
    render();
  };

  $('#download').onclick = download;
  $('#selectAll').onclick = selectShown;
  $('#clearCat').onclick = clearCategory;
  $('#sourcesBtn').onclick = () => $('#sourcesDialog').showModal();
  $('#loadFile').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.tip');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    showNote(t.title);
  });

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
  }

  renderSources();
  render();
}

start();
