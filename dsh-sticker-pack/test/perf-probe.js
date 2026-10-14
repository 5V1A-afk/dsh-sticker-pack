/**
 * dsh-sticker-pack — latency / read-volume probe.
 *
 * Answers "did loading this plugin make replies slower?" with numbers, on the
 * three costs a pick can have:
 *
 *   1. the folder scan + image-header reads `sticker_pick` does internally,
 *   2. the model-visible size of the three tool schemas (printed, not guessed),
 *   3. the front-loaded cost of mounting the plugin (`apply`).
 *
 *   node test/perf-probe.js ["<directory>"]
 */
'use strict'

const fs = require('node:fs')
const { statSync, readdirSync, mkdtempSync } = require('node:fs')
const { extname, join } = require('node:path')
const { tmpdir } = require('node:os')

// Keep the probe's boot.log and settings.json out of the running installation's
// state directory; see the same line in test/selftest.js.
process.env.DSH_STICKER_PACK_HOME = mkdtempSync(join(tmpdir(), 'sticker-pack-probe-'))

const counters = { bytes: 0, calls: 0 }
const realReadSync = fs.readSync
fs.readSync = function (...args) {
  const read = realReadSync.apply(fs, args)
  counters.bytes += typeof read === 'number' ? read : 0
  counters.calls += 1
  return read
}
const realReadFileSync = fs.readFileSync
fs.readFileSync = function (...args) {
  const out = realReadFileSync.apply(fs, args)
  counters.bytes += typeof out === 'string' ? Buffer.byteLength(out) : (out && out.length) || 0
  counters.calls += 1
  return out
}

const { apply } = require('../lib/index.js')
const library = require('../lib/library.js')

const directory = process.argv[2]
// v0.5.0: the plugin reads only remote mirrors, so this probe is pointed straight
// at a folder (the loader still takes one) or at an empty scratch one, because
// the numbers below are about the loader, not about where the stickers came from.
const folders = [{ path: directory === undefined ? mkdtempSync(join(tmpdir(), 'sticker-pack-empty-')) : directory }]
const config = { directories: folders }

const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
const ms = (value) => `${value.toFixed(2)} ms`

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  return sorted[at]
}

function time(calls, body) {
  const samples = []
  for (let index = 0; index < calls; index += 1) {
    const started = process.hrtime.bigint()
    body(index)
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((left, right) => left - right)
  return {
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    max: samples[samples.length - 1],
  }
}

function report(label, stats) {
  console.log(`${label}: mean ${ms(stats.mean)}  median ${ms(stats.median)}  p95 ${ms(stats.p95)}  max ${ms(stats.max)}`)
}

async function main() {
  const tools = new Map()
  const sections = []
  const startMount = process.hrtime.bigint()
  apply({
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    inject(deps, callback) {
      const scope = {}
      if (deps.includes('webServer')) scope.webServer = { register: () => () => {} }
      if (deps.includes('systemPrompt')) scope.systemPrompt = { section: (section) => { sections.push(section); return () => {} } }
      callback(scope)
    },
  }, config)
  console.log(`plugin mount (all three tool definitions built): ${ms(Number(process.hrtime.bigint() - startMount) / 1e6)}`)

  const pack = library.loadLibrary({ directories: folders, fresh: true })
  console.log(`pack: ${pack.stickers.length} stickers from ${pack.directory}`)
  const folderBytes = readdirSync(pack.directory)
    .filter((entry) => library.IMAGE_EXTENSIONS.has(extname(entry).toLowerCase()))
    .reduce((sum, entry) => {
      try {
        return sum + statSync(join(pack.directory, entry)).size
      } catch (err) {
        return sum
      }
    }, 0)
  console.log(`folder holds ${mib(folderBytes)} of images — the volume a per-pick re-read used to pay (v0.2.x)`)
  const headerBudget = pack.stickers.reduce((sum, sticker) => sum + Math.min(sticker.bytes, library.HEADER_BYTES), 0)
  console.log(`header-only budget for the same pack: ${mib(headerBudget)} (${pack.stickers.length} files, capped at ${library.HEADER_BYTES}B each)`)

  const pick = tools.get('sticker_pick')
  const catalog = tools.get('sticker_catalog')
  const contexts = [
    '用户在催我，我要嘴硬回一句',
    '他夸我了，有点不好意思',
    '又要重跑一遍，摆烂',
    '被安排了一堆活',
    '看戏，无语',
  ]

  counters.bytes = 0
  counters.calls = 0
  const warm = time(30, (index) => pick.execute({ context: contexts[index % contexts.length] }))
  const warmBytes = counters.bytes
  report('sticker_pick, caches warm (the normal case)', warm)
  console.log(`  reads: ${warmBytes} bytes in ${counters.calls} calls`)

  counters.bytes = 0
  counters.calls = 0
  const cold = time(10, (index) => {
    library.forgetCaches()
    pick.execute({ context: contexts[index % contexts.length] })
  })
  const coldBytes = counters.bytes
  report('sticker_pick, caches cold (new folder / first call)', cold)
  console.log(`  reads: ${mib(coldBytes)} in ${counters.calls} calls (${mib(coldBytes / 10)} per pick)`)

  counters.bytes = 0
  counters.calls = 0
  report('sticker_catalog, caches warm', time(20, () => catalog.execute()))
  console.log(`  reads: ${counters.bytes} bytes in ${counters.calls} calls`)

  // Breakdown of the hot path, so a slow pick can be attributed instead of guessed at.
  report('  └ loadLibrary alone (scan + size caches warm)', time(30, () => library.loadLibrary(config)))
  report('  └ pickSticker alone (pure string scoring)', time(200, () => library.pickSticker(pack.stickers, { context: '看戏，无语' })))

  // What the model pays for, per request, whether or not it picks anything.
  const schemaBytes = [...tools.values()].reduce((sum, tool) => {
    return sum + Buffer.byteLength(JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }, 0)
  const sectionBytes = sections.reduce((sum, section) => sum + Buffer.byteLength(typeof section.text === 'function' ? section.text() : section.text), 0)
  console.log(`\nmodel-visible cost, paid on every request of every session in this profile:`)
  for (const tool of tools.values()) {
    const own = Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    console.log(`  tool ${tool.name.padEnd(16)} ${String(own).padStart(5)} B  (~${Math.round(own / 4)} tokens)`)
  }
  for (const section of sections) {
    const bytes = Buffer.byteLength(typeof section.text === 'function' ? section.text() : section.text)
    console.log(`  prompt "${section.name}"  ${String(bytes).padStart(5)} B  (~${Math.round(bytes / 4)} tokens)`)
  }
  console.log(`  TOTAL                   ${String(schemaBytes + sectionBytes).padStart(5)} B  (~${Math.round((schemaBytes + sectionBytes) / 4)} tokens)`)
  console.log('  (v0.2.x tool descriptions alone were 2819 B; the trim plus the policy section is a net reduction)')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
