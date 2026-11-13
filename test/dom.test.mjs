import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The DOM behaviours — button placement, version list, hover notes, and the
 * update call — need a document, so they run in jsdom against the real
 * `client.js`. Each harness in `test/harness/` reproduces one transport shape
 * the browser can meet:
 *
 *   harness-real.mjs       a cordis service (`remote.pluginManager`) exists
 *   harness-transport.mjs  only `connection.rpc.call` is available
 *   harness-fetch.mjs      no service at all; only `fetch` reaches the Host
 *
 * They are separate processes on purpose: the module keeps its state, so a
 * second scenario in the same process would read the first one's caches.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const harness = (name) => join(here, 'harness', name);

const hasJsdom = existsSync(join(root, 'node_modules', 'jsdom'));
const hasCordis = existsSync(join(root, 'node_modules', '@deepseek-ai', 'cordis'));
const noJsdom = hasJsdom ? false : 'run `npm install` first: the DOM harness needs jsdom';
const noCordis = hasCordis ? false : 'run `npm install` first: this harness needs @deepseek-ai/cordis';

function run(file, env = {}) {
  return execFileSync(process.execPath, [harness(file)], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ...env },
  });
}

test('dom: service transport renders the button, versions, hover notes and updates', { skip: noJsdom || noCordis }, () => {
  const output = run('harness-real.mjs');
  assert.match(output, /1 button 更新 beforeSwitch true/);
  assert.match(output, /2 rows \[ '0\.2\.100/);
  assert.match(output, /4 hover 0\.2\.100发布于/);
  assert.match(output, /5 afterLeave false/);
  assert.match(output, /6a confirm 将从 0\.2\.96 更新到 0\.2\.100/);
  assert.match(output, /7 update .*已更新到 0\.2\.100/);
  assert.match(output, /\["updateBundle","dsh-mcp-connector","0\.2\.100"\]/);
});

/**
 * The bulk surface hangs off the toolbar instead of a card: a button after the
 * official "N plugins can be updated" note, a panel listing every updatable
 * package, a per-item version picker, and release notes on those version rows.
 * The note is React state and vanishes during a refresh, so the harness removes
 * it mid-flow to prove the panel and a running batch survive.
 */
test('dom: the toolbar offers one-click updates for every updatable plugin', { skip: noJsdom || noCordis }, () => {
  const output = run('harness-bulk.mjs');
  assert.match(output, /1 button 一键更新 afterNote true/);
  assert.match(output, /2 panel true expanded true/);
  assert.match(output, /2c names \[ 'dsh-free-search', 'dsh-mcp-connector', 'dsh-model-think-level' \]/);
  /* A package the Host lists but cannot install here must be called out, not
   * silently dropped from the run. */
  assert.match(output, /2e blocked \[ 'dsh-model-think-level\|没有可直接安装的新版本' \]/);
  assert.match(output, /3b rows \[ '0\.9\.43', '0\.9\.42' \]/);
  assert.match(output, /4 hover true 0\.9\.43发布于/);
  assert.match(output, /5 afterLeave false/);
  /* A version check finishing in the background rebuilds the panel body. The
   * open notes must stay pinned to the same package+version row instead of
   * vanishing mid-read. */
  assert.match(output, /5b reopened 0\.9\.43发布于/);
  assert.match(output, /5c survived true 0\.9\.43发布于.* pinned 0\.9\.43/);
  assert.match(output, /6 retarget \[ '0\.9\.42', '0\.2\.100', '选择版本' \]/);
  assert.match(output, /7 noteGone button false panel true/);
  assert.match(output, /\["updateBundle","dsh-free-search","0\.9\.42"\],\["updateBundle","dsh-mcp-connector","0\.2\.100"\]/);
  assert.match(output, /9b foot 2 个已更新，0 个失败/);
  assert.match(output, /9d panelAlive true/);
  assert.match(output, /'dsh-model-think-level:已跳过'/);
});

/**
 * DSH 0.2.2-rc.2 renamed every CSS-module class prefix (`w6M7KW_` -> `X_2TxG_`).
 * The plugin never matches a full class name, only substrings such as
 * `[class*="cardEnd"]`, so the entry must mount identically on the new build.
 * This runs the same harness against rc.2's prefix.
 */
test('dom: 0.2.2-rc.2 class prefixes still mount the entry', { skip: noJsdom || noCordis }, () => {
  const output = run('harness-real.mjs', { PUE_PREFIX: 'X_2TxG_' });
  assert.match(output, /0 prefix X_2TxG_/);
  assert.match(output, /1 button 更新 beforeSwitch true/);
  assert.match(output, /2 rows \[ '0\.2\.100/);
  assert.match(output, /4 hover 0\.2\.100发布于/);
  assert.match(output, /5 afterLeave false/);
  assert.match(output, /7 update .*已更新到 0\.2\.100/);
  assert.match(output, /\["updateBundle","dsh-mcp-connector","0\.2\.100"\]/);
});

/**
 * The gateway transport (`connection.rpc.call`) is the tier that works even
 * when the namespace service is not mounted in this fiber. Its `args` must be
 * ONE plain object keyed by parameter name — an array is refused by the Host
 * with `Remote payload must contain exactly one plain-object args field`.
 */
test('dom: connection.rpc transport passes named-argument objects', { skip: noJsdom }, () => {
  const output = run('harness-transport.mjs');
  assert.match(output, /rows \[ '0\.9\.42/);
  assert.match(output, /\["pluginManager\/listVersions","name\+options"\]/);
});

/**
 * The wire tier (`POST /api/pluginManager/<method>`) must carry the whole
 * feature when no cordis service resolves at all — the failure mode the live
 * page actually hit. This harness gives the module a hostile context (every
 * service read returns undefined) and only a fetch.
 */
test('dom: the /api wire tier works with no cordis services', { skip: noJsdom }, () => {
  const output = run('harness-fetch.mjs');
  assert.match(output, /1 button 更新 beforeSwitch true/);
  assert.match(output, /3 rows \[ '0\.9\.43/);
  assert.match(output, /4 hover 0\.9\.43发布于/);
  assert.match(output, /5 afterLeave false/);
  assert.match(output, /7 outcome .*已更新到 0\.9\.43/);
  assert.match(output, /\["updateBundle","name\+version\+options","0\.9\.43"\]/);
});

/**
 * The Host concatenates one classic script per batch. When a stale graph row
 * names this same file under a second id (seen after the rename), those bytes
 * land in one script twice. Two `const` declarations of the same name is a
 * parse error, so the whole batch dies before any line runs — and every package
 * scheduled after us with it. The bundle is function-wrapped for that reason,
 * and only the loader's own duplicate error for our id is swallowed.
 *
 * This harness runs in node:vm with no DOM on purpose: the property under test
 * is script-level, not page-level.
 */
test('duplicate: a batch that embeds this bundle twice still loads', { skip: noJsdom }, () => {
  const output = run('harness-duplicate.mjs');
  assert.match(output, /1 batch threw false/);
  assert.match(output, /2 registered \["dsh-plugin-update-entry","later-package"\]/);
  assert.match(output, /3 unrelated duplicate threw true/);
  assert.match(output, /4 our id count 1/);
});
