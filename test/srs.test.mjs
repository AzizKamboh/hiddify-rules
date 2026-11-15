import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { readSrs, summarize } from '../public/lib/srs.js';

const inflate = async (b) => new Uint8Array(inflateSync(b));
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const sorted = (v) => [].concat(v ?? []).map(String).sort();

test('reads a MetaCubeX site list exactly like its published source', async () => {
  const got = await readSrs(fixture('MetaCubeX-openai.srs'), inflate);
  const want = JSON.parse(fixture('MetaCubeX-openai.json'));
  assert.equal(got.version, 2);
  assert.equal(got.rules.length, want.rules.length);
  for (const [i, rule] of want.rules.entries()) {
    for (const field of ['domain', 'domain_suffix', 'domain_keyword', 'domain_regex']) {
      assert.deepEqual(sorted(got.rules[i][field]), sorted(rule[field]), field);
    }
  }
});

test('turns IP ranges back into CIDRs, IPv4 and IPv6', async () => {
  const { rules } = await readSrs(fixture('MetaCubeX-ip-google.srs'), inflate);
  const ips = summarize(rules).match.ip;
  assert.equal(ips.length, 7979);
  assert.ok(ips.includes('2001:4860::/32'));
  assert.ok(ips.every((c) => /^[\d.]+\/\d+$|^[\da-f:]+\/\d+$/.test(c)));
});

test('reads a network list', async () => {
  const { rules } = await readSrs(fixture('MetaCubeX-AS17557.srs'), inflate);
  const ips = summarize(rules).match.ip;
  assert.ok(ips.includes('39.32.0.0/15'));
});

test('rejects files that are not rule-sets', async () => {
  await assert.rejects(readSrs(new Uint8Array([1, 2, 3, 4, 5]), inflate), /Not a sing-box rule-set/);
});

test('reads legacy version 1 suffixes and AdGuard rules, and keeps exceptions apart', async () => {
  // a hand-built file: one logical "and" rule with an AdGuard list and an inverted exception list
  const trie = (keys) => {
    // build the succinct trie like sing-box does (BFS over sorted reversed keys)
    const rev = keys.map((k) => [...k].reverse().join('')).sort();
    const leaves = [], bitmap = [], labels = [];
    const set = (arr, i) => { while (arr.length <= i >> 6) arr.push(0n); arr[i >> 6] |= 1n << BigInt(i & 63); };
    const queue = [[0, rev.length, 0]];
    let l = 0;
    for (let i = 0; i < queue.length; i++) {
      let [s, e, col] = queue[i];
      if (col === rev[s].length) { s++; set(leaves, i); }
      for (let j = s; j < e;) {
        const frm = j;
        while (j < e && rev[j][col] === rev[frm][col]) j++;
        queue.push([frm, j, col + 1]);
        labels.push(rev[frm].charCodeAt(col));
        while (bitmap.length <= l >> 6) bitmap.push(0n);
        l++;
      }
      set(bitmap, l); l++;
    }
    const words = (a) => [a.length, ...a.flatMap((w) => [...Array(8)].map((_, k) => Number((w >> BigInt(56 - k * 8)) & 0xffn)))];
    return [0, ...words(leaves), ...words(bitmap), labels.length, ...labels];
  };
  const body = [
    2, // two rules
    0, 2, ...trie(['example.com', '\r.example.com', 'only.org']), 0xff, 0, // legacy suffix + plain domain
    1, 0, 2, // logical and, two rules
    0, 16, ...trie(['\nads.test', 'start.test', '\rmid\b']), 0xff, 0,
    0, 16, ...trie(['\ngood.ads.test']), 0xff, 1, // inverted: exception
    0, // logical not inverted
  ];
  const file = new Uint8Array([0x53, 0x52, 0x53, 1, ...deflateSync(Buffer.from(body))]);
  const { version, rules } = await readSrs(file, inflate);
  assert.equal(version, 1);
  assert.deepEqual(rules[0], { domain: ['only.org'], domain_suffix: ['example.com'] });
  const s = summarize(rules);
  assert.deepEqual(s.match.adguard.sort(), ['mid', '|start.test^', '||ads.test^'].sort());
  assert.deepEqual(s.except.adguard, ['||good.ads.test^']);
});
