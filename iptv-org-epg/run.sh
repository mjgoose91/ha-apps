#!/bin/sh
set -eu

cd /epg
export PM2_HOME=/tmp/pm2

# Use the image's Node runtime; no Bashio or additional JSON parser is needed.
node <<'NODE'
const fs = require('node:fs')

try {
  const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
  if (typeof options.run_at_startup !== 'boolean') {
    throw new Error('run_at_startup must be true or false')
  }
  if (typeof options.schedule !== 'string') {
    throw new Error('schedule must be a cron expression or an empty string')
  }
  const schedule = options.schedule.trim()
  // Upstream embeds the expression in a shell command. Accept numeric cron only.
  if (schedule && !/^[\d*,/\-]+(?:[ \t]+[\d*,/\-]+){4}$/.test(schedule)) {
    throw new Error('schedule must have five numeric cron fields (digits, *, comma, /, -), or be empty')
  }
  if (schedule) {
    const { createRequire } = require('node:module')
    const chronosRequire = createRequire(require.resolve('@freearhey/chronos'))
    if (!chronosRequire('node-cron').validate(schedule)) {
      throw new Error('schedule is not a valid cron expression')
    }
  }
  if (!Number.isInteger(options.guide_days) || options.guide_days < 1 || options.guide_days > 14) {
    throw new Error('guide_days must be an integer from 1 to 14')
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 32) {
    throw new Error('concurrency must be an integer from 1 to 32')
  }

  fs.mkdirSync('/data/public', { recursive: true })
  if (options.run_at_startup || schedule) {
    try {
      const channels = '/data/public/channels.xml'
      if (!fs.statSync(channels).isFile() || !fs.readFileSync(channels, 'utf8').trim()) {
        throw new Error('not a nonempty file')
      }
    } catch {
      throw new Error('Grabbing requires a nonempty /data/public/channels.xml. Supply an iptv-org channel list, or disable run_at_startup and clear schedule for serve-only mode.')
    }
  } else {
    console.log('Serve-only mode: no grabs enabled. guide.xml will return 404 until a guide exists.')
  }

  const env = {
    RUN_AT_STARTUP: String(options.run_at_startup),
    CRON_SCHEDULE: schedule,
    DAYS: String(options.guide_days),
    MAX_CONNECTIONS: String(options.concurrency)
  }
  // Always use the channel-file mode of upstream's existing PM2 configuration.
  delete process.env.SITES
  Object.assign(process.env, env)
  const upstream = require('/epg/pm2.config.js')
  const apps = upstream.apps
    .filter(app => schedule || app.name !== 'grab')
    .map(app => ({ ...app, cwd: '/epg', env: { ...env, SITES: '' } }))
  fs.writeFileSync('/data/pm2.config.json', JSON.stringify({ apps }, null, 2))
} catch (error) {
  console.error(`IPTV-org EPG startup failed: ${error.message}`)
  process.exit(1)
}
NODE

exec pm2-runtime /data/pm2.config.json
