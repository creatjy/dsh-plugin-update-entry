/* Bulk update surface against the real client.js: the toolbar button that sits
   next to the official "N plugins can be updated" note, the panel it opens, the
   per-item version picker, and release notes on those version rows.

   The note is React state and disappears while a refresh is running, so the
   harness also removes it mid-run to prove the panel (and the run) survive. */
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'

const P = process.env.PUE_PREFIX || 'w6M7KW_'
const dom = new JSDOM(`<!doctype html><html><body>
<div class="${P}pageBar" data-plugin-header-part="toolbar-host">
  <div class="${P}toolbar" data-plugin-toolbar="true" data-plugin-header-part="toolbar">
    <span class="${P}updatesNote" data-tone="info">2 个插件可更新</span>
    <button aria-label="刷新">刷新</button>
    <span class="${P}addGroup"><button aria-label="添加插件">添加插件</button></span>
  </div>
</div>
<div class="${P}pageBody" data-plugin-body><ul class="${P}cards">
<li class="${P}card" data-plugin-package="dsh-free-search">
  <div class="${P}cardHead"><div class="${P}cardMain"><div class="${P}titleRow">
    <button class="${P}cardTitle">dsh-free-search</button>
    <span class="${P}statusTag">可更新</span></div></div>
  <div class="${P}cardEnd"><span class="${P}bundleToggle">
    <button role="switch" aria-checked="true"></button></span></div></div></li>
</ul></div></body></html>`, { url: 'http://127.0.0.1:62881/' })
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
    const name = decodeURIComponent(String(url).split('/').slice(-2)[0])
    return { ok: true, json: async () => ({ version: '9.9.9', repository: { url: `git+https://github.com/example-org/${name}.git` } }) }
  }
  if (String(url).includes('api.github.com')) {
    return { ok: true, json: async () => ([
      { tag_name: 'v0.9.43', published_at: '2026-11-02T00:00:00Z', html_url: 'https://github.com/example-org/x/releases/tag/v0.9.43', body: '发布说明 · 修复搜索超时' },
      { tag_name: 'v0.9.42', published_at: '2026-10-20T00:00:00Z', html_url: 'https://github.com/example-org/x/releases/tag/v0.9.42', body: '旧版说明' },
    ]) }
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

const VERSIONS = {
  'dsh-free-search': ['0.9.43', '0.9.42'],
  'dsh-mcp-connector': ['0.2.100', '0.2.99'],
}

/* A package the Host lists but refuses to install here (needs a newer DSH).
 * The official page leaves it unselected; so must the panel. */
const BLOCKED = {
  'dsh-model-think-level': { requirements: { '@deepseek-ai/dsh': '>=0.3.0' }, runtimeVersion: '0.2.2-rc.1' },
};

/* Version checks finish one by one in the background. Holding one of them lets
 * the harness release it *while* release notes are open, which is exactly what
 * rebuilds the panel body underneath the bubble. */
const gates = new Map()
const hold = (name) => { gates.set(name, null) }
const release = (name) => { const resume = gates.get(name); gates.delete(name); resume?.() }

class Ns extends Service {
  async listBundles() {
    calls.push(['listBundles'])
    return { ok: true, value: [
      { name: 'dsh-mcp-connector', installed: true, updatable: true, version: '0.2.96' },
      { name: 'dsh-free-search', installed: true, updatable: true, version: '0.9.40' },
      { name: 'dsh-context', installed: true, updatable: false, version: '0.83.1' },
      { name: 'dsh-model-think-level', installed: true, updatable: true, version: '0.1.2' },
      { name: 'not-installed', installed: false, updatable: true, version: '1.0.0' },
    ] }
  }
  async listVersions(name) {
    calls.push(['listVersions', name])
    if (gates.has(name)) await new Promise((resume) => gates.set(name, resume))
    return { ok: true, value: {
      status: 'listed',
      installed: name === 'dsh-free-search' ? '0.9.40' : '0.2.96',
      registry: 'registry.npmmirror.com',
      versions: (VERSIONS[name] || ['0.1.3', '0.1.2']).map((version, index) => ({
        version, publishedAt: `2026-11-0${index + 1}T00:00:00Z`, tags: index ? [] : ['latest'], prerelease: false, bundle: true,
        ...(BLOCKED[name] ? { incompatible: { name, version, ...BLOCKED[name] } } : {}),
      })),
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

hold('dsh-mcp-connector')

const note = document.querySelector('[class*="updatesNote"]')
const all = document.querySelector('.pue-all')
console.log('1 button', all?.textContent.trim(), 'afterNote', note?.nextElementSibling === all)
console.log('1b note', note?.textContent.trim())

all.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(300)
const panel = document.querySelector('.pue-panel')
console.log('2 panel', !!panel, 'expanded', all.getAttribute('aria-expanded'))
console.log('2b items', [...document.querySelectorAll('.pue-bulk-item')].map((n) => n.querySelector('.pue-bulk-head').textContent.trim()))
console.log('2c names', [...document.querySelectorAll('.pue-bulk-item')].map((n) => n.querySelector('.pue-bulk-name').textContent))
console.log('2d bundles called', calls.filter((c) => c[0] === 'listBundles').length)
console.log('2e blocked', [...document.querySelectorAll('.pue-bulk-item')]
  .filter((n) => n.querySelector('.pue-bulk-note'))
  .map((n) => n.querySelector('.pue-bulk-name').textContent + '|' + n.querySelector('.pue-bulk-note').textContent.trim()))

// expanding one item must show its versions and pick the newest as the target
const firstItem = document.querySelectorAll('.pue-bulk-item')[0]
firstItem.querySelector('.pue-bulk-head').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(300)
console.log('3 open', firstItem.getAttribute('data-open') === undefined ? 'stale' : document.querySelector('.pue-bulk-item[data-open="true"]')?.getAttribute('data-state'))
console.log('3b rows', [...document.querySelectorAll('.pue-panel .pue-row')].map((r) => r.getAttribute('data-version')))
console.log('3c pick', [...document.querySelectorAll('.pue-bulk-pick')].map((b) => b.textContent.trim()))

// release notes on a version row of the bulk panel
const row = document.querySelector('.pue-panel .pue-row')
row.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }))
await tick(400)
const bubble = document.querySelector('.pue-notes')
console.log('4 hover', bubble?.getAttribute('data-fixed'), bubble?.textContent.trim().slice(0, 40))
row.dispatchEvent(new window.PointerEvent('pointerleave', { bubbles: false }))
await tick(400)
console.log('5 afterLeave', !!document.querySelector('.pue-notes'))

// a background version check finishing must not steal the open notes
const again = document.querySelector('.pue-panel .pue-row')
again.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }))
await tick(400)
console.log('5b reopened', document.querySelector('.pue-notes')?.textContent.trim().slice(0, 12))
release('dsh-mcp-connector')
await tick(700)
const survived = document.querySelector('.pue-notes')
const pinned = document.querySelector('.pue-panel .pue-bulk-item[data-name="dsh-free-search"] .pue-row[aria-describedby]')
console.log('5c survived', survived?.getAttribute('data-fixed'), survived?.textContent.trim().slice(0, 12),
  'pinned', pinned?.getAttribute('data-version'))
