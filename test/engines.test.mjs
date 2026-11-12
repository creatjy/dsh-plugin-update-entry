import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import semver from 'semver';

/**
 * DSH refuses to install a plugin whose `engines.dsh` range rejects the running
 * build. The host evaluates the range with `includePrerelease: true`
 * (`unmetRequirements` in `@deepseek-ai/dsh-app-boot`), so a prerelease build
 * such as 0.2.2-rc.2 only installs when the range was written for prereleases.
 *
 * These cases pin the two builds this plugin was checked against and the ones
 * it was not, so a future range edit cannot silently lock users out.
 */
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const accepts = (version) => semver.satisfies(version, manifest.engines.dsh, { includePrerelease: true });

test('engines.dsh accepts the DSH builds this plugin supports', () => {
  assert.equal(accepts('0.2.2-rc.1'), true, 'the desktop build the plugin was verified on');
  assert.equal(accepts('0.2.2-rc.2'), true, 'the next desktop build, verified against its packages');
  assert.equal(accepts('0.2.3'), true, 'later patches of the same minor line');
});

test('engines.dsh refuses the builds it was never checked against', () => {
  assert.equal(accepts('0.2.1-rc.5'), false, 'older minor line');
  assert.equal(accepts('0.2.2-alpha.3'), false, 'earlier prerelease of the targeted minor');
  assert.equal(accepts('0.3.0-rc.1'), false, 'next minor may break the card DOM');
});
