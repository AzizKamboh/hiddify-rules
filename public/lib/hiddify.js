// Builds Hiddify's route_rules.json and import link.
//
// Format notes, taken from hiddify-app / hiddify-core source:
// - The file is protobuf JSON keyed by field numbers (route_rule.proto):
//   RouteRule { 1: rules[] }
//   Rule { 1 list_order, 2 enabled, 3 name, 4 outbound, 5 rule_sets, 6 package_names,
//          7 process_names, 8 process_paths, 9 network, 10 port_ranges, 11 source_port_ranges,
//          12 protocols, 13 ip_cidrs, 14 source_ip_cidrs, 15 domains, 16 domain_suffixes,
//          17 domain_keywords, 18 domain_regexes }
//   Outbound: 0 proxy, 1 direct, 2 direct_with_fragment, 3 block
// - Built-in rules are recognised by name ("builtin:<key>"). On import the app replaces their
//   content with its own (it differs per platform) and keeps only their switch and position,
//   so only name, enabled and order are written here.
// - The region rule only exists while a region other than "Other" is set; with "Other" the app
//   drops it on import.
// - A rule without any condition is dropped by the core, and "Default proxy" can't be Direct:
//   unmatched traffic always goes to the proxy. "Everything else direct" therefore needs two
//   catch-all rules: a domain regex ".*" (also sends those names to the direct DNS) and a port
//   range "1:65535" (connections without a domain name).
// - Rules are checked top to bottom in list order.

export const OUTBOUNDS = { proxy: 0, direct: 1, direct_with_fragment: 2, block: 3 };
export const OUTBOUND_NAMES = Object.fromEntries(Object.entries(OUTBOUNDS).map(([k, v]) => [v, k]));

export const BUILTINS = ['bypassLan', 'systemDirect', 'blockAds', 'bypassRegion'];
export const BUILTIN_DEFAULTS = { bypassLan: true, systemDirect: false, blockAds: false, bypassRegion: true };
// Hiddify's regions (besides "other"); only whether one is set changes the output
export const REGIONS = ['ir', 'cn', 'ru', 'af', 'id', 'tr', 'br'];

export const FALLBACK_DOMAINS_NAME = 'Direct - all other domains';
export const FALLBACK_REST_NAME = 'Direct - everything else';

// rule fields the builder uses, with their field numbers
const FIELDS = {
  ruleSets: '5',
  packageNames: '6',
  processNames: '7',
  processPaths: '8',
  portRanges: '10',
  ipCidrs: '13',
  domains: '15',
  domainSuffixes: '16',
  domainKeywords: '17',
  domainRegexes: '18',
};

const clean = (list) => [...new Set((list || []).map((v) => String(v).trim()).filter(Boolean))];

/** A rule needs at least one condition, or the core drops it. */
export function hasCondition(rule) {
  return Object.keys(FIELDS).some((key) => clean(rule[key]).length > 0);
}

/**
 * state = {
 *   builtins: { bypassLan, systemDirect, blockAds, bypassRegion }  // on/off
 *   regionSet: boolean        // a region other than "Other" is set in the app
 *   rules: [{ name, outbound, enabled?, ruleSets, domainSuffixes, ... }]
 *   fallback: 'proxy' | 'direct'                                     // unmatched traffic
 * }
 * Returns the list of rules in Hiddify's numbered-field form.
 */
export function buildRules(state) {
  const builtins = { ...BUILTIN_DEFAULTS, ...(state.builtins || {}) };
  const out = [];

  for (const key of BUILTINS) {
    if (key === 'bypassRegion' && !state.regionSet) continue;
    out.push({ '2': Boolean(builtins[key]), '3': `builtin:${key}` });
  }

  for (const rule of state.rules || []) {
    if (!hasCondition(rule)) continue;
    const entry = {
      '2': rule.enabled !== false,
      '3': String(rule.name || 'Rule').trim() || 'Rule',
      '4': OUTBOUNDS[rule.outbound] ?? OUTBOUNDS.proxy,
    };
    for (const [key, num] of Object.entries(FIELDS)) {
      const values = clean(rule[key]);
      if (values.length) entry[num] = values;
    }
    out.push(entry);
  }

  if (state.fallback === 'direct') {
    out.push({ '2': true, '3': FALLBACK_DOMAINS_NAME, '4': OUTBOUNDS.direct, '18': ['.*'] });
    out.push({ '2': true, '3': FALLBACK_REST_NAME, '4': OUTBOUNDS.direct, '10': ['1:65535'] });
  }

  // list_order goes first in each rule, as in the app's own export
  return out.map((rule, i) => ({ '1': i, ...rule }));
}

