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

function run(file) {
  return execFileSync(process.execPath, [harness(file)], { encoding: 'utf8', timeout: 120000 });
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
