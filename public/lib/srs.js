/**
 * Reads sing-box binary rule-sets (.srs, format versions 1–4) back into rules, like
 * `sing-box rule-set decompile` — and it also reads AdGuard rules, which that command can't.
 *
 * File: "SRS", a version byte, then zlib data: a rule count and the rules. Domains and AdGuard
 * rules are stored as a succinct trie of reversed names; IP lists as from–to ranges.
 * Format: github.com/SagerNet/sing-box/blob/main/common/srs/binary.go
 */

// item types, in sing-box's order
const ITEM = [
  'query_type', 'network', 'domain', 'domain_keyword', 'domain_regex', 'source_ip_cidr', 'ip_cidr',
  'source_port', 'source_port_range', 'port', 'port_range', 'process_name', 'process_path', 'package_name',
  'wifi_ssid', 'wifi_bssid', 'adguard_domain', 'process_path_regex', 'network_type', 'network_is_expensive',
  'network_is_constrained', 'network_interface_address', 'default_interface_address',
];
const FINAL = 0xff;
const PREFIX = '\r';   // marks a suffix entry (".example.com" or, in AdGuard rules, no "|" start)
const ROOT = '\n';     // marks "example.com and its subdomains" (AdGuard: "||")
const AG_OPEN = '\b';  // AdGuard rule without a "^" end

/** zlib → bytes in the browser; Node passes its own. */
async function browserInflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes one .srs file. Returns { version, rules } with rules shaped like sing-box's JSON. */
export async function readSrs(buffer, inflate = browserInflate) {
  const raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (raw[0] !== 0x53 || raw[1] !== 0x52 || raw[2] !== 0x53) throw new Error('Not a sing-box rule-set (.srs) file');
  const version = raw[3];
  const r = new Reader(await inflate(raw.subarray(4)));
  const rules = [];
  for (let i = 0, n = r.uvarint(); i < n; i++) rules.push(readRule(r));
  return { version, rules };
}

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  byte() { if (this.p >= this.b.length) throw new Error('Unexpected end of file'); return this.b[this.p++]; }
  uvarint() {
    let x = 0, mul = 1;
    for (;;) {
      const c = this.byte();
      x += (c & 0x7f) * mul;
      if (c < 0x80) return x;
      mul *= 128;
    }
  }
  bytes(n) { if (this.p + n > this.b.length) throw new Error('Unexpected end of file'); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  u16() { const v = this.view.getUint16(this.p); this.p += 2; return v; }
  /** uint64 as [hi, lo] 32-bit halves */
  u64() { const hi = this.view.getUint32(this.p), lo = this.view.getUint32(this.p + 4); this.p += 8; return [hi, lo]; }
  strings() { const out = []; for (let i = 0, n = this.uvarint(); i < n; i++) out.push(utf8(this.bytes(this.uvarint()))); return out; }
  u16s() { const out = []; for (let i = 0, n = this.uvarint(); i < n; i++) out.push(this.u16()); return out; }
  words() { const n = this.uvarint(); const out = new Uint32Array(n * 2); for (let i = 0; i < n; i++) { const [hi, lo] = this.u64(); out[i * 2] = lo; out[i * 2 + 1] = hi; } return out; }
}

const decoder = new TextDecoder();
const utf8 = (b) => decoder.decode(b);

function readRule(r) {
  const type = r.byte();
  if (type === 0) return readDefault(r);
  if (type === 1) {
    const mode = r.byte();
    if (mode > 1) throw new Error(`Unknown logical mode ${mode}`);
    const rules = [];
    for (let i = 0, n = r.uvarint(); i < n; i++) rules.push(readRule(r));
    const rule = { type: 'logical', mode: mode ? 'or' : 'and', rules };
    if (r.byte()) rule.invert = true;
    return rule;
  }
  throw new Error(`Unknown rule type ${type}`);
}

function readDefault(r) {
  const rule = {};
  for (;;) {
    const t = r.byte();
    if (t === FINAL) { if (r.byte()) rule.invert = true; return rule; }
    const name = ITEM[t];
    switch (name) {
      case 'domain': {
        const { domains, suffixes } = dumpDomains(readTrie(r));
        if (domains.length) rule.domain = domains;
        if (suffixes.length) rule.domain_suffix = suffixes;
        break;
      }
      case 'adguard_domain': rule.adguard_domain = dumpAdGuard(readTrie(r)); break;
      case 'source_ip_cidr': case 'ip_cidr': rule[name] = readIpSet(r); break;
      case 'query_type': case 'source_port': case 'port': rule[name] = r.u16s(); break;
      case 'network_type': rule[name] = [...r.bytes(r.uvarint())]; break;
      case 'network_is_expensive': case 'network_is_constrained': rule[name] = true; break;
      case 'network_interface_address': {
        const map = {};
        for (let i = 0, n = r.uvarint(); i < n; i++) { const key = r.byte(); map[key] = readPrefixes(r); }
        rule[name] = map;
        break;
      }
      case 'default_interface_address': rule[name] = readPrefixes(r); break;
      case undefined: throw new Error(`Unknown rule item ${t}`);
      default: rule[name] = r.strings();
    }
  }
}

