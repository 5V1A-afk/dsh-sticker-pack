/**
 * dsh-sticker-pack — host half (CommonJS, see lib/library.js for why).
 *
 * Four things are registered, each guarded on its own:
 *
 * 1. Model-facing tools on `ctx.tools` (`sticker_catalog`, `sticker_pick`) so
 *    the agent can look up a sticker and get back the exact Markdown link its
 *    own reply has to carry. That is the whole point: a path the model was never
 *    shown is a path it cannot use.
 * 2. An image route on `ctx.webServer` at `/sticker-pack/i/<id>`, an HTTP view
 *    of the pack that never exposes the folder's absolute paths. Optional —
 *    when `webServer` is absent or the path collides, the plugin still loads.
 * 3. A settings page (routes below) plus a system-prompt section whose text is a
 *    function of the host's own per-turn coin flip, so "how often to attach one"
 *    is enforced here rather than left to the model's mood. The client half in
 *    `../client.js` adds the same probability knob to DSH's own Settings.
 * 4. A small recency ledger (`~/.dsh/sticker-pack/recent.json`) so `sticker_pick`
 *    can favour a sticker the last few replies did not already use.
 *
 * No imports beyond `node:` builtins and this package's own files: the profile
 * node_modules of a dsh deployment carries no `@deepseek-ai/*` to import from,
 * and every service arrives through `ctx`. Tool definitions are therefore
 * written as the raw `ToolDefinition` shape (plain JSON Schema) rather than
 * through `defineTool`, which lives in exactly such an unimportable package.
 */

'use strict'

const { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, createReadStream, statSync } = require('node:fs')
const { extname, join } = require('node:path')
const { homedir } = require('node:os')
const library = require('./library.js')
const remote = require('./remote.js')

const name = 'dsh-sticker-pack'

/**
 * A boot log, because a third-party bundle that fails to mount leaves no trace
 * anywhere else: the desktop app keeps no runtime log, and `ctx.logger.warn`
 * goes nowhere a person can read. Every line here is written with the same
 * rule as the rest of the plugin — a diagnostic must never be the reason the
 * plugin fails, so all of it is best-effort.
 *
 * `DSH_STICKER_PACK_HOME` overrides the directory holding boot.log, the recency
 * ledger and the settings file. It exists for the self-check, which would
 * otherwise write into the running installation's real state.
 */
const LOG_DIRECTORY = process.env.DSH_STICKER_PACK_HOME || join(homedir(), '.dsh', 'sticker-pack')

function trace(line) {
  try {
    mkdirSync(LOG_DIRECTORY, { recursive: true })
    require('node:fs').appendFileSync(join(LOG_DIRECTORY, 'boot.log'), `${new Date().toISOString()} ${line}\n`)
  } catch (err) {
    /* a failed diagnostic is not a failure */
  }
}

/**
 * Read one service off the plugin context. In-box plugins reach services as
 * plain context properties (`ctx.webServer`, `ctx.tools`), which is what cordis
 * exposes; `ctx.get(name)` is the other spelling in use. A plugin that lives
 * outside the installation cannot assume either, so it asks for both.
 */
function service(ctx, key) {
  if (ctx === null || ctx === undefined) return undefined
  // The property read is the one that lies. For a service that is not declared
  // in `inject`, cordis does not return undefined — it throws
  // `cannot get property "<key>" without inject`. Swallowing that and giving up
  // would report a live service as absent, which is how the web routes went
  // missing even after the tools came back, so each read gets its own guard and
  // the throwing one falls through to `ctx.get` instead of returning early.
  try {
    const direct = ctx[key]
    if (direct !== undefined) return direct
  } catch (err) {
    // Not injected: `ctx.get` below reads the service store without that gate.
  }
  try {
    if (typeof ctx.get === 'function') return ctx.get(key)
  } catch (err) {
    return undefined
  }
  return undefined
}

function ctxSummary(ctx) {
  try {
    if (ctx === null || typeof ctx !== 'object') return String(ctx)
    const keys = Object.keys(ctx)
    return `keys=[${keys.slice(0, 60).join(',')}]${keys.length > 60 ? `,…+${keys.length - 60}` : ''}`
  } catch (err) {
    return `keys unreadable: ${(err && err.message) || String(err)}`
  }
}

trace('module imported')

/**
 * Host services this plugin reads. This is the bug that cost a restart: cordis
 * binds a service onto a plugin's context only when the plugin declares it, so
 * without `inject` the plugin mounted perfectly and then read `ctx.tools` as
 * `undefined` — the tool registrations threw into their own catch, the route
 * guard skipped silently, and a mounted-but-empty plugin left no trace anywhere.
 *
 * `tools` is required (the whole point of the pack is the tools); the web
 * server must NOT be, because a profile with no web server would then keep this
 * plugin pending forever and silently lose the tools too. It is reached through
 * `ctx.get` and waited for with `ctx.inject`, the same way dsh-wechat-plugin
 * does it.
 */
const inject = ['tools']

/**
 * The one thing a tool description cannot enforce is *when* to reach for the
 * tool at all — that is a behavioural rule, so it belongs in the system prompt.
 * Keeping it here (and the tool descriptions short) is also cheaper than the
 * alternative: the section costs ~500 B per request, while the prose it replaced
 * in `sticker_pick` cost ~1.5 kB per request. The call shape below
 * is read off the installed `@deepseek-ai/dsh-system-prompt` (0.2.0-rc.2) source
 * and its README: `section()` takes `{ name, order, text, interpolate }`, `order`
 * must be finite, `text` may be a function that is called per assemble,
 * `interpolate: false` keeps the text from being scanned for `${...}` variables,
 * and the persona sections sit at 10200 while first-party sections live well
 * below 9000.
 *
 * Honest limit on that evidence: the shape is source-read, not observed live.
 * This process could not boot the real cordis host (bare `cordis` is rewritten
 * by the app's own loader), so the section has not been seen inside an assembled
 * prompt. What *is* verified locally is that we call `section()` with exactly
 * those arguments (`test/selftest.js` asserts the recorded call). Live acceptance
 * is one boot-log line after a restart:
 *   prompt: section "sticker-pack:usage" registered (order 9500, 510B per request, probability 60%)
 * (510 B is the 60% wording; the digits change the byte count, and that is the one
 *  edit the settings page makes — see `promptText` below.)
 *
 * Note the honest limits: the probability is prose to the model, not something
 * this plugin can enforce; the text cannot see the conversation; and registering
 * it globally also reaches subagents — which do not reply to the user, so a
 * sticker there is harmless but pointless.
 */
