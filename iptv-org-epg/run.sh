#!/bin/sh
set -eu

cd /epg
export PM2_HOME=/tmp/pm2

# Use the image's Node runtime; no Bashio or additional JSON parser is needed.
node <<'NODE'
const fs = require('node:fs')

async function main() {
  const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'))
  // Existing installations may not yet have Supervisor's new option default.
  const autoGenerate = options.auto_generate_us_channels ?? false
  if (typeof autoGenerate !== 'boolean') {
    throw new Error('auto_generate_us_channels must be true or false')
  }
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
  const channels = autoGenerate ? '/data/public/us.channels.xml' : '/data/public/channels.xml'
  if (autoGenerate) {
    try {
      await require('/epg/generate-us-channels.cjs').generateUSChannels()
    } catch (error) {
      if (options.run_at_startup || schedule) throw error
      console.error(`US channel generation failed: ${error.message}. No grabs enabled; continuing to serve existing files. Check the coverage report timestamp before using generated mappings.`)
    }
  }
  console.log(`Channel configuration: ${channels}`)
  if (options.run_at_startup || schedule) {
    try {
      if (!fs.statSync(channels).isFile() || !fs.readFileSync(channels, 'utf8').trim()) {
        throw new Error('not a nonempty file')
      }
    } catch {
      throw new Error(`Grabbing requires a nonempty ${channels}. Supply an iptv-org channel list, or disable run_at_startup and clear schedule for serve-only mode.`)
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
    .map(app => {
      if (autoGenerate && app.name !== 'serve') {
        const selector = '--channels=public/channels.xml'
        if (!app.script.includes(selector)) {
          throw new Error('Upstream PM2 channel selector changed; refusing to grab an unintended list')
        }
        app = { ...app, script: app.script.replace(selector, '--channels=public/us.channels.xml') }
      }
      return { ...app, cwd: '/epg', env: { ...env, SITES: '' } }
    })
  fs.writeFileSync('/data/pm2.config.json', JSON.stringify({ apps }, null, 2))
}
main().catch(error => {
  console.error(`IPTV-org EPG startup failed: ${error.message}`)
  process.exit(1)
})
NODE

export NODE_OPTIONS="--max-old-space-size=8192"

exec pm2-runtime /data/pm2.config.json
