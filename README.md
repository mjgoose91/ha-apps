# Matt's Home Assistant Apps

Custom Home Assistant OS apps from [mjgoose91/ha-apps](https://github.com/mjgoose91/ha-apps).

## IPTV-org EPG

Runs the official [iptv-org/epg](https://github.com/iptv-org/epg) image to generate
and serve XMLTV guide data. Dispatcharr runs separately on the same HAOS machine
and can use this app's HTTP URL as an EPG source. This app does not install or
configure Dispatcharr, select US channels, or map channels automatically.

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
- `/data/public/guide.xml`: generated XMLTV output for Dispatcharr.
- `/data/pm2.config.json`: runtime configuration regenerated at each start.

The wrapper links upstream's `/epg/public` to `/data/public`, preserving channel
configuration and guides across restarts and app updates. The channel file must
use upstream's `<channels><channel site="..." ...>...</channel></channels>` format,
not an XMLTV `<tv>` output file. This first pass does not create it or provide a
file-upload interface. `/data` is private app storage, not the Home Assistant
Core configuration directory or `/share`; supplying that file currently requires
administrative access to the app's data storage. User-friendly provisioning and
automatic US channel selection/mapping are deferred.

If either grab option is enabled without a nonempty channel file, startup fails
with an explicit error. With both disabled, the app serves existing files only;
`/guide.xml` returns HTTP 404 until a real guide exists. No placeholder guide or
sample channel list is generated.

Port 3000 is plain HTTP with no authentication. Everything under `/data/public`,
including `channels.xml`, is public to clients that can reach that port. Keep it
on a trusted network, do not forward it to the internet, and do not put secrets
there. Other app data, including `options.json`, is outside the served directory.

### Upstream References

- [EPG Docker usage and environment variables](https://github.com/iptv-org/epg#docker)
- [EPG PM2 startup configuration](https://github.com/iptv-org/epg/blob/master/pm2.config.js)
- [Home Assistant app configuration](https://contributors.home-assistant.io/apps/reference/configuration/)
- [Home Assistant app repositories](https://contributors.home-assistant.io/apps/guides/repository/)

The requested upstream `master` tag is mutable, so future local rebuilds can pick
up upstream changes. Pinning a tested image digest is a future release-hardening
step.