const PROMPT_SECTION = 'sticker-pack:usage'
const PROMPT_ORDER = 9500

/** The three lines that only matter when a sticker is actually being attached. */
const ATTACH_RULES = [
  '要贴时先调 sticker_pick，context 写清这条回复在回应什么、什么语气（例：「他夸我了，不好意思」「又要重跑，摆烂」）。',
  '把返回的 markdown 原样放进回复正文，位置放在整条回复的最后：本地路径的图要等消息落定才显示，放最后读者才不用等。',
  '不要手写图片路径，不要连着两次贴同一张。',
]

/**
 * The usage policy, as a function of what the host has already decided for the
 * current turn.
 *
 * `decision` is the host's coin, not the model's:
 *   - `true`  — this reply carries a sticker, so the section states it as a fact.
 *   - `false` — it does not, and saying so explicitly is what stops the model
 *     from attaching one out of habit.
 *   - `undefined` — no turn to decide for (assembly outside a turn, or a host
 *     too old to hand the section a context). The old percentage prose is the
 *     fallback, so the plugin still behaves on a harness that cannot support
 *     the guarantee.
 *
 * The honest cost of the decided forms: the text changes when the coin does,
 * and a changed system prompt invalidates the prompt prefix from that point on.
 * That is the price of the guarantee; see README "概率由谁决定". Both ends of
 * the slider are constant text (`0` is always "不贴", `1` is always "要贴"), so
 * the cache cost exists only for the probabilities in between.
 */
function promptText(probability, decision) {
  if (decision === true) return ['表情包（宿主判定，本轮要贴）：这条回复末尾务必贴一张。', ...ATTACH_RULES].join('\n')
  if (decision === false) return '表情包（宿主判定，本轮不贴）：这条回复不要贴表情包，也不要调用 sticker_pick。'
  const percent = Math.round(probability * 100)
  return [
    `表情包：每次回复有约 ${percent}% 的概率贴一张，随机决定即可，不用凑规律；轮到不贴就正常聊。`,
    ...ATTACH_RULES,
  ].join('\n')
}

/**
 * The per-turn coin, and the reason the probability is no longer a hint.
 *
 * One user message is one turn, and DSH assembles the prompt more than once per
 * turn (pre-step, then every step). The decision therefore has to be *pinned*
 * to the turn — a fresh coin per assembly would hand the model "要贴" and
 * "不贴" inside the same reply.
 *
 * `assembleContextFor(agent, signal)` is what a section's text receives
 * (`@deepseek-ai/dsh-agent`), and that `signal` is the current turn's own
 * control signal, so identity of the signal identifies the turn. `session/event`
 * `turn/start` is the second, independent edge: it clears the entry even on a
 * host that reuses one signal object for every turn.
 *
 * Keyed by agent id (which equals the session id). Bounded, because a long-lived
 * process outlives its sessions.
 */
const TURN_DECISIONS = new Map()
const TURN_DECISION_LIMIT = 256

function forgetTurn(id) {
  if (id === undefined || id === null) return false
  return TURN_DECISIONS.delete(String(id))
}

function rollTurn(context, probability) {
  if (context === null || typeof context !== 'object') return undefined
  const agent = context.scope ?? context.agent
  const id = agent !== null && typeof agent === 'object' && agent.id !== undefined ? String(agent.id) : undefined
  const signal = context.signal
  if (id === undefined && (signal === null || typeof signal !== 'object')) return undefined
  const key = id === undefined ? signal : id
  const known = TURN_DECISIONS.get(key)
  if (known !== undefined && known.signal === signal) return known.decision
  const decision = Math.random() < probability
  if (TURN_DECISIONS.size >= TURN_DECISION_LIMIT) TURN_DECISIONS.clear()
  TURN_DECISIONS.set(key, { signal, decision })
  return decision
}

/**
 * Subagents do not reply to the user, so a sticker there is pointless. They are
 * identified by `options.parentAgent` — the field the agent factory sets on the
 * child (`@deepseek-ai/dsh-agent`).
 */
function isSubagent(context) {
  const agent = (context === null || typeof context !== 'object' ? undefined : (context.scope ?? context.agent)) ?? undefined
  if (agent === null || typeof agent !== 'object') return false
  if (agent.parentAgent !== undefined && agent.parentAgent !== null) return true
  const options = agent.options
  return options !== null && typeof options === 'object' && options.parentAgent !== undefined && options.parentAgent !== null
}

/**
 * The verdict this turn already reached, or a fresh one if nobody asked yet.
 *
 * `sticker_pick` calls this with the *calling* agent, so the tool and the prompt
 * cannot disagree: a turn that lost the toss gets no sticker even if the model
 * calls the tool anyway. Returns `undefined` when there is no agent to key on,
 * which the caller reads as "no verdict" rather than "no".
 */
function turnDecision(agent, probability) {
  if (agent === null || typeof agent !== 'object' || agent.id === undefined) return undefined
  if (isSubagent({ agent })) return false
  const key = String(agent.id)
  const known = TURN_DECISIONS.get(key)
  if (known !== undefined) return known.decision
  const decision = Math.random() < probability
  if (TURN_DECISIONS.size >= TURN_DECISION_LIMIT) TURN_DECISIONS.clear()
  TURN_DECISIONS.set(key, { signal: undefined, decision })
  return decision
}

const RECENT_FILE = join(LOG_DIRECTORY, 'recent.json')
const SETTINGS_FILE = join(LOG_DIRECTORY, 'settings.json')

/**
 * Where remote sources are mirrored.
 *
 * Deliberately **not** under `~/.dsh`: the web GUI refuses to render a local
 * image that sits inside its own config folder (the picture shows up as
 * 「无法预览」), so a mirror kept there yields stickers nobody can see. It is
 * still a cache the plugin owns and may rewrite — the loader cannot tell it
 * apart from a curated folder, which is the whole design. Set
 * `DSH_STICKER_PACK_LIBRARY` to put it somewhere else.
 */
/** Mirrors live outside `~/.dsh`; the self-test's `DSH_STICKER_PACK_HOME`
 *  still wins, so tests never touch the real Pictures folder. */
