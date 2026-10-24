const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { test } = require('node:test')
const { load } = require('cheerio')
const { buildUSChannels, generateUSChannels } = require('../generate-us-channels.cjs')

const root = path.resolve(__dirname, '..')
const config = require('js-yaml').load(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'))
const shell = fs.readFileSync(path.join(root, 'run.sh'), 'utf8')
const embedded = shell.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\nNODE/)[1]
const playlist = ids => '#EXTM3U\n' + ids.map(id => `#EXTINF:-1 tvg-id="${id}",Name\nhttps://example.test/stream`).join('\n')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'us-channels-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  function site(name, xml, configExists = true) {
    const dir = path.join(directory, name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.channels.xml`), xml)
    if (configExists) fs.writeFileSync(path.join(dir, `${name}.config.js`), 'module.exports = {}')
  }
  return { directory, site }
}

test('YAML defaults/schema and embedded startup JavaScript are valid', () => {
  const repo = require('js-yaml').load(fs.readFileSync(path.join(root, '..', 'repository.yaml'), 'utf8'))
  assert.ok(repo.name)
  assert.deepEqual(Object.keys(config.options).sort(), Object.keys(config.schema).sort())
  assert.equal(config.options.auto_generate_us_channels, false)
  assert.equal(config.options.run_at_startup, false)
  assert.equal(config.options.schedule, '')
  assert.deepEqual(config.arch, ['aarch64', 'amd64'])
  assert.equal(config.ports['3000/tcp'], 3000)
  new vm.Script(embedded)
  assert.match(shell, /exec pm2-runtime \/data\/pm2.config.json/)
})

test('exact feed IDs, unique IDs, missing IDs, missing scrapers, and XML escaping', t => {
  const { directory, site } = fixture(t)
  site('a.test', '<channels site="a.test" lang="en"><channel site_id="A&amp;B" xmltv_id="Example.us@HD">News &amp; More</channel><channel site_id="bare" xmltv_id="Bare.us@SD">Bare</channel></channels>')
  site('missing.test', '<channels><channel site="missing.test" site_id="1" lang="en" xmltv_id="Missing.us@SD">Missing</channel></channels>', false)
  const result = buildUSChannels(playlist(['Example.us@HD', 'Example.us@HD', 'Example.us@SD', 'Bare.us', 'Missing.us@SD', '']), directory)
  assert.equal(result.stats.playlist_entries, 6)
  assert.equal(result.stats.playlist_unique_tvg_ids, 4)
  assert.equal(result.stats.playlist_entries_without_tvg_id, 1)
  assert.equal(result.stats.generated_channels, 1)
  assert.equal(result.stats.channels_without_mappings, 3)
  assert.equal(result.mappings[0].xmltv_id, 'Example.us@HD')
  const $ = load(result.xml, { xmlMode: true })
  assert.equal($('channel').attr('site_id'), 'A&B')
  assert.equal($('channel').text(), 'News & More')
})

test('one deterministic source per ID: English, then lexical site/file/site_id', t => {
  const { directory, site } = fixture(t)
  site('a.test', '<channels><channel site="a.test" lang="es" site_id="1" xmltv_id="News.us@SD">Spanish</channel></channels>')
  site('z.test', '<channels site="z.test" lang="en"><channel site_id="2" xmltv_id="News.us@SD">Second</channel><channel site_id="1" xmltv_id="News.us@SD">First</channel></channels>')
  const result = buildUSChannels(playlist(['News.us@SD']), directory)
  assert.equal(result.mappings[0].site, 'z.test')
  assert.equal(result.mappings[0].site_id, '1')
  assert.equal(result.stats.duplicate_candidates_resolved, 2)
  assert.equal(result.stats.channels_with_multiple_candidates, 1)
  assert.equal(result.xml, buildUSChannels(playlist(['News.us@SD']), directory).xml)
  site('b.test', '<channels site="b.test" lang="en"><channel site_id="9" xmltv_id="News.us@SD">Preferred</channel></channels>')
  assert.equal(buildUSChannels(playlist(['News.us@SD']), directory).mappings[0].site, 'b.test')
})

test('reject invalid playlists', t => {
  const { directory } = fixture(t)
  assert.throws(() => buildUSChannels('<html>error</html>', directory), /not an M3U/)
  assert.throws(() => buildUSChannels(playlist(['']), directory), /no nonempty tvg-id/)
})

test('persistent generation preserves manual files and previous results on download/empty failures', async t => {
  const { directory, site } = fixture(t)
  site('a.test', '<channels site="a.test" lang="en"><channel site_id="1" xmltv_id="News.us@SD">News</channel></channels>')
  const outputDir = path.join(directory, 'output')
  fs.mkdirSync(outputDir)
  fs.writeFileSync(path.join(outputDir, 'channels.xml'), 'manual')
  const args = { sitesDir: directory, outputDir }
  const ok = text => async () => ({ ok: true, text: async () => text })
  const report = await generateUSChannels({ ...args, fetchPlaylist: ok(playlist(['News.us@SD'])) })
  const generated = fs.readFileSync(path.join(outputDir, 'us.channels.xml'), 'utf8')
  assert.equal(report.generated_channels, 1)
  assert.equal(fs.readFileSync(path.join(outputDir, 'channels.xml'), 'utf8'), 'manual')
  assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir, 'us.channels.report.json'))).mappings[0].xmltv_id, 'News.us@SD')
  await assert.rejects(generateUSChannels({ ...args, fetchPlaylist: async () => ({ ok: false, status: 503 }) }), /HTTP 503/)
  await assert.rejects(generateUSChannels({ ...args, fetchPlaylist: ok(playlist(['Other.us@SD'])) }), /No exact/)
  assert.equal(fs.readFileSync(path.join(outputDir, 'us.channels.xml'), 'utf8'), generated)
})

test('startup integration against actual upstream PM2 config', { skip: !process.env.EPG_ROOT }, async () => {
  const upstream = fs.readFileSync(path.join(process.env.EPG_ROOT, 'pm2.config.js'), 'utf8')
  async function check(overrides, { channels = '<channels/>', generationError, expectedError, expectedApps } = {}) {
    const options = { ...config.options, ...overrides }
    let output, error, exit, generationCalls = 0
    const env = { SITES: 'must-not-be-used' }
    const mockRequire = id => {
      if (id === 'node:fs') return {
        readFileSync: file => file === '/data/options.json' ? JSON.stringify(options) : channels,
        statSync: () => ({ isFile: () => Boolean(channels) }),
        mkdirSync() {},
        writeFileSync: (_, contents) => { output = JSON.parse(contents) }
      }
      if (id === '/epg/generate-us-channels.cjs') return { generateUSChannels: async () => {
        generationCalls++
        if (generationError) throw new Error(generationError)
      } }
      if (id === 'node:module') return { createRequire: () => () => require('node-cron') }
      if (id === '/epg/pm2.config.js') {
        const module = { exports: {} }
        vm.runInNewContext(upstream, { module, process: { env } })
        return module.exports
      }
      throw new Error(`Unexpected require: ${id}`)
    }
    mockRequire.resolve = () => '/epg/node_modules/@freearhey/chronos/index.js'
    await vm.runInNewContext(embedded, {
      require: mockRequire, process: { env, exit: code => { exit = code } },
      console: { log() {}, error: value => { error = value } }
    })
    if (expectedError) {
      assert.equal(exit, 1)
      assert.match(error, expectedError)
      assert.equal(output, undefined)
    } else {
      assert.equal(exit, undefined)
      assert.deepEqual(output.apps.map(app => app.name), expectedApps)
      for (const app of output.apps) {
        assert.equal(app.cwd, '/epg')
        assert.equal(app.env.SITES, '')
        assert.equal(app.env.MAX_CONNECTIONS, String(options.concurrency))
        assert.equal(app.env.DAYS, String(options.guide_days))
        if (app.name !== 'serve') {
          assert.ok(app.script.includes(options.auto_generate_us_channels ? '--channels=public/us.channels.xml' : '--channels=public/channels.xml'))
        }
      }
      assert.equal(generationCalls, options.auto_generate_us_channels ? 1 : 0)
    }
  }
  await check({}, { expectedApps: ['serve'] })
  await check({ auto_generate_us_channels: undefined }, { expectedApps: ['serve'] })
  await check({ auto_generate_us_channels: true }, { expectedApps: ['serve'] })
  await check({ auto_generate_us_channels: true }, { generationError: 'offline', expectedApps: ['serve'] })
  await check({ run_at_startup: true }, { expectedApps: ['serve', 'grab-at-startup'] })
  await check({ auto_generate_us_channels: true, run_at_startup: true }, { expectedApps: ['serve', 'grab-at-startup'] })
  await check({ auto_generate_us_channels: true, schedule: '0 0 * * *', run_at_startup: true }, { expectedApps: ['serve', 'grab', 'grab-at-startup'] })
  await check({ schedule: '0 0 * * *' }, { expectedApps: ['serve', 'grab'] })
  await check({ auto_generate_us_channels: true, run_at_startup: true }, { generationError: 'offline', expectedError: /offline/ })
  await check({ run_at_startup: true }, { channels: '', expectedError: /requires a nonempty/ })
  await check({ auto_generate_us_channels: 'true' }, { expectedError: /must be true or false/ })
  await check({ schedule: '99 0 * * *' }, { expectedError: /not a valid cron/ })
  await check({ schedule: '0 0 * * *; id' }, { expectedError: /five numeric/ })
  await check({ guide_days: 0 }, { expectedError: /guide_days/ })
  await check({ concurrency: 33 }, { expectedError: /concurrency/ })
})

test('live playlist against current upstream mappings and actual grabber XML parser', { skip: !process.env.EPG_LIVE }, async t => {
  assert.ok(process.env.EPG_ROOT, 'EPG_ROOT must point at a current upstream checkout')
  const { directory } = fixture(t)
  const report = await generateUSChannels({ sitesDir: path.join(process.env.EPG_ROOT, 'sites'), outputDir: directory })
  const xml = fs.readFileSync(path.join(directory, 'us.channels.xml'), 'utf8')
  const { EPGGrabber, Program } = await import(pathToFileURL(require.resolve('epg-grabber')).href)
  const parsed = EPGGrabber.parseChannelsXML(xml)
  assert.equal(parsed.length, report.generated_channels)
  assert.equal(new Set(parsed.map(channel => channel.xmltv_id)).size, parsed.length)
  for (const channel of parsed) {
    const mapping = report.mappings.find(row => row.xmltv_id === channel.xmltv_id)
    assert.equal(channel.site, mapping.site)
    assert.equal(channel.site_id, mapping.site_id)
  }
  // Synthetic programme serialization verifies IDs without contacting providers.
  const sampleProgram = Program.fromParserResult({
    title: 'Serialization test only', start: '2026-10-24T00:00:00Z', stop: '2026-10-24T01:00:00Z'
  }, parsed[0])
  const output = load(EPGGrabber.generateXMLTV(parsed, [sampleProgram]), { xmlMode: true })
  assert.equal(output('tv > channel').length, report.generated_channels)
  assert.equal(output('tv > programme').attr('channel'), parsed[0].xmltv_id)
  assert.deepEqual(output('tv > channel').map((_, node) => output(node).attr('id')).get(), parsed.map(channel => channel.xmltv_id))
  console.log(JSON.stringify({ ...report, mappings: report.mappings.slice(0, 8), unmapped: report.unmapped.slice(0, 8) }, null, 2))
})
