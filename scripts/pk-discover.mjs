#!/usr/bin/env node
// Monthly discovery of Pakistani websites that don't end in .pk (run by .github/workflows/pk-discover.yml).
//
// Two tiers:
//  1. Added automatically: websites Wikidata lists for Pakistani organisations, that pass every filter
//     below and still exist. They go to the [auto] section of data/pakistan.txt.
//  2. For review: sites much more popular in Pakistan than worldwide (Chrome UX Report top lists) that
//     pass the same filters. Only ones not seen in an earlier run are listed, in pk-review.md, which
//     the workflow posts as a GitHub issue. Nothing from this tier is added without a person.
//
// Filters (both tiers): not already listed or excluded (data/pakistan-exclude.txt), not .pk (covered),
// no shared platforms, no other country's ending, not on Hagezi's adult/gambling/fake/malware lists
// or v2fly's adult list, no throwaway endings or betting/piracy/adult/scam words. The review tier
// also needs the site to be ≥10× more popular in Pakistan than worldwide and not popular in India,
// Bangladesh or Nepal (where South Asian piracy/betting/scam sites are popular too).
//
// Usage: node scripts/pk-discover.mjs [--apply] [--seed-seen]
//   without --apply nothing is written but pk-review.md; --seed-seen marks all current candidates as seen

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { promises as dns } from 'node:dns';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const apply = process.argv.includes('--apply');
const seedSeen = process.argv.includes('--seed-seen'); // mark every current candidate as seen (after a manual review)
const PK_FILE = join(root, 'data/pakistan.txt');
const EXCLUDE_FILE = join(root, 'data/pakistan-exclude.txt');
const SEEN_FILE = join(root, 'data/pakistan-seen.txt');
const REVIEW_LIMIT = 200;

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });

/** A shallow, sparse checkout of just `paths` from a GitHub repo. */
function sparse(slug, branch, paths) {
  const dir = join(cache, slug.replace('/', '__'));
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(cache, { recursive: true });
    git(['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--no-checkout', '-b', branch, `https://github.com/${slug}.git`, dir]);
  } else {
    git(['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', branch], dir);
    git(['reset', '--quiet', '--soft', 'FETCH_HEAD'], dir);
  }
  git(['sparse-checkout', 'set', '--no-cone', ...paths], dir);
  git(['checkout', '--quiet', '--force', 'HEAD'], dir);
  return dir;
}

const lines = (file) => readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\d?\./, ''); } catch { return ''; } };
const SLD2 = new Set(['com', 'co', 'net', 'org', 'gov', 'edu', 'ac', 'gob', 'or', 'ne', 'go']);
function mainDomain(h) {
  const p = h.split('.');
  return p.length > 2 && p.at(-1).length === 2 && SLD2.has(p.at(-2)) ? p.slice(-3).join('.') : p.slice(-2).join('.');
}
const inSet = (h, set) => { const p = h.split('.'); for (let i = 0; i < p.length - 1; i++) if (set.has(p.slice(i).join('.'))) return true; return false; };

// ---------- filters ----------
const SHARED = /(^|\.)(facebook|fb|twitter|x|instagram|youtube|youtu|linkedin|blogspot|wordpress|wix|wixsite|weebly|google|linktr|tiktok|github|medium|archive|wikipedia|t|bit|tinyurl|webs|yolasite|jimdo|geocities|tripod|angelfire|sites|carrd|notion|substack)\.(com|me|ee|org|io|co|ly|ws|site|so|be)$/;
const CHEAP = /\.(vip|live|top|xyz|win|bet|club|life|today|link|pro|online|cc|ink|lol|mobi|rest|fit|best|im|games?|garden|gripe|surf|theater|mov|talk|blog|sex|porn|rich|run|icu|cyou|buzz|sbs|shop|store|site|space|fun|click|monster|quest|tk|ml|ga|cf|gq|pages\.dev|netlify\.app|vercel\.app|myshopify\.com|blogspot\.com|wordpress\.com|onrender\.com|herokuapp\.com)$/;
const WORDS = /(pkr|pay|bet|casino|exch|lottery|lucky|jackpot|slot|satta|akra|lasbela|aviator|spin|rummy|teen-?patti|xxx|porn|sex|fap|nude|leak|viral|mms|uncut|chudai|lingerie|movie|bolly|film|hdhub|anime|torrent|1337|pirate|crack|getinto|apk|mod|profit|earn|forex|crypto|trade|invest|loan|cashier|payin|wpay|smm|follower|siminfo|cnic|\d{3,})/;
const FOREIGN_TLD = (h) => { const t = h.split('.').at(-1); return t.length === 2 && t !== 'pk'; };
const SKIP_TYPES = /embassy|consulate|diplomatic|international organization|intergovernmental|united nations|human settlement|city|town|village|tehsil|union council|district|neighbou?rhood|mountain|river|lake|valley|island/i;

