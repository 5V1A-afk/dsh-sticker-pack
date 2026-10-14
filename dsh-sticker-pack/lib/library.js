/**
 * dsh-sticker-pack — sticker library (CommonJS on purpose).
 *
 * The npm package deliberately declares no `"type"`, so Node treats these files
 * as CommonJS. That is the form this dsh deployment is built for and the form
 * its other working host half uses; matching it costs one `require`, while
 * guessing at ESM adds a failure mode that could only be discovered by
 * restarting the desktop app.
 *
 * The one thing that has to be exactly right here is the Markdown link itself:
 * the harness only renders an image whose source is a bare absolute path
 * (`C:\dir\a.gif`). Any URL form (`file:`, `dsh-resource:`, `api/file?path=`)
 * is rejected upstream and comes out as a broken text link instead of a
 * picture. `fileLink` below produces that accepted form, spaces percent-encoded
 * while the path separators stay backslashes, and without the `<...>` wrapper
 * that would otherwise break inline layout.
 *
 * ## Where the metadata comes from (v0.5.0)
 *
 * One layer only: the `pack.json` at the root of each folder this module is
 * pointed at. Those folders are no longer hand-made — `lib/remote.js` mirrors
 * every configured remote source into a folder of its own, and the loader reads
 * that mirror exactly as it would read a local folder. The built-in seed pack is
 * gone, so a source that publishes no manifest contributes nothing at all.
 *
 * A file the manifest does not name still shows up with an auto id (`x01`,
 * `x02`, …): that keeps a hand-written manifest from hiding images, at the cost
 * of those images having no tags.
 */

'use strict'

const { readdirSync, readFileSync, openSync, readSync, closeSync, statSync } = require('node:fs')
const { basename, extname, join } = require('node:path')

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'])

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/** The optional per-folder manifest; see `readManifest`. */
const MANIFEST_NAME = 'pack.json'

/** An id has to survive `encodeURIComponent` and look like a word. */
const ID_PATTERN = /^[A-Za-z0-9_$.-]{1,32}$/

/**
 * Perf: an image header never needs more than this. `imageSizeOf` only reads
 * the PNG IHDR / GIF logical screen descriptor / a JPEG SOF marker, all of
 * which sit at the front — the previous version called `readFileSync(path)`
 * with no bound and pulled in 18.13 MiB per pick to look at 2.5 MiB of headers.
 */
const HEADER_BYTES = 262144

/** Perf: bounded memo for image dimensions, keyed by path+size+mtime. */
const SIZE_CACHE_LIMIT = 512
const sizeCache = new Map()

/** Perf: bounded memo for directory scans, keyed by directory. */
const SCAN_CACHE_LIMIT = 32
const scanCache = new Map()

/** Default `loadLibrary` scan-cache lifetime; 0 disables it. */
const DEFAULT_SCAN_TTL_MS = 1000

/** @returns {{width:number,height:number}|undefined} image size from header bytes. */
function imageSizeOf(buffer) {
  if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  }
  if (buffer.length > 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2
    while (at < buffer.length - 9) {
      if (buffer[at] !== 0xff) {
        at += 1
        continue
      }
      const marker = buffer[at + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(at + 7), height: buffer.readUInt16BE(at + 5) }
      }
      at += 2 + buffer.readUInt16BE(at + 2)
    }
  }
  return undefined
}

/**
 * Read at most `HEADER_BYTES` from the front of a file.
 *
 * `readFileSync` cannot express "the first N bytes", so this opens the file and
 * reads one bounded chunk. The whole point of the module: a 12.8 MiB GIF must
 * not be dragged through memory to learn it is 480x854.
 *
 * @param {string} filePath
 * @param {number} [bytes] - file size, to size the buffer exactly.
 * @returns {Buffer}
 */
