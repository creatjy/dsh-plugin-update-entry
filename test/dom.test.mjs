import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The DOM behaviours (button placement, version list, hover notes, the update
 * call) need a document. They are exercised by a jsdom harness kept in the
 * workspace scratch directory so this package keeps zero dependencies; the
 * test skips when the harness or its jsdom install is absent.
 */
const here = dirname(fileURLToPath(import.meta.url));
const harness = join(here, '..', '..', '.scratch', 'pue-harness', 'harness-real.mjs');
const transport = join(here, '..', '..', '.scratch', 'pue-harness', 'harness-transport.mjs');
const fetchTier = join(here, '..', '..', '.scratch', 'pue-harness', 'harness-fetch.mjs');
const hasHarness = existsSync(harness) && existsSync(join(dirname(harness), 'node_modules', 'jsdom'));

test('dom harness: button, versions, hover notes and the update call', { skip: !hasHarness && 'jsdom harness not installed' }, () => {
  const output = execFileSync(process.execPath, [harness], { encoding: 'utf8', timeout: 120000 });
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
test('dom harness: connection.rpc transport uses named-argument objects', { skip: !hasHarness && 'jsdom harness not installed' }, () => {
  const output = execFileSync(process.execPath, [transport], { encoding: 'utf8', timeout: 120000 });
  assert.match(output, /rows \[ '0\.9\.42/);
  assert.match(output, /\["pluginManager\/listVersions","name\+options"\]/);
});

/**
 * The wire tier (`POST /api/pluginManager/<method>`) must carry the whole
 * feature when no cordis service resolves at all — the failure mode the live
 * page actually hit. This harness gives the module a hostile context (every
 * service read returns undefined) and only a fetch.
 */
test('dom harness: the /api wire tier works with no cordis services', { skip: !hasHarness && 'jsdom harness not installed' }, () => {
  const output = execFileSync(process.execPath, [fetchTier], { encoding: 'utf8', timeout: 120000 });
  assert.match(output, /1 button 更新 beforeSwitch true/);
  assert.match(output, /3 rows \[ '0\.9\.43/);
  assert.match(output, /4 hover 0\.9\.43发布于/);
  assert.match(output, /5 afterLeave false/);
  assert.match(output, /7 outcome .*已更新到 0\.9\.43/);
  assert.match(output, /\["updateBundle","name\+version\+options","0\.9\.43"\]/);
});
