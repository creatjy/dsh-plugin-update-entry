/* Recovery of a failed version check inside the bulk panel.

   The live failure this reproduces: a package shows "选择版本" in the panel, the
   user clicks it, and nothing is ever retrieved. The card never had the bug
   because opening it goes through `loadVersions`, which re-queries whenever the
   cache is stale and offers a 重试 button when the query failed. The panel only
   ever queried once, at list time, so a single failed (or raced) check left the
   row permanently dead — every click re-rendered the same message and no
   request was ever issued again.

   This harness fails the first `listVersions` for one package and then asserts
   the two escape hatches the card already had: expanding the row re-queries it,
   and the error state offers 重试. */
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'

const P = process.env.PUE_PREFIX || 'w6M7KW_'
const dom = new JSDOM(`<!doctype html><html><body>
<div class="${P}toolbar" data-plugin-toolbar="true" data-plugin-header-part="toolbar">
  <span class="${P}updatesNote" data-tone="info">2 个插件可更新</span>
  <button aria-label="刷新">刷新</button>
</div>
<div class="${P}pageBody" data-plugin-body><ul class="${P}cards"><li class="${P}card"
  data-plugin-package="dsh-context">
  <div class="${P}cardEnd"><span class="${P}bundleToggle"><button role="switch"></button></span></div>
</li></ul></div></body></html>`, { url: 'http://127.0.0.1:62882/' })

const { window } = dom
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  localStorage: window.localStorage, sessionStorage: window.sessionStorage,
})
Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => `req-${Math.random().toString(16).slice(2)}` }, configurable: true })
window.__ModuleLoader__ = { load(def) { globalThis.__reg = def } }
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) })

const calls = []
const root = new Context()
class Locale extends Service { register() { return () => {} } bind() { return (k) => k } }
new Locale(root, 'locale')
class Remote extends Service { $on() { return () => {} } }
new Remote(root, 'remote')

/* dsh-context fails its first version check and succeeds on every later one —
 * exactly the transient failure a flaky registry or a half-mounted gateway
 * produces. */
let attempts = 0
class Ns extends Service {
  async listBundles() {
    return { ok: true, value: [
      { name: 'dsh-context', installed: true, updatable: true, version: '0.83.1' },
    ] }
  }
  async listVersions(name) {
    attempts += 1
    calls.push(['listVersions', name, attempts])
    if (attempts <= 2) throw new Error('plugin-manager: HTTP 500')
    return { ok: true, value: {
      status: 'listed', installed: '0.83.1', registry: 'registry.npmjs.org',
      versions: [
        { version: '0.84.1', publishedAt: '2026-11-13T00:00:00Z', tags: ['latest'], prerelease: false, bundle: true },
        { version: '0.84.0', publishedAt: '2026-11-12T00:00:00Z', tags: [], prerelease: false, bundle: true },
      ],
    } }
  }
  async updateBundle(name, version) {
    calls.push(['updateBundle', name, version])
    return { ok: true, value: { from: '0.83.1', to: version, step: 'install', result: { changed: true, application: 'applied' } } }
  }
}
new Ns(root, 'remote.pluginManager')

const CLIENT = new URL('../../client.js', import.meta.url).pathname
await import(CLIENT)
const reg = globalThis.__reg
await root.plugin({ name: reg.id, inject: reg.inject, apply: reg.factory({}).apply })
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))
await tick(250)

const all = document.querySelector('.pue-all')
console.log('1 button', all?.textContent.trim() ?? 'missing')
all.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(400)

const item = () => document.querySelector('.pue-bulk-item[data-name="dsh-context"]')
console.log('2 failedPick', item()?.querySelector('.pue-bulk-pick')?.textContent.trim())
console.log('2b note', item()?.querySelector('.pue-bulk-note')?.textContent.trim())

/* Expanding the row must retry, the way opening the card does. This retry also
 * fails, so the row is now expanded AND failed — the state in which a retry
 * button has to be reachable. */
item().querySelector('.pue-bulk-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(400)
console.log('3 open', item()?.getAttribute('data-open'))
console.log('3b attempts', attempts)
console.log('3c pick', item()?.querySelector('.pue-bulk-pick')?.textContent.trim())

const retry = [...(item()?.querySelectorAll('.pue-bulk-versions button') || [])]
  .find((b) => /重试|Retry/.test(b.textContent.trim()))
console.log('4 retryOffered', !!retry)
retry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(400)
console.log('4b rows', [...(item()?.querySelectorAll('.pue-row') || [])].map((r) => r.getAttribute('data-version')))
console.log('4c attempts', attempts)
console.log('4d pick', item()?.querySelector('.pue-bulk-pick')?.textContent.trim())
const run = [...document.querySelectorAll('.pue-panel button')].find((b) => /^更新 \d+ 个$/.test(b.textContent.trim()))
console.log('5 run', run?.textContent.trim(), 'disabled', run?.disabled)
run.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(500)
console.log('6 updates', JSON.stringify(calls.filter((c) => c[0] === 'updateBundle')))
console.log('6b foot', document.querySelector('.pue-bulk-foot')?.textContent.trim().slice(0, 40))