function readHeader(filePath, bytes) {
  const wanted = typeof bytes === 'number' && bytes >= 0 ? Math.min(HEADER_BYTES, bytes) : HEADER_BYTES
  if (wanted === 0) return Buffer.alloc(0)
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(wanted)
    const read = readSync(fd, buffer, 0, wanted, 0)
    return read === wanted ? buffer : buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/** @returns {{width:number,height:number}|undefined} header-derived size, memoised. */
function imageSizeFor(filePath, stat) {
  const key = `${filePath}|${stat.size}|${Math.floor(stat.mtimeMs)}`
  if (sizeCache.has(key)) return sizeCache.get(key)
  let size
  try {
    size = imageSizeOf(readHeader(filePath, stat.size))
  } catch (err) {
    size = undefined
  }
  if (sizeCache.size >= SIZE_CACHE_LIMIT) sizeCache.clear()
  sizeCache.set(key, size)
  return size
}

/**
 * @deprecated kept for callers and tests that only have a path; use
 * `imageSizeFor` so the bounded read can size its buffer.
 */
function imageSizeAt(filePath) {
  try {
    return imageSizeFor(filePath, statSync(filePath))
  } catch (err) {
    return undefined
  }
}

/**
 * The exact Markdown an assistant reply needs to show one sticker inline.
 * @param {string} filePath - absolute native path.
 * @returns {string} `![sticker](C:\dir\name.gif)` with spaces percent-encoded.
 */
function fileLink(filePath) {
  // Encode only spaces: the character class the harness rewrites is
  // `[^\\/\s()]`, so percent-encoding anything else would simply not match.
  return `![sticker](${filePath.replace(/ /gu, '%20')})`
}

/**
 * The same Markdown, but pointing at an absolute HTTP URL instead of a local
 * path. Two reasons this exists:
 *
 * - A local-path image is deliberately hidden while the reply is still
 *   streaming (`const file = streaming ? void 0 : parseFileLink(destination)`),
 *   so it only appears once the message settles. An absolute `http(s)` URL
 *   passes the author-side whitelist, so it shows up as the reply streams.
 * - An absolute URL is the only way to reach a route this plugin registered
 *   itself: a root-relative `![](/sticker-pack/i/x)` is NOT a request to that
 *   route, it is treated as a local path and rewritten to
 *   `<base>api/file?path=%2Fsticker-pack%2Fi%2Fx`.
 *
 * @param {string} baseUrl - origin, e.g. `http://127.0.0.1:19387`.
 * @param {string} id - a sticker id; ids are `[A-Za-z0-9_$.-]`, so URL-safe.
 * @param {number|string} [version] - optional cache-buster (a file mtime works:
 *   re-saving an image under the same id then invalidates the client's copy).
 */
function httpLink(baseUrl, id, version) {
  const stem = `${String(baseUrl).replace(/\/+$/u, '')}/sticker-pack/i/${encodeURIComponent(id)}`
  const suffix = version === undefined || version === null || version === '' ? '' : `?v=${encodeURIComponent(String(version))}`
  return `![sticker](${stem}${suffix})`
}

/** @returns {string} media type for a path, defaulting to application/octet-stream. */
function mimeOf(filePath) {
  return MIME_BY_EXTENSION[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

/** Absolute path of the per-folder manifest. */
function manifestPathOf(directory) {
  return join(directory, MANIFEST_NAME)
}

/** Normalise one authored entry (from a `pack.json`) to a full record. */
function normalizeEntry(raw, fallbackFile) {
  if (raw === null || typeof raw !== 'object') return undefined
  const file = typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : (fallbackFile || '')
  if (file === '') return undefined
  let id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (!ID_PATTERN.test(id)) id = slugOf(basename(file, extname(file)))
  const label = typeof raw.label === 'string' && raw.label.trim() !== ''
    ? raw.label.trim()
    : basename(file, extname(file))
  const entry = { id, file, label, tags: normalizeTags(raw.tags) }
  if (typeof raw.when === 'string' && raw.when.trim() !== '') entry.when = raw.when.trim()
  if (typeof raw.note === 'string' && raw.note.trim() !== '') entry.note = raw.note.trim()
  return entry
}

/** `['a','b']`, `'a b'`, `'a~b'` and `'a、b，c'` all mean the same tags. */
function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
  if (typeof value === 'string') return value.split(/[\s,，、;；~～]+/u).map((tag) => tag.trim()).filter((tag) => tag !== '')
  return []
}

/** An id derived from a filename stem, or `''` when the stem is not ASCII-safe. */
function slugOf(stem) {
  const cleaned = String(stem).trim().replace(/\s+/gu, '-')
  return ID_PATTERN.test(cleaned) ? cleaned : ''
}

/**
 * Read `pack.json` from the素材库 folder. Never throws: a broken manifest
 * degrades to "built-in pack + filename convention" and reports itself through
 * `error`, because losing every sticker over one bad comma would be worse than
 * losing the manifest.
 *
 * Accepted shapes — both of these work:
 *
 *     { "stickers": [ { "id": "fish", "file": "cf26….jpg", "tags": ["开心"] } ] }
 *     [ { "id": "fish", "file": "cf26….jpg", "tags": ["开心"] } ]
 *
 * @returns {{path:string, exists:boolean, entries:object[], error?:string, skipped:number}}
 */
function readManifest(directory) {
  const path = manifestPathOf(directory)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { path, exists: false, entries: [], skipped: 0 }
    return { path, exists: true, entries: [], error: `${path} 读不到：${(err && err.message) || String(err)}`, skipped: 0 }
  }
  let parsed
  try {
    parsed = JSON.parse(stripBom(text))
  } catch (err) {
    return { path, exists: true, entries: [], error: `${MANIFEST_NAME} 不是合法 JSON：${(err && err.message) || String(err)}`, skipped: 0 }
  }
  const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.stickers) ? parsed.stickers : undefined)
  if (list === undefined) {
    return { path, exists: true, entries: [], error: `${MANIFEST_NAME} 顶层要是数组，或者 {"stickers": [...]}`, skipped: 0 }
  }
  const entries = []
  let skipped = 0
  for (const raw of list) {
    const entry = normalizeEntry(raw)
    if (entry === undefined) skipped += 1
    else entries.push(entry)
  }
  return { path, exists: true, entries, skipped }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Read metadata straight out of a filename, so a new image is usable the moment
 * it lands in the folder:
 *
 *     `语塞 #yuse [无语 沉默].gif`  →  id `yuse`, label `语塞`, tags 无语/沉默
 *     `摆烂 [躺平].gif`             →  id from the name (`bailan`? no — the name
 *                                      is not ASCII, so an `xNN` id is assigned),
 *                                      label `摆烂`, tags 躺平
 *     `yuse [无语].gif`             →  id `yuse`, label `yuse`, tags 无语
 *
 * Rules, in order: a bracketed group at the end holds the tags; `#word` anywhere
 * in the rest is the explicit id (and is removed from the label); otherwise the
 * id is the label itself when the label is ASCII-safe, else left empty so the
 * loader can assign `xNN`.
 */
