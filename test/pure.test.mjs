import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * `client.js` is a browser classic script: it registers a module with the
 * loader at import time and does no DOM work until `apply()` runs. We capture
 * that registration and exercise the pure helpers it exposes.
 */
let registration = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registration = definition;
    },
  },
};
await import('../client.js');

const pure = registration && registration.__pure;

test('registers exactly one client module', () => {
  assert.equal(registration.id, 'dsh-plugin-update-entry');
  assert.equal(typeof registration.factory, 'function');
  assert.ok(pure, 'pure helpers are exported for tests');
});

test('interp replaces known placeholders only', () => {
  assert.equal(pure.interp('更新到 {version}', { version: '1.2.3' }), '更新到 1.2.3');
  assert.equal(pure.interp('需要 {peers}', {}), '需要 {peers}');
  assert.equal(pure.interp('no placeholders', { a: 1 }), 'no placeholders');
});

test('versionOfTag reads the version out of release tags', () => {
  assert.equal(pure.versionOfTag('v0.5.2'), '0.5.2');
  assert.equal(pure.versionOfTag('billion-context@v0.1.213'), '0.1.213');
  assert.equal(pure.versionOfTag('v0.1.0-alpha3'), '0.1.0-alpha3');
  assert.equal(pure.versionOfTag('nightly'), null);
  assert.equal(pure.versionOfTag(''), null);
});

test('repoFromUrl understands the shapes npm accepts', () => {
  assert.equal(pure.repoFromUrl({ type: 'git', url: 'git+https://github.com/T-Auto/dsh-ops.git' }), 'T-Auto/dsh-ops');
  assert.equal(pure.repoFromUrl('https://github.com/DDDMUC/dsh-free-search'), 'DDDMUC/dsh-free-search');
  assert.equal(pure.repoFromUrl('git@github.com:ranxianglei/billion-context.git'), 'ranxianglei/billion-context');
  assert.equal(pure.repoFromUrl('github:dsh-market/dsh-market'), 'dsh-market/dsh-market');
  assert.equal(pure.repoFromUrl('https://github.com/a/b/tree/main/packages/c'), 'a/b');
  assert.equal(pure.repoFromUrl('https://gitlab.com/a/b.git'), null);
  assert.equal(pure.repoFromUrl({}), null);
  assert.equal(pure.repoFromUrl(null), null);
});

test('matchRelease only answers for the exact version', () => {
  const releases = { '1.0.0': { version: '1.0.0' } };
  assert.deepEqual(pure.matchRelease(releases, '1.0.0'), { version: '1.0.0' });
  assert.equal(pure.matchRelease(releases, '1.0.1'), null);
  assert.equal(pure.matchRelease(null, '1.0.0'), null);
});

test('filterPrerelease keeps order and honours the toggle', () => {
  const versions = [
    { version: '2.0.0' },
    { version: '2.0.0-beta.1', prerelease: true },
    { version: '1.9.0', prerelease: false },
  ];
  assert.deepEqual(pure.filterPrerelease(versions, false).map((v) => v.version), ['2.0.0', '1.9.0']);
  assert.deepEqual(pure.filterPrerelease(versions, true).map((v) => v.version), ['2.0.0', '2.0.0-beta.1', '1.9.0']);
  assert.deepEqual(pure.filterPrerelease(undefined, false), []);
});

test('installBlocker mirrors the host pre-check', () => {
  assert.equal(pure.installBlocker({ bundle: true }), null);
  assert.equal(pure.installBlocker({ bundle: false }), 'notBundle');
  assert.equal(pure.installBlocker({ bundle: true, incompatible: { name: 'dsh' } }), 'blocked');
  assert.equal(pure.installBlocker({}), 'notBundle');
});

