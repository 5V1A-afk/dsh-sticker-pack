/**
 * dsh-sticker-pack — offline self-check.
 *
 * Runs the library and the tool bodies without a harness: a fake `ctx` records
 * what a real one would have received, and the tools are executed by hand, so
 * the exact Markdown an assistant reply would get is printed.
 *
 *   node test/selftest.js
 *
 * A few sections work on a throwaway folder under the system temp directory
 * (tiny 1x1 images written on the spot) so the manifest-writing paths can be
 * exercised without touching the real sticker folder.
 */
'use strict'

// Count real file reads: `lib/library.js` destructures `node:fs` at load time,
// so the wrappers have to be in place before it is required.
const fs = require('node:fs')
const { mkdtempSync, writeFileSync, rmSync, mkdirSync: mkdir } = require('node:fs')
const { Writable } = require('node:stream')
const { once, EventEmitter } = require('node:events')
const { join: joinPath } = require('node:path')
const { tmpdir } = require('node:os')

const counters = { readSyncBytes: 0, readSyncCalls: 0, readFileBytes: 0, readFileCalls: 0 }
function resetCounters() {
  counters.readSyncBytes = 0
  counters.readSyncCalls = 0
  counters.readFileBytes = 0
  counters.readFileCalls = 0
}
const realReadSync = fs.readSync
fs.readSync = function (...args) {
  const read = realReadSync.apply(fs, args)
  counters.readSyncBytes += typeof read === 'number' ? read : 0
  counters.readSyncCalls += 1
  return read
}
const realReadFileSync = fs.readFileSync
fs.readFileSync = function (...args) {
  const out = realReadFileSync.apply(fs, args)
  counters.readFileBytes += typeof out === 'string' ? Buffer.byteLength(out) : (out && out.length) || 0
  counters.readFileCalls += 1
  return out
}
const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`

// A self-check that only prints can pass while the thing it claims to test is
// answering from somewhere else — which is exactly what happened when a fifth
// route was registered and the image check below kept destructuring positionally.
// Every expectation that matters goes through `check`, and any FAIL fails the run.
const failures = []
function check(label, ok, detail) {
  if (ok === true) console.log(`  ok   ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
  return ok === true
}

// The plugin writes boot.log, recent.json and settings.json into its state
// directory; point it at a throwaway one before `lib/index.js` is required, so a
// self-check never disturbs the installation that is actually running.
const stateHome = mkdtempSync(joinPath(tmpdir(), 'sticker-pack-state-'))
process.env.DSH_STICKER_PACK_HOME = stateHome

const plugin = require('../lib/index.js')
const { apply } = plugin
const library = require('../lib/library.js')

// The plugin reads nothing but remote mirrors now, so this self-check stands one
// up inside the state directory it already owns: a mirror is an ordinary folder
// plus the `source.json` that stops the next sync from reaching for the network.
// No hand-made sticker folder is involved anywhere below.
const MIRROR_NAME = 'mirror'
const MIRROR_URL = 'https://mirror.invalid/pack.json'
const mirrorRoot = joinPath(stateHome, 'library', 'remotes', MIRROR_NAME)
const config = { remotes: [{ url: MIRROR_URL, name: MIRROR_NAME }] }

