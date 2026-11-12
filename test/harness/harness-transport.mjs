/* Proves the connection.rpc fallback: no namespace service at all, only a
   `connection` service exposing rpc.call, exactly like the gateway carrier. */
import { JSDOM } from 'jsdom'
const dom = new JSDOM(`<!doctype html><html><body>
<div data-plugin-body><ul><li data-plugin-package="dsh-free-search" data-plugin-status="running">
<div class="cardHead"><div class="cardMain"><div class="titleRow">
<button class="cardTitle cardOpen">dsh-free-search</button><span class="statusTag">可更新</span></div>
<span class="cardDesc">search</span></div>
<div class="cardEnd"><span class="bundleToggle"><button role="switch"></button></span></div></div>
</li></ul></div></body></html>`, { url: 'http://127.0.0.1:54943/' })
const { window } = dom
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Element: window.Element, Node: window.Node, MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle,
  requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0), cancelAnimationFrame: clearTimeout,
  localStorage: window.localStorage, sessionStorage: window.sessionStorage })
Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'r1' }, configurable: true })
window.__ModuleLoader__ = { load(d) { globalThis.__reg = d } }
globalThis.fetch = async (u) => String(u).includes('registry')
  ? { ok: true, json: async () => ({ version: '0.9.42', repository: { url: 'git+https://github.com/DDDMUC/dsh-free-search.git' } }) }
  : { ok: true, json: async () => ([{ tag_name: 'v0.9.42', published_at: '2026-11-02T00:00:00Z', body: '新增 Bing 引擎', html_url: 'https://github.com/DDDMUC/dsh-free-search/releases/tag/v0.9.42' }]) }

const calls = []
const ctx = {
  locale: { register: () => () => {}, bind: () => (k) => k },
  get(name) {
    if (name === 'connection') return {
      rpc: { call: async (path, endpoint, payload) => {
        calls.push([endpoint, Object.keys(payload.args).join('+')])
        if (endpoint === 'pluginManager/listVersions') return { ok: true, value: {
          status: 'listed', installed: '0.9.37', registry: 'registry.npmmirror.com',
          versions: [{ version: '0.9.42', publishedAt: '2026-11-02T00:00:00Z', tags: ['latest'], prerelease: false, bundle: true }] } }
        return { ok: true, value: { from: '0.9.37', to: '0.9.42', step: 'install', result: { changed: true, application: 'applied' } } }
      } },
    }
    return undefined
  },
  reflect: { get: () => undefined },
  effect: (fn) => { const d = fn(); return () => d && d() },
}
await import(new URL('../../client.js', import.meta.url).pathname)
const reg = globalThis.__reg
reg.factory({}).apply(ctx)
await new Promise((r) => setTimeout(r, 150))
document.querySelector('.pue-btn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 500))
console.log('rows', [...document.querySelectorAll('.pue-row')].map((r) => r.textContent.trim().slice(0, 20)))
console.log('build', document.querySelector('.pue-build')?.textContent, '| window', window.__PUE_BUILD__)
console.log('calls', JSON.stringify(calls))