function entryFromFileName(file) {
  const stem = basename(file, extname(file))
  const match = /^(.*?)\s*\[([^\]]*)\]\s*$/u.exec(stem)
  let label = ((match === null ? stem : match[1]).trim()) || stem
  const tags = match === null ? [] : normalizeTags(match[2])
  const hashed = /(^|\s)#([A-Za-z0-9_$.-]{1,32})(?=\s|$)/u.exec(label)
  let id = ''
  if (hashed !== null) {
    id = hashed[2]
    label = label.replace(hashed[0], ' ').replace(/\s{2,}/gu, ' ').trim() || hashed[2]
  }
  return {
    id: id !== '' ? id : slugOf(label),
    file,
    label,
    tags,
  }
}

/** Merge seeded pack + manifest, manifest last (so it wins). */
function mergeAuthored(seeded, manifestEntries) {
  const merged = seeded.map((entry) => ({ ...entry, tags: entry.tags.slice() }))
  const byId = new Map(merged.map((entry, at) => [entry.id.toLowerCase(), at]))
  const byFile = new Map(merged.map((entry, at) => [entry.file.toLowerCase(), at]))
  const duplicates = []
  for (const entry of manifestEntries) {
    const at = byId.get(entry.id.toLowerCase()) !== undefined && byId.get(entry.id.toLowerCase()) !== byFile.get(entry.file.toLowerCase())
      ? byId.get(entry.id.toLowerCase())
      : byFile.get(entry.file.toLowerCase())
    if (at === undefined) {
      byId.set(entry.id.toLowerCase(), merged.length)
      byFile.set(entry.file.toLowerCase(), merged.length)
      merged.push({ ...entry, tags: entry.tags.slice() })
      continue
    }
    if (merged[at].id.toLowerCase() !== entry.id.toLowerCase() && byId.has(entry.id.toLowerCase())) {
      duplicates.push(entry.id)
    }
    merged[at] = { ...entry, tags: entry.tags.slice() }
    byFile.set(entry.file.toLowerCase(), at)
    byId.set(entry.id.toLowerCase(), at)
  }
  return { merged, duplicates }
}