function libraryRoot() {
  const explicit = process.env.DSH_STICKER_PACK_LIBRARY
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const stateHome = process.env.DSH_STICKER_PACK_HOME
  if (typeof stateHome === 'string' && stateHome.trim() !== '') return join(stateHome, 'library')
  return join(homedir(), 'Pictures', 'dsh-sticker-pack')
}

// `remote.directoryOf` appends `remotes/<source>/` to whatever it is handed, so
// this is the library root, not the remotes folder itself.
const REMOTE_CACHE_DIRECTORY = libraryRoot()

/** Chance, per reply, that the model is asked to attach a sticker. */
const DEFAULT_PROBABILITY = 0.6

/**
 * Shipped sticker source, so a fresh `dsh plugin add` has a working library
 * without anyone hand-editing a config file. Setting `remotes` in
 * settings.json or the profile config replaces it entirely.
 */
const DEFAULT_REMOTES = [
  {
    url: 'https://gcore.jsdelivr.net/gh/5V1A-afk/dsh-sticker-pack@main/stickers/pack.json',
    name: '大肥鱼',
  },
]

let settingsCache
let settingsCacheStamp = Number.NaN

/**
 * Runtime settings owned by this plugin's own settings page, kept next to the
 * runtime state (`~/.dsh/sticker-pack/settings.json`). Precedence is
 * file > profile config > default, so a profile that pins a value in
 * `cordis.yml` can still be overridden from the UI without editing files by
 * hand. The cache is keyed by the file's mtime, so hand-editing `settings.json`
 * (which the README tells people to do for `remotes`) also lands on the next
 * request — a plain read-once cache kept the old value until a restart, which
 * cost a debugging round on 2026-10-14.
 */
function readSettings() {
  let stamp = Number.NaN
  try {
    stamp = statSync(SETTINGS_FILE).mtimeMs
  } catch (err) {
    stamp = Number.NaN
  }
  if (settingsCache !== undefined && stamp === settingsCacheStamp) return settingsCache
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    settingsCache = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    settingsCache = {}
  }
  settingsCacheStamp = stamp
  return settingsCache
}

