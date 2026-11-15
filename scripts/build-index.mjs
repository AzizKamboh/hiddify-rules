#!/usr/bin/env node
// Builds public/data/index.json from the upstream rule-set branches, and mirrors the IP-only
// rule sets that need a "geoip-" file name (see README: Hiddify keeps rule sets whose tag starts
// with "geoip-" out of DNS rules, and the tag is the file name).
//
// Usage: node scripts/build-index.mjs [--no-mirror]
// Env:   PAGES_URL  public URL of the site (default: derived from GITHUB_REPOSITORY)

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const publicDir = join(root, 'public');
const setsDir = join(publicDir, 'sets');
const mirror = !process.argv.includes('--no-mirror');

const repoSlug = process.env.GITHUB_REPOSITORY || 'AzizKamboh/hiddify-rules';
const [owner, repo] = repoSlug.split('/');
const pagesUrl = (process.env.PAGES_URL || `https://${owner.toLowerCase()}.github.io/${repo}`).replace(/\/$/, '');

const SOURCES = {
  sn_site: { name: 'SagerNet sing-geosite', repo: 'SagerNet/sing-geosite', branch: 'rule-set' },
  sn_ip: { name: 'SagerNet sing-geoip', repo: 'SagerNet/sing-geoip', branch: 'rule-set' },
  mc: { name: 'MetaCubeX meta-rules-dat', repo: 'MetaCubeX/meta-rules-dat', branch: 'sing' },
  hg: { name: 'Hiddify hiddify-geo', repo: 'hiddify/hiddify-geo', branch: 'rule-set' },
};
const raw = (src, path) => `https://raw.githubusercontent.com/${SOURCES[src].repo}/${SOURCES[src].branch}/${path}`;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** File list and last commit time of a branch, without downloading file contents. */
function listBranch(key) {
  const { repo: slug, branch } = SOURCES[key];
  const dir = join(cache, key);
  if (existsSync(join(dir, '.git'))) {
    git(['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', branch], dir);
    git(['reset', '--quiet', '--soft', 'FETCH_HEAD'], dir);
  } else {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(cache, { recursive: true });
    git(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '-b', branch,
      `https://github.com/${slug}.git`, dir]);
  }
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD'], dir).split('\n').filter(Boolean);
  const updated = git(['log', '-1', '--format=%cI'], dir).trim();
  const commit = git(['rev-parse', 'HEAD'], dir).trim();
  return { files, updated, commit };
}

const pick = (files, re) => files.map((f) => f.match(re)?.[1]).filter(Boolean).sort();

async function download(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 4) throw new Error('empty file');
      writeFileSync(dest, buf);
      return buf.length;
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/**
 * Network names and countries from iptoasn.com (public domain, updated hourly), kept only for networks
 * MetaCubeX has a list for. Env IP2ASN_FILE points at a local copy (plain or .gz) instead.
 * Returns the number of names written, or 0 when the file can't be had (the page then shows numbers only).
 */