/** `readdirSync` + one `statSync` per candidate, memoised for `ttlMs`. */
function scanDirectory(directory, ttlMs, now) {
  const cached = scanCache.get(directory)
  const fresh = cached !== undefined && ttlMs > 0 && now - cached.at < ttlMs
  if (fresh) return { ...cached.value, cached: true }
  const byFile = new Map()
  let error
  let entries = []
  try {
    entries = readdirSync(directory)
  } catch (err) {
    error = `${directory} 读不到：${(err && err.message) || String(err)}`
  }
  if (error === undefined) {
    for (const entry of entries) {
      if (!IMAGE_EXTENSIONS.has(extname(entry).toLowerCase())) continue
      const filePath = join(directory, entry)
      let stat
      try {
        stat = statSync(filePath)
      } catch (err) {
        continue
      }
      if (!stat.isFile()) continue
      byFile.set(entry, { path: filePath, bytes: stat.size, mtimeMs: stat.mtimeMs, stat })
    }
  }
  const value = { byFile, error, scannedAt: Date.now() }
  if (error === undefined) {
    if (scanCache.size >= SCAN_CACHE_LIMIT) scanCache.clear()
    scanCache.set(directory, { at: now, value })
  }
  return { ...value, cached: false }
}

/**
 * Which folders this load covers.
 *
 * Since v0.5.0 the plugin itself only ever points this at remote mirrors
 * (`lib/remote.js` writes each source into its own folder), and there is no
 * default folder any more: no `directories`, no `directory`, means an empty
 * library. The single-folder `directory` form is still accepted for callers that
 * have exactly one folder in hand (the self-test's scratch directories).
 *
 * @returns {Array<{path: string, tolerateMissing: boolean}>}
 */
function directoriesOf(settings) {
  const fallback = settings.tolerateMissing === true
  const list = []
  const add = function (path, tolerateMissing) {
    if (typeof path !== 'string') return
    const trimmed = path.trim()
    if (trimmed === '' || list.some((item) => item.path === trimmed)) return
    list.push({ path: trimmed, tolerateMissing })
  }
  if (Array.isArray(settings.directories)) {
    for (const item of settings.directories) {
      if (typeof item === 'string') add(item, fallback)
      else if (item !== null && typeof item === 'object' && typeof item.path === 'string') add(item.path, item.tolerateMissing === true)
    }
  }
  add(settings.directory, fallback)
  return list
}

/**
 * Build the resolvable sticker list.
 *
 * One call covers every configured folder: a hand-made 素材库 and any number of
 * remote mirrors (see `lib/remote.js`) are all just directories by this point.
 * Ids are made unique across folders instead of letting a later folder silently
 * shadow an earlier one, which is what makes "add a database of stickers" safe
 * for a pack that already has ids of its own.
 *
 * Files that are not images are skipped; an entry authored in `pack.json` whose
 * file is gone is reported in `missing` so the caller can describe a degraded
 * pack instead of failing to load. A folder marked `tolerateMissing` is the
 * exception: a remote mirror lists stickers before anyone has downloaded them,
 * so those become normal stickers with `pending: true`.
 *
 * Every sticker is authored in the `pack.json` of one of those folders: the
 * built-in seed list is gone (v0.5.0), so a folder with no manifest yields
 * nothing at all.
 *
 * @param {{directories?: Array<string|{path: string, tolerateMissing?: boolean}>, scanTtlMs?: number, fresh?: boolean, now?: number, tolerateMissing?: boolean}} [options]
 */
function loadLibrary(options) {
  const settings = options || {}
  const directories = directoriesOf(settings)
  const ttlMs = settings.fresh === true ? 0 : (typeof settings.scanTtlMs === 'number' ? settings.scanTtlMs : DEFAULT_SCAN_TTL_MS)
  const now = typeof settings.now === 'number' ? settings.now : Date.now()
  const used = new Set()
  const stickers = []
  const missing = []
  const duplicates = []
  const sources = []
  let cached = true
  let error

  for (const directory of directories) {
    const one = loadOneFolder(directory.path, { ttlMs, now, tolerateMissing: directory.tolerateMissing, used })
    cached = cached && one.cached
    if (error === undefined && one.error !== undefined) error = one.error
    for (const sticker of one.stickers) stickers.push(sticker)
    for (const file of one.missing) missing.push(file)
    for (const duplicate of one.duplicates) duplicates.push(duplicate)
    sources.push(one.source)
  }

  const first = sources.length > 0 ? sources[0] : undefined
  return {
    directory: directories.length > 0 ? directories[0].path : undefined,
    directories: directories.map((item) => item.path),
    ok: error === undefined && missing.length === 0,
    error,
    missing,
    stickers,
    sources,
    // Kept for callers that only know about a single folder (the settings page,
    // the image route): it describes the first one.
    manifest: {
      path: first === undefined ? undefined : first.manifest.path,
      exists: first !== undefined && first.manifest.exists,
      count: first === undefined ? 0 : first.manifest.count,
      skipped: first === undefined ? 0 : first.manifest.skipped,
      error: first === undefined ? undefined : first.manifest.error,
    },
    duplicates,
    cached,
  }
}

