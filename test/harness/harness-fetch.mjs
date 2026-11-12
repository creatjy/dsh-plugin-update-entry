/* Worst case: the module sees NO cordis services at all (no locale, no remote,
 * no connection). Only global fetch works — the wire tier must carry the whole
 * feature: version list, hover notes, and the update call. */
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
Object.defineProperty(globalThis, 'crypto', { value: { randomUUID: () => 'rpc-1' }, configurable: true })
window.__ModuleLoader__ = { load(d) { globalThis.__reg = d } }

const calls = []
globalThis.fetch = async (url, init) => {
  const u = String(url)
  if (u.startsWith('/api/pluginManager/listVersions')) {
    const body = JSON.parse(init.body)
    calls.push(['listVersions', Object.keys(body.payload.args).join('+')])
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {
      status: 'listed', installed: '0.9.37', registry: 'https://registry.npmmirror.com/', omitted: 0,
      versions: [
        { version: '0.9.43', publishedAt: '2026-11-11T00:00:00Z', tags: ['latest'], prerelease: false, bundle: true },
        { version: '0.9.40', publishedAt: '2026-11-09T00:00:00Z', tags: [], prerelease: false, bundle: true, deprecated: 'broken' },
      ] } } }) }
  }
  if (u.startsWith('/api/pluginManager/updateBundle')) {
    const body = JSON.parse(init.body)
    calls.push(['updateBundle', Object.keys(body.payload.args).join('+'), body.payload.args.version])
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {
      from: '0.9.37', to: '0.9.43', step: 'install',
      result: { changed: true, application: 'applied', stage: 'install', target: 'dsh-free-search' } } } }) }
  }
  if (u.includes('registry.npmmirror.com')) {
    return { ok: true, status: 200, json: async () => ({ version: '0.9.43', repository: { url: 'git+https://github.com/DDDMUC/dsh-free-search.git' } }) }
  }
  if (u.includes('api.github.com')) {
    return { ok: true, status: 200, json: async () => ([
      { tag_name: 'v0.9.43', published_at: '2026-11-11T00:00:00Z', body: '新增 Tavily 引擎\n修复 Bing 结果解析', html_url: 'https://github.com/DDDMUC/dsh-free-search/releases/tag/v0.9.43' },
      { tag_name: 'v0.9.40', published_at: '2026-11-09T00:00:00Z', body: '实验性改动', html_url: 'https://github.com/DDDMUC/dsh-free-search/releases/tag/v0.9.40' },
    ]) }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

/* Deliberately hostile context: every service read fails or returns nothing. */
const ctx = {
  locale: { register: () => () => {}, bind: () => (k) => k },
  get() { return undefined },
  reflect: { get: () => undefined },
  effect: (fn) => { const d = fn(); return () => d && d() },
}
await import(new URL('../../client.js', import.meta.url).pathname)
const reg = globalThis.__reg
reg.factory({}).apply(ctx)
await new Promise((r) => setTimeout(r, 150))

const btn = document.querySelector('.pue-btn')
console.log('1 button', btn && btn.textContent, 'beforeSwitch', btn?.parentElement?.nextElementSibling === undefined ? 'n/a' : btn.parentElement.parentElement.lastElementChild === btn.parentElement.nextElementSibling || true)
btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 400))
const pop = document.querySelector('.pue-pop')
console.log('2 build', document.querySelector('.pue-build')?.textContent)
console.log('3 rows', [...document.querySelectorAll('.pue-row')].map((r) => r.textContent.trim().slice(0, 14)))
const rows = [...document.querySelectorAll('.pue-row')]
rows[0].dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: true }))
await new Promise((r) => setTimeout(r, 260))
const tip = document.querySelector('.pue-notes')
console.log('4 hover', tip && tip.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
rows[0].dispatchEvent(new window.PointerEvent('pointerleave', { bubbles: true }))
await new Promise((r) => setTimeout(r, 320))
console.log('5 afterLeave', document.querySelector('.pue-notes') !== null)
// pick 0.9.43 then confirm
rows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 120))
console.log('6a buttons', [...pop.querySelectorAll('button')].map((b) => b.textContent.trim().slice(0, 18)))
const foot = [...pop.querySelectorAll('button')].find((b) => /^更新到/.test(b.textContent.trim()))
if (foot) { foot.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)) }
const confirmBtn = [...pop.querySelectorAll('button')].find((b) => b.textContent.trim() === '更新')
console.log('6 confirmBtn', confirmBtn && confirmBtn.textContent.trim())
confirmBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 500))
console.log('7 outcome', pop.textContent.replace(/\s+/g, ' ').trim().slice(0, 80))
console.log('8 calls', JSON.stringify(calls))
