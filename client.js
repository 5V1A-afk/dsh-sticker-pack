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
 * probability is editable inside DSH's own Settings — no separate page needed.
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

      const refresh = React.useCallback(async () => {
        try {
          const body = await call(ENDPOINT)
          setSnapshot(body)
          setDraft(body.probability)
          setNote(`当前 ${percent(body.probability)}%（来源：${body.source}）`)
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
