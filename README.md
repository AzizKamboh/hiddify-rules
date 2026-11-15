# Hiddify Split Tunneling

A web page for building [Hiddify](https://github.com/hiddify/hiddify-app)'s routing rules (`route_rules.json`)
from ready-made rule sets: choose what goes through the VPN, what goes direct through your ISP and what
gets blocked, then import the result into Hiddify on Windows or Android.

**Live page:** https://azizkamboh.github.io/hiddify-rules/

The list of rule sets is refreshed every day by a GitHub Action, so the page always offers what the
upstream projects currently publish. The rule sets themselves are not copied here (except a few IP lists,
see below): Hiddify downloads them straight from their source and keeps them up to date on its own.

## Sources

| Source | What it gives |
|---|---|
| [SagerNet/sing-geosite](https://github.com/SagerNet/sing-geosite/tree/rule-set) | ~2,000 site lists (domains), from v2fly's community list |
| [SagerNet/sing-geoip](https://github.com/SagerNet/sing-geoip/tree/rule-set) | 238 country IP lists (MaxMind GeoLite2) |
| [MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat/tree/sing) | Service IP lists (Telegram, Google, Netflix, Cloudflare…), ~83,000 network (ASN) lists, and site lists SagerNet doesn't have |
| [hiddify/hiddify-geo](https://github.com/hiddify/hiddify-geo/tree/rule-set) | Ad, malware, phishing and miner block lists (the same ones Hiddify's built-in rule uses) |
| [iptoasn.com](https://iptoasn.com/) | Network names and countries for network search (public domain; names only) |
| [AdGuard DNS filter](https://github.com/AdguardTeam/AdGuardSDNSFilter) | AdBlock *Adguard*: AdGuard Base, Social, Tracking, Mobile Ads, EasyList and EasyPrivacy for DNS (GPL-3.0); converted daily with sing-box |
| [HaGeZi Multi NORMAL](https://github.com/hagezi/dns-blocklists) | AdBlock *Hagezi*: ads, trackers, telemetry, phishing, malware, scams (GPL-3.0); converted daily with sing-box |

Country flags: [flag-icons](https://github.com/lipis/flag-icons) (MIT), in `public/flags/`. Service and website icons are loaded from Google's favicon service, with DuckDuckGo's as a fallback.

## Split tunneling

| Mode | What you pick | Everything else |
|---|---|---|
| **Exclude** (default) | bypasses the VPN, connects directly | VPN |
| **Include** | uses the VPN | connects directly through your ISP, local network included |

The page shows the rules in the order Hiddify checks them: **1** Hiddify's built-in rules (switches),
**2** AdBlock (only when an AdBlock list is picked), **3** Bypass VPN or Use VPN with your picks.
Exclude with nothing picked is exactly Hiddify's default: only the local network (the built-in Bypass LAN
rule) bypasses the VPN. Uploaded files open in Include or Exclude, depending on where their unmatched
traffic goes.

Rules in an uploaded file that Include/Exclude can't show — typed domains, IPs, ports or apps, rules sending
traffic the other way, switched-off rules, *Direct + fragment* — are kept exactly as they were in a
**From your file** section, placed right after the built-ins in the downloaded file. Each can be removed.

## Pakistan

No public rule source covers Pakistan, so this project keeps its own list in
[`data/pakistan.txt`](data/pakistan.txt) — banks and payments, government and education, news and TV, telecom,
streaming, shopping and everyday services, sorted into sections for easy editing. The page shows two choices
first in **Services**, as one **Pakistan** row that opens into its parts:

- **Pakistani websites** — every `.pk` site plus every domain in that file.
- **Pakistan IPs** — Pakistan's country IP list.
- **Pakistan networks** — the Pakistan ISP networks.

Ticking Pakistan picks all three; each part can also be picked on its own.

In Exclude mode that keeps local sites — many of which refuse foreign IPs — on your ISP. The daily build
publishes the list as `sets/geosite-pk-all.json` (each section also as `sets/geosite-pk-<section>.json`) and
leaves out domains that no longer exist (listed in the Action's log). To add a site, edit `data/pakistan.txt`
on GitHub.

## How to import into Hiddify

1. Build your rules on the page.
2. Click **Download rules**, then in Hiddify go to **Settings → Routing → ⋮ → import from file**.
3. Reconnect from Hiddify's Home page.

Importing replaces all your routing rules. To change rules you already have, export them from Hiddify
first (**⋮ → export to file**) and use **Upload rules** on the page.

## How Hiddify reads the rules

These details come from the [hiddify-app](https://github.com/hiddify/hiddify-app) and
[hiddify-core](https://github.com/hiddify/hiddify-core) source, and the page is built around them:

- **Rules are checked top to bottom**; the first one that matches decides.
- **Built-in rules** (Bypass LAN, System services, Ads and malware, Bypass region) are recognised by their
  name. On import Hiddify fills in their content itself, which differs between Windows and Android, and keeps
  only their on/off switch and position. The page therefore writes only those.
- **Bypass region** only exists when a region other than *Other* is selected in Hiddify. The page leaves it
  out of the file (so Hiddify keeps its own setting) unless you tick *My Hiddify region isn't "Other"*, which
  shows its switch. Pakistan isn't one of Hiddify's regions; use the Pakistan lists in Services instead.
- **"Everything else → Direct"** can't be set in Hiddify (its *Default proxy* only picks between VPN
  servers, and unmatched traffic always goes to the VPN). The page adds two catch-all rules at the end
  instead: domain regex `.*` → Direct, which also sends those names to the direct DNS, and ports
  `1:65535` → Direct, for connections without a domain name. A rule with no condition at all would be
  dropped by Hiddify.
- **Within a rule**, sites, IP lists and IPs are combined with OR. Ports and apps are combined with AND,
  so a rule with sites and ports only matches those ports of those sites. App rules (Windows process
  names, Android package names) only work in VPN (TUN) mode.
- **IP lists named `geoip-*`**: Hiddify names each rule set after its file and leaves `geoip-*` files out
  of its DNS rules, since IP lists mean nothing to a DNS query. MetaCubeX's service and network IP lists
  are named `telegram.srs`, `AS17557.srs` and so on, so the daily job copies those to this site as
  `sets/geoip-telegram.srs`, `sets/geoip-as17557.srs`… — all 9 service lists and all ~83,000 networks
  (about 6 MB together).
- Hiddify downloads rule sets **through the VPN**, so they load once the VPN connects.

## What's inside a list

The eye button next to every list opens it in a new tab: its domains, domain patterns and IP ranges, a search
that answers "is this domain or IP in the list?", and a .txt download. The page reads sing-box's binary `.srs`
files itself ([`public/lib/srs.js`](public/lib/srs.js)) — including AdGuard rules, which
`sing-box rule-set decompile` can't show. Each build checks the reader against sing-box on sample lists
(`scripts/check-srs.mjs`).

## Repository layout

```
.github/workflows/sync.yml   daily at 03:17 UTC: test, build the list index, deploy the page
scripts/build-index.mjs      lists the upstream branches and mirrors the geoip-* IP lists
data/catalog.json            hand-kept: services, Pakistan networks
public/                      the page (plain HTML, CSS and JavaScript, no build step)
public/lib/hiddify.js        turns the choices into Hiddify's file format and import link
public/lib/picks.js          grouping of picks (shared lists) and reading uploaded files
public/lib/srs.js            reads sing-box .srs rule sets for the "what's inside" page (view.html)
scripts/check-srs.mjs        checks that reader against sing-box's own decompiler in CI
test/                        checks the output against real exports from Hiddify (Windows and Android),
                             shared lists, and upload → download round trips
```

`public/data/` and `public/sets/` are made by the build and aren't kept in the repository.

## Run it on your computer

Needs [Node.js](https://nodejs.org) 20 or newer and git.

```sh
npm test                          # check the generator
node scripts/build-index.mjs      # fetch the lists (a few seconds)
npx serve public                  # open the address it prints
```

## Change the services or Pakistan networks

Edit `data/catalog.json`. Names must match the upstream list names (the page's *Websites* tab shows them);
the daily build checks every name and drops ones that don't exist, listing them in the Action's log.

## License

MIT — see [LICENSE](LICENSE). The rule lists themselves come from their sources under their own licenses.