function writeSettings(next) {
  settingsCache = next
  try {
    mkdirSync(LOG_DIRECTORY, { recursive: true })
    const temporary = `${SETTINGS_FILE}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    try {
      renameSync(temporary, SETTINGS_FILE)
    } catch (err) {
      unlinkSync(temporary)
      throw err
    }
    return true
  } catch (err) {
    trace(`settings write failed: ${(err && err.message) || String(err)}`)
    return false
  }
}

/** Clamp whatever the profile config or the settings page hands us to 0..1. */
function asProbability(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number)) return undefined
  return Math.min(1, Math.max(0, number))
}

function probabilityOf(config) {
  const fromPage = asProbability(readSettings().probability)
  if (fromPage !== undefined) return fromPage
  const fromProfile = asProbability((config || {}).probability)
  return fromProfile === undefined ? DEFAULT_PROBABILITY : fromProfile
}

/** What the settings page (and the self-test) reads back. */
function settingsSnapshot(config) {
  const fromPage = asProbability(readSettings().probability)
  const fromProfile = asProbability((config || {}).probability)
  return {
    probability: probabilityOf(config),
    source: fromPage !== undefined ? 'settings.json' : (fromProfile !== undefined ? 'profile config' : 'default'),
    defaultProbability: DEFAULT_PROBABILITY,
    file: SETTINGS_FILE,
  }
}

/**
 * Merge a patch from the settings page into the runtime file. Unknown keys are
 * preserved, `probability` is the only key the page owns today, and a rejected
 * value leaves the file untouched.
 */
function applySettingsPatch(config, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'body must be a JSON object', ...settingsSnapshot(config) }
  }
  const next = { ...readSettings() }
  if (Object.prototype.hasOwnProperty.call(patch, 'probability')) {
    const value = asProbability(patch.probability)
    if (value === undefined) {
      return { ok: false, error: 'probability must be a number between 0 and 1', ...settingsSnapshot(config) }
    }
    next.probability = value
  }
  return { ok: writeSettings(next), ...settingsSnapshot(config) }
}

/**
 * List-shaped settings, read from `settings.json` first and the profile config
 * second.
 *
 * The settings page owns `probability` and rewrites the file without disturbing
 * other keys, which makes the file the friendliest place for a hand-edited list:
 * no dsh restart, no config schema to learn.
 */
function listSetting(config, key) {
  const stored = readSettings()[key]
  const value = stored === undefined ? (config || {})[key] : stored
  if (value === undefined || value === null || value === '') return []
  return Array.isArray(value) ? value : [value]
}

function numberSetting(config, key, fallback) {
  const stored = readSettings()[key]
  const value = stored === undefined ? (config || {})[key] : stored
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * Configured sources, falling back to the one this plugin ships for — an
 * unconfigured install should hand you a working library, not an empty one.
 * An explicit empty array is a deliberate "no library" and is honoured.
 */
function configuredRemotes(config) {
  const stored = readSettings().remotes
  const raw = stored === undefined ? (config || {}).remotes : stored
  if (Array.isArray(raw) && raw.length === 0) return []
  const parsed = remote.parseRemotes(listSetting(config, 'remotes'))
  return parsed.length > 0 ? parsed : remote.parseRemotes(DEFAULT_REMOTES)
}

function settingsOf(config) {
  const given = config || {}
  const base = typeof given.httpBaseUrl === 'string' ? given.httpBaseUrl.trim().replace(/\/+$/u, '') : ''
  return {
    // The only source of stickers since v0.5.0: every remote manifest is
    // mirrored into a folder of its own and read from there. No local folder
    // is scanned any more, so this list is the whole library.
    remotes: configuredRemotes(config),
    // A mirror is refreshed at most once per TTL, and never on a path that a
    // reply is waiting on: see `snapshotRemote` versus `snapshot`.
    remoteTtlMs: numberSetting(config, 'remoteTtlMs', remote.DEFAULT_TTL_MS),
    remoteTimeoutMs: numberSetting(config, 'remoteTimeoutMs', remote.DEFAULT_TIMEOUT_MS),
    largeFileBytes: typeof given.largeFileBytes === 'number' ? given.largeFileBytes : 2 * 1024 * 1024,
    // Read through on every call so the settings page takes effect immediately.
    probability: probabilityOf(config),
    // How many of the most recently used ids `sticker_pick` pushes to the back
    // of the queue. 0 restores pure random behaviour.
    recentWindow: typeof given.recentWindow === 'number' && given.recentWindow >= 0 ? given.recentWindow : 3,
    // How long a directory scan may be reused. New files still appear within
    // this window; 0 makes every call re-scan.
    scanTtlMs: typeof given.scanTtlMs === 'number' && given.scanTtlMs >= 0 ? given.scanTtlMs : 1000,
    // When set, `sticker_pick` hands back an absolute HTTP URL to this plugin's
    // own image route instead of a local path. Trade-off, both verified in the
    // client code: the local-path form survives a port change and needs no
    // configuration, but is only rendered after the reply settles; the HTTP form
    // renders while streaming, but breaks if the port moves and is refused by
    // the /api fence in desktop mode (this route is not under /api, so it is not
    // fenced — but that also means it is reachable without credentials).
    httpBaseUrl: base === '' ? undefined : base,
  }
}

/**
 * Every folder one load covers: one mirror directory per remote source.
 *
 * Computed from configuration alone, with no network access, which is what lets
 * the synchronous paths (the image route, the manifest JSON) run without ever
 * waiting on a fetch — they see whatever the last successful sync mirrored.
 * A mirror that has never been created is skipped rather than reported: "not
 * fetched yet" is a normal state, not a broken library.
 */
function libraryFolders(settings) {
  const folders = []
  for (const source of settings.remotes) {
    const path = remote.directoryOf(REMOTE_CACHE_DIRECTORY, source)
    if (!existsSync(path)) continue
    folders.push({ path, tolerateMissing: true })
  }
  return folders
}

/**
 * Read the pack fresh on every call: the point of pointing the plugin at a
 * folder is that images get dropped in or deleted while dsh runs, and a cached
 * list would keep handing out paths that no longer exist. The scan and the image
 * headers are memoised for a second and by mtime respectively, which keeps that
 * promise while no longer re-reading 18 MiB per pick.
 */
function snapshot(config, options) {
  const settings = settingsOf(config)
  const fresh = options !== undefined && options.fresh === true
  const pack = library.loadLibrary({
    directories: libraryFolders(settings),
    scanTtlMs: fresh ? 0 : settings.scanTtlMs,
  })
  if (settings.httpBaseUrl !== undefined) {
    for (const sticker of pack.stickers) {
      sticker.link = library.httpLink(settings.httpBaseUrl, sticker.id, Math.floor(sticker.mtimeMs || 0))
    }
  }
  return { pack, settings, largeFileBytes: settings.largeFileBytes }
}

/**
 * `snapshot` after refreshing every remote source.
 *
 * This is the only place a manifest is fetched. It is called from the three tool
 * entry points, which are already asynchronous, and from the catalog route; the
 * pick path additionally downloads the one image it actually needs (see
 * `resolveSticker`). Everything else reads the mirror and moves on.
 */
const TOOL_DEADLINE_MS = 9000
const DEADLINE = Symbol('sticker-pack deadline')

/**
 * Run `work`, but never longer than `ms`.
 *
 * A reply must not be held hostage by a hanging network. The tool entry points
 * used to wait out every retry of every source, so on a machine where the CDN is
 * unreachable the agent just sat there "thinking" and never answered (reported
 * 2026-10-15). Timing out falls back to whatever mirror is already on disk —
 * usually still a usable library — and says why instead of stalling.
 */
function withDeadline(work, ms) {
  let timer
  return Promise.race([
    work,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function snapshotRemote(config) {
  const settings = settingsOf(config)
  const remoteSources = await withDeadline(
    remote.syncRemotes(settings.remotes, {
      cacheDirectory: REMOTE_CACHE_DIRECTORY,
      ttlMs: settings.remoteTtlMs,
      timeoutMs: settings.remoteTimeoutMs,
    }),
    TOOL_DEADLINE_MS,
  )
  const read = snapshot(config)
  if (remoteSources === DEADLINE) {
    trace(`remote: refresh still running after ${TOOL_DEADLINE_MS}ms — answering from the mirror`)
    read.remoteSources = settings.remotes.map((source) => ({
      name: source.name,
      url: source.url,
      directory: remote.directoryOf(REMOTE_CACHE_DIRECTORY, source),
      status: 'stale',
      count: 0,
      error: `等待远端超过 ${Math.round(TOOL_DEADLINE_MS / 1000)} 秒，本轮先用本地镜像`,
      skipped: [],
    }))
    return read
  }
  read.remoteSources = remoteSources
  return read
}

/** One line naming where a pack came from, for the catalog's headline. */
function describeSources(read) {
  const sources = read.remoteSources
  if (!Array.isArray(sources) || sources.length === 0) return '(没有配置远端素材库)'
  const names = sources.map((source) => source.name)
  if (names.length === 1) return names[0]
  return `${names[0]} 等 ${names.length} 个远端源`
}

/** What the mirror state has to say, or undefined when everything is fine. */
function sourceNotice(read) {
  const sources = read.remoteSources
  if (!Array.isArray(sources) || sources.length === 0) return undefined
  const parts = []
  for (const source of sources) {
    if (source.status === 'error') parts.push(`远端 ${source.name} 拉取失败：${source.error}`)
    else if (source.status === 'stale') parts.push(`远端 ${source.name} 沿用了上次镜像：${source.error}`)
    else if (Array.isArray(source.skipped) && source.skipped.length > 0) {
      parts.push(`远端 ${source.name} 跳过 ${source.skipped.length} 条：${source.skipped.slice(0, 3).join('；')}`)
    }
  }
  return parts.length === 0 ? undefined : parts.join(' ')
}

/**
 * Download one mirrored sticker on its first use.
 *
 * The mirror names files after the id, so the URL is looked up by `file` rather
 * than by id: ids are made unique across folders by the loader, and a
 * de-duplicated id would miss its own manifest entry.
 */
async function fetchPending(sticker, read) {
  const images = remote.readImages(sticker.directory)
  let url
  for (const key of Object.keys(images)) {
    const item = images[key]
    if (item !== null && typeof item === 'object' && item.file === sticker.file && typeof item.url === 'string') {
      url = item.url
      break
    }
  }
  if (url === undefined) return undefined
  const path = await remote.ensureFile({
    directory: sticker.directory,
    file: sticker.file,
    url,
    timeoutMs: read.settings.remoteTimeoutMs,
  })
  if (path === undefined) trace(`remote: 下载失败 ${url}`)
  return path
}

/**
 * Pick a sticker that can actually be shown.
 *
 * A mirrored sticker nobody has fetched yet is not an answer — the model would
 * paste a path that does not exist — so it is fetched first, and a failed fetch
 * drops that candidate instead of failing the call. The model asked for a
 * sticker, not for a particular id; the next candidate is a better answer than
 * an apology.
 */
async function resolveSticker(config, read, query) {
  let result = library.pickSticker(read.pack.stickers, query)
  const tried = []
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sticker = result.sticker
    if (sticker === undefined || sticker.pending !== true) return result
    const fetched = await fetchPending(sticker, read)
    if (fetched !== undefined) {
      // Re-read with the scan cache bypassed: the file was written a moment ago.
      const refreshed = snapshot(config, { fresh: true }).pack
      const again = library.findSticker(refreshed.stickers, sticker.id)
      if (again !== undefined && again.pending !== true) {
        return {
          sticker: again,
          matched: result.matched,
          alternatives: result.alternatives.filter((item) => item.sticker.id !== sticker.id),
        }
      }
    }
    tried.push(sticker.id)
    const next = library.pickSticker(read.pack.stickers, { ...query, avoid: query.avoid.concat(tried) })
    // `pickSticker` falls back to the whole pool when `avoid` excludes
    // everything, so a repeat would loop forever without this guard.
    if (next.sticker === undefined || tried.indexOf(next.sticker.id) !== -1) return next
    result = next
  }
  return result
}

/**
 * The recency ledger: newest first, at most `RECENT_LIMIT` ids.
 *
 * It is a soft hint ("don't repeat what I just used"), not state worth blocking
 * a reply on. Measured on this machine, the old write-on-every-pick version cost
 * 7.5 ms per `sticker_pick` call while the actual lookup cost 0.1 ms, so the
 * ledger now lives in memory and the file is written at most once per
 * `RECENT_FLUSH_MS`, plus once on dispose. Losing the last second of picks to a
 * crash costs nothing; see test/perf-probe.js for the numbers.
 */
const RECENT_LIMIT = 24
const RECENT_FLUSH_MS = 2000

let recentCache
let recentFlushTimer
let recentDirty = false

function readRecent() {
  if (recentCache !== undefined) return recentCache
  try {
    const parsed = JSON.parse(readFileSync(RECENT_FILE, 'utf8'))
    const ids = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.ids) ? parsed.ids : [])
    recentCache = ids.map((id) => String(id)).filter((id) => id !== '')
  } catch (err) {
    recentCache = []
  }
  return recentCache
}

function writeRecent(ids) {
  try {
    mkdirSync(LOG_DIRECTORY, { recursive: true })
    const temporary = `${RECENT_FILE}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify({ ids }, null, 2)}\n`, 'utf8')
    try {
      renameSync(temporary, RECENT_FILE)
    } catch (err) {
      unlinkSync(temporary)
      throw err
    }
  } catch (err) {
    trace(`recent ledger write failed (not fatal): ${(err && err.message) || String(err)}`)
  }
}

function flushRecent() {
  if (recentFlushTimer !== undefined) {
    clearTimeout(recentFlushTimer)
    recentFlushTimer = undefined
  }
  if (!recentDirty || recentCache === undefined) return
  recentDirty = false
  writeRecent(recentCache)
}

function scheduleRecentFlush() {
  if (recentFlushTimer !== undefined) return
  recentFlushTimer = setTimeout(function () {
    recentFlushTimer = undefined
    if (!recentDirty || recentCache === undefined) return
    recentDirty = false
    writeRecent(recentCache)
  }, RECENT_FLUSH_MS)
  // Never hold the process open just to persist a hint.
  if (typeof recentFlushTimer.unref === 'function') recentFlushTimer.unref()
}

function rememberRecent(ids) {
  const seen = new Set()
  const merged = []
  for (const id of [].concat(ids, readRecent())) {
    const key = String(id).toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    merged.push(String(id))
    if (merged.length >= RECENT_LIMIT) break
  }
  recentCache = merged
  recentDirty = true
  scheduleRecentFlush()
  return merged
}

function blockedMessage(pack) {
  if (pack.error !== undefined) {
    return `素材库读不到：${pack.error}。检查配置项 remotes 指向的清单地址。`
  }
  if (pack.manifest !== undefined && pack.manifest.error !== undefined) {
    return `${pack.manifest.error}（其余图册照常可用）`
  }
  return `来源清单里找不到这些文件：${pack.missing.join('、')}。`
}

/** `sticker_catalog` — the whole pack, so the agent knows what exists. */
function catalogTool(config) {
  return {
    name: 'sticker_catalog',
    description:
      '列出表情包图册：每张图的 id、含义标签、尺寸与适用场景。'
      + '要往回复里插图时别自己拼路径，用 sticker_pick 返回的 markdown 字段。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          sources: { type: 'string' },
          ok: { type: 'boolean' },
          lines: { type: 'array', items: { type: 'string' } },
          notice: { type: 'string' },
        },
        required: ['count', 'sources', 'ok', 'lines'],
      },
      render: function (_args, value) {
        const lines = [`素材库 ${value.sources}（${value.count} 张）`].concat(value.lines)
        if (value.notice !== undefined) lines.push('', value.notice)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async function () {
      const read = await snapshotRemote(config)
      const pack = read.pack
      const value = {
        count: pack.stickers.length,
        sources: describeSources(read),
        ok: pack.ok,
        lines: library.formatCatalog(pack.stickers, { max: 40 }),
      }
      const notice = sourceNotice(read)
      if (!pack.ok) value.notice = blockedMessage(pack)
      else if (notice !== undefined) value.notice = notice
      return value
    },
  }
}

/** `sticker_pick` — one sticker plus the exact Markdown its reply must carry. */
function pickTool(config) {
  return {
    name: 'sticker_pick',
    description:
      '挑一张表情包，返回可直接贴进回复正文的 Markdown。'
      + '给 context：一句话描述这条回复的语气或场景（最能挑准）；'
      + '也可用 tag 按含义挑、或 id 精确指定，都不给就随机。count>1 会多给几张备选。'
      + '返回的 markdown 原样当成回复正文的一个片段，不要包进代码块、不要改写里面的路径。',
    parameters: {
      type: 'object',
      properties: {
        context: { type: 'string', description: '当前回复的语气/场景，一句话，最能挑准的一张' },
        id: { type: 'string', description: '图册里的表情包 id，如 glare / tea / fish / angry' },
        tag: { type: 'string', description: '按含义挑，匹配 id、标签、场景和说明里的文字' },
        avoid: { type: 'array', items: { type: 'string' }, description: '本轮不想重复出现的 id' },
        count: { type: 'number', description: '要几张候选，1-5，默认 1' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          path: { type: 'string' },
          markdown: { type: 'string' },
          bytes: { type: 'number' },
          matched: { type: 'string' },
          when: { type: 'string' },
          alternatives: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                markdown: { type: 'string' },
                when: { type: 'string' },
              },
              required: ['id', 'label', 'markdown'],
            },
          },
          notice: { type: 'string' },
        },
        required: ['id', 'label', 'path', 'markdown', 'bytes', 'matched'],
      },
      render: function (_args, value) {
        if (value.markdown === '') {
          const why = value.notice === undefined ? `挑不出表情包：${value.label}` : value.notice
          return [{ type: 'text', text: why }]
        }
        const lines = [
          `${value.id} — ${value.label}（匹配方式：${value.matched}）`,
          `路径：${value.path}`,
          '贴进回复的 Markdown：',
          value.markdown,
        ]
        if (value.when !== undefined) lines.push(`适用场景：${value.when}`)
        if (Array.isArray(value.alternatives) && value.alternatives.length > 0) {
          lines.push('', '备选（想换一张就直接用它的 markdown）：')
          for (const alternative of value.alternatives) {
            const when = alternative.when === undefined ? '' : ` ｜${alternative.when}`
            lines.push(`- ${alternative.id} — ${alternative.label}${when}`, `  ${alternative.markdown}`)
          }
        }
        if (value.notice !== undefined) lines.push('', value.notice)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async function (args, exec) {
      // The second gate. The prompt already announced this turn's outcome; a turn
      // that lost the toss does not get a sticker just because the model called
      // the tool anyway. `turnDecision` reads the very decision the prompt used.
      const caller = exec === undefined || exec === null ? undefined : exec.agent
      if (turnDecision(caller, probabilityOf(config)) === false) {
        return {
          id: '',
          label: '本轮不贴',
          path: '',
          markdown: '',
          bytes: 0,
          matched: 'turn-skipped',
          alternatives: [],
          notice: '本轮由宿主掷骰判定为「不贴」：这条回复不要贴表情包，也不需要重试。',
        }
      }
      const read = await snapshotRemote(config)
      const pack = read.pack
      if (pack.stickers.length === 0) {
        return {
          id: '',
          label: blockedMessage(pack),
          path: '',
          markdown: '',
          bytes: 0,
          matched: 'none',
          alternatives: [],
        }
      }
      const requested = args || {}
      const recentAll = readRecent()
      const window = Math.min(read.settings.recentWindow, Math.max(0, pack.stickers.length - 2))
      const query = {
        avoid: Array.isArray(requested.avoid) ? requested.avoid.map(String) : [],
        recent: recentAll.slice(0, window),
        count: requested.count,
      }
      if (typeof requested.id === 'string' && requested.id !== '') query.id = requested.id
      if (typeof requested.tag === 'string' && requested.tag !== '') query.tag = requested.tag
      if (typeof requested.context === 'string' && requested.context !== '') query.context = requested.context

      const result = await resolveSticker(config, read, query)
      const sticker = result.sticker
      // Every candidate was pending and every download failed. An empty markdown
      // is this tool's way of saying "no sticker this time" (see the
      // `markdown === ''` branch in `render`), and it beats a link to a file that
      // does not exist.
      if (sticker === undefined || sticker.pending === true) {
        return {
          id: '',
          label: '挑不出可用的表情包：远端图还没下载成功，换一张再试或先用本地素材库',
          path: '',
          markdown: '',
          bytes: 0,
          matched: 'none',
          alternatives: [],
        }
      }
      const describe = (candidate) => {
        const item = {
          id: candidate.id,
          label: candidate.label,
          markdown: candidate.link,
        }
        if (candidate.when !== undefined) item.when = candidate.when
        if (candidate.bytes > read.largeFileBytes) item.large = true
        return item
      }
      const value = {
        id: sticker.id,
        label: sticker.label,
        path: sticker.path,
        markdown: sticker.link,
        bytes: sticker.bytes,
        matched: result.matched,
        alternatives: result.alternatives.map((candidate) => describe(candidate.sticker)),
      }
      if (sticker.when !== undefined) value.when = sticker.when
      const used = [sticker.id].concat(value.alternatives.map((item) => item.id))
      const ledger = rememberRecent(used)
      const notes = []
      if (sticker.bytes > read.largeFileBytes) {
        notes.push(`这张 ${Math.round(sticker.bytes / 1024)} KB，偏大、加载会慢，能换就换一张。`)
      }
      const previous = recentAll.filter((id) => ledger.indexOf(id) !== -1 && id.toLowerCase() !== sticker.id.toLowerCase())
      if (previous.length > 0) notes.push(`最近用过：${previous.slice(0, 5).join('、')}（已尽量避开）。`)
      if (pack.manifest !== undefined && pack.manifest.error !== undefined) notes.push(pack.manifest.error)
      const remoteNote = sourceNotice(read)
      if (remoteNote !== undefined) notes.push(remoteNote)
      if (notes.length > 0) value.notice = notes.join(' ')
      return value
    },
  }
}

/** Registration of one tool, isolated so a bad definition cannot fail the plugin. */
function registerTool(tools, ctx, definition) {
  try {
    const dispose = tools.register(definition)
    trace(`tool ${definition.name}: registered`)
    return typeof dispose === 'function' ? dispose : function () {}
  } catch (err) {
    trace(`tool ${definition.name}: FAILED ${(err && err.stack) || String(err)}`)
    if (ctx.logger && ctx.logger.warn) ctx.logger.warn(`[sticker-pack] 工具 ${definition.name} 注册失败：${(err && err.message) || String(err)}`)
    return function () {}
  }
}

/**
 * `/sticker-pack/cat.json` and `/sticker-pack/i/<id>`. The handler owns the
 * whole response; the deployment's own authentication fences the route before
 * it reaches here, so nothing extra is checked.
 */
function registerRoutes(webServer, ctx, config) {
  function send(res, status, body, headers) {
    res.writeHead(status, headers)
    res.end(body)
  }

  async function catalog(_req, res) {
    // This endpoint is a human looking at the library, so it is worth one
    // refresh here (bounded by `remoteTtlMs`): without it a source that was just
    // added shows nothing until some reply happens to pick a sticker.
    let read
    try {
      read = await snapshotRemote(config)
    } catch (err) {
      read = snapshot(config)
    }
    const pack = read.pack
    send(res, 200, JSON.stringify({
      ok: pack.ok,
      sources: describeSources(read),
      remoteSources: read.remoteSources,
      manifest: pack.manifest,
      missing: pack.missing,
      stickers: pack.stickers.map((sticker) => ({
        id: sticker.id,
        label: sticker.label,
        tags: sticker.tags,
        when: sticker.when,
        width: sticker.width,
        height: sticker.height,
        bytes: sticker.bytes,
        pending: sticker.pending === true,
        url: `/sticker-pack/i/${encodeURIComponent(sticker.id)}`,
      })),
    }), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  }

  const json = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

  /**
   * Settings API for the plugin's settings page. `GET` reads, `POST` writes, and
   * `GET ?probability=0.8` also writes — a deliberate fallback because this
   * process cannot see the host's route table, and if plugin routes turn out to
   * be GET/HEAD-only (as `/api/*` is) the page would otherwise be read-only.
   */
  function settingsRoute(req, res) {
    const url = new URL(req.url || '/', 'http://x')
    if (req.method !== 'POST') {
      if (url.searchParams.has('probability')) {
        const result = applySettingsPatch(config, { probability: url.searchParams.get('probability') })
        trace(`settings: probability -> ${Math.round(result.probability * 100)}% (${result.source}) ok=${result.ok}`)
        send(res, result.ok ? 200 : 400, JSON.stringify(result), json)
        return
      }
      send(res, 200, JSON.stringify({ ok: true, ...settingsSnapshot(config) }), json)
      return
    }
    let body = ''
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      if (body.length > 16 * 1024) {
        settled = true
        send(res, 413, JSON.stringify({ ok: false, error: 'body too large' }), json)
        req.destroy()
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      let patch
      try {
        patch = body.trim() === '' ? {} : JSON.parse(body)
      } catch (err) {
        send(res, 400, JSON.stringify({ ok: false, error: 'body is not valid JSON' }), json)
        return
      }
      const result = applySettingsPatch(config, patch)
      trace(`settings: probability -> ${Math.round(result.probability * 100)}% (${result.source}) ok=${result.ok}`)
      send(res, result.ok ? 200 : 400, JSON.stringify(result), json)
    })
    req.on('error', () => {
      settled = true
    })
  }

  /**
   * The settings page itself, so the plugin owns a UI even when nothing in the
   * GUI registers one. Read once and kept: a static asset has no business doing
   * disk I/O per request.
   */
  let pageCache
  function page(_req, res) {
    if (pageCache === undefined) {
      try {
        pageCache = readFileSync(join(__dirname, 'settings.html'), 'utf8')
      } catch (err) {
        pageCache = null
        trace(`settings page unreadable: ${(err && err.message) || String(err)}`)
      }
    }
    if (pageCache === null) {
      send(res, 500, 'settings page unavailable — see boot.log', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    send(res, 200, pageCache, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  }

  /**
   * Stream one image. The bytes are cached by the client (`max-age`) and
   * re-validated by ETag, because the previous `no-cache` + `readFileSync`
   * combination re-read and re-sent a 12.8 MiB GIF on every render.
   */
  async function image(req, res) {
    const pathname = new URL(req.url || '/', 'http://x').pathname
    const id = decodeURIComponent(pathname.slice('/sticker-pack/i/'.length))
    const read = snapshot(config)
    let sticker = library.findSticker(read.pack.stickers, id)
    if (sticker !== undefined && sticker.pending === true) {
      // A mirrored image is fetched on its first request, so opening the catalog
      // in a browser warms the mirror instead of showing broken thumbnails.
      const fetched = await fetchPending(sticker, read)
      if (fetched !== undefined) {
        const again = library.findSticker(snapshot(config, { fresh: true }).pack.stickers, id)
        if (again !== undefined) sticker = again
      }
    }
    if (sticker === undefined) {
      send(res, 404, 'unknown sticker', { 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    let stat
    try {
      stat = statSync(sticker.path)
    } catch (err) {
      send(res, 404, `read failed: ${(err && err.message) || String(err)}`, { 'content-type': 'text/plain; charset=utf-8' })
      return
    }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
    const headers = {
      'content-type': library.mimeOf(sticker.path),
      'content-length': String(stat.size),
      'cache-control': 'public, max-age=86400',
      etag,
    }
    if (req.headers !== undefined && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': headers['cache-control'] })
      res.end()
      return
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(sticker.path)
    stream.on('error', (err) => {
      trace(`image stream failed for ${sticker.id}: ${(err && err.message) || String(err)}`)
      res.destroy()
    })
    stream.pipe(res)
  }

  const disposers = []
  try {
    disposers.push(webServer.register({ kind: 'exact', path: '/sticker-pack/cat.json', handler: catalog }))
    disposers.push(webServer.register({ kind: 'exact', path: '/sticker-pack/settings', handler: settingsRoute }))
    disposers.push(webServer.register({ kind: 'exact', path: '/sticker-pack/settings.html', handler: page }))
    disposers.push(webServer.register({ kind: 'exact', path: '/sticker-pack/', handler: page }))
    disposers.push(webServer.register({ kind: 'prefix', path: '/sticker-pack/i', handler: image }))
    trace('routes /sticker-pack/{cat.json,settings,settings.html,i}: registered')
  } catch (err) {
    trace(`routes: FAILED ${(err && err.stack) || String(err)}`)
    if (ctx.logger && ctx.logger.warn) ctx.logger.warn(`[sticker-pack] 路由注册失败（工具不受影响）：${(err && err.message) || String(err)}`)
  }
  return function () {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Wire `/sticker-pack/...` once the web server actually exists.
 *
 * The `webserver` row is contributed by `@deepseek-ai/dsh-web-app` — the bundle
 * immediately before this one — and cordis mounts rows asynchronously, so
 * reading the service during `apply` is a race. `ctx.get` is strict by default
 * and only answers for a provider fiber that is already ACTIVE, so losing that
 * race reads as `undefined` even though the server is plainly listening. The
 * first end-to-end boot logged exactly that: `webServer=undefined`, routes
 * never registered, both sticker URLs 404 while `/` returned 401.
 *
 * `ctx.inject` is cordis's own answer to this: the callback runs once the
 * requested service is available, and is unloaded and re-run if the provider is
 * replaced. The previous run's routes have to be torn down first, or the re-run
 * would trip the web server's `duplicate <kind> route` error.
 */
function registerRoutesWhenReady(ctx, config) {
  if (typeof ctx.inject !== 'function') {
    const webServer = service(ctx, 'webServer')
    if (webServer === undefined) {
      trace('routes: no ctx.inject and no webServer service, /sticker-pack routes NOT registered')
      return
    }
    trace('routes: no ctx.inject, registering directly')
    if (typeof ctx.effect === 'function') ctx.effect(function () { return registerRoutes(webServer, ctx, config) })
    else registerRoutes(webServer, ctx, config)
    return
  }
  ctx.inject(['webServer'], function (inner) {
    const webServer = service(inner, 'webServer')
    if (webServer === undefined) {
      trace('routes: webServer injected but still unreadable, /sticker-pack routes NOT registered')
      return
    }
    const disposeRoutes = registerRoutes(webServer, inner, config)
    if (typeof inner.effect === 'function') inner.effect(function () { return disposeRoutes })
    else trace('routes: no ctx.effect, relying on plugin disposal')
  })
}

/**
 * Add the sticker usage policy to the system prompt, once that service exists.
 *
 * `systemPrompt` is deliberately NOT in `inject`: declaring it there would make
 * the whole plugin wait for it, so a profile without the prompt service would
 * silently lose the tools as well — the same trap `webServer` is kept out of.
 * Going through `ctx.inject` keeps the dependencies independent.
 */
function registerPromptWhenReady(ctx, config) {
  /**
   * The section's text, evaluated once per assembly. The host decides, the
   * model is told what to do — that is the whole change from v0.3.0, where the
   * section only stated a probability and the model did the rolling.
   *
   * Both fixed ends of the slider skip the coin entirely: at 1 there is nothing
   * to decide, at 0 there is nothing to attach, and a constant text keeps the
   * prompt prefix cacheable.
   */
  const text = function (context) {
    const probability = probabilityOf(config)
    if (probability <= 0 || isSubagent(context)) return promptText(probability, false)
    if (probability >= 1) return promptText(probability, true)
    return promptText(probability, rollTurn(context, probability))
  }
  const register = function (scope) {
    const systemPrompt = service(scope, 'systemPrompt')
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      trace('prompt: systemPrompt service unreadable, sticker usage section NOT registered')
      return
    }
    try {
      systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text, interpolate: false })
      trace(`prompt: section "${PROMPT_SECTION}" registered (order ${PROMPT_ORDER}, ${Buffer.byteLength(text())}B fallback text, probability ${Math.round(probabilityOf(config) * 100)}%, host-rolled per turn)`)
    } catch (err) {
      trace(`prompt: section registration FAILED ${(err && err.stack) || String(err)}`)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], register)
  } else {
    register(ctx)
  }
  return watchTurnStarts(ctx)
}

/**
 * Retire the last turn's coin when a new turn starts.
 *
 * `rollTurn` already re-rolls when the turn's signal object changes, which is
 * what the shipped agent does. This is the independent second edge: on a host
 * that reuses one signal for every turn, only the session event would notice.
 * It is deliberately unattached to any effect — a host that never dispatches
 * `session/event` to a plugin context simply never calls it, and the signal edge
 * still carries the feature.
 */
function watchTurnStarts(ctx) {
  if (typeof ctx.on !== 'function') return undefined
  try {
    const off = ctx.on('session/event', function (session, event) {
      if (event === null || typeof event !== 'object' || event.type !== 'turn/start') return
      forgetTurn(session === null || typeof session !== 'object' ? undefined : session.id)
    }, { global: true })
    if (typeof off === 'function') return off
  } catch (err) {
    trace(`prompt: session/event listener not registered (${(err && err.message) || String(err)}); relying on the turn signal alone`)
  }
  return undefined
}

/**
 * Cordis plugin entry.
 * @param {object} ctx - the harness context.
 * @param {{directory?: string, largeFileBytes?: number, httpBaseUrl?: string,
 *          recentWindow?: number, scanTtlMs?: number, prompt?: boolean,
 *          probability?: number}} [config]
 */
function apply(ctx, config) {
  const disposers = []
  try {
    const tools = service(ctx, 'tools')
    const webServer = service(ctx, 'webServer')
    trace(`apply entered — tools=${typeof tools} webServer=${typeof webServer} ${ctxSummary(ctx)}`)
    if (tools === undefined) {
      trace('apply: no tools service, sticker tools NOT registered')
    } else {
      disposers.push(registerTool(tools, ctx, catalogTool(config)))
      disposers.push(registerTool(tools, ctx, pickTool(config)))
    }
    registerRoutesWhenReady(ctx, config)
    if ((config || {}).prompt === false) trace('prompt: disabled by config')
    else {
      const stopPrompt = registerPromptWhenReady(ctx, config)
      if (typeof stopPrompt === 'function') disposers.push(stopPrompt)
    }
  } catch (err) {
    trace(`apply THREW: ${(err && err.stack) || String(err)}`)
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', function () {
      for (const dispose of disposers) dispose()
      flushRecent()
    })
  }
  trace('apply finished')
}

module.exports = {
  name,
  inject,
  apply,
  default: { name, inject, apply },
  library,
  // Exported for test/selftest.js and test/perf-probe.js only.
  promptText,
  // The host's per-turn coin. `TURN_DECISIONS` is deliberately not exported: the
  // tests drive it through `rollTurn`/`forgetTurn`, which is what the plugin
  // itself uses.
  rollTurn,
  forgetTurn,
  turnDecision,
  isSubagent,
  settingsSnapshot,
  applySettingsPatch,
  probabilityOf,
}