/** One folder → stickers. `loadLibrary` only picks the folders and merges. */
function loadOneFolder(directory, context) {
  const scan = scanDirectory(directory, context.ttlMs, context.now)
  // Copy: the scan result is memoised, and the loop below consumes entries out
  // of this map. Deleting from the cached Map itself emptied the cache, so a
  // second call inside the TTL window reported ten missing files and zero
  // stickers — which is exactly how "pick a sticker" failed after the first one.
  const byFile = new Map(scan.byFile)
  const manifest = readManifest(directory)
  const missing = []
  const { merged, duplicates } = mergeAuthored([], manifest.entries)
  const stickers = []

  for (const entry of merged) {
    const found = byFile.get(entry.file)
    if (found === undefined) {
      // A mirror publishes ids before the images are fetched. Reporting these as
      // missing would mark every un-downloaded mirror as broken.
      if (context.tolerateMissing === true) {
        stickers.push(describePending(entry, directory, context.used))
        continue
      }
      missing.push(entry.file)
      continue
    }
    byFile.delete(entry.file)
    stickers.push(describeFile(entry, found, directory, context.used))
  }

  // Anything in the folder the authored layers do not name stays usable, named
  // by its filename (with `[tags]` honoured), so dropping a new image into the
  // folder works immediately and never needs a restart.
  const auto = []
  for (const pair of byFile) {
    auto.push(entryFromFileName(pair[0]))
  }
  auto.sort((left, right) => left.file.localeCompare(right.file))
  let counter = 0
  const nextAutoId = function () {
    counter += 1
    return `x${String(counter).padStart(2, '0')}`
  }
  for (const draft of auto) {
    stickers.push(describeFile({
      id: draft.id,
      file: draft.file,
      label: draft.id === '' ? `${draft.label}（自动 id）` : draft.label,
      tags: draft.tags,
      note: manifest.exists
        ? '未登记：在来源仓库的 pack.json 里登记一下，id 与标签才会稳定'
        : '未登记：加进 pack.json 或把文件名写成「名字 [标签].gif」就能被按含义挑中',
    }, byFile.get(draft.file), directory, context.used, nextAutoId))
  }

  const folderError = scan.error !== undefined ? scan.error : manifest.error
  return {
    stickers,
    missing,
    duplicates,
    error: folderError,
    cached: scan.cached,
    source: {
      path: directory,
      count: stickers.length,
      missing: missing.length,
      error: folderError,
      manifest: {
        path: manifest.path,
        exists: manifest.exists,
        count: manifest.entries.length,
        skipped: manifest.skipped,
        error: manifest.error,
      },
    },
  }
}

/**
 * An id nobody else in this library holds.
 *
 * A clash is resolved by prefixing the folder's own name (`大肥鱼/angry.png` next
 * to a remote `angry`) rather than by renumbering, so the id the author chose
 * stays recognisable in the catalog. Ids are capped like `ID_PATTERN` caps them.
 */
function uniqueId(candidate, used, directory, nextAutoId) {
  if (candidate === undefined || candidate === null || candidate === '') {
    if (typeof nextAutoId === 'function') {
      let generated = nextAutoId()
      while (used.has(generated.toLowerCase())) generated = nextAutoId()
      used.add(generated.toLowerCase())
      return generated
    }
    candidate = 'x'
  }
  const clean = String(candidate).slice(0, 32)
  if (!used.has(clean.toLowerCase())) {
    used.add(clean.toLowerCase())
    return clean
  }
  // Shorten the prefix, never the author's id: an id that lost its own tail is
  // no longer the id anyone wrote in the manifest.
  const head = slugOf(basename(directory)) || 'x'
  for (let take = Math.min(head.length, 24); take >= 1; take -= 1) {
    const prefix = `${head.slice(0, take)}-`
    if (prefix.length + clean.length > 32) continue
    const prefixed = `${prefix}${clean}`
    if (!used.has(prefixed.toLowerCase())) {
      used.add(prefixed.toLowerCase())
      return prefixed
    }
  }
  const tail = clean.slice(-24)
  let attempt = 1
  let id = `${tail}-${attempt}`
  while (used.has(id.toLowerCase())) {
    attempt += 1
    const suffix = `-${attempt}`
    id = `${tail.slice(0, 32 - suffix.length)}${suffix}`
  }
  used.add(id.toLowerCase())
  return id
}

