/* Real cordis + real client.js: proves the version list and hover notes work
   against the exact fiber topology the gateway uses (sibling fibers). */
import { JSDOM } from 'jsdom'
import { Context, Service } from '@deepseek-ai/cordis'

const dom = new JSDOM(`<!doctype html><html><body>
<div class="w6M7KW_pageBody" data-plugin-body><ul class="cards">
<li class="w6M7KW_card" data-plugin-package="dsh-mcp-connector" data-plugin-status="running">
  <div class="w6M7KW_cardHead"><span class="w6M7KW_cardIcon"></span>
  <div class="w6M7KW_cardMain"><div class="w6M7KW_titleRow">
    <button class="w6M7KW_cardTitle cardOpen">dsh-mcp-connector</button>
    <span class="w6M7KW_statusTag">可更新</span></div>
    <span class="w6M7KW_cardDesc">MCP connector</span></div>
  <div class="w6M7KW_cardEnd"><span class="w6M7KW_bundleToggle">
    <span class="w6M7KW_toggleProgress" role="status"></span>
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
Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'req-1' }, configurable: true })
window.__ModuleLoader__ = { load(def) { globalThis.__reg = def } }

const calls = []
globalThis.fetch = async (url) => {
  calls.push(String(url))
  if (String(url).includes('registry')) return { ok: true, json: async () => ({ version: '0.2.100', repository: { url: 'git+https://github.com/duhu2000/dsh-mcp-connector.git' } }) }
  if (String(url).includes('api.github.com')) return { ok: true, json: async () => ([
    { tag_name: 'v0.2.100', published_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/duhu2000/dsh-mcp-connector/releases/tag/v0.2.100', body: '修复 · 修复 MCP 连接超时' },
  ]) }
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

// the gateway mounts namespaces as their own fiber under a dotted name
class Ns extends Service {
  async listVersions(name, options) {
    calls.push(['listVersions', name, JSON.stringify(options)])
    return { ok: true, value: { status: 'listed', installed: '0.2.96', registry: 'registry.npmmirror.com', versions: [
      { version: '0.2.100', publishedAt: '2026-11-01T00:00:00Z', tags: ['latest'], prerelease: false, bundle: true },
      { version: '0.2.99', publishedAt: '2026-10-20T00:00:00Z', tags: [], prerelease: false, bundle: true },
    ] } }
  }
  async updateBundle(name, version, options) {
    calls.push(['updateBundle', name, version])
    return { ok: true, value: { from: '0.2.96', to: version, step: 'install', result: { changed: true, application: 'applied' } } }
  }
}
if (process.env.PUE_NO_SERVICE) { console.log('NO_SERVICE mode') } else new Ns(root, 'remote.pluginManager')

await root.plugin({ name: reg.id, inject: reg.inject, apply: reg.factory({}).apply })
await new Promise((r) => setTimeout(r, 200))

const btn = document.querySelector('.pue-btn')
console.log('1 button', btn?.textContent.trim(), 'beforeSwitch', btn?.nextElementSibling === document.querySelector('.bundleToggle'))
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 400))
console.log('2 rows', [...document.querySelectorAll('.pue-row')].map((r) => r.textContent.trim().slice(0, 22)))
console.log('3 body', document.querySelector('.pue-body')?.textContent.trim().slice(0, 60))

const row = document.querySelectorAll('.pue-row')[0]
row.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }))
await new Promise((r) => setTimeout(r, 400))
console.log('4 hover', document.querySelector('.pue-notes')?.textContent.trim().slice(0, 60))
row.dispatchEvent(new window.PointerEvent('pointerleave', { bubbles: false }))
await new Promise((r) => setTimeout(r, 400))
console.log('5 afterLeave', !!document.querySelector('.pue-notes'))
console.log('popoverAlive', !!document.querySelector('.pue-pop'), 'rowsNow', document.querySelectorAll('.pue-row').length)
const rowBtn = [...document.querySelectorAll('.pue-row')][0]
rowBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 200))
const foot = [...document.querySelectorAll('.pue-pop button')].find((b) => /^更新到/.test(b.textContent.trim()))
foot.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 200))
console.log('6a confirm', document.querySelector('.pue-confirm')?.textContent.trim().slice(0, 50))
const go = [...document.querySelectorAll('.pue-pop button')].find((b) => b.textContent.trim() === '更新')
console.log('6 popText', document.querySelector('.pue-pop')?.textContent.trim().slice(0, 160))
console.log('6b buttons', [...document.querySelectorAll('.pue-pop button')].map((b) => b.textContent.trim().slice(0, 20)))
console.log('6c confirm', !!go)
go.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 500))
console.log('7 update', document.querySelector('.pue-pop')?.textContent.trim().slice(0, 80))
console.log('8 calls', JSON.stringify(calls.filter((c) => Array.isArray(c))))
