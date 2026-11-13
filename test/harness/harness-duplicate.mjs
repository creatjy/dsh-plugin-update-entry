/* The Host composes the boot graph into ONE classic script per batch, and that
 * script may embed this bundle twice when a stale graph row names the same file
 * under a second id (observed after the package rename: the old row lived on in
 * the Host's in-memory table until a restart). The second execution used to hit
 * `duplicate factory registration` — a throw that aborts the whole batch, so
 * every package scheduled after us failed to register too.
 *
 * This harness reproduces exactly that: one script, our bytes twice, another
 * package after us, and a loader that throws on a duplicate id like the real
 * one. Assertions:
 *   1. neither execution throws            -> the batch keeps running
 *   2. our id is registered exactly once   -> the plugin still installs
 *   3. the package after us registers      -> no collateral damage
 *   4. an unrelated duplicate still throws -> the guard is not a blanket mute
 *
 * No jsdom: nothing here needs a document, only `window.__ModuleLoader__`.
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const bundles = { 'dsh-plugin-update-entry': readFileSync(new URL('../../client.js', import.meta.url), 'utf8') }

const registered = []
const loader = {
  load(registration) {
    const id = registration.id
    if (registered.includes(id)) {
      throw new Error(`client-modules: duplicate factory registration for "${id}" (bundle executed twice without invalidate?)`)
    }
    registered.push(id)
    globalThis.__last = registration
  },
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: { __ModuleLoader__: loader },
  localStorage: { getItem: () => null, setItem() {} },
  navigator: { language: 'zh-CN' },
  document: { createElement: () => ({ style: {}, dataset: {}, append() {}, remove() {} }), head: { append() {} } },
}
sandbox.globalThis = sandbox
const context = createContext(sandbox)

/* One batch: ours, ours again (the stale row), then a later package. */
const later = `window.__ModuleLoader__.load({ id: 'later-package', factory() { return {} } })`
const batch = [bundles['dsh-plugin-update-entry'], bundles['dsh-plugin-update-entry'], later].join('\n;\n')

let threw = null
try {
  runInContext(batch, context, { filename: 'batch-application.js' })
} catch (error) {
  threw = error
}

console.log('1 batch threw', threw ? threw.message : false)
console.log('2 registered', JSON.stringify(registered))

/* Snippet 4: an unrelated bundle registering its own id twice must still be loud. */
let unrelated = null
try {
  runInContext(
    `window.__ModuleLoader__.load({ id: 'someone-else', factory() { return {} } });window.__ModuleLoader__.load({ id: 'someone-else', factory() { return {} } })`,
    context,
    { filename: 'other-bundle.js' },
  )
} catch (error) {
  unrelated = error
}
console.log('3 unrelated duplicate threw', Boolean(unrelated) && /duplicate factory registration for "someone-else"/.test(unrelated.message))
console.log('4 our id count', registered.filter((id) => id === 'dsh-plugin-update-entry').length)
console.log('5 factory present', typeof (globalThis.__last && globalThis.__last.factory) === 'function' || 'n/a')
