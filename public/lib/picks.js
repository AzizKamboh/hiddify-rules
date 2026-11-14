// Picks and uploads, kept apart from the page so they can be tested without a browser.
//
// A pick is a list: { kind, n } (kind: site, country, service, asn, block, pk, url).
// A bundle is several lists chosen together, e.g. a popular service (its site list + its IP list)
// or "Everything in Pakistan". Bundles may share a list: WhatsApp and Instagram both use the
// Facebook IP list.

import { parseRouteRules, toRouteRule } from './hiddify.js?v=__BUILD__';

export const itemKey = (item) => `${item.kind}:${item.n}`;

/**
 * Picks as rows: each bundle picked whole is one row, every other list a row of its own.
 * A bundle whose lists are all already shown by earlier bundles gets no row of its own.
 */
export function groupPicks(items, bundles) {
  const keys = new Set(items.map(itemKey));
  const covered = new Set();
  const rows = [];
  for (const b of bundles) {
    const bi = b.items;
    if (!bi.length || !bi.every((i) => keys.has(itemKey(i))) || bi.every((i) => covered.has(itemKey(i)))) continue;
    bi.forEach((i) => covered.add(itemKey(i)));
    rows.push({ featured: b, members: items.filter((i) => bi.some((x) => itemKey(x) === itemKey(i))) });
  }
  for (const item of items) if (!covered.has(itemKey(item))) rows.push({ featured: null, members: [item] });
  return rows;
}

/** Keys of lists that bundles still picked whole in `bucket` need, other than the one being removed. */
export function neededByOthers(bucket, removing, bundles) {
  const gone = new Set(removing.map(itemKey));
  const keys = new Set(bucket.map(itemKey));
  const keep = new Set();
  for (const b of bundles) {
    const bi = b.items.map(itemKey);
    const same = bi.length === gone.size && bi.every((k) => gone.has(k));
    if (!same && bi.length && bi.every((k) => keys.has(k))) bi.forEach((k) => keep.add(k));
  }
  return keep;
}

/** `bucket` without `members`; when they are a bundle (2+ lists), lists other picked bundles share stay. */
export function withoutPicks(bucket, members, bundles) {
  const keep = members.length > 1 ? neededByOthers(bucket, members, bundles) : new Set();
  const gone = new Set(members.map(itemKey).filter((k) => !keep.has(k)));
  return bucket.filter((x) => !gone.has(itemKey(x)));
}

const DIRECT = 1;
const isBuiltin = (raw) => String(raw['3'] || '').startsWith('builtin:');

/** The two "everything else direct" rules the page writes for Include. */
export function isCatchAll(raw) {
  const fields = Object.keys(raw).filter((k) => !['1', '2', '3', '4'].includes(k));
  const only = (num, values) => fields.length === 1 && fields[0] === num && raw[num].length === 1 && values.includes(raw[num][0]);
  return raw['4'] === DIRECT && raw['2'] !== false && (only('18', ['.*', '^.*$', '.+']) || only('10', ['1:65535', '0:65535', '1:65000']));
}

const OTHER_FIELDS = ['packageNames', 'processNames', 'processPaths', 'portRanges', 'ipCidrs', 'domains', 'domainSuffixes', 'domainKeywords', 'domainRegexes'];

/**
 * Splits an uploaded route_rules.json in one pass over its rules:
 *  - `parsed`: built-ins, region and direction (Include when it sends everything else direct)
 *  - `simple`: rules the page can show as picks without losing anything, with their `items`
 *  - `kept`:   every other rule, exactly as it was in the file
 * The catch-all direct rules are only dropped when both are there (that is what makes it Include).
 */
export function splitUpload(text, urlToItem) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  const parsed = parseRouteRules(data);
  const include = parsed.fallback === 'direct';
  const want = include ? 'proxy' : 'direct';
  const simple = [];
  const kept = [];
  const raws = [...(data['1'] || [])].sort((a, b) => (a['1'] ?? 0) - (b['1'] ?? 0));
  for (const raw of raws) {
    if (isBuiltin(raw)) continue;
    if (isCatchAll(raw)) { if (!include) kept.push(raw); continue; }
    const [rule] = parseRouteRules({ '1': [raw] }).rules; // the same reader, one rule at a time
    if (!rule) { kept.push(raw); continue; }
    const items = (rule.ruleSets || []).map(urlToItem);
    const plain = rule.enabled !== false && !rule.extra && items.length && OTHER_FIELDS.every((k) => !(rule[k] || []).length)
      && (rule.outbound === 'block' ? items.every((it) => it.kind === 'block') : rule.outbound === want);
    if (plain) simple.push({ ...rule, items });
    else kept.push(raw);
  }
  return { parsed, simple, kept };
}

/** route_rules.json text: the generator's rules, with kept rules right after Hiddify's built-ins. */
export function fileText(builderState, kept = []) {
  const rules = toRouteRule(builderState)['1'];
  const at = rules.filter(isBuiltin).length;
  rules.splice(at, 0, ...kept.map((raw) => ({ ...raw })));
  return JSON.stringify({ '1': rules.map((r, i) => { const { '1': _, ...rest } = r; return { '1': i, ...rest }; }) });
}
