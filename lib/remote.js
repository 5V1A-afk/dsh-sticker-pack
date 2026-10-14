'use strict'

/**
 * Remote sticker sources — the "database" half of the library.
 *
 * A source is a JSON manifest somewhere on the network: a GitHub raw URL, a
 * gist, a static page on any host. The plugin mirrors each manifest into its own
 * state folder (`~/.dsh/sticker-pack/library/remotes/<name>/`) and then treats
 * that folder exactly like a hand-made 素材库 folder — `pack.json` is written
 * from the manifest, images land beside it. Nothing downstream has to know a
 * sticker came from the network, so picking, the catalog and the image route
 * all keep working unchanged.
 *
 * Two rules shape this file:
 *
 *   - **The network is optional.** A stale mirror beats an empty library, so a
 *     failed refresh keeps the last good copy and only reports the error. If
 *     nothing was ever fetched, the source simply contributes no stickers.
 *   - **A manifest is untrusted input.** Ids are validated against the same
 *     pattern the local manifest uses, extensions against the image whitelist,
 *     and the local filename is *derived from the validated id*, never taken
 *     from the manifest — so a hostile manifest cannot name a path outside its
 *     own folder (`../../.ssh/authorized_keys` is simply an invalid id).
 *
 * The manifest format mirrors the local `pack.json`, which is the point: the
 * same file can be dropped in a folder or served over HTTP.
 *
 * ```json
 * {
 *   "version": 1,
 *   "name": "大肥鱼表情包",
 *   "stickers": [
 *     { "id": "fish", "label": "笑眯眯抱着大肥鱼", "tags": ["开心"], "when": "得意时", "file": "images/fish.jpg" },
 *     { "id": "tea",  "label": "喝茶", "url": "https://example.com/tea.jpg" }
 *   ]
 * }
 * ```
 *
 * `file` is resolved relative to the manifest's own URL, `url` is used as-is;
 * both must point at an image with a whitelisted extension.
 */

const { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')

const library = require('./library')

/** How long a mirrored manifest is trusted before it is fetched again. */
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 15000

/** The remote is untrusted, so both directions are bounded. */
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_SOURCES = 16
const MAX_STICKERS_PER_SOURCE = 2000

const MANIFEST_FILE = 'pack.json'
const SOURCE_FILE = 'source.json'
const IMAGES_FILE = 'images.json'

const ID_PATTERN = /^[A-Za-z0-9_$.-]{1,32}$/

/** In-flight fetches, so ten calls in a second still cost one request. */
const INFLIGHT = new Map()

function trimUrl(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch (err) {
    return false
  }
}

/** A folder-safe, ASCII-ish name for one source. */
function slugOf(value) {
  const ascii = String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
  return ascii === '' ? '' : ascii
}

function hashOf(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

/**
 * Accept the several shapes a user might write in `config.remotes`:
 * a bare URL string, `{ url, name }`, or `{ name, manifest }`.
 *
 * @returns {Array<{url: string, name: string}>} valid, de-duplicated sources
 */
function parseRemotes(raw) {
  const list = Array.isArray(raw) ? raw : (raw === undefined || raw === null || raw === '' ? [] : [raw])
  const seen = new Set()
  const sources = []
  for (const item of list) {
    if (sources.length >= MAX_SOURCES) break
    let url = ''
    let name = ''
    if (typeof item === 'string') {
      url = trimUrl(item)
    } else if (item !== null && typeof item === 'object') {
      url = trimUrl(item.url || item.manifest || item.src)
      name = trimUrl(item.name)
    }
    if (!isHttpUrl(url) || seen.has(url)) continue
    seen.add(url)
    sources.push({ url, name: name === '' ? deriveName(url) : name })
  }
  return sources
}

/** `https://raw.githubusercontent.com/me/pack/main/pack.json` → `pack`. */
function deriveName(url) {
  try {
    const parsed = new URL(url)
    const parts = parsed.pathname.split('/').filter((piece) => piece !== '')
    const last = parts.length > 0 ? parts[parts.length - 1] : ''
    const withoutFile = last.replace(/\.[A-Za-z0-9]+$/u, '')
    if (withoutFile !== '' && withoutFile !== 'pack' && withoutFile !== 'index') return withoutFile
    const parent = parts.length > 1 ? parts[parts.length - 2] : parsed.hostname
    return parent === '' ? parsed.hostname : parent
  } catch (err) {
    return 'remote'
  }
}

/** Where one source is mirrored. Stable per name, so a rename starts fresh. */
function directoryOf(cacheDirectory, source) {
  const slug = slugOf(source.name) || `remote-${hashOf(source.url)}`
  return join(cacheDirectory, 'remotes', slug)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    renameSync(temporary, file)
  } catch (err) {
    try {
      unlinkSync(temporary)
    } catch (ignored) {
      // best effort
    }
    throw err
  }
}

function writeIfChanged(file, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  try {
    if (readFileSync(file, 'utf8') === text) return false
  } catch (err) {
    // missing or unreadable: write it
  }
  writeJsonAtomic(file, value)
  return true
}

/**
 * One attempt. `retryable` tells {@link fetchBounded} whether another try could
 * plausibly succeed — a reset connection could, a certificate failure could not.
 *
 * @returns {{buffer: Buffer}|{error: string, retryable: boolean}}
 */
async function fetchOnce(url, limit, timeoutMs) {
  if (typeof fetch !== 'function') return { error: 'Node 运行时不支持 fetch（需要 Node 18 或更新）', retryable: false }
  const controller = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller,
      headers: { 'user-agent': 'dsh-sticker-pack', accept: 'application/json,image/*' },
    })
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, retryable: response.status >= 500 || response.status === 429 }
    }
    const declared = Number(response.headers.get('content-length') || '0')
    if (Number.isFinite(declared) && declared > limit) {
      return { error: `体积 ${Math.round(declared / 1024)} KB 超过上限 ${Math.round(limit / 1024)} KB`, retryable: false }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > limit) {
      return { error: `体积 ${Math.round(buffer.length / 1024)} KB 超过上限 ${Math.round(limit / 1024)} KB`, retryable: false }
    }
    return { buffer }
  } catch (err) {
    const message = (err && err.name === 'TimeoutError') ? `超时（${timeoutMs} ms）` : ((err && err.message) || String(err))
    const cause = err && err.cause && err.cause.code ? String(err.cause.code) : ''
    const text = cause === '' ? message : `${message}（${cause}）`
    return { error: text, retryable: worthRetrying(cause === '' ? message : cause) }
  }
}

/**
 * This machine resets roughly a third of its jsDelivr requests (`ECONNRESET`),
 * so a single-shot fetch loses images that the second try would have delivered.
 * Certificate failures are deterministic — retrying only wastes time.
 */
const DEFAULT_ATTEMPTS = 3
const RETRY_DELAYS_MS = [300, 900]

function worthRetrying(text) {
  if (/UNABLE_TO_VERIFY|CERT_|DEPTH_ZERO|ERR_TLS/i.test(text)) return false
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|超时/i.test(text)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** @returns {{buffer: Buffer}|{error: string}} */
async function fetchBounded(url, limit, timeoutMs) {
  let last = { error: '未发起请求' }
  for (let attempt = 0; attempt < DEFAULT_ATTEMPTS; attempt += 1) {
    const result = await fetchOnce(url, limit, timeoutMs)
    if (result.buffer !== undefined) return result
    last = result
    if (result.retryable !== true) return result
    if (attempt < DEFAULT_ATTEMPTS - 1) {
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)])
    }
  }
  return last
}

/**
 * Turn an untrusted manifest into what the local loader already understands.
 *
 * @returns {{manifest: object, images: object, skipped: string[]}}
 */