/** A file that is present: the ordinary case. */
function describeFile(entry, found, directory, used, nextAutoId) {
  const size = imageSizeFor(found.path, found.stat)
  const sticker = {
    id: uniqueId(entry.id, used, directory, nextAutoId),
    label: entry.label,
    tags: entry.tags.slice(),
    file: entry.file,
    path: found.path,
    directory,
    extension: extname(entry.file).toLowerCase().replace('.', ''),
    bytes: found.bytes,
    mtimeMs: found.mtimeMs,
    link: fileLink(found.path),
  }
  if (entry.when !== undefined) sticker.when = entry.when
  if (entry.note !== undefined) sticker.note = entry.note
  if (size !== undefined) {
    sticker.width = size.width
    sticker.height = size.height
  }
  return sticker
}

/**
 * A file the manifest promises but nobody has fetched yet.
 *
 * `size` is deliberately absent (there is nothing to measure) and `bytes` is 0,
 * which keeps the "this one is huge, load something else" notice quiet until the
 * real file exists.
 */
function describePending(entry, directory, used) {
  const path = join(directory, entry.file)
  const sticker = {
    id: uniqueId(entry.id, used, directory),
    label: entry.label,
    tags: entry.tags.slice(),
    file: entry.file,
    path,
    directory,
    extension: extname(entry.file).toLowerCase().replace('.', ''),
    bytes: 0,
    mtimeMs: 0,
    link: fileLink(path),
    pending: true,
  }
  if (entry.when !== undefined) sticker.when = entry.when
  if (entry.note !== undefined) sticker.note = entry.note
  return sticker
}

/** Look up one sticker by id (case-insensitive); undefined when unknown. */
function findSticker(stickers, id) {
  const wanted = String(id === undefined || id === null ? '' : id).trim().toLowerCase()
  return stickers.find((sticker) => sticker.id.toLowerCase() === wanted)
}