console.log('5d rows', [...document.querySelectorAll('.pue-bulk-pick')].map((b) => b.textContent.trim()))

// choosing the older version must retarget that item only
const older = [...document.querySelectorAll('.pue-panel .pue-row')][1]
older.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(200)
console.log('6 retarget', [...document.querySelectorAll('.pue-bulk-pick')].map((b) => b.textContent.trim()))

// the note disappearing (a refresh) must not kill the panel
note.remove()
await tick(200)
console.log('7 noteGone button', !!document.querySelector('.pue-all'), 'panel', !!document.querySelector('.pue-panel'))

const runButton = [...document.querySelectorAll('.pue-panel button')].find((b) => /^更新 \d+ 个$/.test(b.textContent.trim()))
console.log('8 runButton', runButton?.textContent.trim(), 'disabled', runButton?.disabled)
runButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await tick(600)
console.log('9 updates', JSON.stringify(calls.filter((c) => c[0] === 'updateBundle')))
console.log('9b foot', document.querySelector('.pue-bulk-foot')?.textContent.trim().slice(0, 60))
console.log('9c states', [...document.querySelectorAll('.pue-bulk-line')].map((n) => `${n.querySelector('.pue-bulk-name').textContent}:${n.textContent.replace(n.querySelector('.pue-bulk-name').textContent, '').trim()}`))
console.log('9d panelAlive', !!document.querySelector('.pue-panel'))