function convertManifest(raw, manifestUrl, fallbackName) {
  const object = raw !== null && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(object.stickers) ? object.stickers : (Array.isArray(object) ? object : [])
  const name = typeof object.name === 'string' && object.name.trim() !== '' ? object.name.trim() : fallbackName
  const stickers = []
  const images = {}
  const skipped = []
  const used = new Set()

  for (const item of list.slice(0, MAX_STICKERS_PER_SOURCE)) {
    if (item === null || typeof item !== 'object') {
      skipped.push('非对象条目')
      continue
    }
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!ID_PATTERN.test(id)) {
      skipped.push(`id 不合法：${id === '' ? '(空)' : id}`)
      continue
    }
    if (used.has(id.toLowerCase())) {
      skipped.push(`id 重复：${id}`)
      continue
    }
    const relative = trimUrl(item.file || item.path || item.src)
    const absolute = trimUrl(item.url)
    let resolved = ''
    if (absolute !== '') resolved = absolute
    else if (relative !== '') {
      try {
        resolved = new URL(relative, manifestUrl).toString()
      } catch (err) {
        resolved = ''
      }
    }
    if (!isHttpUrl(resolved)) {
      skipped.push(`${id}：缺少可用的图片地址`)
      continue
    }
    const extension = extensionOf(resolved)
    if (extension === undefined) {
      skipped.push(`${id}：不是支持的图片格式（${resolved}）`)
      continue
    }
    used.add(id.toLowerCase())
    const file = `${id}${extension}`
    const sticker = { id, file, label: typeof item.label === 'string' && item.label !== '' ? item.label : id }
    if (Array.isArray(item.tags)) sticker.tags = item.tags.map((tag) => String(tag)).filter((tag) => tag !== '')
    if (typeof item.when === 'string' && item.when !== '') sticker.when = item.when
    stickers.push(sticker)
    images[id] = { url: resolved, file }
  }

  return {
    manifest: {
      version: 1,
      name,
      source: manifestUrl,
      stickers,
    },
    images,
    skipped,
  }
}

/** Whitelisted extension of a URL path, or undefined. */
function extensionOf(url) {
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch (err) {
    return undefined
  }
  const match = /\.([A-Za-z0-9]+)$/u.exec(pathname)
  if (match === null) return undefined
  const extension = `.${match[1].toLowerCase()}`
  return library.IMAGE_EXTENSIONS.has(extension) ? extension : undefined
}

/**
 * Mirror every source, reusing the on-disk copy inside the TTL.
 *
 * Never throws: each source reports its own `status` (`ok`, `cached`, `stale`,
 * `error`) and the caller decides how loudly to say so.
 *
 * @param {Array<{url: string, name: string}>} sources
 * @param {{cacheDirectory: string, ttlMs?: number, timeoutMs?: number, fresh?: boolean}} options
 */
async function syncRemotes(sources, options) {
  const settings = options || {}
  const cacheDirectory = settings.cacheDirectory
  const ttlMs = typeof settings.ttlMs === 'number' && settings.ttlMs >= 0 ? settings.ttlMs : DEFAULT_TTL_MS
  const timeoutMs = typeof settings.timeoutMs === 'number' && settings.timeoutMs > 0 ? settings.timeoutMs : DEFAULT_TIMEOUT_MS
  const now = Date.now()
  const results = []
  if (typeof cacheDirectory !== 'string' || cacheDirectory === '') return results
  for (const source of sources || []) {
    results.push(await syncOne(source, { cacheDirectory, ttlMs, timeoutMs, fresh: settings.fresh === true, now }))
  }
  return results
}

