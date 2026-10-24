# Matt's Home Assistant Apps

Custom Home Assistant OS apps from [mjgoose91/ha-apps](https://github.com/mjgoose91/ha-apps).

## IPTV-org EPG

Runs the official [iptv-org/epg](https://github.com/iptv-org/epg) image to generate
and serve XMLTV guide data. Dispatcharr runs separately on the same HAOS machine
and can use this app's HTTP URL as an EPG source. This app does not install or
configure Dispatcharr. Optional automatic US channel selection uses mappings
already maintained by IPTV-org; no channel list needs to be maintained manually.

### Installation And First Start

1. In Home Assistant's app store (called the add-on store in older versions), add
   `https://github.com/mjgoose91/ha-apps` under **Repositories**.
2. Install **IPTV-org EPG**. Supervisor builds the small wrapper locally using
   `ghcr.io/iptv-org/epg:master`; no separate image publication is required.
3. Leave the defaults and start the app. It starts the HTTP server without
   downloading any guide. Open Web UI should show the served directory.
4. Once a guide has been generated, configure Dispatcharr's XMLTV/EPG source as
   `http://<HAOS-LAN-IP>:3000/guide.xml`. Use the HAOS machine's address, not
   `localhost` inside the Dispatcharr container. Adjust the URL if you change the
   app's host port in its Network settings.

Supported architectures: `amd64` and `aarch64`, matching the upstream image's
published platforms. No Home Assistant API access, privileged mode, or host
networking is required.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `auto_generate_us_channels` | `false` | On each app start, download the current IPTV-org US playlist and build a persistent channel list from the installed EPG mappings. Selects this list instead of the manual file; does not enable any grab. |
| `run_at_startup` | `false` | Run a grab when the app starts; maps to `RUN_AT_STARTUP`. This is separate from HA's Start on boot setting. |
| `schedule` | `""` | Empty disables scheduled grabs. Otherwise a five-field numeric cron expression, e.g. `0 0 * * *`; maps to `CRON_SCHEDULE`. Names and cron macros are not accepted. |
| `guide_days` | `3` | Days to request, from 1 to 14; maps to `DAYS`. Sources may provide fewer days. |
| `concurrency` | `1` | Concurrent requests, from 1 to 32; maps to `MAX_CONNECTIONS`. Keep low to avoid overloading sources. |

Restart the app after changing options. Cron follows the container's timezone;
check the app logs when verifying scheduled times.

### Persistent Files

Home Assistant automatically provides persistent private storage at `/data`:

- `/data/options.json`: options written by Supervisor; do not edit manually.
- `/data/public/channels.xml`: user-supplied iptv-org grabber channel definitions.
- `/data/public/us.channels.xml`: automatically generated US channel definitions.
- `/data/public/us.channels.report.json`: generation time, counts, selected sources,
  candidate counts, and all unmapped playlist IDs.
- `/data/public/guide.xml`: generated XMLTV output for Dispatcharr.
- `/data/pm2.config.json`: runtime configuration regenerated at each start.

The wrapper links upstream's `/epg/public` to `/data/public`, preserving channel
configuration and guides across restarts and app updates. The channel file must
use upstream's `<channels><channel site="..." ...>...</channel></channels>` format,
not an XMLTV `<tv>` output file. There is no file-upload interface. `/data` is
private app storage, not the Home Assistant Core configuration directory or
`/share`; supplying a manual file currently requires administrative access to
the app's data storage. Automatic generation never overwrites the manual file.
Set `auto_generate_us_channels: false` to use the manual file again. Generated
files remain on disk when automatic mode is disabled.

If either grab option is enabled without a nonempty selected channel file, startup fails
with an explicit error. With both disabled, the app serves existing files only;
`/guide.xml` returns HTTP 404 until a real guide exists. No placeholder guide or
sample channel list is generated.

### Automatic US Mapping

To validate channel selection on HAOS **without grabbing any schedules**, use:

```yaml
auto_generate_us_channels: true
run_at_startup: false
schedule: ""
guide_days: 3
concurrency: 1
```

Restart the app and check the generation counts in its logs. Inspect these URLs
using the HAOS host address and configured port:

- `http://<HAOS-LAN-IP>:3000/us.channels.xml`
- `http://<HAOS-LAN-IP>:3000/us.channels.report.json`

The XML is a **grabber input**, not an XMLTV guide for Dispatcharr. The existing
`/guide.xml` is not modified by generation and still returns 404 if no guide has
ever been grabbed. Keep grabbing disabled until you have reviewed the list.

Generation works as follows:

1. Fetch `https://iptv-org.github.io/iptv/countries/us.m3u` over HTTPS with a
   60-second request timeout. Count playlist entries, distinct nonempty `tvg-id`
   values, and entries without an ID separately.
2. Read every `sites/**/*.channels.xml` in the installed `/epg` image. The US
   playlist may include channels from other countries, so filenames/country
   suffixes are not used as filters. Only rows with an exact full `xmltv_id`
   match, nonempty source ID, name and language, and an installed site config are
   eligible. No API endpoint, name matching, or third-party scraping is needed
   for generation.
3. Select one row per playlist ID: prefer `lang="en"`, then compare site,
   relative mapping filename, site ID, language, and name lexically. This is our
   deterministic tie-break, **not an upstream source-quality priority**. A
   non-English source is kept when English is unavailable. Duplicate candidate
   counts include repeated mappings in different files.
4. Preserve the selected row's full ID, source, source ID, language, and display
   name. Write a single mixed-site `<channels>` document and a JSON coverage
   report under `/data/public`, replacing each file by same-filesystem rename.
   There is one row per unique mapped ID, not per stream URL.
5. When grabs are explicitly enabled, use upstream's existing PM2 jobs with
   `--channels=public/us.channels.xml` instead of the manual filename. The
   HTTP server, scheduling, guide output, and other grab options are unchanged.

Generation uses only the EPG definitions shipped in the image, not live `master`
files that could require newer scraper code. Restarting refreshes the playlist;
**rebuilding/updating the app image** refreshes the EPG mappings and scraper code
together. There is no background regeneration or automatic fallback between
sources. Lexical choices can change when the installed mappings change.

A failed playlist request, invalid/empty playlist, or zero exact matches leaves
previous generated files untouched. With grabs disabled, log the failure and
continue serving existing files; inspect report timestamps to detect stale data.
With either grab option enabled, fail startup instead of silently grabbing a
stale list. Disabling automatic mode removes the playlist-download dependency.
Generated XML and report are individually replaced, not a transactional pair;
an interrupted write can leave a report from a different generation.

### Current Upstream Architecture

The database separates channel IDs (e.g. `3ABNEnglish.us`) from feeds. Feed IDs
are local to a channel; the composite stream ID is `<channel>@<feed>`, for example
`3ABNEnglish.us@SD`. Current playlist `tvg-id` values generally use that composite
ID. EPG mapping rows associate `xmltv_id` with a scraper `site` and its `site_id`.
The grabber writes `xmltv_id` unchanged into XMLTV `<channel id>` and
`<programme channel>`. Database main-feed resolution is metadata behavior, not
automatic XMLTV ID rewriting.

We therefore do **not** strip `@feed`, infer feeds from resolution, match by
display name, or substitute another regional/timeshift feed. Bare IDs match only
bare upstream mappings. This conservative policy leaves some channels unmapped
rather than assigning potentially incorrect schedules.

Current upstream supports one multi-site channels document: each row loads its
own `/epg/sites/<site>/<site>.config.js`. The upstream custom-list test fixture
also contains multiple sites. Passing multiple competing rows is not a source
fallback policy: upstream queues them all and can emit overlapping schedules
and duplicate XMLTV channel IDs. Selecting one row avoids that ambiguity. The
generator does not contact any EPG provider; an explicitly enabled grab later
uses upstream's existing scraper implementations.

### Coverage Snapshot

Validated on 2026-10-24 against the live US playlist and EPG commit
`d43b000cbbb41aad7df42c556678e899c7f2a25e`:

| Measure | Count |
| --- | ---: |
| US playlist entries | 1,483 |
| Unique nonempty playlist IDs | 1,483 |
| Entries without an ID | 0 |
| IDs with usable exact mappings | 611 (41.2%) |
| IDs without usable exact mappings | 872 |
| IDs with multiple candidates | 488 |
| Extra candidate rows resolved | 1,831 |
| Final generated channel rows | 611 |
| Upstream mapping files scanned | 540 |

Example exact joins; the first column is both the playlist `tvg-id` and the
XMLTV ID that the grabber would emit:

| Playlist ID / XMLTV ID | Selected Site | Site ID |
| --- | --- | --- |
| `24HourFreeMovies.us@SD` | `distro.tv` | `39730` |
| `3ABNEnglish.us@SD` | `tvpassport.com` | `three-angels-broadcasting-network/19066` |
| `3ABNLatino.us@SD` | `mi.tv` | `hn#3abn-latino` |
| `48Hours.us@US` | `i.mjh.nz` | `Roku/all#e1df79771ae4850c0e48ecc6284065d0` |

Unmapped examples include `00sReplay.us@SD`, `30ADarcizzleOffshore.us@SD`,
`30AGeorgiaHollywoodReview.us@SD`, and `30AGolfKingdom.us@SD`. The report lists
all unmapped IDs; lack of an exact row does not prove a provider has no schedule.

This validates mapping coverage and compatibility with `epg-grabber@0.48.0`'s
channel parser, **not** live provider availability or programme coverage. No
schedule grab was run. Some upstream sources may be broken, require credentials,
or produce empty schedules. A 611-channel multi-site grab can still be expensive;
there is intentionally no automatically enabled US grab.

### Developer Validation

`iptv-org-epg/tests/verify.cjs` uses Node's test runner. Dependencies for validation
are `cheerio`, `js-yaml`, `node-cron`, and `epg-grabber@0.48.0`; the runtime
generator only uses `cheerio`, already supplied by the upstream image. Install
validation dependencies outside the app directory and expose them through
`NODE_PATH`, or use a suitable existing development environment.

```sh
sh -n iptv-org-epg/run.sh
node --check iptv-org-epg/generate-us-channels.cjs
node --test iptv-org-epg/tests/verify.cjs
# Optional: test PM2 integration against a current upstream EPG checkout,
# and fetch the live US playlist. This does not run a schedule grab.
EPG_ROOT=/path/to/iptv-org/epg EPG_LIVE=1 node --test iptv-org-epg/tests/verify.cjs
```

Tests cover YAML/schema defaults, exact feed matching, duplicate selection,
escaping, missing scraper configs, invalid downloads, preservation of manual
and previous generated files, and startup modes. Live mode checks that the
actual upstream grabber parser accepts every generated row with unique IDs.

Port 3000 is plain HTTP with no authentication. Everything under `/data/public`,
including `channels.xml`, is public to clients that can reach that port. Keep it
on a trusted network, do not forward it to the internet, and do not put secrets
there. Other app data, including `options.json`, is outside the served directory.

### Upstream References

- [EPG Docker usage and environment variables](https://github.com/iptv-org/epg#docker)
- [EPG PM2 startup configuration](https://github.com/iptv-org/epg/blob/master/pm2.config.js)
- [EPG mapping format](https://github.com/iptv-org/epg/blob/master/CONTRIBUTING.md#how-to-add-a-channel-to-the-guide)
- [EPG grab loader](https://github.com/iptv-org/epg/blob/master/scripts/commands/epg/grab.ts)
- [EPG multi-site test fixture](https://github.com/iptv-org/epg/blob/master/tests/__data__/input/epg_grab/custom.channels.xml)
- [IPTV stream/feed IDs](https://github.com/iptv-org/iptv/blob/master/docs/stream-id.md)
- [Database channel/feed schema](https://github.com/iptv-org/database/blob/master/CONTRIBUTING.md#data-scheme)
- [Home Assistant app configuration](https://contributors.home-assistant.io/apps/reference/configuration/)
- [Home Assistant app repositories](https://contributors.home-assistant.io/apps/guides/repository/)

The requested upstream `master` tag is mutable, so future local rebuilds can pick
up upstream changes. Pinning a tested image digest is a future release-hardening
step.