/** The object written to route_rules.json. */
export function toRouteRule(state) {
  return { '1': buildRules(state) };
}

/** The route_rules.json text, compact like the app writes it. */
export function toJsonFile(state) {
  return JSON.stringify(toRouteRule(state));
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(b64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The app's import link. The app exports base64(jsonEncode(writeToJson())): the JSON text is
 * encoded as a JSON string a second time, and the import decodes it twice. The base64 is
 * percent-encoded because the app reads it with Uri.queryParameters, which turns "+" into a space.
 */
export function toImportLink(state) {
  const payload = utf8ToBase64(JSON.stringify(toJsonFile(state)));
  return `hiddify:///settings/routing-options?routeRule=${encodeURIComponent(payload)}`;
}

/** Reads an import link back into the route_rules object (for checks and tests). */
export function parseImportLink(link) {
  const query = link.slice(link.indexOf('?') + 1);
  const params = new URLSearchParams(query.replace(/\+/g, '%2B'));
  const inner = JSON.parse(base64ToUtf8(params.get('routeRule')));
  return JSON.parse(inner);
}

/**
 * Turns a route_rules.json from the app (or from this tool) back into builder state, so an
 * existing list can be edited. Unknown fields are kept on the rule as `extra`.
 */
export function parseRouteRules(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const rules = [...(data['1'] || [])].sort((a, b) => (a['1'] ?? 0) - (b['1'] ?? 0));
  const state = { builtins: { ...BUILTIN_DEFAULTS }, regionSet: false, rules: [], fallback: 'proxy' };
  let sawDomainsFallback = false;
  let sawRestFallback = false;
  for (const raw of rules) {
    const name = raw['3'] || '';
    if (name.startsWith('builtin:')) {
      const key = name.slice('builtin:'.length);
      if (key === 'appleDirect') state.builtins.systemDirect = raw['2'] !== false; // old name
      else if (key in BUILTIN_DEFAULTS) state.builtins[key] = raw['2'] !== false;
      if (key === 'bypassRegion') state.regionSet = true;
      continue;
    }
    // catch-all direct rules are recognised by what they hold, whatever they're called
    const fields = Object.keys(raw).filter((k) => !['1', '2', '3', '4'].includes(k));
    const direct = raw['4'] === OUTBOUNDS.direct && raw['2'] !== false;
    const only = (num, values) => fields.length === 1 && fields[0] === num && raw[num].length === 1 && values.includes(raw[num][0]);
    if (direct && only('18', ['.*', '^.*$', '.+'])) { sawDomainsFallback = true; continue; }
    if (direct && only('10', ['1:65535', '0:65535', '1:65000'])) { sawRestFallback = true; continue; }
    const rule = { name, enabled: raw['2'] !== false, outbound: OUTBOUND_NAMES[raw['4'] ?? 0] || 'proxy' };
    for (const [key, num] of Object.entries(FIELDS)) rule[key] = raw[num] ? [...raw[num]] : [];
    const known = new Set(['1', '2', '3', '4', ...Object.values(FIELDS)]);
    const extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !known.has(k)));
    if (Object.keys(extra).length) rule.extra = extra;
    state.rules.push(rule);
  }
  if (sawDomainsFallback && sawRestFallback) state.fallback = 'direct';
  return state;
}

/** Problems worth showing next to the output. */
export function lint(state) {
  const notes = [];
  for (const rule of state.rules || []) {
    const name = rule.name || 'Rule';
    if (!hasCondition(rule)) notes.push({ level: 'warn', text: `"${name}" has nothing to match and will be left out.` });
    const hasDest = ['ruleSets', 'domains', 'domainSuffixes', 'domainKeywords', 'domainRegexes', 'ipCidrs'].some((k) => clean(rule[k]).length);
    if (hasDest && clean(rule.portRanges).length)
      notes.push({ level: 'info', text: `"${name}": ports are combined with the sites by AND, so only those ports of those sites match.` });
    if (hasDest && (clean(rule.processNames).length || clean(rule.packageNames).length || clean(rule.processPaths).length))
      notes.push({ level: 'info', text: `"${name}": apps are combined with the sites by AND. Use a separate rule to send a whole app.` });
    if (clean(rule.processNames).length || clean(rule.packageNames).length || clean(rule.processPaths).length)
      notes.push({ level: 'info', text: `"${name}": app rules only work in VPN (TUN) mode.` });
  }
  if ((state.rules || []).some((r) => clean(r.ruleSets).length))
    notes.push({ level: 'info', text: 'Hiddify downloads rule sets through the VPN, so they load once the VPN connects.' });
  return notes;
}
