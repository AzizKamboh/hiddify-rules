import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildRules, toJsonFile, toImportLink, parseImportLink, parseRouteRules, lint,
  FALLBACK_DOMAINS_NAME, FALLBACK_REST_NAME,
} from '../public/lib/hiddify.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const windows = fixture('windows-default.json');
const android = fixture('android-default.json');

const youtubeOnly = {
  builtins: { bypassLan: true, systemDirect: false, blockAds: false },
  regionSet: false,
  rules: [{
    name: 'YouTube',
    outbound: 'proxy',
    ruleSets: ['https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-youtube.srs'],
    domainSuffixes: ['youtube.com', 'googlevideo.com'],
  }],
  fallback: 'direct',
};

test('real exports use the field layout the generator writes', () => {
  for (const file of [windows, android]) {
    assert.deepEqual(Object.keys(file), ['1']);
    const names = file['1'].map((r) => r['3']);
    assert.deepEqual(names, ['builtin:bypassLan', 'builtin:systemDirect', 'builtin:blockAds']);
    file['1'].forEach((r, i) => assert.equal(r['1'], i));
  }
});

test('built-in rules carry only order, switch and name', () => {
  const rules = buildRules(youtubeOnly);
  for (const r of rules.filter((r) => r['3'].startsWith('builtin:'))) {
    assert.deepEqual(Object.keys(r).sort(), ['1', '2', '3']);
  }
  assert.deepEqual(rules.slice(0, 3).map((r) => [r['3'], r['2']]), [
    ['builtin:bypassLan', true], ['builtin:systemDirect', false], ['builtin:blockAds', false],
  ]);
});

test('region rule only when a region is set', () => {
  assert.ok(!buildRules(youtubeOnly).some((r) => r['3'] === 'builtin:bypassRegion'));
  const withRegion = buildRules({ ...youtubeOnly, regionSet: true });
  assert.equal(withRegion[3]['3'], 'builtin:bypassRegion');
});

test('user rule, then the two direct catch-alls, in order', () => {
  const rules = buildRules(youtubeOnly);
  assert.deepEqual(rules.map((r) => r['1']), rules.map((_, i) => i));
  const yt = rules[3];
  assert.equal(yt['3'], 'YouTube');
  assert.equal(yt['4'], 0);
  assert.deepEqual(yt['16'], ['youtube.com', 'googlevideo.com']);
  assert.equal(rules[4]['3'], FALLBACK_DOMAINS_NAME);
  assert.deepEqual(rules[4]['18'], ['.*']);
  assert.equal(rules[4]['4'], 1);
  assert.equal(rules[5]['3'], FALLBACK_REST_NAME);
  assert.deepEqual(rules[5]['10'], ['1:65535']);
  assert.equal(rules.length, 6);
});

test('fallback proxy adds no catch-all', () => {
  const rules = buildRules({ ...youtubeOnly, fallback: 'proxy' });
  assert.equal(rules.length, 4);
});

test('rules without conditions are left out and empty lists are not written', () => {
  const rules = buildRules({ rules: [{ name: 'empty', outbound: 'direct', domainSuffixes: [' ', ''] }] });
  assert.equal(rules.length, 3);
  const one = buildRules({ rules: [{ name: 'pk', outbound: 'direct', domainSuffixes: ['.pk', '.pk'], ipCidrs: [] }] })[3];
  assert.deepEqual(one['16'], ['.pk']);
  assert.ok(!('13' in one));
  assert.equal(one['4'], 1);
});

test('outbound numbers', () => {
  const r = (outbound) => buildRules({ rules: [{ outbound, domains: ['a.com'] }] })[3]['4'];
  assert.equal(r('proxy'), 0);
  assert.equal(r('direct'), 1);
  assert.equal(r('direct_with_fragment'), 2);
  assert.equal(r('block'), 3);
});

test('import link decodes twice, like the app, and survives "+" in base64', () => {
  // enough non-ASCII and varied text to make "+" and "/" appear in the base64
  const state = { ...youtubeOnly, rules: [...youtubeOnly.rules, { name: 'تست ~~~ ???', outbound: 'block', domainKeywords: ['>>>?', 'ÿÿÿ'] }] };
  const link = toImportLink(state);
  assert.ok(link.startsWith('hiddify:///settings/routing-options?routeRule='));
  const raw = decodeURIComponent(link.split('routeRule=')[1]);
  assert.match(raw, /[+/]/, 'test should cover + or / in the payload');
  assert.ok(!link.split('routeRule=')[1].includes('+'), '+ must be percent-encoded');
  assert.deepEqual(parseImportLink(link), JSON.parse(toJsonFile(state)));
  // the app: jsonDecode(utf8.decode(base64.decode(x))) as String, then RouteRule.fromJson
  const once = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  assert.equal(typeof once, 'string');
  assert.deepEqual(JSON.parse(once), JSON.parse(toJsonFile(state)));
});

test('parsing the real exports gives the app defaults', () => {
  for (const file of [windows, android]) {
    const state = parseRouteRules(file);
    assert.deepEqual(state.builtins, { bypassLan: true, systemDirect: false, blockAds: false, bypassRegion: true });
    assert.equal(state.rules.length, 0);
    assert.equal(state.fallback, 'proxy');
    assert.equal(state.regionSet, false);
    // and writing it back gives the same names, switches and order
    const back = buildRules(state);
    assert.deepEqual(back.map((r) => [r['1'], r['2'], r['3']]), file['1'].map((r) => [r['1'], r['2'], r['3']]));
  }
});

test('generated file round-trips through the parser', () => {
  const state = parseRouteRules(toJsonFile(youtubeOnly));
  assert.equal(state.fallback, 'direct');
  assert.equal(state.rules.length, 1);
  assert.deepEqual(state.rules[0].ruleSets, youtubeOnly.rules[0].ruleSets);
  assert.equal(toJsonFile(state), toJsonFile(youtubeOnly));
});

test('lint points out AND-combined conditions and app rules', () => {
  const notes = lint({ rules: [{ name: 'x', domainSuffixes: ['a.com'], portRanges: ['443'], processNames: ['chrome.exe'] }] });
  const text = notes.map((n) => n.text).join('\n');
  assert.match(text, /ports are combined/);
  assert.match(text, /apps are combined/);
  assert.match(text, /TUN/);
});

test('catch-all rules are recognised by content, not name', () => {
  const file = { '1': [
    { '1': 0, '2': true, '3': 'YouTube', '5': ['https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-youtube.srs'] },
    { '1': 1, '2': true, '3': 'Direct - all domains (PTCL)', '4': 1, '18': ['.*'] },
    { '1': 2, '2': true, '3': 'Direct - everything else (PTCL)', '4': 1, '10': ['1:65535'] },
  ] };
  const state = parseRouteRules(file);
  assert.equal(state.fallback, 'direct');
  assert.deepEqual(state.rules.map((r) => r.name), ['YouTube']);
  assert.equal(state.rules[0].outbound, 'proxy');
});
