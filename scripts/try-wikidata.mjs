// One-off: what would Wikidata give for Pakistani organisations' websites (not .pk)?
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
console.log('HTTP', res.status);
const data = await res.json();
const rows = data.results.bindings;
const SHARED = /(^|\.)(facebook|fb|twitter|x|instagram|youtube|linkedin|blogspot|wordpress|wix|weebly|google|sites\.google|linktr|tiktok|github|medium|archive|web\.archive|wikipedia|t)\.(com|me|ee|org|io|co)$/;
const byHost = new Map();
let pk = 0, shared = 0, bad = 0;
for (const r of rows) {
  let host;
  try { host = new URL(r.site.value).hostname.toLowerCase().replace(/^www\d?\./, ''); } catch { bad++; continue; }
  if (host.endsWith('.pk') || host === 'pk') { pk++; continue; }
  if (SHARED.test(host)) { shared++; continue; }
  const t = r.typeLabel?.value || '?';
  if (!byHost.has(host)) byHost.set(host, new Set());
  byHost.get(host).add(t);
}
console.log(`rows ${rows.length} · .pk ${pk} · shared platforms ${shared} · unparsable ${bad} · non-.pk domains ${byHost.size}`);
const types = new Map();
for (const ts of byHost.values()) for (const t of ts) types.set(t, (types.get(t) || 0) + 1);
console.log('TOP TYPES', [...types].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, n]) => `${t}:${n}`).join(' | '));
const all = [...byHost.keys()].sort();
console.log('SAMPLE', all.filter((_, i) => i % Math.max(1, Math.floor(all.length / 150)) === 0).join(' '));
for (const want of ['dawn.com', 'geo.tv', 'hbl.com', 'meezanbank.com', 'zameen.com', 'daraz.pk', 'arynews.tv', 'nayatel.com', 'pakwheels.com', 'jazz.com.pk', 'khaadi.com', 'careem.com', 'ufone.com', 'samaa.tv', 'brecorder.com']) console.log('HAS', want, byHost.has(want) || want.endsWith('.pk'));