test('stripMarkdown flattens release bodies', () => {
  const body = [
    '## What changed',
    '',
    '- **fix** the [switch](https://example.com) flicker',
    '![screenshot](https://example.com/a.png)',
    '<details>hidden</details>',
    '',
    '```',
    'npm i dsh-ops',
    '```',
  ].join('\n');
  const text = pure.stripMarkdown(body);
  assert.ok(!text.includes('##'));
  assert.ok(!text.includes('**'));
  assert.ok(!text.includes(']('));
  assert.ok(!text.includes('<details>'));
  assert.ok(text.includes('fix the switch flicker'));
  assert.ok(text.includes('npm i dsh-ops'));
});

test('stripMarkdown caps the body length', () => {
  const text = pure.stripMarkdown('x'.repeat(10000));
  assert.equal(text.length, 6000);
});

test('outcomeOf maps every host answer', () => {
  assert.equal(pure.outcomeOf({ ok: false, error: { message: 'boom' } }).kind, 'lost');
  assert.equal(pure.outcomeOf(null).kind, 'lost');
  assert.equal(
    pure.outcomeOf({ ok: true, value: { from: '1.0.0', to: '2.0.0', step: 'check', result: { application: 'failed' } } }).kind,
    'refused',
  );
  assert.equal(
    pure.outcomeOf({ ok: true, value: { from: '1.0.0', to: '2.0.0', step: 'remove', result: { application: 'failed' } } }).kind,
    'removeFailed',
  );
  assert.equal(
    pure.outcomeOf({ ok: true, value: { from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'applied' } } }).kind,
    'done',
  );
  assert.equal(
    pure.outcomeOf({ ok: true, value: { from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'restart-required' } } }).kind,
    'restart',
  );
  assert.equal(
    pure.outcomeOf({ ok: true, value: { from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'failed' } } }).kind,
    'broken',
  );
  const restored = pure.outcomeOf({
    ok: true,
    value: { from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'failed' }, restore: { application: 'applied' } },
  });
  assert.equal(restored.kind, 'restored');
  assert.equal(restored.from, '1.0.0');
  assert.equal(restored.to, '2.0.0');
});

test('planSteps names the four host steps with their versions', () => {
  const steps = pure.planSteps('1.0.0', '2.0.0', 'https://registry.npmmirror.com');
  assert.deepEqual(steps.map((step) => step.key), ['checking', 'removing', 'installing', 'restoring']);
  assert.deepEqual(steps[1].params, { version: '1.0.0' });
  assert.deepEqual(steps[2].params, { version: '2.0.0', registry: 'https://registry.npmmirror.com' });
});

test('stepState marks progress and the failed install before a restore', () => {
  assert.equal(pure.stepState(0, null), 'pending');
  assert.equal(pure.stepState(0, 'installing'), 'done');
  assert.equal(pure.stepState(2, 'installing'), 'active');
  assert.equal(pure.stepState(3, 'installing'), 'pending');
  assert.equal(pure.stepState(2, 'restoring'), 'failed');
  assert.equal(pure.stepState(3, 'restoring'), 'active');
});

test('outputOf digs the pnpm log out of either result', () => {
  assert.equal(
    pure.outputOf({ ok: true, value: { result: { packageResult: { output: 'installed' } } } }),
    'installed',
  );
  assert.equal(
    pure.outputOf({ ok: true, value: { result: {}, restore: { packageResult: { output: 'restored' } } } }),
    'restored',
  );
  assert.equal(pure.outputOf({ ok: true, value: { result: {} } }), '');
  assert.equal(pure.outputOf({ ok: false }), '');
});

/* --- the `without inject` regression --------------------------------------
 * `remote.pluginManager` is a cordis Service under a DOTTED name. Reading it
 * through the ctx proxy (`ctx.remote.pluginManager` or
 * `ctx['remote.pluginManager']`) throws unless that exact dotted name is in
 * this fiber's inject, so the plugin resolves it from the service store.
 */