function makeFilter(block) {
  return (h) => {
    if (!h || !h.includes('.') || /^\d+(\.\d+){3}$/.test(h)) return 'not a domain';
    if (h.endsWith('.pk')) return '.pk (already covered)';
    if (SHARED.test(h)) return 'shared platform';
    if (FOREIGN_TLD(h)) return "another country's ending";
    for (const [name, set] of block) if (inSet(h, set)) return name;
    if (CHEAP.test(h)) return 'throwaway ending or free hosting';
    if (WORDS.test(mainDomain(h))) return 'betting/piracy/adult/scam words';
    return null;
  };
}

async function exists(d) {
  for (const q of [() => dns.resolve4(d), () => dns.resolve6(d), () => dns.resolve4(`www.${d}`), () => dns.resolveNs(d)]) {
    try { await q(); return true; } catch (err) { if (!['ENOTFOUND', 'ENODATA'].includes(err.code)) return true; }
  }
  return false;
}

// ---------- sources ----------
function loadCrux(file) {
  const out = new Map();
  for (const row of gunzipSync(readFileSync(file)).toString('utf8').split('\n').slice(1)) {
    const [origin, rank] = row.split(',');
    if (!origin) continue;
    const h = hostOf(origin);
    if (h && (!out.has(h) || out.get(h) > Number(rank))) out.set(h, Number(rank));
  }
  return out;
}

/** v2fly list with its include: lines followed. */
function v2fly(dir, name, seen = new Set()) {
  const out = new Set();
  const file = join(dir, 'data', name);
  if (seen.has(name) || !existsSync(file)) return out;
  seen.add(name);
  for (let l of readFileSync(file, 'utf8').split('\n')) {
    l = l.split('#')[0].trim();
    if (!l) continue;
    if (l.startsWith('include:')) { for (const d of v2fly(dir, l.slice(8).split(/\s/)[0], seen)) out.add(d); continue; }
    const t = l.split(/\s/)[0];
    if (!/^(regexp|keyword):/.test(t)) out.add(t.replace(/^(domain|full):/, ''));
  }
  return out;
}

