/**
 * dsh-sticker-pack — client half (hand-written, no build step).
 *
 * A DSH client plugin is not an ES module: it is a plain script that calls
 * `window.__ModuleLoader__.load({ id, factory })` at load time, where `id` must
 * equal this package's name and `factory(require)` returns the CJS exports the
 * host will read (`apply`, `inject`). The host picks this file up because
 * `package.json` declares `dsh.client.platform === "web"` and maps
 * `exports["./client"]` to it, then serves it from `/plugins/<pkg>/client.js`.
 *
 * It contributes one entry to the host's `settings.section` slot, so the sticker
 * probability and the wait budget (5..30 s slider plus an uncapped seconds
 * field) are editable inside DSH's own Settings — no separate page needed.
 * The plugin's HTTP page (`/sticker-pack/settings.html`) stays as the fallback
 * and as the thing that works without the GUI.
 *
 * Deliberately dependency-light: `react` only (a platform seed word), no locale
 * service, no CSS file, inline styles. Every extra service named in `inject` is
 * another way for this entry to end up `failed`, and the load-bearing one is
 * `slots` — without it `ctx.slots` is unreachable and the entry fails to boot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sticker-pack',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const ENDPOINT = '/sticker-pack/settings'
    const inject = ['slots']
    const percent = (value) => Math.round(Number(value) * 100)

    // The wait budget — how long a reply may block on an unreachable remote
    // source. The slider covers 5..30 s; the number field has no upper clamp,
    // because the right number is a property of this machine's network, not of
    // the plugin. Both write `deadlineMs` into the same settings.json.
    const SLIDER_MIN_SECONDS = 5
    const SLIDER_MAX_SECONDS = 30
    const secondsOf = (ms) => Math.round(Number(ms) / 100) / 10
    const msOfSeconds = (value) => Math.round(Number(value) * 1000)
    const insideSlider = (value) => value >= SLIDER_MIN_SECONDS && value <= SLIDER_MAX_SECONDS
    const sliderSeconds = (value) =>
      String(Math.min(SLIDER_MAX_SECONDS, Math.max(SLIDER_MIN_SECONDS, Math.round(value))))

    async function call(url, options) {
      const response = await fetch(url, options)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    const styles = {
      wrap: { padding: '4px 0' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      slider: { flex: '1 1 220px', minWidth: '160px' },
      value: { fontVariantNumeric: 'tabular-nums', minWidth: '52px', textAlign: 'right' },
      button: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
      },
      note: { marginTop: '8px', fontSize: '12px', opacity: 0.75, lineHeight: 1.6 },
      hint: { fontSize: '12px', opacity: 0.75, lineHeight: 1.6 },
      number: { width: '88px', padding: '2px 6px' },
      link: { color: 'inherit' },
    }

    /** One line about where the pictures actually came from. */
    function describeLibrary(pack) {
      const remotes = Array.isArray(pack.remoteSources) ? pack.remoteSources : []
      const parts = []
      if (remotes.length === 0) {
        parts.push('还没配置远端素材库')
      } else {
        const live = remotes.filter((source) =>
          source.status === 'ok' || source.status === 'cached' || source.status === 'stale').length
        parts.push(`远端 ${live}/${remotes.length} 个源可用`)
      }
      const pending = Array.isArray(pack.stickers)
        ? pack.stickers.filter((sticker) => sticker.pending === true).length
        : 0
      if (pending > 0) parts.push(`${pending} 张用到时才下载`)
      return parts.join(' · ')
    }

    function Panel() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [pack, setPack] = React.useState(null)
      const [draft, setDraft] = React.useState(0.6)
      const [note, setNote] = React.useState('读取中…')
      const [deadline, setDeadline] = React.useState(15000)
      const [deadlineText, setDeadlineText] = React.useState('')
      const [deadlineNote, setDeadlineNote] = React.useState('等待上限：默认 15 秒')

      const refresh = React.useCallback(async () => {
        try {
          const body = await call(ENDPOINT)
          setSnapshot(body)
          setDraft(body.probability)
          setNote(`当前 ${percent(body.probability)}%（来源：${body.source}）`)
          setDeadline(body.deadlineMs)
          setDeadlineText(insideSlider(secondsOf(body.deadlineMs)) ? '' : String(secondsOf(body.deadlineMs)))
          setDeadlineNote(`当前 ${secondsOf(body.deadlineMs)} 秒（来源：${body.deadlineSource}）`)
        } catch (error) {
          setNote(`读不到设置：${error.message}`)
        }
        // Best effort: the pack listing is decoration here, so its failure is not
        // allowed to turn the probability panel into an error message.
        try {
          setPack(await call('/sticker-pack/cat.json'))
        } catch (error) {
          setPack(null)
        }
      }, [])

      React.useEffect(() => {
        refresh()
      }, [refresh])

      const save = async (value) => {
        setNote('保存中…')
        try {
          const body = await call(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ probability: value }),
          })
          setSnapshot(body)
          setDraft(body.probability)
          setNote(`已保存 ${percent(body.probability)}% — 下一条回复就按它来，不用重启`)
        } catch (error) {
          setNote(`保存失败：${error.message}`)
        }
      }

      const pick = (value) => {
        setDraft(value)
        save(value)
      }

      const saveDeadline = async (value) => {
        setDeadlineNote('保存中…')
        try {
          const body = await call(ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deadlineMs: msOfSeconds(value) }),
          })
          setDeadline(body.deadlineMs)
          setDeadlineText(insideSlider(secondsOf(body.deadlineMs)) ? '' : String(secondsOf(body.deadlineMs)))
          setDeadlineNote(`已保存 ${secondsOf(body.deadlineMs)} 秒 — 下一条回复就按它来，不用重启`)
        } catch (error) {
          setDeadlineNote(`保存失败：${error.message}`)
        }
      }

      const pickDeadline = (value) => {
        setDeadline(msOfSeconds(value))
        setDeadlineText(insideSlider(value) ? '' : String(value))
        saveDeadline(value)
      }

      // The free field only commits on blur or Enter, so a half-typed number
      // never gets written to disk.
      const commitDeadlineText = () => {
        const raw = String(deadlineText).trim()
        if (raw === '') {
          setDeadlineText(insideSlider(secondsOf(deadline)) ? '' : String(secondsOf(deadline)))
          return
        }
        const value = Number(raw)
        if (!Number.isFinite(value) || value <= 0) {
          setDeadlineNote('秒数要填一个大于 0 的数字')
          return
        }
        saveDeadline(value)
      }

      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.row },
          h('input', {
            type: 'range',
            min: '0',
            max: '100',
            step: '5',
            value: String(percent(draft)),
            style: styles.slider,
            onChange: (event) => setDraft(Number(event.target.value) / 100),
            onMouseUp: (event) => save(Number(event.target.value) / 100),
            onKeyUp: (event) => save(Number(event.target.value) / 100),
          }),
          h('span', { style: styles.value }, `${percent(draft)}%`),
          ...[0, 0.3, 0.6, 1].map((value) =>
            h(
              'button',
              { key: String(value), type: 'button', style: styles.button, onClick: () => pick(value) },
              value === 1 ? '总是' : value === 0 ? '从不' : `${percent(value)}%`,
            ),
          ),
        ),
        h('div', { style: styles.note }, note),
        h(
          'div',
          { style: { ...styles.row, marginTop: '14px' } },
          h('span', { style: styles.value }, '等待上限'),
          h('input', {
            type: 'range',
            min: String(SLIDER_MIN_SECONDS),
            max: String(SLIDER_MAX_SECONDS),
            step: '1',
            value: sliderSeconds(secondsOf(deadline)),
            style: styles.slider,
            onChange: (event) => {
              setDeadline(msOfSeconds(Number(event.target.value)))
              setDeadlineText('')
            },
            onMouseUp: (event) => saveDeadline(Number(event.target.value)),
            onKeyUp: (event) => saveDeadline(Number(event.target.value)),
          }),
          h('span', { style: styles.value }, `${secondsOf(deadline)} 秒`),
          ...[5, 10, 15, 30].map((value) =>
            h(
              'button',
              { key: String(value), type: 'button', style: styles.button, onClick: () => pickDeadline(value) },
              value === 15 ? '默认' : `${value} 秒`,
            ),
          ),
        ),
        h(
          'div',
          { style: styles.row },
          h('span', { style: styles.value }, '自定义'),
          h('input', {
            type: 'number',
            min: '1',
            step: '1',
            value: deadlineText,
            placeholder: '例如 90',
            style: styles.number,
            onChange: (event) => setDeadlineText(event.target.value),
            onBlur: commitDeadlineText,
            onKeyDown: (event) => {
              if (event.key === 'Enter') commitDeadlineText()
            },
          }),
          h('span', { style: styles.hint }, '秒，无上限（填完按回车或点别处才保存）'),
        ),
        h('div', { style: styles.note }, deadlineNote),
        h(
          'div',
          { style: styles.hint },
          '等待上限＝某个远端素材库连不上时，这条回复最多等它多久；设得越大，连不上的那轮就等得越久。',
        ),
        h(
          'div',
          { style: styles.note },
          '掷骰的是插件，不是模型：命中的那一轮，模型收到的指令是「本轮要贴一张」，没命中就是「本轮不贴」。',
        ),
        pack !== null && Array.isArray(pack.stickers)
          ? h('div', { style: styles.note }, `素材库：${pack.stickers.length} 张 · ${describeLibrary(pack)}`)
          : null,
        h(
          'div',
          { style: styles.note },
          h('a', { style: styles.link, href: '/sticker-pack/settings.html', target: '_blank', rel: 'noreferrer' }, '独立设置页'),
          ' · ',
          h('a', { style: styles.link, href: '/sticker-pack/cat.json', target: '_blank', rel: 'noreferrer' }, '图册 JSON'),
          snapshot !== null && snapshot.file !== undefined ? ` · 状态文件：${snapshot.file}` : '',
        ),
      )
    }

    function apply(ctx) {
      const register = () =>
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'sticker-pack',
              // Built-in sections sit in the 10..30 range, so this lands after them.
              order: 60,
              label: () => '表情包',
            },
            Panel,
          ),
        )
      if (typeof ctx.effect === 'function') ctx.effect(register)
      else register()
    }

    return { apply, inject }
  },
})
