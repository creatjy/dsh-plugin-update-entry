/* Two reports from the page, both about the bulk panel disagreeing with the
   official list:

   1. a package the list calls updatable but whose registry answer held no
      versions must not occupy a row saying "up to date" — the row is hidden;
   2. a package whose version read failed must not be skipped in silence when a
      run starts: the run re-reads it, and only skips after that read too fails.

   The second one is the dangerous shape — "nothing to install" and "the read
   never landed" look identical to a bare skip, and a real update disappears. */
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'

const P = process.env.PUE_PREFIX || 'w6M7KW_'
const dom = new JSDOM(`<!doctype html><html><body>
<div class="${P}toolbar" data-plugin-toolbar="true">
  <span class="${P}updatesNote" data-tone="info">3 个插件可更新</span>
  <button aria-label="刷新">刷新</button>
</div>
<div class="${P}pageBody" data-plugin-body><ul class="${P}cards"></ul></div></body></html>`,
{ url: 'http://127.0.0.1:62883/' })
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

const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  if (String(url).includes('registry')) {
    return { ok: true, json: async () => ({ version: '9.9.9', repository: { url: 'git+https://github.com/example-org/x.git' } }) }
  }
  if (String(url).includes('api.github.com')) {
    return { ok: true, json: async () => ([{ tag_name: 'v3.0.0', published_at: '2026-11-02T00:00:00Z', html_url: 'https://github.com/example-org/x/releases/tag/v3.0.0', body: '说明' }]) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

const root = new Context()
class Locale extends Service {
  register() { return () => {} }
  bind() { return (k) => k }
}
new Locale(root, 'locale')
class Remote extends Service { $on() { return () => {} } }
new Remote(root, 'remote')

const CLIENT = new URL('../../client.js', import.meta.url).pathname
await import(CLIENT)
const reg = globalThis.__reg

/* dsh-ops: the Host lists it as updatable, the registry answer is empty.
   dsh-flaky: the first version read throws, the retry finds an update.
   dsh-dead: every version read throws — it may only be skipped, never hidden. */
const reads = { 'dsh-flaky': 0, 'dsh-dead': 0 }
class Ns extends Service {
  async listBundles() {
    calls.push(['listBundles'])
    return { ok: true, value: [
      { name: 'dsh-flaky', installed: true, updatable: true, version: '2.5.0' },
      { name: 'dsh-ops', installed: true, updatable: true, version: '0.9.1' },
      { name: 'dsh-dead', installed: true, updatable: true, version: '1.0.0' },
    ] }
  }
  async listVersions(name) {
    calls.push(['listVersions', name])
    if (name === 'dsh-ops') {
      return { ok: true, value: { status: 'listed', installed: '0.9.1', registry: 'registry.npmjs.org', versions: [] } }
    }
    reads[name] = (reads[name] || 0) + 1
    if (name === 'dsh-dead' || reads[name] < 2) throw new Error('plugin-manager: HTTP 500')
    return { ok: true, value: {
      status: 'listed', installed: '2.5.0', registry: 'registry.npmjs.org',
      versions: [{ version: '2.6.4', publishedAt: '2026-11-12T00:00:00Z', tags: ['latest'], prerelease: false, bundle: true }],
    } }
  }
  async updateBundle(name, version) {
    calls.push(['updateBundle', name, version])
    await new Promise((r) => setTimeout(r, 10))
    return { ok: true, value: { from: 'old', to: version, step: 'install', result: { changed: true, application: 'applied' } } }
  }
}
new Ns(root, 'remote.pluginManager')

await root.plugin({ name: reg.id, inject: reg.inject, apply: reg.factory({}).apply })
const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms))
await tick(250)

const all = document.querySelector('.pue-all')
all.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(400)

const names = () => [...document.querySelectorAll('.pue-bulk-item')].map((n) => n.querySelector('.pue-bulk-name').textContent)
console.log('1 rows', JSON.stringify(names()))
console.log('1b noUpToDateNote', ![...document.querySelectorAll('.pue-bulk-note')].some((n) => n.textContent.trim() === '已是最新版本'))
console.log('2 picks', JSON.stringify([...document.querySelectorAll('.pue-bulk-pick')].map((b) => `${b.getAttribute('data-state')}|${b.textContent.trim()}`)))
console.log('2b reads', JSON.stringify(reads))

const run = [...document.querySelectorAll('.pue-panel button')].find((b) => /^更新 \d+ 个$/.test(b.textContent.trim()))
console.log('3 runButton', run?.textContent.trim(), 'disabled', run?.disabled)
run.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(900)

console.log('4 updates', JSON.stringify(calls.filter((c) => c[0] === 'updateBundle')))
console.log('4b readsAfterRun', JSON.stringify(reads))
console.log('4c states', JSON.stringify([...document.querySelectorAll('.pue-bulk-line')]
  .map((n) => `${n.querySelector('.pue-bulk-name').textContent}:${n.querySelector('span:last-child').textContent.trim()}`)))
console.log('4d foot', document.querySelector('.pue-bulk-foot')?.textContent.trim().slice(0, 80))
console.log('4e opsHidden', !names().includes('dsh-ops'))