async function wikidata() {
  const query = `SELECT DISTINCT ?site ?typeLabel WHERE {
    ?i wdt:P17 wd:Q843; wdt:P856 ?site.
    OPTIONAL { ?i wdt:P31 ?type }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }`;
  const res = await fetch('https://query.wikidata.org/sparql', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/sparql-results+json', 'user-agent': 'hiddify-rules (github.com/AzizKamboh/hiddify-rules)' },
    body: new URLSearchParams({ query }),
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const byHost = new Map();
  for (const r of (await res.json()).results.bindings) {
    const h = hostOf(r.site.value);
    if (!h) continue;
    if (!byHost.has(h)) byHost.set(h, new Set());
    if (r.typeLabel?.value) byHost.get(h).add(r.typeLabel.value);
  }
  return byHost;
}

// ---------- run ----------
async function main() {
  const listed = new Set(lines(PK_FILE).filter((l) => !l.startsWith('[')).map((l) => l.replace(/^\./, '')));
  const excluded = new Set(existsSync(EXCLUDE_FILE) ? lines(EXCLUDE_FILE) : []);
  const seen = new Set(existsSync(SEEN_FILE) ? lines(SEEN_FILE) : []);
  const known = (d) => inSet(d, listed) || inSet(d, excluded);

  console.log('fetching lists…');
  const hz = sparse('hagezi/dns-blocklists', 'main', ['/wildcard/nsfw-onlydomains.txt', '/wildcard/gambling-onlydomains.txt', '/wildcard/fake-onlydomains.txt', '/wildcard/tif-onlydomains.txt']);
  const dlc = sparse('v2fly/domain-list-community', 'master', ['/data/*']);
  const read = (f) => new Set(lines(join(hz, 'wildcard', f)).map((l) => l.replace(/^\*\./, '')));
  const block = [
    ['adult (Hagezi, v2fly)', new Set([...read('nsfw-onlydomains.txt'), ...v2fly(dlc, 'category-porn')])],
    ['gambling (Hagezi)', read('gambling-onlydomains.txt')],
    ['fake shops and scams (Hagezi)', read('fake-onlydomains.txt')],
    ['malware and phishing (Hagezi)', read('tif-onlydomains.txt')],
  ];
  const reject = makeFilter(block);

  const crux = sparse('zakird/crux-top-lists', 'main', ['/data/country/pk/*', '/data/country/in/*', '/data/country/bd/*', '/data/country/np/*', '/data/global/*']);
  const months = readdirSync(join(crux, 'data/country/pk')).map((f) => f.match(/^(\d{6})\.csv\.gz$/)?.[1]).filter(Boolean).sort();
  const month = months.at(-1);
  const pick = (dir) => { const f = join(crux, dir, `${month}.csv.gz`); return existsSync(f) ? f : join(crux, dir, 'current.csv.gz'); };
  const pk = loadCrux(pick('data/country/pk'));
  const global = loadCrux(pick('data/global'));
  // neighbours by main domain: the best rank any of its hosts has there
  const byMain = (map) => { const m = new Map(); for (const [h, r] of map) { const d = mainDomain(h); if (!m.has(d) || m.get(d) > r) m.set(d, r); } return m; };
  const neighbours = ['in', 'bd', 'np'].map((cc) => byMain(loadCrux(pick(`data/country/${cc}`))));
  console.log(`CrUX ${month}: Pakistan ${pk.size} sites`);

  // tier 1: Wikidata
  const auto = [];
  const skipped = {};
  let wd = new Map();
  try { wd = await wikidata(); } catch (err) { console.warn(`Wikidata skipped: ${err.message}`); }
  for (const [h, types] of wd) {
    const d = h;
    if (known(d)) continue;
    let why = reject(d);
    if (!why && [...types].some((t) => SKIP_TYPES.test(t))) why = 'embassy, place or international body';
    if (!why && (global.get(d) ?? Infinity) <= 100000 && !((pk.get(d) ?? Infinity) * 10 <= (global.get(d) ?? Infinity))) why = 'popular worldwide, not mainly in Pakistan';
    if (why) { skipped[why] = (skipped[why] || 0) + 1; continue; }
    auto.push(d);
  }
  const alive = [];
  for (let i = 0; i < auto.length; i += 16) {
    const batch = auto.slice(i, i + 16);
    const ok = await Promise.all(batch.map(exists));
    batch.forEach((d, j) => (ok[j] ? alive.push(d) : (skipped["doesn't exist"] = (skipped["doesn't exist"] || 0) + 1)));
  }
  // a DNS outage would make everything look gone: then add nothing this month
  const autoAdd = alive.length >= auto.length / 3 ? [...new Set(alive)].sort() : [];
  console.log(`Wikidata: ${wd.size} Pakistani organisations' websites; adding ${autoAdd.length}; skipped ${JSON.stringify(skipped)}`);
  if (autoAdd.length) console.log(`ADDING: ${autoAdd.join(' ')}`);

  // tier 2: popular in Pakistan, for review
  const candidates = new Map();
  for (const [h, r] of pk) {
    if (r > 5000) continue;
    const d = mainDomain(h);
    if (known(d) || autoAdd.includes(d) || reject(d)) continue;
    if ((global.get(h) ?? Infinity) < 10 * r || (global.get(d) ?? Infinity) < 10 * r) continue;
    if (neighbours.some((n) => (n.get(d) ?? Infinity) < 10 * r)) continue;
    candidates.set(d, Math.min(candidates.get(d) ?? Infinity, r));
  }
  const fresh = [...candidates].filter(([d]) => !seen.has(d)).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  console.log(`review: ${candidates.size} candidates, ${fresh.length} new since the last run`);

  const review = [
    `Sites that are much more popular in Pakistan than worldwide (Chrome UX Report, ${month.slice(0, 4)}-${month.slice(4)}), not popular in India, Bangladesh or Nepal, and not on any adult, gambling, scam or malware list. Only sites not shown in an earlier issue are listed.`,
    '',
    'They are **not** added automatically. For each real Pakistani site, add the domain to the right section of `data/pakistan.txt`; for each site that should never be suggested again, add it to `data/pakistan-exclude.txt`.',
    '',
    ...(autoAdd.length ? [`Added automatically this month from Wikidata (${autoAdd.length}): ${autoAdd.join(', ')}`, ''] : []),
    ...fresh.slice(0, REVIEW_LIMIT).map(([d, r]) => `- [ ] ${d} — Pakistan top ${r.toLocaleString('en-US')}`),
    ...(fresh.length > REVIEW_LIMIT ? ['', `…and ${fresh.length - REVIEW_LIMIT} more, shown next month.`] : []),
  ].join('\n');
  writeFileSync(join(root, 'pk-review.md'), `${review}\n`);
  writeFileSync(join(root, 'pk-review-count.txt'), `${Math.min(fresh.length, REVIEW_LIMIT)} ${autoAdd.length}\n`);

  if (!apply && !seedSeen) { console.log('dry run: data files unchanged'); return; }
  if (apply && autoAdd.length) {
    let text = readFileSync(PK_FILE, 'utf8').replace(/\n*$/, '\n');
    if (!/^\[auto\]/m.test(text)) text += '\n[auto] Added automatically (Wikidata: websites of Pakistani organisations)\n';
    text += `# ${month.slice(0, 4)}-${month.slice(4)}\n${autoAdd.join('\n')}\n`;
    writeFileSync(PK_FILE, text);
  }
  const shown = (seedSeen ? fresh : fresh.slice(0, REVIEW_LIMIT)).map(([d]) => d);
  if (shown.length) {
    const head = existsSync(SEEN_FILE) ? '' : '# Sites already suggested in a monthly review issue (scripts/pk-discover.mjs), so they are not suggested again.\n';
    writeFileSync(SEEN_FILE, `${head}${existsSync(SEEN_FILE) ? readFileSync(SEEN_FILE, 'utf8').replace(/\n*$/, '\n') : ''}${shown.join('\n')}\n`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