function readPrefixes(r) {
  const out = [];
  for (let i = 0, n = r.uvarint(); i < n; i++) {
    const addr = r.bytes(r.uvarint());
    out.push(`${ipText(addr)}/${r.byte()}`);
  }
  return out;
}

// ---------- domain trie ----------

/** The keys of a succinct trie (BFS order: a 0 bit per child, then a 1 per node). */
function readTrie(r) {
  r.byte(); // set format version
  const leaves = r.words();
  const bitmap = r.words();
  const labels = r.bytes(r.uvarint());
  const bit = (words, i) => (words[i >>> 5] >>> (i & 31)) & 1; // little 32-bit words, low half first
  const nodes = labels.length + 1;
  const parent = new Int32Array(nodes);
  parent[0] = -1;
  let node = 0, child = 0;
  for (let i = 0; node < nodes; i++) {
    if (i >= bitmap.length * 32) throw new Error('Damaged domain list');
    if (bit(bitmap, i)) node++;
    else { child++; parent[child] = node; }
  }
  const keys = [];
  const buf = [];
  for (let n = 0; n < nodes; n++) {
    if (!bit(leaves, n)) continue;
    buf.length = 0;
    for (let k = n; k > 0; k = parent[k]) buf.push(labels[k - 1]);
    // the stored key is the name reversed rune by rune: decode it root → leaf, then un-reverse
    keys.push([...utf8(Uint8Array.from(buf.reverse()))].reverse().join(''));
  }
  return keys;
}

function dumpDomains(keys) {
  const domains = new Set();
  const prefixes = new Set();
  const suffixes = [];
  for (const raw of keys) {
    const key = raw;
    if (key[0] === PREFIX) prefixes.add(key.slice(1));
    else if (key[0] === ROOT) suffixes.push(key.slice(1));
    else domains.add(key);
  }
  for (const p of prefixes) {
    // legacy (version 1) files store a suffix as the name itself plus ".name"
    if (p[0] === '.' && domains.has(p.slice(1))) { domains.delete(p.slice(1)); suffixes.push(p.slice(1)); }
    else suffixes.push(p);
  }
  return { domains: [...domains].sort(), suffixes: suffixes.sort() };
}

function dumpAdGuard(keys) {
  return keys.map((raw) => {
    let key = raw;
    let start = '';
    if (key[0] === PREFIX) key = key.slice(1);
    else if (key[0] === ROOT) { key = key.slice(1); start = '||'; } else start = '|';
    let end = '^';
    if (key.endsWith(AG_OPEN)) { key = key.slice(0, -1); end = ''; }
    return start + key + end;
  });
}

// ---------- IP sets ----------

function readIpSet(r) {
  if (r.byte() !== 1) throw new Error('Unknown IP list format');
  const [hi, lo] = r.u64();
  const count = hi * 2 ** 32 + lo;
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = r.bytes(r.uvarint());
    const to = r.bytes(r.uvarint());
    rangeToCidrs(from, to, out);
  }
  return out;
}

const toBig = (b) => b.reduce((v, x) => (v << 8n) | BigInt(x), 0n);

function rangeToCidrs(fromB, toB, out) {
  const bits = BigInt(fromB.length * 8);
  let from = toBig(fromB);
  const to = toBig(toB);
  while (from <= to) {
    // largest block that starts at `from` and stays inside the range
    let size = 0n;
    while (size < bits && ((from >> size) & 1n) === 0n && from + (1n << (size + 1n)) - 1n <= to) size++;
    out.push(`${ipText(from, fromB.length)}/${bits - size}`);
    from += 1n << size;
  }
}

function ipText(v, len) {
  const bytes = v instanceof Uint8Array ? v : Uint8Array.from({ length: len }, (_, i) => Number((v >> BigInt((len - 1 - i) * 8)) & 0xffn));
  if (bytes.length === 4) return bytes.join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  // shorten the longest run of zero groups to "::"
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    if (groups[i]) { i++; continue; }
    let j = i;
    while (j < 8 && !groups[j]) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

// ---------- for the viewer ----------

const SECTION_OF = {
  domain: 'domain', domain_suffix: 'suffix', domain_keyword: 'keyword', domain_regex: 'regex',
  ip_cidr: 'ip', adguard_domain: 'adguard',
};

/**
 * Collects every value in the rules into sections for display:
 * { domain, suffix, keyword, regex, ip, adguard, other: { field: [...] } }, each split into
 * `match` and `except` (values under an inverted rule: the list does NOT match them).
 */
export function summarize(rules) {
  const out = { match: emptySections(), except: emptySections() };
  const walk = (rule, inverted) => {
    const inv = inverted !== Boolean(rule.invert);
    if (rule.type === 'logical') { rule.rules.forEach((x) => walk(x, inv)); return; }
    const into = inv ? out.except : out.match;
    for (const [field, values] of Object.entries(rule)) {
      if (field === 'invert' || field === 'type') continue;
      const list = Array.isArray(values) ? values.map(String) : [JSON.stringify(values)];
      const sec = SECTION_OF[field];
      if (sec) into[sec].push(...list);
      else (into.other[field] ||= []).push(...list);
    }
  };
  rules.forEach((r) => walk(r, false));
  return out;
}

function emptySections() {
  return { domain: [], suffix: [], keyword: [], regex: [], ip: [], adguard: [], other: {} };
}