async function syncOne(source, options) {
  const directory = directoryOf(options.cacheDirectory, source)
  const sourceFile = join(directory, SOURCE_FILE)
  const manifestFile = join(directory, MANIFEST_FILE)
  const imagesFile = join(directory, IMAGES_FILE)
  const recorded = readJson(sourceFile)
  const sameSource = recorded !== undefined && recorded.url === source.url
  const fresh = sameSource && typeof recorded.fetchedAt === 'number' && (options.now - recorded.fetchedAt) < options.ttlMs
  const mirrored = sameSource && existsSync(manifestFile) && existsSync(imagesFile)

  const base = {
    name: source.name,
    url: source.url,
    directory,
    count: sameSource && typeof recorded.count === 'number' ? recorded.count : 0,
    fetchedAt: sameSource && typeof recorded.fetchedAt === 'number' ? recorded.fetchedAt : undefined,
  }

  if (mirrored && fresh && options.fresh !== true) {
    return { ...base, status: 'cached', count: countOf(manifestFile), skipped: [] }
  }

  const fetched = await once(source.url, () => fetchBounded(source.url, MAX_MANIFEST_BYTES, options.timeoutMs))
  if (fetched.error !== undefined) {
    // A stale mirror is still a usable library; say what broke and move on.
    if (mirrored) return { ...base, status: 'stale', count: countOf(manifestFile), error: fetched.error, skipped: [] }
    return { ...base, status: 'error', count: 0, error: fetched.error, skipped: [] }
  }

  let parsed
  try {
    parsed = JSON.parse(fetched.buffer.toString('utf8'))
  } catch (err) {
    const message = `manifest 不是合法 JSON：${(err && err.message) || String(err)}`
    if (mirrored) return { ...base, status: 'stale', count: countOf(manifestFile), error: message, skipped: [] }
    return { ...base, status: 'error', count: 0, error: message, skipped: [] }
  }

  const converted = convertManifest(parsed, source.url, source.name)
  try {
    mkdirSync(directory, { recursive: true })
    // Order matters: the manifest is what the loader reads, so it is written
    // last. A crash in between leaves the previous mirror in place.
    writeIfChanged(imagesFile, converted.images)
    writeJsonAtomic(sourceFile, {
      url: source.url,
      name: converted.manifest.name,
      fetchedAt: options.now,
      count: converted.manifest.stickers.length,
      bytes: fetched.buffer.length,
      skipped: converted.skipped,
    })
    writeIfChanged(manifestFile, converted.manifest)
  } catch (err) {
    return { ...base, status: 'error', count: 0, error: `写入镜像失败：${(err && err.message) || String(err)}`, skipped: [] }
  }

  return {
    ...base,
    name: converted.manifest.name,
    status: 'ok',
    count: converted.manifest.stickers.length,
    fetchedAt: options.now,
    bytes: fetched.buffer.length,
    skipped: converted.skipped,
  }
}

/** Coalesce concurrent fetches of the same URL into one request. */
function once(url, run) {
  const running = INFLIGHT.get(url)
  if (running !== undefined) return running
  const promise = run().finally(() => {
    INFLIGHT.delete(url)
  })
  INFLIGHT.set(url, promise)
  return promise
}

function countOf(manifestFile) {
  const parsed = readJson(manifestFile)
  return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.stickers) ? parsed.stickers.length : 0
}

/** `{ id: { url, file } }` for one mirror; `{}` when there is none. */
function readImages(directory) {
  const parsed = readJson(join(directory, IMAGES_FILE))
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * Download one sticker into its mirror, if it is not there yet.
 *
 * Returns the local path on success, `undefined` when the sticker has no known
 * remote (a local folder) or the download failed — the caller hands back another
 * candidate rather than a path that does not exist.
 */
async function ensureFile(args) {
  const settings = args || {}
  const directory = settings.directory
  const file = settings.file
  const url = settings.url
  if (typeof directory !== 'string' || typeof file !== 'string') return undefined
  const target = join(directory, file)
  if (url === undefined || url === null || url === '') return existsSync(target) ? target : undefined
  if (existsSync(target)) {
    try {
      if (statSync(target).size > 0) return target
    } catch (err) {
      // fall through to download
    }
  }
  const fetched = await once(url, () => fetchBounded(url, MAX_IMAGE_BYTES, typeof settings.timeoutMs === 'number' ? settings.timeoutMs : DEFAULT_TIMEOUT_MS))
  if (fetched.error !== undefined) return undefined
  try {
    mkdirSync(directory, { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    writeFileSync(temporary, fetched.buffer)
    try {
      renameSync(temporary, target)
    } catch (err) {
      unlinkSync(temporary)
      throw err
    }
  } catch (err) {
    return undefined
  }
  return target
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_MANIFEST_BYTES,
  MAX_IMAGE_BYTES,
  MANIFEST_FILE,
  SOURCE_FILE,
  IMAGES_FILE,
  parseRemotes,
  deriveName,
  directoryOf,
  convertManifest,
  extensionOf,
  syncRemotes,
  readImages,
  ensureFile,
}
