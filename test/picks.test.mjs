import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRules } from '../public/lib/hiddify.js';
import { itemKey, groupPicks, neededByOthers, withoutPicks, splitUpload, fileText, isCatchAll } from '../public/lib/picks.js';

const fixtureText = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// the page's popular services that share the Facebook IP list
const site = (n) => ({ kind: 'site', n });
const fbIp = { kind: 'service', n: 'facebook' };
const bundles = [
  { label: 'Facebook', items: [site('facebook'), fbIp] },
  { label: 'Instagram', items: [site('instagram'), fbIp] },
  { label: 'WhatsApp', items: [site('whatsapp'), fbIp] },
  { label: 'YouTube', items: [site('youtube')] },
];
const keys = (items) => items.map(itemKey).sort();

// a stand-in for the page's URL → list mapping
const SN = 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-';
const urlToItem = (url) => {
  if (url.startsWith(SN)) return { kind: 'site', n: url.slice(SN.length, -4) };
  if (url.includes('/geoip-pk.srs')) return { kind: 'country', n: 'pk' };
  if (url.includes('/block/')) return { kind: 'block', n: url.split('/').pop().slice(0, -4) };
  return { kind: 'url', n: url };
};

test('services sharing a list each get their own row', () => {
  const picks = [site('whatsapp'), fbIp, site('instagram')];
  const rows = groupPicks(picks, bundles);
  assert.deepEqual(rows.map((r) => r.featured?.label).sort(), ['Instagram', 'WhatsApp']);
  assert.ok(rows.every((r) => r.members.some((m) => itemKey(m) === itemKey(fbIp))));
});

test('removing one service keeps a list another picked service still needs', () => {
  const picks = [site('whatsapp'), fbIp, site('instagram')];
  assert.deepEqual([...neededByOthers(picks, bundles[2].items, bundles)].sort(), ['service:facebook', 'site:instagram']);
  assert.deepEqual(keys(withoutPicks(picks, bundles[2].items, bundles)), ['service:facebook', 'site:instagram']);
  // the last service using it takes it along
  assert.deepEqual(withoutPicks([site('instagram'), fbIp], bundles[1].items, bundles), []);
});

test('removing a single list removes just that list', () => {
  const picks = [site('whatsapp'), fbIp, site('instagram')];
  assert.deepEqual(keys(withoutPicks(picks, [fbIp], bundles)), ['site:instagram', 'site:whatsapp']);
});

test('an uploaded file: plain rules become picks, everything else is kept as it was', () => {
  const text = fixtureText('upload-mixed.json');
  const { parsed, simple, kept } = splitUpload(text, urlToItem);
  assert.equal(parsed.fallback, 'proxy');
  assert.deepEqual(simple.map((r) => r.name), ['Bypass VPN', 'AdBlock']);
  assert.deepEqual(kept.map((r) => r['3']), ['Work VPN', 'Telegram via VPN', 'Old rule', 'Steam fragment', 'Chrome direct', 'Mixed', 'UDP only']);
  // kept rules are the file's own objects, untouched
  const src = JSON.parse(text)['1'];
  for (const raw of kept) assert.deepEqual(raw, src.find((r) => r['3'] === raw['3']));
});

test('kept rules are written back after the built-ins, numbered in order', () => {
  const { kept } = splitUpload(fixtureText('upload-mixed.json'), urlToItem);
  const state = { builtins: { bypassLan: true }, regionSet: false, fallback: 'proxy',
    rules: [{ name: 'Bypass VPN', outbound: 'direct', ruleSets: ['https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-pk.srs'] }] };
  const out = JSON.parse(fileText(state, kept))['1'];
  assert.deepEqual(out.map((r) => r['1']), out.map((_, i) => i));
  assert.deepEqual(out.slice(0, 3).map((r) => r['3']), ['builtin:bypassLan', 'builtin:systemDirect', 'builtin:blockAds']);
  assert.equal(out[3]['3'], 'Work VPN');
  assert.equal(out.at(-1)['3'], 'Bypass VPN');
  const strip = ({ '1': _, ...rest }) => rest;
  for (const raw of kept) assert.ok(out.some((r) => JSON.stringify(strip(r)) === JSON.stringify(strip(raw))), raw['3']);
});

test('an Include file: both catch-alls make it Include and are not kept', () => {
  const state = { builtins: {}, regionSet: false, fallback: 'direct',
    rules: [{ name: 'Use VPN', outbound: 'proxy', ruleSets: [`${SN}telegram.srs`] }] };
  const text = JSON.stringify({ '1': buildRules(state) });
  const { parsed, simple, kept } = splitUpload(text, urlToItem);
  assert.equal(parsed.fallback, 'direct');
  assert.deepEqual(simple.map((r) => r.name), ['Use VPN']);
  assert.deepEqual(kept, []);
});

test('a lone catch-all rule is kept, not lost', () => {
  const text = JSON.stringify({ '1': [{ '1': 0, '2': true, '3': 'Only domains direct', '4': 1, '18': ['.*'] }] });
  const { parsed, kept } = splitUpload(text, urlToItem);
  assert.equal(parsed.fallback, 'proxy');
  assert.equal(kept.length, 1);
  assert.ok(isCatchAll(kept[0]));
});

test('downloading, uploading and downloading again gives the same file', () => {
  const { parsed, simple, kept } = splitUpload(fixtureText('upload-mixed.json'), urlToItem);
  const state = { builtins: parsed.builtins, regionSet: parsed.regionSet, fallback: parsed.fallback,
    rules: simple.map((r) => ({ ...r, ruleSets: r.ruleSets })) };
  const first = fileText(state, kept);
  const again = splitUpload(first, urlToItem);
  const second = fileText({ builtins: again.parsed.builtins, regionSet: again.parsed.regionSet, fallback: again.parsed.fallback, rules: again.simple }, again.kept);
  assert.equal(second, first);
});
