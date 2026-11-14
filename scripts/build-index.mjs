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
      asn: raw('mc', 'asn/AS{n}.srs'),
      block: raw('hg', 'block/{n}.srs'),
    },
    counts: { sites: sites.length, countries: snCountries.length, services: services.length, asns: mcAsns.length, block: hgBlock.length },
    sites,
    countries: snCountries,
    services,
    block: hgBlock,
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