async function buildAsnNames(asnSet, dest) {
  let buf;
  try {
    if (process.env.IP2ASN_FILE) buf = readFileSync(process.env.IP2ASN_FILE);
    else {
      const res = await fetch('https://iptoasn.com/data/ip2asn-v4.tsv.gz', { headers: { 'user-agent': 'hiddify-rules (github.com/AzizKamboh/hiddify-rules)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  } catch (err) {
    console.warn(`network names skipped: ${err.message}`);
    return 0;
  }
  // columns: range_start, range_end, AS_number, country_code, AS_description
  const names = new Map();
  for (const line of buf.toString('utf8').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 5) continue;
    const asn = Number(cols[2]);
    if (!asn || names.has(asn) || !asnSet.has(asn)) continue;
    const cc = /^[A-Z]{2}$/.test(cols[3]) ? cols[3] : '';
    const name = cols[4].replace(/[\t\r]/g, ' ').trim();
    if (name && name !== 'Not routed') names.set(asn, [cc, name]);
  }
  const rows = [...names].sort((a, b) => a[0] - b[0]).map(([asn, [cc, name]]) => `${asn}\t${cc}\t${name}`);
  writeFileSync(dest, rows.join('\n') + '\n');
  return rows.length;
}

/**
 * The hand-kept Pakistani website lists (data/pakistan.txt) as sing-box source rule sets
 * (sets/geosite-pk-{id}.json). Domains that no longer exist are dropped and reported; a lookup
 * that fails for any other reason keeps the domain, so a bad DNS day never empties a list.
 */
/**
 * Ad block lists built here from their own sources with sing-box's converter, so they stay current:
 *  - adguard: AdGuard DNS filter (AdGuard Base, Social, Tracking, Mobile Ads, EasyList, EasyPrivacy for DNS)
 *  - hagezi:  HaGeZi Multi NORMAL (ads, trackers, telemetry, phishing, malware, scams)
 * sing-box 1.10.7 writes rule-set format 2, which every Hiddify with sing-box 1.10 or newer reads.
 * A list that fails to build is left out (and reported); the rest of the build carries on.
 */
const SING_BOX = {
  version: '1.10.7',
  url: 'https://github.com/SagerNet/sing-box/releases/download/v1.10.7/sing-box-1.10.7-linux-amd64.tar.gz',
  sha256: '1951a0785c8b4e1e21e0640227a49528ca772aec3d680061652e3d6b687e00fe',
};
const ADBLOCK = {
  adguard: { url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt', type: 'adguard' },
  hagezi: { url: 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/multi-onlydomains.txt', type: 'domains' },
};
async function buildAdblock(problems) {
  const built = [];
  let sb;
  try {
    const tgz = join(cache, `sing-box-${SING_BOX.version}.tar.gz`);
    if (!existsSync(tgz)) {
      const res = await fetch(SING_BOX.url);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    }
    const sum = createHash('sha256').update(readFileSync(tgz)).digest('hex');
    if (sum !== SING_BOX.sha256) { rmSync(tgz); throw new Error(`checksum mismatch (${sum})`); }
    execFileSync('tar', ['xzf', tgz, '-C', cache]);
    sb = join(cache, `sing-box-${SING_BOX.version}-linux-amd64`, 'sing-box');
  } catch (err) {
    problems.push(`adblock: sing-box unavailable: ${err.message}`);
    return built;
  }
  mkdirSync(setsDir, { recursive: true });
  for (const [name, src] of Object.entries(ADBLOCK)) {
    try {
      const res = await fetch(src.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const out = join(setsDir, `block-${name}.srs`);
      const tmp = join(cache, `adblock-${name}`);
      if (src.type === 'adguard') {
        writeFileSync(`${tmp}.txt`, text);
        execFileSync(sb, ['rule-set', 'convert', '--type', 'adguard', '--output', out, `${tmp}.txt`]);
      } else {
        const domains = text.split('\n').map((l) => l.trim().replace(/^\*\./, '')).filter((l) => l && !l.startsWith('#'));
        if (domains.length < 1000) throw new Error(`only ${domains.length} domains`);
        writeFileSync(`${tmp}.json`, JSON.stringify({ version: 2, rules: [{ domain_suffix: domains }] }));
        execFileSync(sb, ['rule-set', 'compile', '--output', out, `${tmp}.json`]);
      }
      built.push(name);
      console.log(`adblock: ${name} built (${Math.round(readFileSync(out).length / 1024)} KB)`);
    } catch (err) {
      problems.push(`adblock: ${name} not built: ${err.message}`);
      console.warn(`adblock: ${name} not built: ${err.message}`);
    }
  }
  return built;
}

async function buildPakistan(problems) {
  const text = readFileSync(join(root, 'data/pakistan.txt'), 'utf8');
  const lists = [];
  for (const line of text.split('\n').map((l) => l.trim())) {
    if (!line || line.startsWith('#')) continue;
    const head = line.match(/^\[([a-z0-9-]+)\]\s*(.+)$/);
    if (head) { lists.push({ id: head[1], label: head[2].trim(), domains: [] }); continue; }
    if (!lists.length) continue;
    // ".gov.pk" is an ending (every site under it), kept without a lookup; "hbl.com" is a site
    const ending = line.startsWith('.');
    const d = line.toLowerCase().replace(/^\.|\.$/g, '');
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) lists[lists.length - 1].domains.push(ending ? `.${d}` : d);
    else problems.push(`pakistan: "${line}" isn't a domain`);
  }
  const all = [...new Set(lists.flatMap((l) => l.domains))];
  const checked = all.filter((d) => !d.startsWith('.'));
  const alive = new Map();
  const exists = async (d) => {
    for (const q of [() => dns.resolve4(d), () => dns.resolve6(d), () => dns.resolve4(`www.${d}`), () => dns.resolveNs(d)]) {
      try { await q(); return true; } catch (err) { if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return true; }
    }
    return false;
  };
  for (const d of all) if (d.startsWith('.')) alive.set(d, true);
  for (let i = 0; i < checked.length; i += 16) {
    await Promise.all(checked.slice(i, i + 16).map(async (d) => alive.set(d, await exists(d))));
  }
  let gone = all.filter((d) => !alive.get(d));
  if (gone.length > checked.length / 3) {
    // that many missing means lookups aren't working here, not that the sites are gone
    console.warn(`pakistan: ${gone.length} of ${checked.length} domains didn't resolve; DNS looks unavailable, keeping all`);
    for (const d of gone) alive.set(d, true);
    gone = [];
  }
  for (const d of gone) problems.push(`pakistan: ${d} doesn't exist (left out)`);
  if (gone.length) console.warn(`pakistan: left out ${gone.join(', ')}`);
  const write = (id, suffixes) => writeFileSync(join(setsDir, `geosite-pk-${id}.json`),
    JSON.stringify({ version: 1, rules: [{ domain_suffix: suffixes }] }));
  mkdirSync(setsDir, { recursive: true });
  const out = [];
  const nonPk = all.filter((d) => alive.get(d) && !d.endsWith('.pk'));
  write('all', ['.pk', ...nonPk]);
  out.push({ id: 'all', label: 'Pakistani websites', count: nonPk.length, allPk: true, examples: ['every .pk site', ...nonPk.slice(0, 5)], domains: nonPk });
  for (const l of lists) {
    const domains = l.domains.filter((d) => alive.get(d));
    if (!domains.length) continue;
    write(l.id, domains);
    out.push({ id: l.id, label: l.label, count: domains.length, examples: domains.slice(0, 6) });
  }
  console.log(`pakistan: ${out.length} lists, ${all.length - gone.length} domains`);
  return out;
}

async function main() {
  const catalog = JSON.parse(readFileSync(join(root, 'data/catalog.json'), 'utf8'));
  const lists = {};
  for (const key of Object.keys(SOURCES)) {
    process.stdout.write(`listing ${SOURCES[key].repo}@${SOURCES[key].branch} … `);
    lists[key] = listBranch(key);
    console.log(`${lists[key].files.length} files`);
  }

  const snSites = pick(lists.sn_site.files, /^geosite-(.+)\.srs$/);
  const snCountries = pick(lists.sn_ip.files, /^geoip-(.+)\.srs$/);
  const mcSites = pick(lists.mc.files, /^geo\/geosite\/(.+)\.srs$/);
  const mcIps = pick(lists.mc.files, /^geo\/geoip\/(.+)\.srs$/);
  const mcAsns = pick(lists.mc.files, /^asn\/AS(\d+)\.srs$/).map(Number).sort((a, b) => a - b);
  const hgBlock = pick(lists.hg.files, /^block\/(.+)\.srs$/);

  const snSet = new Set(snSites);
  const countrySet = new Set(snCountries);
  // site lists: SagerNet first, MetaCubeX only for names SagerNet doesn't have
  const sites = [
    ...snSites.map((n) => [n, 's']),
    ...mcSites.filter((n) => !snSet.has(n)).map((n) => [n, 'm']),
  ].sort((a, b) => a[0].localeCompare(b[0]));
  // service IP lists: MetaCubeX geoip names that aren't countries (two letters) or "private"
  const services = mcIps.filter((n) => !/^[a-z]{2}$/.test(n) && n !== 'private' && !countrySet.has(n));

  // check the hand-kept catalog against upstream
  const problems = [];
  const siteNames = new Set(sites.map((s) => s[0]));
  const serviceSet = new Set(services);
  const asnSet = new Set(mcAsns);
  for (const f of catalog.featured) {
    for (const s of f.site) if (!siteNames.has(s)) problems.push(`featured ${f.id}: no site list "${s}"`);
    for (const s of f.ip) if (!serviceSet.has(s)) problems.push(`featured ${f.id}: no IP list "${s}"`);
  }
  for (const g of catalog.asnGroups) for (const a of g.items) if (!asnSet.has(a.asn)) problems.push(`ASN ${a.asn} (${a.label}) not upstream`);
  if (problems.length) console.warn(`catalog problems (dropped from the page):\n  ${problems.join('\n  ')}`);
  const featured = catalog.featured
    .map((f) => ({ ...f, site: f.site.filter((s) => siteNames.has(s)), ip: f.ip.filter((s) => serviceSet.has(s)) }))
    .filter((f) => f.site.length || f.ip.length);
  const asnGroups = catalog.asnGroups.map((g) => ({ ...g, items: g.items.filter((a) => asnSet.has(a.asn)) }));

  // mirror IP-only lists under geoip-* names: all service lists and every network (about 6 MB in all)
  const mirrored = { services: [], asns: [], allAsns: false };
  if (mirror) {
    rmSync(setsDir, { recursive: true, force: true });
    mkdirSync(setsDir, { recursive: true });
    for (const n of services) {
      await download(raw('mc', `geo/geoip/${n}.srs`), join(setsDir, `geoip-${n}.srs`));
      mirrored.services.push(n);
    }
    // every network list, fetched in one go through the blob-less clone made for the listing
    try {
      const dir = join(cache, 'mc');
      git(['sparse-checkout', 'set', '--no-cone', '/asn/*.srs'], dir);
      git(['checkout', '--quiet', '--force', 'HEAD'], dir);
      let n = 0;
      for (const f of readdirSync(join(dir, 'asn'))) {
        const m = f.match(/^AS(\d+)\.srs$/);
        if (!m) continue;
        copyFileSync(join(dir, 'asn', f), join(setsDir, `geoip-as${m[1]}.srs`));
        n++;
      }
      mirrored.allAsns = n > 0;
      console.log(`mirrored ${n} network lists`);
    } catch (err) {
      // fall back to the catalog networks one by one; others then link to MetaCubeX
      console.warn(`network lists not mirrored in bulk: ${err.message}`);
      for (const a of asnGroups.flatMap((g) => g.items.map((i) => i.asn))) {
        await download(raw('mc', `asn/AS${a}.srs`), join(setsDir, `geoip-as${a}.srs`));
        mirrored.asns.push(a);
      }
    }
    console.log(`mirrored ${readdirSync(setsDir).length} IP lists to public/sets/`);
  }

  mkdirSync(join(publicDir, 'data'), { recursive: true });
  const nameCount = await buildAsnNames(new Set(mcAsns), join(publicDir, 'data/asn-names.tsv'));
  if (nameCount) console.log(`network names: ${nameCount}`);

  const pakistan = await buildPakistan(problems);
  const adblock = await buildAdblock(problems);

  const index = {
    generated: new Date().toISOString(),
    asnNames: nameCount ? 'data/asn-names.tsv' : null,
    asnNamesSource: nameCount ? { name: 'iptoasn.com', updated: new Date().toISOString() } : null,
    pagesUrl,
    sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, {
      ...v, updated: lists[k].updated, commit: lists[k].commit,
    }])),
    urls: {
      site_s: raw('sn_site', 'geosite-{n}.srs'),
      site_m: raw('mc', 'geo/geosite/{n}.srs'),
      country: raw('sn_ip', 'geoip-{n}.srs'),
      service: `${pagesUrl}/sets/geoip-{n}.srs`,
      asn_mirror: `${pagesUrl}/sets/geoip-as{n}.srs`,
      pk: `${pagesUrl}/sets/geosite-pk-{n}.json`,
      asn: raw('mc', 'asn/AS{n}.srs'),
      block: raw('hg', 'block/{n}.srs'),
      block_extra: `${pagesUrl}/sets/block-{n}.srs`,
    },
    pakistan,
    counts: { sites: sites.length, countries: snCountries.length, services: services.length, asns: mcAsns.length, block: hgBlock.length + adblock.length },
    sites,
    countries: snCountries,
    services,
    block: hgBlock,
    blockExtra: adblock,
    mirroredAsns: mirrored.asns,
    allAsnsMirrored: mirrored.allAsns,
    featured,
    asnGroups,
    serviceDomains: catalog.serviceDomains || {},
    problems,
  };

  writeFileSync(join(publicDir, 'data/index.json'), JSON.stringify(index));
  // every ASN MetaCubeX has, for checking a typed ASN without a request
  writeFileSync(join(publicDir, 'data/asns.txt'), mcAsns.join('\n') + '\n');
  console.log(`index: ${sites.length} site lists, ${snCountries.length} countries, ${services.length} service IP lists, ${mcAsns.length} ASNs, ${hgBlock.length} block lists`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
