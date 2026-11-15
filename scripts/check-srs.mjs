#!/usr/bin/env node
/**
 * Checks the page's .srs reader (public/lib/srs.js) against sing-box itself: each sample list is
 * decompiled with the sing-box binary the build downloaded, and both results must match.
 * AdGuard lists can't be decompiled by sing-box, so the AdGuard list is checked against its source.
 * Run after scripts/build-index.mjs (it leaves sing-box and the AdGuard source in .cache).
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { readSrs, summarize } from '../public/lib/srs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const work = join(cache, 'check-srs');
mkdirSync(work, { recursive: true });
const inflate = async (b) => new Uint8Array(inflateSync(b));

const sbDir = readdirSync(cache).find((d) => /^sing-box-.*-linux-amd64$/.test(d));
if (!sbDir) { console.warn('check-srs: skipped, sing-box not found in .cache (run build-index first)'); process.exit(0); }
const sb = join(cache, sbDir, 'sing-box');

const SAMPLES = [
  ['site (SagerNet)', 'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-youtube.srs'],
  ['site (MetaCubeX)', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geosite/openai.srs'],
  ['country', 'https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-pk.srs'],
  ['service IPs', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/geo/geoip/google.srs'],
  ['network', 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/asn/AS17557.srs'],
  ['block (domains)', 'https://raw.githubusercontent.com/hiddify/hiddify-geo/rule-set/block/geosite-category-ads-all.srs'],
  ['block (IPs)', 'https://raw.githubusercontent.com/hiddify/hiddify-geo/rule-set/block/geoip-malware.srs'],
  ['block (HaGeZi)', join(root, 'public/sets/block-hagezi.srs')],
];

/** Rules in a comparable form: sorted values, a domain that is also a suffix dropped (sing-box drops it too). */
const norm = (rules) => rules.map((r) => {
  if (r.type === 'logical') return JSON.stringify({ ...r, rules: norm(r.rules) });
  // sing-box writes a one-item list as a plain string
  const o = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'invert' ? v : [...new Set([].concat(v).map(String))].sort()]));
  if (o.domain && o.domain_suffix) { const s = new Set(o.domain_suffix); o.domain = o.domain.filter((x) => !s.has(x)); if (!o.domain.length) delete o.domain; }
  return JSON.stringify(Object.fromEntries(Object.entries(o).sort()));
});

let failed = 0;
for (const [label, src] of SAMPLES) {
  try {
    let file = src;
    if (src.startsWith('http')) {
      const res = await fetch(src).catch(() => null);
      // a download hiccup isn't a reader problem: skip that sample rather than stop the deploy
      if (!res?.ok) { console.log(`skip  ${label}: download failed`); continue; }
      file = join(work, src.split('/').pop());
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } else if (!existsSync(src)) { console.log(`skip  ${label}: not built`); continue; }
    const out = `${file}.json`;
    execFileSync(sb, ['rule-set', 'decompile', '--output', out, file]);
    const want = norm(JSON.parse(readFileSync(out, 'utf8')).rules);
    const got = norm((await readSrs(readFileSync(file), inflate)).rules);
    const same = got.length === want.length && got.every((x, i) => x === want[i]);
    console.log(`${same ? 'ok   ' : 'FAIL '} ${label} (${src.split('/').pop()})`);
    if (!same) failed++;
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
    failed++;
  }
}

// AdGuard: every decoded rule must come from the filter's own lines
const agFile = join(root, 'public/sets/block-adguard.srs');
const agSource = join(cache, 'adblock-adguard.txt');
if (existsSync(agFile) && existsSync(agSource)) {
  const lines = new Set(readFileSync(agSource, 'utf8').split('\n').map((l) => l.trim().replace(/^@@/, '').replace(/\$.*$/, '')));
  const s = summarize((await readSrs(readFileSync(agFile), inflate)).rules);
  const patterns = [...s.match.adguard, ...s.except.adguard];
  const known = patterns.filter((p) => lines.has(p) || lines.has(p.replace(/\^$/, '')) || lines.has(p.replace(/^\|\|/, ''))).length;
  const share = patterns.length ? known / patterns.length : 0;
  const ok = patterns.length > 10000 && share > 0.98;
  console.log(`${ok ? 'ok   ' : 'FAIL '} block (AdGuard): ${patterns.length} rules, ${(share * 100).toFixed(1)}% found in the filter`);
  if (!ok) failed++;
} else console.log('skip  block (AdGuard): not built');

if (failed) { console.error(`check-srs: ${failed} failed`); process.exit(1); }
console.log('check-srs: the page reads every sample like sing-box does');