const registered = []
const routes = []
const ctx = {
  tools: {
    register(definition) {
      registered.push(definition)
      return function () {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return function () {}
    },
  },
  logger: {
    warn(message) {
      console.log('[warn]', message)
    },
  },
}

apply(ctx, config)
console.log(`registered tools: ${registered.map((tool) => tool.name).join(', ')}`)
console.log(`registered routes: ${routes.map((route) => `${route.kind} ${route.path}`).join(', ')}`)

// The other spelling of a service, and the no-service case: neither may throw.
const viaGet = []
apply({ get: (key) => (key === 'tools' ? { register: (d) => { viaGet.push(d.name); return () => {} } } : undefined) }, config)
console.log(`tools via ctx.get: ${viaGet.join(', ')}`)
let bareThrew
try {
  apply({}, config)
  bareThrew = false
} catch (err) {
  bareThrew = true
}
console.log(`apply({}) threw: ${bareThrew}`)

// The production path: `ctx.inject` defers route registration until the web
// server exists. It is the real boot that needs this — this bundle composes
// before the one providing `webServer`, and cordis mounts rows asynchronously.
const injectedDeps = []
const injectedRoutes = []
const injectedSections = []
let injectedCleanup
apply({
  tools: { register: () => () => {} },
  inject(deps, callback) {
    injectedDeps.push(deps.join(','))
    callback({
      webServer: { register: (route) => { injectedRoutes.push(route); return () => {} } },
      systemPrompt: { section: (section) => { injectedSections.push(section); return () => {} } },
      effect(fn) { injectedCleanup = fn() },
    })
  },
}, config)
console.log(`ctx.inject deps: ${injectedDeps.join(', ')}`)
console.log(`routes via ctx.inject: ${injectedRoutes.map((route) => `${route.kind} ${route.path}`).join(', ')}`)
console.log(`ctx.inject effect cleanup returned: ${typeof injectedCleanup}`)
const sectionText = (section) => (typeof section.text === 'function' ? section.text() : section.text)
for (const section of injectedSections) {
  const text = sectionText(section)
  const bytes = Buffer.byteLength(text)
  console.log(`\nprompt section "${section.name}" order=${section.order} ${bytes}B`
    + ` (~${Math.round(bytes / 4)} tokens per request, text is ${typeof section.text})`)
  console.log(text.split('\n').map((line) => `  | ${line}`).join('\n'))
}
if (injectedSections.length === 0) console.log('\nprompt section: NONE REGISTERED — check registerPromptWhenReady')

// ---------------------------------------------------------------- settings API
// The sticker probability is owned by the plugin's settings page. Walk the whole
// path here — precedence, the HTTP route the page talks to, and the fact that a
// write reaches the prompt wording with no restart.
console.log('\nsettings')
check('default probability is 0.6', plugin.probabilityOf({}) === 0.6, String(plugin.probabilityOf({})))
check('profile config wins over the default', plugin.probabilityOf({ probability: 0.25 }) === 0.25)
check('out-of-range config is clamped', plugin.probabilityOf({ probability: 9 }) === 1)

const settingsRoute = routes.find((route) => route.path === '/sticker-pack/settings')
const pageRoute = routes.find((route) => route.path === '/sticker-pack/settings.html')
let lastStatus = 0
function callRoute(route, method, url) {
  let body = ''
  const res = {
    writeHead(status) { lastStatus = status },
    end(text) { body = String(text === undefined ? '' : text) },
  }
  // Only the GET paths are exercised here, and they answer synchronously inside
  // the handler. The POST branch needs a request stream and is not covered.
  route.handler({ method, url, headers: {}, on() {} }, res)
  return `${lastStatus} ${body}`
}
check('settings route registered', settingsRoute !== undefined)
check('settings page route registered', pageRoute !== undefined)
const read = callRoute(settingsRoute, 'GET', '/sticker-pack/settings')
check('GET /settings reads the snapshot', read.startsWith('200 ') && read.includes('"probability":0.6'), read)
const wrote = callRoute(settingsRoute, 'GET', '/sticker-pack/settings?probability=0.85')
check('GET ?probability=0.85 writes', wrote.startsWith('200 ') && wrote.includes('0.85'), wrote)
const onDisk = JSON.parse(fs.readFileSync(joinPath(stateHome, 'settings.json'), 'utf8'))
check('settings.json persisted 0.85', onDisk.probability === 0.85, JSON.stringify(onDisk))
const percent = /(\d+)%/.exec(sectionText(injectedSections[0]))[1]
check('prompt wording followed with no restart', percent === '85', `${percent}%`)
const rejected = callRoute(settingsRoute, 'GET', '/sticker-pack/settings?probability=abc')
check('GET ?probability=abc rejected', rejected.startsWith('400 '), rejected)
const stillOnDisk = JSON.parse(fs.readFileSync(joinPath(stateHome, 'settings.json'), 'utf8'))
check('settings.json unchanged after the rejection', stillOnDisk.probability === 0.85)
const page = callRoute(pageRoute, 'GET', '/sticker-pack/settings.html')
const onDiskBytes = fs.statSync(joinPath(__dirname, '..', 'lib', 'settings.html')).size
check('settings page served in full',
  page.startsWith('200 ') && page.includes('<title>表情包插件设置')
    && Buffer.byteLength(page.slice(4)) === onDiskBytes,
  `${Buffer.byteLength(page.slice(4))} bytes served, ${onDiskBytes} on disk`)

const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** The loader call every mirror-reading section shares. */
const loadMirror = () => library.loadLibrary({ directories: [{ path: mirrorRoot, tolerateMissing: true }], fresh: true })

// The mirror has to exist before the first load below, not just before the first
// tool call: the top-level sections read the library directly.
standUpMirror()

library.forgetCaches()
resetCounters()
const pack = loadMirror()
const coldRead = { ...counters }
resetCounters()
loadMirror()
const warmRead = { ...counters }
console.log(`\nbytes read by loadLibrary: cold ${mib(coldRead.readSyncBytes + coldRead.readFileBytes)}`
  + ` (${coldRead.readSyncCalls} header reads), warm ${mib(warmRead.readSyncBytes + warmRead.readFileBytes)}`
  + ` (per-pick cost when the scan cache is warm)`)
console.log(`directory: ${pack.directory}`)
console.log(`ok=${pack.ok} missing=[${pack.missing.join(', ')}] stickers=${pack.stickers.length} cached=${pack.cached === true}`)
pack.stickers.forEach((sticker) => {
  console.log(`  ${sticker.id.padEnd(7)} ${String(sticker.bytes).padStart(9)}B ${sticker.width}x${sticker.height} [${sticker.tags.join(' ')}] — ${sticker.label}`)
})

const byName = new Map(registered.map((tool) => [tool.name, tool]))
const run = (tool, args) => byName.get(tool).execute(args)
const text = (tool, args, value) => byName.get(tool).output.render(args, value)[0].text

/** A throwaway素材库 with four images, one manifest entry and one junk file. */
function fixture() {
  const root = mkdtempSync(joinPath(tmpdir(), 'sticker-pack-'))
  const files = [
    '语塞 #yuse [无语 沉默].gif',
    'yuse2 [害羞~脸红].gif',
    'plain.gif',
    'tea2.gif',
    '摆烂 [躺平].gif',
  ]
  for (const file of files) writeFileSync(joinPath(root, file), GIF_1X1)
  writeFileSync(joinPath(root, 'icon.png'), PNG_1X1)
  writeFileSync(joinPath(root, 'notes.txt'), 'not an image\n')
  writeFileSync(joinPath(root, 'pack.json'), `${JSON.stringify({
    version: 1,
    stickers: [
      { id: 'teatwo', file: 'tea2.gif', label: '喝茶二号', tags: ['喝茶', '看戏'], when: '用户在忙别的、我插不上手' },
    ],
  }, null, 2)}\n`)
  return root
}

/**
 * Write the mirror the plugin will actually read: the same images `fixture()`
 * makes, plus the two JSON files `lib/remote.js` leaves behind after a sync.
 * `images.json` says where each image came from, and `source.json` with a fresh
 * `fetchedAt` is what makes the sync answer `cached` instead of dialling out.
 */
function standUpMirror() {
  mkdir(mirrorRoot, { recursive: true })
  const images = ['语塞 #yuse [无语 沉默].gif', 'yuse2 [害羞~脸红].gif', 'plain.gif', 'tea2.gif', '摆烂 [躺平].gif']
  for (const file of images) writeFileSync(joinPath(mirrorRoot, file), GIF_1X1)
  writeFileSync(joinPath(mirrorRoot, 'icon.png'), PNG_1X1)
  writeFileSync(joinPath(mirrorRoot, 'pack.json'), `${JSON.stringify({
    version: 1,
    name: MIRROR_NAME,
    source: MIRROR_URL,
    stickers: [
      { id: 'teatwo', file: 'tea2.gif', label: '喝茶二号', tags: ['喝茶', '看戏'], when: '用户在忙别的、我插不上手' },
    ],
  }, null, 2)}\n`)
  // Keyed by id, the shape `convertManifest` produces. Every file is on disk
  // already, so nothing is pending — the same state a mirror reaches after the
  // first pick has paid for its download.
  writeFileSync(joinPath(mirrorRoot, 'images.json'), `${JSON.stringify({
    teatwo: { url: `${MIRROR_URL.slice(0, -'pack.json'.length)}tea2.gif`, file: 'tea2.gif' },
  }, null, 2)}\n`)
  writeFileSync(joinPath(mirrorRoot, 'source.json'), `${JSON.stringify({
    url: MIRROR_URL,
    name: MIRROR_NAME,
    fetchedAt: Date.now(),
    count: 1,
  }, null, 2)}\n`)
}

async function main() {
  const catalog = await run('sticker_catalog')
  console.log(`\ncatalog ok=${catalog.ok} count=${catalog.count}`)
  console.log('  ' + text('sticker_catalog', {}, catalog).split('\n').slice(0, 4).join('\n  '))

  // ---- the filename convention and pack.json (requirement 2: adding a file is
  //      a file copy, not a code edit) ------------------------------------------
  const root = fixture()
  const temp = library.loadLibrary({ directory: root, fresh: true })
  console.log(`\nfixture ${root}`)
  console.log(`  ok=${temp.ok} stickers=${temp.stickers.length} manifest=${temp.manifest.exists} skipped=${temp.manifest.skipped}`)
  for (const sticker of temp.stickers) {
    console.log(`  ${sticker.id.padEnd(8)} file=${sticker.file.padEnd(26)} [${sticker.tags.join(' ')}]`
      + `${sticker.when === undefined ? '' : ` ｜${sticker.when}`}`)
  }
  const named = library.findSticker(temp.stickers, 'yuse')
  const tagged = library.findSticker(temp.stickers, 'teatwo')
  const tilde = library.findSticker(temp.stickers, 'yuse2')
  console.log(`  #id honoured: ${named !== undefined && named.label === '语塞' && named.tags.join(',') === '无语,沉默'}`)
  console.log(`  '~' splits tags: ${tilde !== undefined && tilde.tags.join(',') === '害羞,脸红'}`)
  console.log(`  pack.json when honoured: ${tagged !== undefined && tagged.when === '用户在忙别的、我插不上手'}`)
  console.log(`  Chinese name gets an auto id: ${temp.stickers.some((sticker) => sticker.id === 'x01' && sticker.label.startsWith('摆烂'))}`)
  console.log(`  non-image ignored: ${temp.stickers.every((sticker) => !sticker.file.endsWith('.txt'))}`)
  console.log(`  pick by context finds the manifest entry: ${library.pickSticker(temp.stickers, { context: '用户在忙别的，我插不上手', random: () => 0 }).sticker.id}`)

  // ---- degraded inputs -----------------------------------------------------
  const brokenRoot = mkdtempSync(joinPath(tmpdir(), 'sticker-broken-'))
  writeFileSync(joinPath(brokenRoot, 'a.gif'), GIF_1X1)
  writeFileSync(joinPath(brokenRoot, 'pack.json'), '{ "stickers": [ { "id": ')
  const broken = library.loadLibrary({ directory: brokenRoot, fresh: true })
  console.log(`\nbroken pack.json: ok=${broken.ok} error=${(broken.missing || []).length === 0 ? String(broken.manifest.error).slice(0, 60) : ''}`)
  console.log(`  stickers still loaded from filename: ${broken.stickers.length}`)
  const strayRoot = mkdtempSync(joinPath(tmpdir(), 'sticker-stray-'))
  writeFileSync(joinPath(strayRoot, 'pack.json'), JSON.stringify({ stickers: [{ id: 'ghost', file: 'gone.gif', tags: ['幽灵'] }] }))
  const stray = library.loadLibrary({ directory: strayRoot, fresh: true })
  console.log(`stray manifest entry: ok=${stray.ok} missing=[${stray.missing.join(', ')}]`)
  console.log(`empty directory: ${JSON.stringify(library.loadLibrary({ directory: 'C:\\definitely\\not\\here' }).error)}`)
  rmSync(root, { recursive: true, force: true })
  rmSync(brokenRoot, { recursive: true, force: true })
  rmSync(strayRoot, { recursive: true, force: true })

  // ---- sticker_pick --------------------------------------------------------
  const queries = [
    {},
    { tag: '无语' },
    { id: 'teatwo' },
    { tag: '害羞' },
    { tag: '生气' },
    { tag: '不存在的标签' },
    { context: '用户在催我，我要嘴硬回一句' },
    { context: '他夸我了，有点不好意思' },
    { context: '又要重跑一遍，摆烂' },
    { tag: '无语', count: 3 },
    { id: 'teatwo', recent: ['teatwo'] },
  ]
  for (const args of queries) {
    const value = await run('sticker_pick', args)
    const alternatives = value.alternatives.map((item) => item.id).join('/')
    console.log(`\npick ${JSON.stringify(args)} -> ${value.id} (${value.matched})${alternatives === '' ? '' : ` 备选: ${alternatives}`}`)
    console.log('  markdown: ' + value.markdown)
  }

  // ---- links and edge cases ------------------------------------------------
  console.log('\nfileLink with a space: ' + library.fileLink('C:\\a b\\c.gif'))
  console.log('httpLink (trailing slash trimmed): ' + library.httpLink('http://127.0.0.1:19387/', 'glare'))
  console.log('avoid-all falls back: ' + library.pickSticker(pack.stickers, { avoid: pack.stickers.map((s) => s.id), random: () => 0 }).sticker.id)
  console.log('unknown id falls back: ' + (await run('sticker_pick', { id: 'nope' })).id)
  console.log('picker stays inside the recent pool: '
    + library.pickSticker(pack.stickers, { recent: ['teatwo', 'yuse'], random: () => 0 }).sticker.id)
  console.log('score explainability: '
    + JSON.stringify(library.termsOf('他夸我了，有点不好意思')))

  // HTTP mode: a second registration against the same fake ctx, with a base URL.
  const httpTools = new Map()
  apply({
    tools: { register: (definition) => { httpTools.set(definition.name, definition); return () => {} } },
    logger: { warn: (message) => console.log('[warn]', message) },
  }, { ...config, httpBaseUrl: 'http://127.0.0.1:19387/' })
  const httpPick = await httpTools.get('sticker_pick').execute({ id: 'teatwo' })
  console.log('\nhttp mode markdown: ' + httpPick.markdown)
  console.log('http mode path still reported: ' + (httpPick.path === library.findSticker(pack.stickers, 'teatwo').path))

  // Route handlers, called by hand: the catalog JSON and one image's headers.
  // The image route pipes into the response, so the fake one is a real Writable.
  // Pick by path, never by position: registration order grows over time and a
  // positional pick silently hands the image check some other route's handler.
  const catalogRoute = routes.find((route) => route.path === '/sticker-pack/cat.json')
  const imageRoute = routes.find((route) => route.kind === 'prefix' && route.path === '/sticker-pack/i')
  if (catalogRoute === undefined || imageRoute === undefined) {
    throw new Error(`route lookup failed: catalog=${catalogRoute !== undefined} image=${imageRoute !== undefined}`)
  }
  class FakeResponse extends Writable {
    constructor() {
      super()
      this.status = undefined
      this.headers = {}
      this.chunks = []
    }

    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    }

    _write(chunk, _encoding, callback) {
      this.chunks.push(chunk)
      callback()
    }

    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk))
      super.end()
      return this
    }

    get text() {
      return Buffer.concat(this.chunks).toString('utf8')
    }
  }
  const call = async (route, request) => {
    const answer = new FakeResponse()
    route.handler(request, answer)
    // The image route pipes asynchronously; wait for the response to finish so
    // the byte count below actually proves the file streamed.
    await once(answer, 'finish')
    return answer
  }

  const catalogAnswer = await call(catalogRoute, { url: '/sticker-pack/cat.json', method: 'GET' })
  const catalogBody = JSON.parse(catalogAnswer.text)
  check('catalog route is JSON with the pack', catalogAnswer.status === 200 && catalogBody.stickers.length === 6,
    `stickers=${catalogBody.stickers.length} first=${catalogBody.stickers[0].id}`)
  const head = await call(imageRoute, { url: `/sticker-pack/i/${encodeURIComponent('teatwo')}`, method: 'GET', headers: {} })
  const bodyBytes = head.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  check('image route streams the file, not JSON',
    head.status === 200 && /^image\//.test(String(head.headers['content-type'])) && bodyBytes > 0
      && bodyBytes === Number(head.headers['content-length']),
    `${head.status} ${head.headers['content-type']} ${head.headers['content-length']}B`
      + ` etag=${head.headers.etag} cache=${head.headers['cache-control']} bytes=${bodyBytes}`)
  const unknown = await call(imageRoute, { url: '/sticker-pack/i/nope', method: 'GET', headers: {} })
  check('image route unknown id is 404', unknown.status === 404, String(unknown.status))
  const revalidated = await call(imageRoute, {
    url: `/sticker-pack/i/${encodeURIComponent('teatwo')}`,
    method: 'GET',
    headers: { 'if-none-match': head.headers.etag },
  })
  check('image route revalidation is 304 with no body', revalidated.status === 304 && revalidated.chunks.length === 0,
    `${revalidated.status} sent ${revalidated.chunks.length} body chunks`)
  const headOnly = await call(imageRoute, { url: '/sticker-pack/i/teatwo', method: 'HEAD', headers: {} })
  check('image route HEAD is 200 with no body', headOnly.status === 200 && headOnly.chunks.length === 0,
    `${headOnly.status} sent ${headOnly.chunks.length} body chunks`)

  // ---- the POST half of the settings API ------------------------------------
  // It needs a request stream, so it gets a real (if tiny) one: an EventEmitter
  // emitting `data` then `end` on the next tick — the contract the handler codes
  // against. `destroy` is the 413 path's cleanup call.
  const postRoute = (route, payload) => new Promise((resolve) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = {}
    req.url = '/sticker-pack/settings'
    req.destroy = () => {}
    const res = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(text) {
        this.body = String(text === undefined ? '' : text)
        resolve(this)
      },
    }
    route.handler(req, res)
    process.nextTick(() => {
      if (payload !== undefined) req.emit('data', Buffer.from(payload))
      req.emit('end')
    })
  })
  const posted = await postRoute(settingsRoute, JSON.stringify({ probability: 0.3 }))
  check('POST /settings writes', posted.status === 200 && posted.body.includes('0.3'), `${posted.status} ${posted.body}`)
  const postPercent = /(\d+)%/.exec(sectionText(injectedSections[0]))[1]
  check('prompt wording followed the POST too', postPercent === '30', `${postPercent}%`)
  const badJson = await postRoute(settingsRoute, '{not json')
  check('POST with invalid JSON is 400', badJson.status === 400 && badJson.body.includes('not valid JSON'),
    `${badJson.status} ${badJson.body}`)
  const tooBig = await postRoute(settingsRoute, `{"probability":${'0'.repeat(17 * 1024)}}`)
  check('POST over 16 KiB is 413', tooBig.status === 413 && tooBig.body.includes('body too large'),
    `${tooBig.status} ${tooBig.body}`)
  const afterBig = JSON.parse(fs.readFileSync(joinPath(stateHome, 'settings.json'), 'utf8'))
  check('oversized body never reached the file', afterBig.probability === 0.3, JSON.stringify(afterBig))

  // ---- the host's coin, not the model's -------------------------------------
  // The point of the host-side decision: the section states the outcome instead
  // of asking the model to roll, and one user message is exactly one coin.
  const contextOf = (agent, signal) => ({ agent, scope: agent, signal })
  const flipAgent = { id: 'flip' }
  const flipSignal = { turn: 1 }
  plugin.forgetTurn('flip')
  const pinned = plugin.rollTurn(contextOf(flipAgent, flipSignal), 1)
  const stillPinned = plugin.rollTurn(contextOf(flipAgent, flipSignal), 0)
  check('a pinned turn ignores a later probability', pinned === true && stillPinned === true, `${pinned},${stillPinned}`)
  plugin.forgetTurn('flip')
  const relearned = plugin.rollTurn(contextOf(flipAgent, flipSignal), 0)
  check('forgetTurn (the turn/start edge) forces a new roll', relearned === false, String(relearned))

  let heads = 0
  for (let i = 0; i < 400; i += 1) {
    const agent = { id: `flip-${i}` }
    if (plugin.rollTurn(contextOf(agent, { i }), 0.5) === true) heads += 1
  }
  check('the coin is the host\'s, and it is fair', heads > 140 && heads < 260, `${heads}/400`)

  plugin.forgetTurn('flip')
  plugin.rollTurn(contextOf(flipAgent, flipSignal), 1)
  check('the tool sees the very decision the prompt was built from',
    plugin.turnDecision({ id: 'flip' }, 0) === true, String(plugin.turnDecision({ id: 'flip' }, 0)))
  check('a subagent never gets a sticker',
    plugin.turnDecision({ id: 'child', options: { parentAgent: { id: 'p' } } }, 1) === false, '')
  check('an agent nobody rolled for has no verdict, not a "no"',
    plugin.turnDecision(undefined, 1) === undefined, String(plugin.turnDecision(undefined, 1)))

  check('a subagent is not a reply',
    plugin.isSubagent({ scope: { id: 'child', options: { parentAgent: { id: 'parent' } } } }) === true
      && plugin.isSubagent({ scope: { id: 'root', options: {} } }) === false, '')

  const attachText = plugin.promptText(0.5, true)
  const skipText = plugin.promptText(0.5, false)
  check('the "attach one" wording is an order, with no percentage left in it',
    attachText.includes('本轮要贴') && !attachText.includes('%'), attachText.split('\n')[0])
  check('the "skip" wording is one line and forbids the call',
    skipText.split('\n').length === 1 && skipText.includes('不要调用 sticker_pick'), skipText)
  check('assembly outside a turn still states a probability',
    plugin.promptText(0.8, undefined).includes('80%'), '')

  // End to end through the section, at both fixed ends of the slider.
  const sectionsAt = (probability) => {
    plugin.applySettingsPatch(config, { probability })
    const collected = []
    apply({
      tools: { register: () => () => {} },
      inject(deps, callback) {
        callback({
          webServer: { register: () => () => {} },
          systemPrompt: { section: (value) => { collected.push(value); return () => {} } },
          effect() {},
        })
      },
    }, config)
    return sectionText(collected[0])
  }
  const alwaysText = sectionsAt(1)
  check('probability 1 is a constant order',
    alwaysText.includes('本轮要贴') && !alwaysText.includes('%'), alwaysText.split('\n')[0])
  const neverText = sectionsAt(0)
  check('probability 0 is a constant refusal',
    neverText.includes('本轮不贴') && neverText.split('\n').length === 1, neverText)
  plugin.applySettingsPatch(config, { probability: 0.3 })

  // ---- the library is more than one folder ----------------------------------
  const remoteLib = require('../lib/remote.js')
  const parsedRemotes = remoteLib.parseRemotes([
    'https://example.com/packs/a/pack.json',
    { url: 'https://example.com/packs/b/manifest.json', name: '朋友的表情包' },
    'ftp://example.com/nope.json',
    'https://example.com/packs/a/pack.json',
  ])
  check('remote sources parse, name themselves and de-duplicate',
    parsedRemotes.length === 2 && parsedRemotes[0].name === 'a' && parsedRemotes[1].name === '朋友的表情包',
    JSON.stringify(parsedRemotes))

  const converted = remoteLib.convertManifest({
    name: '测试源',
    stickers: [
      { id: 'ok', file: 'images/ok.jpg', label: '正常' },
      { id: '../../evil', file: 'x.jpg' },
      { id: 'bad', file: 'x.exe' },
      { id: 'dup', file: 'd.png' },
      { id: 'dup', file: 'e.png' },
      { id: 'cdn', url: 'https://cdn.example.com/a.webp' },
    ],
  }, 'https://example.com/x/pack.json', '兜底名')
  check('a manifest is untrusted input, and gets sanitised',
    converted.manifest.stickers.map((sticker) => sticker.id).join(',') === 'ok,dup,cdn',
    converted.manifest.stickers.map((sticker) => sticker.id).join(',') || '(none)')
  check('a repeated id is dropped, not duplicated',
    converted.skipped.some((line) => line.includes('id 重复')), converted.skipped.join(' | '))
  check('a non-image file is refused, not fetched',
    converted.skipped.some((line) => line.includes('bad')), converted.skipped.join(' | '))
  check('a path-traversal id is refused, not resolved',
    converted.skipped.some((line) => line.includes('evil')), converted.skipped.join(' | '))
  check('the local filename comes from the id, never from the manifest',
    converted.images.ok.file === 'ok.jpg' && converted.images.ok.url === 'https://example.com/x/images/ok.jpg',
    JSON.stringify(converted.images.ok))

  // Two folders, one library: ids are made unique instead of shadowed, and a
  // mirror entry nobody has downloaded is pending rather than missing.
  const localFolder = mkdtempSync(joinPath(tmpdir(), 'sticker-pack-local-'))
  const mirrorFolder = mkdtempSync(joinPath(tmpdir(), 'sticker-pack-mirror-'))
  const writeManifest = (folder, stickers) => writeFileSync(joinPath(folder, 'pack.json'),
    JSON.stringify({ version: 1, stickers }, null, 2))
  writeFileSync(joinPath(localFolder, 'shared.png'), PNG_1X1)
  writeManifest(localFolder, [{ id: 'shared', file: 'shared.png', label: '本地同名' }])
  writeFileSync(joinPath(mirrorFolder, 'shared.png'), PNG_1X1)
  writeManifest(mirrorFolder, [
    { id: 'shared', file: 'shared.png', label: '远端同名' },
    { id: 'later', file: 'not-downloaded.png', label: '还没下载' },
  ])
  const merged = library.loadLibrary({
    directories: [{ path: localFolder }, { path: mirrorFolder, tolerateMissing: true }],
    fresh: true,
  })
  const mergedIds = merged.stickers.map((sticker) => sticker.id)
  check('ids from two folders stay unique',
    new Set(mergedIds.map((id) => id.toLowerCase())).size === mergedIds.length && mergedIds.includes('shared'),
    mergedIds.join(','))
  check('the de-duplicated id still carries the author\'s name',
    mergedIds.some((id) => id !== 'shared' && id.endsWith('-shared')), mergedIds.join(','))
  const pendingSticker = merged.stickers.find((sticker) => sticker.file === 'not-downloaded.png')
  check('an un-downloaded mirror entry is pending, not missing',
    pendingSticker !== undefined && pendingSticker.pending === true && merged.missing.length === 0,
    `${pendingSticker === undefined ? 'none' : pendingSticker.id} missing=${merged.missing.length}`)

  // ---- a real fetch, against a throwaway server -----------------------------
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    if (req.url === '/pack.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: '网络源', stickers: [{ id: 'net', file: 'net.png', label: '远端图' }] }))
      return
    }
    if (req.url === '/net.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG_1X1)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const cacheFolder = mkdtempSync(joinPath(tmpdir(), 'sticker-pack-cache-'))
  const netSources = remoteLib.parseRemotes([`http://127.0.0.1:${port}/pack.json`])
  const synced = await remoteLib.syncRemotes(netSources, { cacheDirectory: cacheFolder, ttlMs: 0 })
  check('a remote manifest is mirrored', synced[0].status === 'ok' && synced[0].count === 1, JSON.stringify(synced[0]))
  const mirrorDir = synced[0].directory
  check('the mirror is a folder the loader already understands',
    fs.existsSync(joinPath(mirrorDir, 'pack.json')) && fs.existsSync(joinPath(mirrorDir, 'images.json')), mirrorDir)
  const mirroredBefore = library.loadLibrary({ directories: [{ path: mirrorDir, tolerateMissing: true }], fresh: true })
  check('a mirrored sticker starts pending',
    mirroredBefore.stickers.length === 1 && mirroredBefore.stickers[0].pending === true,
    `${mirroredBefore.stickers.length} sticker(s)`)
  const ensured = await remoteLib.ensureFile({
    directory: mirrorDir,
    file: 'net.png',
    url: `http://127.0.0.1:${port}/net.png`,
  })
  const mirroredAfter = library.loadLibrary({ directories: [{ path: mirrorDir, tolerateMissing: true }], fresh: true })
  check('the image downloads on first use, and stops being pending',
    ensured !== undefined && mirroredAfter.stickers[0].pending === undefined && mirroredAfter.stickers[0].bytes === PNG_1X1.length,
    `${String(ensured)} ${mirroredAfter.stickers[0].bytes}B`)
  const cachedSync = await remoteLib.syncRemotes(netSources, { cacheDirectory: cacheFolder, ttlMs: 60000 })
  check('a second sync inside the TTL reuses the mirror', cachedSync[0].status === 'cached', cachedSync[0].status)
  const goneSource = await remoteLib.syncRemotes(
    remoteLib.parseRemotes([`http://127.0.0.1:${port}/gone.json`]), { cacheDirectory: cacheFolder })
  check('an unreachable source reports an error instead of throwing',
    goneSource[0].status === 'error' && typeof goneSource[0].error === 'string', JSON.stringify(goneSource[0]))
  await new Promise((resolve) => server.close(resolve))
  const staleSync = await remoteLib.syncRemotes(netSources, { cacheDirectory: cacheFolder, ttlMs: 0, fresh: true })
  check('a source that goes away keeps its last mirror',
    staleSync[0].status === 'stale' && staleSync[0].count === 1,
    JSON.stringify({ status: staleSync[0].status, error: staleSync[0].error }))

  // ---- the client half ------------------------------------------------------
  // It is a script, not a module: it calls `window.__ModuleLoader__.load(...)` at
  // load time and hands back CJS exports. Run it in a fresh VM context with a
  // stub `react` and drive the registration it made — the same three things the
  // host checks (id equals the package name, `inject` names `slots`, the slot
  // spec is well formed).
  const vm = require('node:vm')
  const pkg = JSON.parse(fs.readFileSync(joinPath(__dirname, '..', 'package.json'), 'utf8'))
  const loads = []
  vm.runInNewContext(fs.readFileSync(joinPath(__dirname, '..', 'client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: (registration) => { loads.push(registration) } } },
  })
  check('client bundle registers itself once', loads.length === 1, `${loads.length} load() call(s)`)
  const registration = loads[0]
  check('client id equals the package name', registration.id === pkg.name, String(registration.id))
  check('package declares the web client half',
    pkg.dsh.client.platform === 'web' && pkg.exports['./client'] === './client.js',
    JSON.stringify(pkg.dsh.client))
  const reactStub = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  }
  const required = []
  const clientExports = registration.factory((spec) => {
    required.push(spec)
    if (spec === 'react') return reactStub
    throw new Error(`client bundle requires "${spec}", which is not a platform seed word`)
  })
  check('client half exports apply + inject',
    typeof clientExports.apply === 'function' && Array.isArray(clientExports.inject))
  check('client half declares the slots service', clientExports.inject.includes('slots'),
    clientExports.inject.join(',') || '(none)')
  check('client half requires react only', required.join(',') === 'react', required.join(',') || '(none)')
  const slots = []
  let panel
  clientExports.apply({
    effect: (fn) => fn(),
    slots: {
      inject: (name, contributor) => { slots.push({ name }); return contributor() },
      register: (spec, Component) => { slots.push({ spec }); panel = Component; return () => {} },
    },
  })
  const slotName = slots.find((entry) => entry.name !== undefined)
  const spec = slots.find((entry) => entry.spec !== undefined)
  check('client half contributes settings.section', slotName !== undefined && slotName.name === 'settings.section',
    String(slotName === undefined ? 'nothing' : slotName.name))
  check('section spec is well formed',
    spec !== undefined && spec.spec.id === 'sticker-pack' && typeof spec.spec.order === 'number'
      && typeof spec.spec.label === 'function',
    spec === undefined ? 'no spec' : `id=${spec.spec.id} order=${spec.spec.order} label=${spec.spec.label()}`)
  const tree = panel({})
  check('panel renders under a stub react', tree !== undefined && tree !== null && tree.type === 'div',
    tree === undefined || tree === null ? 'nothing rendered' : String(tree.type))
  check('panel starts on the default 60%', JSON.stringify(tree).includes('"value":"60"'), '')

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED: ${failures.join('; ')}`)
    process.exitCode = 1
    return
  }
  console.log('\nall assertions passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