/** Split a free-text situation into search terms. CJK has no spaces, so the whole run counts. */
function termsOf(text) {
  return String(text === undefined || text === null ? '' : text)
    .toLowerCase()
    .split(/[\s,，。、；;：:！!？?~～/\\|()（）[\]{}"'`*#-]+/u)
    .map((term) => term.trim())
    .filter((term) => term !== '')
}

/**
 * How well one sticker answers a described situation. Matching is deliberately
 * dumb and explainable (substring containment both ways) rather than clever:
 * the model reads the score's reason, and a scoring rule nobody can predict is
 * worse than a blunt one.
 */
function scoreSticker(sticker, terms) {
  const haystack = [sticker.id, sticker.label, sticker.tags.join(' '), sticker.when || ''].join(' ').toLowerCase()
  const pieces = haystack.split(/[\s,，、；;：:！!？?~～/\\|()（）[\]{}"'`*#-]+/u).filter((piece) => piece !== '')
  let score = 0
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 2 + Math.min(3, term.length / 4)
      continue
    }
    for (const piece of pieces) {
      if (piece.length > 1 && term.includes(piece)) {
        score += 1
        break
      }
    }
  }
  return score
}

/**
 * Pick a sticker for a mood.
 *
 * Order of precedence: an explicit `id`, then `tag`/`context` matches, then a
 * random draw. `avoid` removes a sticker outright; `recent` only breaks ties,
 * so an explicit `tag`/`context` the pack can answer is still answered when the
 * only sticker carrying it is the one just used — dropping recent entries
 * before matching turned `tag: '害羞'` into a random sticker.
 *
 * @param {object[]} stickers
 * @param {{id?:string, tag?:string, context?:string, avoid?:string[], recent?:string[],
 *          count?:number, random?:() => number}} [query]
 * @returns {{sticker:object, matched:string, score?:number, alternatives:object[]}}
 */
function pickSticker(stickers, query) {
  const asked = query || {}
  const random = typeof asked.random === 'function' ? asked.random : Math.random
  const recent = new Set((asked.recent || []).map((value) => String(value).toLowerCase()))
  const avoid = new Set((asked.avoid || []).map((value) => String(value).toLowerCase()))
  const wanted = Number.isFinite(asked.count) ? Math.max(1, Math.min(5, Math.floor(asked.count))) : 1

  const isRecent = (sticker) => recent.has(sticker.id.toLowerCase())
  const withoutAvoid = stickers.filter((sticker) => !avoid.has(sticker.id.toLowerCase()))
  const usable = withoutAvoid.length > 0 ? withoutAvoid : stickers
  const prefer = usable.filter((sticker) => !isRecent(sticker))
  const pool = prefer.length > 0 ? prefer : usable

  const done = (sticker, matched, ranked, score) => {
    const rest = (ranked || []).filter((candidate) => candidate.sticker.id !== sticker.id)
    return { sticker, matched, score, alternatives: rest.slice(0, Math.max(0, wanted - 1)) }
  }

  /** Best score first, then anything not used recently. */
  const rank = (candidates) => candidates.slice().sort((left, right) => {
    return (right.score - left.score) || (Number(isRecent(left.sticker)) - Number(isRecent(right.sticker)))
  })

  /** Random among the best-scoring tier, preferring entries not used recently. */
  const draw = (ranked) => {
    const best = ranked[0].score
    const tied = ranked.filter((candidate) => candidate.score === best)
    const open = tied.filter((candidate) => !isRecent(candidate.sticker))
    const from = open.length > 0 ? open : tied
    return from[Math.min(from.length - 1, Math.max(0, Math.floor(random() * from.length)))]
  }

  if (asked.id !== undefined && asked.id !== '') {
    const exact = findSticker(usable, asked.id) || findSticker(stickers, asked.id)
    if (exact !== undefined) return done(exact, 'id')
  }

  if (asked.tag !== undefined && asked.tag !== '') {
    const needle = String(asked.tag).toLowerCase()
    const matches = usable.filter((sticker) => {
      return sticker.id.toLowerCase() === needle
        || sticker.tags.some((tag) => tag.toLowerCase().includes(needle))
        || sticker.label.toLowerCase().includes(needle)
        || (sticker.when || '').toLowerCase().includes(needle)
    })
    if (matches.length > 0) {
      const ranked = rank(matches.map((sticker) => ({ sticker, score: 1 })))
      return done(draw(ranked).sticker, 'tag', ranked)
    }
  }

  if (asked.context !== undefined && asked.context !== '') {
    const terms = termsOf(asked.context)
    if (terms.length > 0) {
      const ranked = rank(usable
        .map((sticker) => ({ sticker, score: scoreSticker(sticker, terms) }))
        .filter((candidate) => candidate.score > 0))
      if (ranked.length > 0) {
        const chosen = draw(ranked)
        return done(chosen.sticker, 'context', ranked, chosen.score)
      }
    }
  }

  const chosen = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))]
  return done(chosen, 'random')
}

/**
 * One-line catalog rows. `场景` is what makes the list actionable — an id alone
 * does not tell a reader when to use it.
 */
function formatCatalog(stickers, options) {
  const max = (options && options.max) || 40
  const withWhen = !(options && options.compact === true)
  return stickers.slice(0, max).map((sticker) => {
    const size = sticker.width === undefined ? '' : ` ${sticker.width}x${sticker.height}`
    const tags = sticker.tags.length === 0 ? '' : ` [${sticker.tags.join(' ')}]`
    const when = withWhen && sticker.when !== undefined ? ` ｜场景：${sticker.when}` : ''
    return `${sticker.id}${tags}${size} — ${sticker.label}${when}`
  })
}

/** Drop the memo tables; used by the self-test and after a directory change. */
function forgetCaches() {
  sizeCache.clear()
  scanCache.clear()
}

module.exports = {
  IMAGE_EXTENSIONS,
  MANIFEST_NAME,
  HEADER_BYTES,
  fileLink,
  httpLink,
  mimeOf,
  imageSizeOf,
  imageSizeAt,
  readHeader,
  readManifest,
  manifestPathOf,
  normalizeEntry,
  normalizeTags,
  entryFromFileName,
  termsOf,
  scoreSticker,
  loadLibrary,
  findSticker,
  pickSticker,
  formatCatalog,
  forgetCaches,
}
