const fs = require('node:fs')
const path = require('node:path')
const { load } = require('cheerio')

const PLAYLIST_URL = 'https://iptv-org.github.io/iptv/countries/us.m3u'
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const escapeXML = value => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
})[char])

function buildUSChannels(playlist, sitesDir) {
  const lines = playlist.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (!lines[0].startsWith('#EXTM3U')) throw new Error('US playlist is not an M3U document')
  const ids = new Map()
  let playlistEntries = 0
  let entriesWithoutId = 0
  for (const line of lines) {
    if (!line.startsWith('#EXTINF:')) continue
    playlistEntries++
    const id = line.match(/\btvg-id="([^"]*)"/)?.[1]?.trim()
    if (!id) {
      entriesWithoutId++
      continue
    }
    if (!ids.has(id)) ids.set(id, line.slice(line.indexOf(',') + 1).trim())
  }
  if (!ids.size) throw new Error('US playlist has no nonempty tvg-id values')

  const candidates = new Map()
  let mappingFiles = 0
  // Scan all countries: the US playlist can include channels originating elsewhere.
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        scan(file)
      } else if (entry.isFile() && entry.name.endsWith('.channels.xml')) {
        mappingFiles++
        const $ = load(fs.readFileSync(file, 'utf8'), { xmlMode: true })
        $('channels > channel').each((_, element) => {
          const node = $(element)
          const root = node.parent()
          const id = node.attr('xmltv_id')
          if (!ids.has(id)) return
          const candidate = {
            xmltv_id: id,
            site: node.attr('site') || root.attr('site') || '',
            site_id: node.attr('site_id') || '',
            lang: node.attr('lang') || root.attr('lang') || '',
            name: node.text().trim(),
            file: path.relative(sitesDir, file).split(path.sep).join('/')
          }
          // Only select sources the installed grabber can load; never fetch scraper code.
          if (!/^[a-z0-9.-]+$/.test(candidate.site) || !candidate.site_id || !candidate.lang || !candidate.name) return
          if (!fs.existsSync(path.join(sitesDir, candidate.site, `${candidate.site}.config.js`))) return
          if (!candidates.has(id)) candidates.set(id, [])
          candidates.get(id).push(candidate)
        })
      }
    }
  }
  scan(sitesDir)

  const mappings = []
  const unmapped = []
  let duplicateCandidatesResolved = 0
  let channelsWithMultipleCandidates = 0
  for (const id of [...ids.keys()].sort(compare)) {
    const choices = candidates.get(id) || []
    // This is a stable tie-break, NOT an upstream source-quality ranking.
    choices.sort((a, b) => Number(b.lang === 'en') - Number(a.lang === 'en') ||
      compare(a.site, b.site) || compare(a.file, b.file) || compare(a.site_id, b.site_id) ||
      compare(a.lang, b.lang) || compare(a.name, b.name))
    if (!choices.length) {
      unmapped.push({ tvg_id: id, playlist_name: ids.get(id) })
      continue
    }
    duplicateCandidatesResolved += choices.length - 1
    if (choices.length > 1) channelsWithMultipleCandidates++
    mappings.push({ ...choices[0], candidate_count: choices.length })
  }
  const stats = {
    playlist_entries: playlistEntries,
    playlist_unique_tvg_ids: ids.size,
    playlist_entries_without_tvg_id: entriesWithoutId,
    channels_with_usable_mappings: mappings.length,
    channels_without_mappings: unmapped.length,
    channels_with_multiple_candidates: channelsWithMultipleCandidates,
    duplicate_candidates_resolved: duplicateCandidatesResolved,
    generated_channels: mappings.length,
    mapping_files_scanned: mappingFiles
  }
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n' + mappings.map(channel =>
    `  <channel site="${escapeXML(channel.site)}" lang="${escapeXML(channel.lang)}" xmltv_id="${escapeXML(channel.xmltv_id)}" site_id="${escapeXML(channel.site_id)}">${escapeXML(channel.name)}</channel>`
  ).join('\n') + '\n</channels>\n'
  return { xml, stats, mappings, unmapped }
}

async function generateUSChannels({ sitesDir = '/epg/sites', outputDir = '/data/public', fetchPlaylist = fetch } = {}) {
  console.log(`Generating US channels from ${PLAYLIST_URL} and installed EPG site mappings`)
  // Fail closed on refresh errors; do not silently use stale or partial coverage.
  const response = await fetchPlaylist(PLAYLIST_URL, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`US playlist download failed: HTTP ${response.status}`)
  const result = buildUSChannels(await response.text(), sitesDir)
  if (!result.mappings.length) throw new Error('No exact US playlist EPG mappings found; previous generated files left untouched')
  const report = {
    generated_at: new Date().toISOString(),
    playlist_url: PLAYLIST_URL,
    selection_policy: 'Exact full tvg-id; English first, then site, mapping file, site_id, language, name in lexical order. No feed fallback.',
    ...result.stats,
    mappings: result.mappings,
    unmapped: result.unmapped
  }
  fs.mkdirSync(outputDir, { recursive: true })
  // Rename on the same filesystem so readers never see a half-written channel file.
  for (const [name, contents] of [
    ['us.channels.report.json', JSON.stringify(report, null, 2) + '\n'],
    ['us.channels.xml', result.xml]
  ]) {
    const target = path.join(outputDir, name)
    fs.writeFileSync(`${target}.tmp`, contents)
    fs.renameSync(`${target}.tmp`, target)
  }
  console.log(`US playlist: ${result.stats.playlist_entries} entries, ${result.stats.playlist_unique_tvg_ids} unique tvg-id values, ${result.stats.playlist_entries_without_tvg_id} entries without an ID`)
  console.log(`US EPG mappings: ${result.stats.channels_with_usable_mappings} usable, ${result.stats.channels_without_mappings} unmapped; ${result.stats.duplicate_candidates_resolved} duplicate candidates resolved across ${result.stats.channels_with_multiple_candidates} IDs`)
  console.log(`Generated ${result.stats.generated_channels} channels in ${path.join(outputDir, 'us.channels.xml')}; full coverage report: ${path.join(outputDir, 'us.channels.report.json')}`)
  return report
}

module.exports = { buildUSChannels, generateUSChannels }

if (require.main === module) {
  generateUSChannels({ sitesDir: process.argv[2], outputDir: process.argv[3] }).catch(error => {
    console.error(`US channel generation failed: ${error.message}`)
    process.exitCode = 1
  })
}