test('readService returns undefined instead of throwing when absent', () => {
  const bare = {};
  assert.equal(pure.readService(bare, 'remote.pluginManager'), undefined);
  assert.equal(pure.readService(undefined, 'remote.pluginManager'), undefined);
});

test('readService prefers ctx.get and survives a throwing proxy', () => {
  const service = { listVersions() {} };
  const ctx = {
    get(name) {
      if (name === 'remote.pluginManager') return service;
      return undefined;
    },
    reflect: {
      get() {
        throw new Error('boom');
      },
    },
  };
  assert.equal(pure.readService(ctx, 'remote.pluginManager'), service);
});

test('readService falls back to ctx.reflect.get', () => {
  const service = { listVersions() {} };
  const ctx = {
    get() {
      throw new Error('proxy guard');
    },
    reflect: {
      get(name) {
        return name === 'remote.pluginManager' ? service : undefined;
      },
    },
  };
  assert.equal(pure.readService(ctx, 'remote.pluginManager'), service);
});

test('readService never reads through the ctx proxy property path', () => {
  const ctx = {
    get remote() {
      throw new Error('cannot get property "remote" without inject');
    },
    get() {
      return undefined;
    },
    reflect: { get: () => undefined },
  };
  assert.equal(pure.readService(ctx, 'remote.pluginManager'), undefined);
});

test('updatableBundles keeps only installed packages that offer an update', () => {
  const bundles = [
    { name: 'b', installed: true, updatable: true, version: '2.0.0' },
    { name: 'a', installed: true, updatable: true, version: '1.0.0' },
    { name: 'c', installed: false, updatable: true, version: '3.0.0' },
    { name: 'd', installed: true, updatable: false, version: '4.0.0' },
    { installed: true, updatable: true, version: '5.0.0' },
  ];
  assert.deepEqual(pure.updatableBundles(bundles), [
    { name: 'a', from: '1.0.0' },
    { name: 'b', from: '2.0.0' },
  ]);
  assert.deepEqual(pure.updatableBundles(undefined), []);
  assert.deepEqual(pure.updatableBundles([]), []);
});

test('bulkSummary counts finished, failed, skipped and untouched items', () => {
  assert.deepEqual(pure.bulkSummary([
    { state: 'done' }, { state: 'failed' }, { state: 'idle' }, { state: 'skipped' },
  ]), { ok: 1, failed: 1, skipped: 1, pending: 1 });
  assert.deepEqual(pure.bulkSummary([]), { ok: 0, failed: 0, skipped: 0, pending: 0 });
  assert.deepEqual(pure.bulkSummary(undefined), { ok: 0, failed: 0, skipped: 0, pending: 0 });
});

test('bulkRows hides a package whose registry answer held no versions', () => {
  const listed = (versions) => ({ phase: 'listed', list: { status: 'listed', versions } });
  assert.deepEqual(pure.bulkRows([
    { name: 'has-update', ...listed([{ version: '2.0.0' }]) },
    { name: 'up-to-date', ...listed([]) },
    { name: 'unread', phase: 'idle', list: null },
    { name: 'failed', phase: 'error', list: null },
  ]).map((item) => item.name), ['has-update', 'unread', 'failed']);
  assert.deepEqual(pure.bulkRows(undefined), []);
});

test('userMessage hides cordis transport internals from the page', () => {
  const raw = 'cannot get property "remote.pluginManager" without inject';
  const shown = pure.userMessage(new Error(raw));
  assert.doesNotMatch(shown, /without inject|cannot get property/);
  assert.equal(shown, '与 DSH 的连接尚未就绪，请稍后重试');
  assert.equal(
    pure.userMessage(new Error('client api: pluginManager/listVersions expected 2 argument(s), got 1')),
    '与 DSH 的连接尚未就绪，请稍后重试',
  );
  assert.equal(pure.userMessage(new Error('HTTP 500')), 'HTTP 500');
  assert.equal(pure.userMessage(null), '');
});
