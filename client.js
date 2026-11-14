/**
 * plugin-update-entry — Client module.
 *
 * The official plugin page puts the update action on the detail page only and
 * leaves the list card with nothing but a `可更新` tag. This module adds an
 * `更新` control to that card, immediately before the switch, and opens a
 * popover that lists the versions the Host is willing to install, with the
 * GitHub release notes of each version on hover.
 *
 * Placement is a deliberate, contained exception to "stay inside your slot":
 * the plugin page exposes no slot for a list-card action. We therefore add one
 * node of our own inside `.cardEnd` and never touch official attributes,
 * classes or React state. Every anchor is a semantic `data-*` attribute or a
 * stable class substring; if any anchor disappears the module does nothing at
 * all (fail-closed).
 */

/* A classic script may be concatenated with itself.
 *
 * The Host composes the boot graph into ONE classic script per batch by
 * concatenating each package's bundle. If two graph rows ever point at this
 * same file (observed after a package rename: the old row lives on in the
 * Host's in-memory table until a restart, so both `@local/old-name` and
 * `dsh-plugin-update-entry` resolve to these bytes), those bytes appear twice
 * in one script — and two `const` declarations of the same name is a PARSE
 * error, which kills the entire batch before a single line runs. Nothing this
 * file can catch afterwards would help.
 *
 * The function wrapper gives each copy its own declarations, so the script
 * parses no matter how many times the Host embeds it. Registration is still
 * attempted on every execution (HMR invalidation drops the factory and needs
 * the next execution to re-register), and only the loader's own
 * `duplicate factory registration` error for THIS package is swallowed below —
 * that is the second copy of one batch, which carries no new information.
 */
;(function () {
  const PACKAGE_ID = 'dsh-plugin-update-entry';
  const NS = 'plugin-update-entry';

  /* ------------------------------------------------------------------ *
   * Pure helpers (also exported for `node --test`, see `__pure` below)
   * ------------------------------------------------------------------ */

  const BUILD = '1.0.1';

  /* Read a cordis service by its registration name, without the ctx proxy guard.
   *
   * `ctx.<name>` on the context proxy throws `cannot get property "<name>"
   * without inject` for anything this fiber did not declare. `remote.pluginManager`
   * is a Service registered under a DOTTED name, so even `ctx.remote` being
   * declared does not make `.pluginManager` reachable — the proxy only resolves
   * dotted names through an `associate` tracker, which re-enters the same guard.
   *
   * `ctx.get(name)` is the documented unguarded read (cordis ReflectService
   * mixes it onto every context) and returns `undefined` instead of throwing when
   * the service is not mounted yet. Declaring `remote.pluginManager` in `inject`
   * would park this whole module until the namespace mounts, which is a heavier
   * coupling than a lazy read on click.
   */
  function readService(ctx, name) {
    if (!ctx) return undefined;
    try {
      const found = ctx.get(name);
      if (found) return found;
    } catch {}
    try {
      const found = ctx.reflect && ctx.reflect.get(name);
      if (found) return found;
    } catch {}
    return undefined;
  }

  const VERSION_IN_TAG = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

  function interp(text, params) {
    if (!params) return text;
    return String(text).replace(/\{(\w+)\}/g, (match, key) =>
      params[key] === undefined || params[key] === null ? match : String(params[key]),
    );
  }

  function versionOfTag(tag) {
    const match = String(tag || '').match(VERSION_IN_TAG);
    return match ? match[1] : null;
  }

  /** Resolve an npm `repository` field (string or object) to `owner/repo`. */
  function repoFromUrl(repository) {
    let url = '';
    if (typeof repository === 'string') url = repository;
    else if (repository && typeof repository === 'object' && typeof repository.url === 'string') {
      url = repository.url;
    }
    url = url.trim();
    if (!url) return null;
    url = url.replace(/^git\+/, '');
    const shorthand = url.match(/^github:([\w.-]+)\/([\w.-]+)$/i);
    if (shorthand) return `${shorthand[1]}/${shorthand[2]}`;
    const scp = url.match(/^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
    if (scp) return `${scp[1]}/${scp[2]}`;
    const http = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
    if (http) return `${http[1]}/${http[2]}`;
    return null;
  }

  /** Look one exact version up in the `{ version: release }` map built above. */
  function matchRelease(releases, version) {
    if (!releases || !version) return null;
    return releases[version] || null;
  }

  function filterPrerelease(versions, show) {
    const list = Array.isArray(versions) ? versions : [];
    return show ? list.slice() : list.filter((item) => !item || !item.prerelease);
  }

  /** Keep a version installable-or-not decision in one place. */
  function installBlocker(item) {
    if (!item) return 'notBundle';
    if (item.bundle !== true) return 'notBundle';
    if (item.incompatible) return 'blocked';
    return null;
  }

  /** GitHub release bodies are markdown; the bubble shows plain text. */
  function stripMarkdown(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (match, code) => code)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '· ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/[*_`]{1,2}/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 6000);
  }

  /**
   * Map an `updateBundle` answer to the outcome the user is told about.
   * Conditions mirror the official page's own `outcomeOf` exactly.
   */
  function outcomeOf(answer) {
    const value = answer && answer.ok === false
      ? null
      : answer && Object.prototype.hasOwnProperty.call(answer, 'value') ? answer.value : answer;
    if (!value) {
      const reason = answer && answer.error
        ? answer.error.message || String(answer.error)
        : '';
      return { kind: 'lost', reason };
    }
    const result = value.result;
    if (!result) return { kind: 'lost', reason: '' };
    if (value.step === 'check') return { kind: 'refused', to: value.to };
    if (value.step === 'remove') return { kind: 'removeFailed', from: value.from };
    if (result.application !== 'failed') {
      return result.application === 'restart-required'
        ? { kind: 'restart', to: value.to }
        : { kind: 'done', to: value.to };
    }
    if (value.restore === undefined) return { kind: 'broken', from: value.from, to: value.to };
    return { kind: 'restored', from: value.from, to: value.to };
  }

  const STEP_ORDER = ['checking', 'removing', 'installing', 'restoring'];

  function planSteps(from, to, registry) {
    return [
      { key: 'checking', labelKey: 'updateStepChecking', params: { version: to } },
      { key: 'removing', labelKey: 'updateStepRemoving', params: { version: from } },
      { key: 'installing', labelKey: 'updateStepInstalling', params: { version: to, registry: registry || '…' } },
      { key: 'restoring', labelKey: 'updateStepRestoring', params: { version: from } },
    ];
  }

  function stepState(index, current) {
    if (!current) return 'pending';
    const at = STEP_ORDER.indexOf(current);
    if (at < 0) return 'pending';
    if (index < at) {
      // A restore only happens because the install failed.
      return current === 'restoring' && index === 2 ? 'failed' : 'done';
    }
    return index === at ? 'active' : 'pending';
  }

  function outputOf(answer) {
    const value = answer && answer.value ? answer.value : null;
    if (!value) return '';
    const direct = value.result && value.result.packageResult && value.result.packageResult.output;
    if (direct) return String(direct);
    const restored = value.restore && value.restore.packageResult && value.restore.packageResult.output;
    return restored ? String(restored) : '';
  }

  /**
   * The bundles worth listing: installed, updatable, and actually a bundle.
   * `listBundles` reports both profile and installation packages; only the
   * installed ones can be updated from here, and `official` packages are the
   * Host's own and never appear as updatable.
   */
  function updatableBundles(bundles) {
    const list = Array.isArray(bundles) ? bundles : [];
    const out = [];
    for (const bundle of list) {
      if (!bundle || typeof bundle.name !== 'string') continue;
      if (!bundle.installed || !bundle.updatable) continue;
      out.push({ name: bundle.name, from: String(bundle.version || '') });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Tally of a bulk run, for the summary line. */
  function bulkSummary(items) {
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    let pending = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      if (item.state === 'done') ok += 1;
      else if (item.state === 'failed') failed += 1;
      else if (item.state === 'skipped') skipped += 1;
      else if (item.state === 'idle') pending += 1;
    }
    return { ok, failed, skipped, pending };
  }

  /** The rows a run will actually try: they have a target, or their version read
   * never landed and the run re-reads them first. A row that was read but offers
   * nothing installable here stays visible yet is not attempted. */
  function bulkTargets(items) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.state !== 'idle') continue;
      if (!item.to && item.phase === 'listed') continue;
      out.push(item);
    }
    return out;
  }

  /** The rows the panel shows. `listBundles` calls a package updatable when it
   * *could* be updated, not when a newer version exists, so a listed answer
   * with no versions at all means "nothing newer" — that row is hidden instead
   * of being reported as up to date. A row whose versions exist but none can be
   * installed here stays visible: it carries information the user needs. */
  function bulkRows(items) {
    const out = [];
    for (const item of Array.isArray(items) ? items : []) {
      if (!item) continue;
      const versions = (item.list && item.list.versions) || [];
      if (item.phase === 'listed' && versions.length === 0) continue;
      out.push(item);
    }
    return out;
  }

  function messageOf(error) {
    if (!error) return '';
    return String(error.message || error.error || error || '');
  }

  /* Module scope: this string is needed before `apply()` (and therefore DICT)
   * exists, so the Chinese default lives here and DICT reuses it. */
  const FALLBACK_UNAVAILABLE = '与 DSH 的连接尚未就绪，请稍后重试';

  /* A raw `cannot get property "…" without inject` is a cordis proxy guard, never
   * something a user can act on. Map it (and the other transport-level strings)
   * to the localized explanation; the raw text still reaches the console. */
  function userMessage(error) {
    const raw = messageOf(error);
    if (!raw) return '';
    if (/without inject|cannot get property|client api:|has no active Connection/i.test(raw)) {
      return FALLBACK_UNAVAILABLE;
    }
    return raw;
  }

  /* ------------------------------------------------------------------ *
   * Client module
   * ------------------------------------------------------------------ */

  const REGISTRATION = {
    id: PACKAGE_ID,
    __pure: {
      readService,
      interp,
      versionOfTag,
      repoFromUrl,
      matchRelease,
      filterPrerelease,
      userMessage,
      diagnostics: null,
      installBlocker,
      stripMarkdown,
      outcomeOf,
      planSteps,
      stepState,
      outputOf,
      updatableBundles,
      bulkSummary,
      bulkRows,
      bulkTargets,
    },
    factory() {
      const SEL = {
        scope: '[data-plugin-body]',
        scopeAlt: '[data-plugin-panel]',
        card: 'li[data-plugin-package]',
        end: '[class*="cardEnd"]',
        badge: '[class*="statusTag"]',
        toggle: '[class*="bundleToggle"]',
        switch: '[role="switch"]',
        toolbar: '[data-plugin-toolbar]',
        note: '[class*="updatesNote"]',
      };

      /** Localised text of the official `statusUpdateAvailable` tag, all 8 shipped languages. */
      const BADGE_TEXTS = [
        '可更新',
        'Update available',
        'アップデートあり',
        'Actualización disponible',
        'Mise à jour disponible',
        'Update verfügbar',
        'Доступно обновление',
        'Atualização disponível',
      ];

      const DEFAULT_REGISTRY = 'https://registry.npmmirror.com';
      const VERSION_TTL = 10 * 60 * 1000;
      const RELEASES_TTL = 20 * 60 * 1000;
      const HOVER_OPEN_MS = 140;
      const HOVER_CLOSE_MS = 180;
      const FETCH_TIMEOUT = 12000;

      const CSS = `
  .pue-slot{display:inline-flex;align-items:center;flex:none}
  .pue-btn{appearance:none;border:0;background:transparent;font-family:inherit;font-size:12px;line-height:20px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background-color .12s ease,color .12s ease}
  .pue-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .pue-btn:active{background:var(--dsw-alias-interactive-bg-active)}
  .pue-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
  .pue-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;background:transparent}
  .pue-open{position:relative;z-index:3}
  .pue-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:4;box-sizing:border-box;display:flex;flex-direction:column;width:min(320px,calc(100vw - 32px));max-height:min(360px,60vh);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);animation:pue-in .12s ease-out}
  .pue-pop[data-flip="up"]{top:auto;bottom:calc(100% + 6px)}
  @keyframes pue-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}
  .pue-head{display:flex;align-items:center;gap:8px;padding:10px 10px 6px 12px;min-width:0}
  .pue-hint{margin-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
  .pue-build{flex:none;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
  .pue-title{font-size:13px;line-height:20px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pue-chip{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
  .pue-x{flex:none;margin-left:auto;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;cursor:pointer;font-family:inherit}
  .pue-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .pue-x:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
  .pue-body{min-height:0;display:flex;flex-direction:column}
  .pue-list{list-style:none;margin:0;padding:2px 6px 6px;overflow:auto;max-height:min(240px,42vh);display:flex;flex-direction:column;gap:1px}
  .pue-li{display:block;margin:0}
  .pue-row{display:flex;flex-direction:column;gap:1px;width:100%;padding:5px 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;font-family:inherit;text-align:left;color:var(--dsw-alias-label-primary);cursor:pointer}
  .pue-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .pue-row:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
  .pue-row[aria-selected="true"]{background:var(--dsw-alias-interactive-bg-active)}
  .pue-row[aria-disabled="true"]{opacity:.45;cursor:default}
  .pue-row[aria-disabled="true"]:hover{background:transparent}
  .pue-row-main{display:flex;align-items:baseline;gap:8px;min-width:0}
  .pue-v{font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
  .pue-tag{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;white-space:nowrap}
  .pue-tag[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
  .pue-tag[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
  .pue-date{margin-left:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}
  .pue-why{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
  .pue-tick{flex:none;width:12px;font-size:11px;line-height:16px;color:var(--dsw-alias-brand-primary);opacity:0}
  .pue-row[aria-selected="true"] .pue-tick{opacity:1}
  .pue-loading{display:flex;align-items:center;gap:8px;padding:10px 12px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-spin{width:12px;height:12px;flex:none;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:pue-spin .8s linear infinite}
  @keyframes pue-spin{to{transform:rotate(360deg)}}
  .pue-foot{display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px}
  .pue-foot[data-bordered="true"]{border-top:1px solid var(--dsw-alias-border-l1)}
  .pue-info{display:flex;flex-wrap:wrap;gap:2px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
  .pue-actions{display:flex;align-items:center;gap:8px}
  .pue-spacer{margin-left:auto}
  .pue-primary{height:24px;padding:0 12px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
  .pue-primary:hover{background:var(--dsw-alias-button-primary-hover)}
  .pue-primary:disabled{opacity:.5;cursor:default}
  .pue-primary:focus-visible,.pue-ghost:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
  .pue-ghost{height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}
  .pue-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .pue-ghost:disabled{opacity:.5;cursor:default;background:transparent}
  .pue-confirm{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
  .pue-steps{display:flex;flex-direction:column;gap:2px;padding:6px 12px 8px}
  .pue-step{display:flex;align-items:center;gap:8px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
  .pue-step[data-state="active"],.pue-step[data-state="done"]{color:var(--dsw-alias-label-primary)}
  .pue-step[data-state="failed"]{color:var(--dsw-alias-state-error-primary)}
  .pue-glyph{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;line-height:1}
  .pue-out{display:flex;flex-direction:column;gap:4px;padding:8px 12px 6px}
  .pue-out-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
  .pue-out[data-tone="success"] .pue-out-title{color:var(--dsw-alias-state-success-primary)}
  .pue-out[data-tone="warn"] .pue-out-title{color:var(--dsw-alias-state-warn-primary)}
  .pue-out[data-tone="error"] .pue-out-title{color:var(--dsw-alias-state-error-primary)}
  .pue-out-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
  .pue-out details{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
  .pue-out summary{cursor:pointer;padding:2px 0}
  .pue-out pre{margin:4px 0 0;max-height:160px;overflow:auto;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}
  .pue-notes{position:absolute;right:calc(100% + 8px);box-sizing:border-box;width:min(360px,calc(100vw - 64px));max-height:300px;overflow:auto;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv3);z-index:5;animation:pue-in .1s ease-out}
  .pue-notes-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;flex-wrap:wrap}
  .pue-notes-v{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
  .pue-notes-date{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-notes-link{margin-left:auto;border:0;background:transparent;padding:0;font-family:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-link);text-decoration:none;cursor:pointer}
  .pue-notes-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
  .pue-notes[data-scrollable="true"]{-webkit-mask-image:linear-gradient(to bottom,#000 0,#000 calc(100% - 20px),transparent 100%);mask-image:linear-gradient(to bottom,#000 0,#000 calc(100% - 20px),transparent 100%)}
  .pue-notes-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-facts{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}
  .pue-fact{display:flex;gap:8px;font-size:12px;line-height:18px}
  .pue-fact-k{flex:none;width:60px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-fact-v{min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word}
  .pue-all{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-family:inherit;font-size:12px;line-height:20px;height:24px;padding:0 10px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;transition:background-color .12s ease,color .12s ease}
  .pue-all:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
  .pue-all:active{background:var(--dsw-alias-interactive-bg-active)}
  .pue-all:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
  .pue-all:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;background:var(--dsw-alias-bg-layer-2)}
  .pue-all[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}
  .pue-panel{position:fixed;z-index:60;box-sizing:border-box;display:flex;flex-direction:column;width:min(440px,calc(100vw - 24px));max-height:min(540px,calc(100vh - 24px));background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);animation:pue-in .12s ease-out}
  .pue-panel-body{min-height:0;display:flex;flex-direction:column;overflow:auto}
  .pue-bulk{list-style:none;margin:0;padding:2px 6px 8px;display:flex;flex-direction:column;gap:2px}
  .pue-bulk-item{display:flex;flex-direction:column;border-radius:var(--dsw-radius-sm)}
  .pue-bulk-item[data-open="true"]{background:var(--dsw-alias-bg-layer-2)}
  .pue-bulk-head{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:var(--dsw-radius-sm);min-width:0}
  .pue-bulk-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .pue-bulk-name{min-width:0;flex:1;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pue-bulk-from{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
  .pue-bulk-arrow{flex:none;font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-bulk-pick{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11px;line-height:1;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pue-bulk-pick:hover{background:var(--dsw-alias-interactive-bg-hover)}
  .pue-bulk-pick:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
  .pue-bulk-pick:disabled{opacity:.5;cursor:default}
  .pue-bulk-pick[data-state="loading"]{color:var(--dsw-alias-label-tertiary)}
  .pue-bulk-state{flex:none;width:14px;font-size:11px;line-height:18px;text-align:center;color:var(--dsw-alias-label-tertiary)}
  .pue-bulk-state[data-tone="done"]{color:var(--dsw-alias-state-success-primary)}
  .pue-bulk-state[data-tone="failed"]{color:var(--dsw-alias-state-error-primary)}
  .pue-bulk-versions{padding:0 6px 6px 22px}
  .pue-bulk-versions .pue-list{max-height:min(180px,32vh)}
  .pue-bulk-foot{display:flex;flex-direction:column;gap:8px;padding:8px 10px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
  .pue-bulk-note{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 8px 6px}
  .pue-bulk-note[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
  .pue-bulk-done{display:flex;flex-direction:column;gap:2px;max-height:min(240px,40vh);overflow:auto;padding:2px 12px 8px}
  .pue-bulk-line{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px}
  .pue-bulk-line .pue-bulk-name{flex:1}
  .pue-bulk-line[data-tone="failed"] .pue-bulk-name{color:var(--dsw-alias-state-error-primary)}
  .pue-bulk-line span:last-child{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
  .pue-panel-head{display:flex;align-items:center;gap:8px;padding:10px 10px 6px 12px;min-width:0}
  .pue-panel-title{flex:1;min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pue-panel-body{position:relative}
  .pue-panel .pue-list{max-height:none}
  .pue-bulk-item[data-state="running"] .pue-bulk-name{color:var(--dsw-alias-label-primary)}
  .pue-bulk-item[data-state="done"] .pue-bulk-name{color:var(--dsw-alias-label-secondary)}
  .pue-bulk-item[data-state="failed"] .pue-bulk-name{color:var(--dsw-alias-state-error-primary)}
  .pue-bulk-item[data-state="skipped"] .pue-bulk-name{color:var(--dsw-alias-label-tertiary)}
  .pue-notes[data-fixed="true"]{position:fixed;right:auto;z-index:61}
  .pue-panel-empty{display:flex;flex-direction:column;gap:8px;padding:14px 14px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
  .pue-panel-empty .pue-loading{padding:0}
  @media (prefers-reduced-motion:reduce){.pue-pop,.pue-panel,.pue-notes{animation:none}.pue-spin{animation-duration:2.4s}}
  `;

      const DICT = {
        zh: {
          entry: '更新',
          rpcUnavailable: FALLBACK_UNAVAILABLE,
          entryLabel: '更新 {name}',
          close: '关闭',
          versions: '版本',
          installedAt: '已安装 {version}',
          checking: '正在检查更新',
          latest: '已是最新版本',
          checkedAt: '上次检查于 {time}',
          blocked: '新版本需要更新 DSH',
          needsPeers: '需要 {peers}',
          notBundle: '这个版本没有声明组合包，无法安装',
          noneInstallable: '没有可直接安装的新版本',
          prerelease: '预发布',
          deprecated: '已弃用',
          publishedAt: '发布于 {date}',
          omitted: '另有 {count} 个版本未列出',
          showPrerelease: '显示预发布版本',
          hidePrerelease: '隐藏预发布版本',
          registry: '安装源',
          updateTo: '更新到 {version}',
          cancel: '取消',
          confirm: '更新',
          confirmText: '将从 {from} 更新到 {to}，期间插件可能短暂停止。安装失败时会保留或重新安装 {from}。',
          running: '正在更新',
          updateStepChecking: '检查 {version}',
          updateStepRemoving: '停止并移除 {version}',
          updateStepInstalling: '从 {registry} 安装 {version}',
          updateStepRestoring: '重新安装 {version}',
          done: '已更新到 {version}',
          doneDetail: '新版本已经开始运行。',
          restart: '已安装 {version}，重启后生效',
          restartDetail: '重启 DSH 后生效，当前仍在运行旧版本。',
          refused: '无法更新到 {version}',
          removeFailed: '无法移除 {version}',
          restored: '更新失败，已恢复到 {version}',
          restoredDetail: '{to} 安装失败，插件已重新安装 {from}。',
          broken: '更新失败，插件未安装',
          brokenDetail: '{to} 安装失败，重新安装 {from} 也未成功。请从“添加插件”重新安装。',
          lost: '无法确认更新结果',
          lostDetail: '与 DSH 的连接中断：{reason}。刷新插件列表可查看当前版本。',
          keptDetail: '{from} 未被移除，仍在使用。{reason}',
          finish: '完成',
          output: '查看安装输出',
          network: '无法连接安装源',
          unknown: '失败',
          retry: '重试',
          buildHint: '插件更新入口的构建版本',
          serviceHint: '如果一直如此，请在插件页把「插件更新入口」关闭再打开，让入口重新加载；仍失败请重启 DSH。',
          noNotes: '没有找到这一版本的更新说明',
          notesLoading: '正在读取更新说明',
          viewOnGitHub: '在 GitHub 查看',
          factVersion: '版本',
          factDate: '发布',
          factTags: '标签',
          factNeeds: '需要',
          factBundle: '组合包',
          yes: '是',
          no: '否',
          all: '一键更新',
          allLabel: '一键更新全部可更新插件',
          allTitle: '可更新的插件',
          allChecking: '正在读取可更新的插件',
          allNone: '当前没有可更新的插件',
          allCount: '{count} 个插件可更新',
          allRun: '更新 {count} 个',
          allRunning: '正在更新',
          allProgress: '第 {index}/{total} 个 · {name}',
          allDone: '更新完成',
          allDoneDetail: '{ok} 个已更新，{failed} 个失败',
          allPartial: '部分插件未能更新',
          allFailed: '失败',
          allSkipped: '已跳过',
          allStopped: '已停止，剩余 {count} 个未处理',
          allSkippedDetail: '{count} 个已跳过',
          allStop: '停止',
          allPick: '选择版本',
          allHint: '按列表顺序逐个更新；展开插件可换版本或查看更新日志。',
          allRetry: '重新读取',
          allStuck: '{count} 个版本尚未取到',
          allEmpty: '全部插件已是最新版本',
        },
        en: {
          entry: 'Update',
          rpcUnavailable: 'The DSH connection is not ready yet. Try again in a moment.',
          entryLabel: 'Update {name}',
          close: 'Close',
          versions: 'Versions',
          installedAt: 'Installed {version}',
          checking: 'Checking for updates',
          latest: 'Already up to date',
          checkedAt: 'Checked {time}',
          blocked: 'A newer version needs a newer DSH',
          needsPeers: 'Needs {peers}',
          notBundle: 'This version declares no bundle and cannot be installed',
          noneInstallable: 'No newer version can be installed directly',
          prerelease: 'Pre-release',
          deprecated: 'Deprecated',
          publishedAt: 'Published {date}',
          omitted: '{count} more versions are not listed',
          showPrerelease: 'Show pre-release versions',
          hidePrerelease: 'Hide pre-release versions',
          registry: 'Registry',
          updateTo: 'Update to {version}',
          cancel: 'Cancel',
          confirm: 'Update',
          confirmText: 'Updates from {from} to {to}. The plugin may stop briefly; a failed install keeps or reinstalls {from}.',
          running: 'Updating',
          updateStepChecking: 'Check {version}',
          updateStepRemoving: 'Stop and remove {version}',
          updateStepInstalling: 'Install {version} from {registry}',
          updateStepRestoring: 'Reinstall {version}',
          done: 'Updated to {version}',
          doneDetail: 'The new version is already running.',
          restart: 'Installed {version}, takes effect after restart',
          restartDetail: 'Restart DSH to run it; the old version is still running.',
          refused: 'Cannot update to {version}',
          removeFailed: 'Cannot remove {version}',
          restored: 'Update failed, restored {version}',
          restoredDetail: 'Installing {to} failed; {from} was installed again.',
          broken: 'Update failed, the plugin is not installed',
          brokenDetail: 'Installing {to} failed and reinstalling {from} did not succeed either. Reinstall it from “Add plugin”.',
          lost: 'The update result is unknown',
          lostDetail: 'The connection to DSH was interrupted: {reason}. Refresh the plugin list to see the current version.',
          keptDetail: '{from} was not removed and is still in use. {reason}',
          finish: 'Done',
          output: 'Show install output',
          network: 'Cannot reach the registry',
          unknown: 'Failed',
          retry: 'Retry',
          buildHint: 'Build of Plugin update entry',
          serviceHint: 'If this persists, switch Plugin update entry off and on in the plugin page so the entry reloads; restart DSH if it still fails.',
          noNotes: 'No release notes were found for this version',
          notesLoading: 'Reading release notes',
          viewOnGitHub: 'View on GitHub',
          factVersion: 'Version',
          factDate: 'Published',
          factTags: 'Tags',
          factNeeds: 'Needs',
          factBundle: 'Bundle',
          yes: 'Yes',
          no: 'No',
          all: 'Update all',
          allLabel: 'Update every updatable plugin',
          allTitle: 'Plugins with updates',
          allChecking: 'Reading updatable plugins',
          allNone: 'No plugin can be updated right now',
          allCount: 'Updates available: {count}',
          allRun: 'Update {count}',
          allRunning: 'Updating',
          allProgress: '{index}/{total} · {name}',
          allDone: 'Updates finished',
          allDoneDetail: '{ok} updated, {failed} failed',
          allPartial: 'Some plugins could not be updated',
          allFailed: 'Failed',
          allSkipped: 'Skipped',
          allStopped: 'Stopped with {count} left to process',
          allSkippedDetail: '{count} skipped',
          allStop: 'Stop',
          allPick: 'Choose version',
          allHint: 'Plugins update one after another. Expand one to change its version or read release notes.',
          allRetry: 'Read again',
          allStuck: '{count} not read yet',
          allEmpty: 'Everything is up to date',
        },
      };

      /* ---------------- small DOM helpers ---------------- */

      function el(tag, props, ...children) {
        const node = document.createElement(tag);
        if (props) {
          for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === 'class') node.className = value;
            else if (key === 'text') node.textContent = value;
            else if (key === 'style') Object.assign(node.style, value);
            else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
            else node.setAttribute(key, value === true ? '' : String(value));
          }
        }
        for (const child of children.flat(4)) {
          if (child === undefined || child === null || child === false || child === '') continue;
          node.append(typeof child === 'string' || typeof child === 'number'
            ? document.createTextNode(String(child))
            : child);
        }
        return node;
      }

      function formatDate(iso) {
        const text = String(iso || '');
        const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
      }

      function shortRegistry(registry) {
        return String(registry || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
      }

      function makeRequestId() {
        try {
          if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
            return globalThis.crypto.randomUUID();
          }
        } catch {}
        return `pue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }

      /* ---------------- module ---------------- */

      function apply(ctx) {
        const t = makeTranslate(ctx);
        const entries = new Map();
        const versionCache = new Map();
        const versionPending = new Map();
        const notesCache = new Map();
        const repoCache = new Map();
        const blockedRepos = new Set();
        const hover = { open: 0, close: 0 };
        let active = null;
        let running = null;
        let observer = null;
        let raf = 0;
        let scanFailures = 0;
        let disposed = false;
        let uid = 0;

        /* Bulk update targets the official toolbar's “N plugins can be updated”
         * note. That note is rendered by React only while every check is done,
         * so both the button and this state have to survive being torn down and
         * rebuilt at any moment. */
        /* The bulk surface reuses the card popover's note renderer, which reads
         * its subject from an `entry`-shaped object. `bulk.host` is that stand-in:
         * it is never mounted, never scanned, and only carries the fields
         * `notesNodes`/`loadNotes` actually touch. */
        const bulk = {
          open: false,
          phase: 'idle',
          items: [],
          error: '',
          cancelled: false,
          expanded: null,
          showPre: false,
          currentName: '',
          index: 0,
          total: 0,
          button: null,
          anchor: null,
          panel: null,
          body: null,
          foot: null,
          hover: { open: 0, close: 0 },
          host: {
            uid: 'pue-bulk',
            name: '',
            popover: null,
            bubble: null,
            bubbleRow: null,
            bubbleKey: null,
            view: { list: null },
          },
        };

        const debug = readFlag('pueDebug');

        /* ---- locale ---- */

        function makeTranslate(service) {
          let bound = null;
          try {
            const translate = service.locale.bind(NS);
            if (typeof translate === 'function') bound = translate;
          } catch {}
          return (key, params) => {
            let text = null;
            if (bound) {
              try {
                const answer = bound(key, params);
                if (typeof answer === 'string' && answer !== key) text = answer;
              } catch {}
            }
            if (text === null) text = DICT.zh[key];
            if (text === undefined) text = key;
            return interp(text, params);
          };
        }

        /* ---- lifecycle ---- */

        try {
          window.__PUE_BUILD__ = BUILD;
        } catch {}

        ctx.effect(() => {
          try {
            return ctx.locale.register(NS, DICT);
          } catch {
            return () => {};
          }
        }, `${NS}: dictionaries`);

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.pluginCss = `${NS}/client.css`;
          style.textContent = CSS;
          document.head.append(style);
          return () => style.remove();
        }, `${NS}: styles`);

        ctx.effect(() => {
          const stopEvents = subscribeUpdates();
          attach();
          return () => {
            disposed = true;
            stopEvents();
            detach();
          };
        }, `${NS}: card entries`);

        /* ---- host events ---- */

        function subscribeUpdates() {
          const bus = readService(ctx, 'remote');
          if (!bus || typeof bus.$on !== 'function') return () => {};
          try {
            const dispose = bus.$on('plugin-manager/update-state', (payload) => advance(payload));
            return typeof dispose === 'function' ? dispose : () => {};
          } catch {
            return () => {};
          }
        }

        /* `remote.pluginManager` is a cordis Service registered under a DOTTED
         * name (see the gateway: `super(ctx, remoteServiceKey(namespace))`).
         * Reading it through the context proxy needs BOTH `remote` and
         * `remote.pluginManager` in this fiber's `inject` — with only the dotted
         * name the proxy throws on the `remote` hop, with only the bare name it
         * throws on the dotted read (reproduced against the vendored cordis).
         * `readService()` above avoids that coupling entirely: `ctx.get(name)`
         * reads the same store with no proxy guard and no activation condition. */
        const MANAGER_SERVICE = 'remote.pluginManager';

        /* Third tier: the gateway's own transport. `connection.rpc.call` is what
         * every namespace method ultimately does (`invoke()` → `rpc.call('/api',
         * endpoint, {args})`), and `connection` is a plain-named service that is
         * always mounted, so this works even when the namespace fiber is missing
         * or the ctx proxy refuses the dotted read. */
        function managerFromConnection() {
          const connection = readService(ctx, 'connection');
          if (!connection || !connection.rpc || typeof connection.rpc.call !== 'function') return undefined;
          /* The Host refuses anything but ONE plain object keyed by parameter
           * name: `Remote payload must contain exactly one plain-object args
           * field`. The gateway builds it exactly this way (`prepared.args` is
           * keyed by the descriptor's parameter names, undefined values dropped).
           * An array is rejected, so the call shape below mirrors the wire. */
          const call = (method, args) => connection.rpc.call('/api', `pluginManager/${method}`, { args });
          return {
            listBundles: () => call('listBundles', {}),
            listVersions: (name, options) => call('listVersions', { name, options }),
            updateBundle: (name, version, options) => call('updateBundle', { name, version, options }),
          };
        }

        /* Last tier: the wire itself. The page is same-origin with the Host, so a
         * plain POST carries the session cookie, and `/api/<namespace>/<method>`
         * accepts the same envelope the Connection caller sends:
         *   { type: 'client-request', rpcId, method, payload: { args } }
         * The answer is `{ type: 'server-response', rpcId, result: { ok, value } }`.
         * This tier touches no cordis service at all, which is what makes the
         * control survive a module that materialized before the gateway did. */
        function managerFromFetch() {
          const send = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
          if (!send) return undefined;
          const call = async (method, args) => {
            const rpcId = makeRequestId();
            const response = await send(`/api/pluginManager/${method}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({
                type: 'client-request',
                rpcId,
                method: `pluginManager/${method}`,
                payload: { args },
              }),
            });
            if (!response || !response.ok) throw new Error(`plugin-manager: HTTP ${response ? response.status : 'no response'}`);
            const envelope = await response.json();
            if (!envelope || typeof envelope !== 'object' || !envelope.result) {
              throw new Error('plugin-manager: malformed response envelope');
            }
            return envelope.result;
          };
          return {
            listBundles: () => call('listBundles', {}),
            listVersions: (name, options) => call('listVersions', { name, options }),
            updateBundle: (name, version, options) => call('updateBundle', { name, version, options }),
          };
        }

        /* Why the page needs this: `remote.pluginManager` is mounted by the api
         * gateway only after it has mounted the contribution that declares the
         * methods, and the whole module can be materialized before that happens.
         * A silent fallback message cannot tell "not mounted yet" apart from "this
         * bundle is stale", so the failure carries what was actually found. */
        function diagnostics() {
          const found = [];
          try {
            if (ctx.get) found.push(`get=${typeof ctx.get(MANAGER_SERVICE)}`);
          } catch (error) {
            found.push(`get=throw:${messageOf(error)}`);
          }
          try {
            if (ctx.reflect && ctx.reflect.get) found.push(`reflect=${typeof ctx.reflect.get(MANAGER_SERVICE)}`);
          } catch (error) {
            found.push(`reflect=throw:${messageOf(error)}`);
          }
          try {
            const connection = readService(ctx, 'connection');
            found.push(`connection=${connection ? (connection.rpc && typeof connection.rpc.call === 'function' ? 'rpc' : 'no-rpc') : 'none'}`);
            found.push(`fetch=${typeof globalThis.fetch === 'function' ? 'yes' : 'none'}`);
          } catch (error) {
            found.push(`connection=throw:${messageOf(error)}`);
          }
          try {
            if (ctx.reflect && ctx.reflect.props) {
              const names = Object.keys(ctx.reflect.props).filter((key) => key.startsWith('remote'));
              found.push(`props=${names.length ? names.join(',') : 'none'}`);
            }
          } catch {}
          return found.join(' · ') || 'no ctx';
        }

        function advance(payload) {
          if (!running || !payload || payload.requestId !== running.requestId) return;
          running.current = payload.step;
          const entry = running.entry;
          entry.view.current = payload.step;
          if (entry.popover) render(entry);
        }

        /* ---- scanning the official page ---- */

        function scope() {
          return document.querySelector(SEL.scope) || document.querySelector(SEL.scopeAlt);
        }

        function attach() {
          observer = new MutationObserver(() => schedule());
          observer.observe(document.body, { childList: true, subtree: true });
          document.addEventListener('pointerdown', onDocumentPointerDown, true);
          document.addEventListener('keydown', onDocumentKeydown, true);
          window.addEventListener('scroll', onViewportChange, true);
          window.addEventListener('resize', onViewportChange);
          schedule();
        }

        function detach() {
          if (observer) observer.disconnect();
          observer = null;
          document.removeEventListener('pointerdown', onDocumentPointerDown, true);
          document.removeEventListener('keydown', onDocumentKeydown, true);
          window.removeEventListener('scroll', onViewportChange, true);
          window.removeEventListener('resize', onViewportChange);
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
          for (const li of [...entries.keys()]) removeEntry(li);
          closeBulk();
          bulk.button = null;
          bulk.anchor = null;
          clearTimeout(hover.open);
          clearTimeout(hover.close);
          clearTimeout(bulk.hover.open);
          clearTimeout(bulk.hover.close);
          active = null;
          running = null;
        }

        function schedule() {
          if (disposed || raf) return;
          raf = requestAnimationFrame(() => {
            raf = 0;
            try {
              scan();
              scanFailures = 0;
            } catch (error) {
              scanFailures += 1;
              warn('scan failed', error);
              if (scanFailures >= 3) {
                warn('giving up on this page build');
                if (observer) observer.disconnect();
                observer = null;
              }
            }
          });
        }

        function scan() {
          if (disposed) return;
          const host = scope();
          if (!host) {
            for (const li of [...entries.keys()]) removeEntry(li);
            ensureBulkButton();
            return;
          }
          const live = new Set();
          for (const li of host.querySelectorAll(SEL.card)) {
            const name = li.getAttribute('data-plugin-package');
            if (!name) continue;
            live.add(li);
            const end = li.querySelector(SEL.end);
            const badged = Boolean(end && hasBadge(li));
            const entry = entries.get(li);
            if (!badged) {
              if (entry) removeEntry(li);
              continue;
            }
            if (entry && entry.slot.parentElement === end) {
              syncBusy(entry);
              continue;
            }
            if (entry) removeEntry(li);
            mount(li, end, name);
          }
          for (const li of [...entries.keys()]) {
            if (!live.has(li) || !li.isConnected) removeEntry(li);
          }
          ensureBulkButton();
        }

        function hasBadge(li) {
          for (const tag of li.querySelectorAll(SEL.badge)) {
            const text = (tag.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            if (BADGE_TEXTS.some((label) => text === label || text.includes(label))) return tag;
          }
          return null;
        }

        function mount(li, end, name) {
          const slot = el('span', { class: 'pue-slot' });
          const button = el('button', {
            class: 'pue-btn',
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false',
            title: t('entryLabel', { name }),
          }, t('entry'));
          slot.append(button);
          end.insertBefore(slot, end.firstElementChild);
          uid += 1;
          const entry = {
            li,
            slot,
            button,
            name,
            uid: `pue-${uid}`,
            popover: null,
            body: null,
            foot: null,
            chip: null,
            bubble: null,
            bubbleRow: null,
            view: {
              phase: 'idle',
              list: null,
              selected: null,
              showPre: false,
              confirm: false,
              outcome: null,
              output: '',
              current: null,
              run: null,
              error: '',
              installed: '',
            },
          };
          entries.set(li, entry);
          button.addEventListener('pointerdown', (event) => event.stopPropagation());
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (active === entry) closePopover(entry, { restoreFocus: true });
            else openPopover(entry);
          });
          syncBusy(entry);
          if (debug) console.info(`[${NS}] attached ${name}`);
          return entry;
        }

        function removeEntry(li) {
          const entry = entries.get(li);
          if (!entry) return;
          closePopover(entry);
          entry.slot.remove();
          entries.delete(li);
          li.classList.remove('pue-open');
          li.style.zIndex = '';
        }

        function isCardBusy(li) {
          const toggle = li.querySelector(SEL.switch);
          if (!toggle) return false;
          return toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true';
        }

        function syncBusy(entry) {
          /* A bulk run and a card run write the same profile, so one disables
           * the entry point of the other. */
          entry.button.disabled = Boolean(running) || bulk.phase === 'running' || isCardBusy(entry.li);
        }

        function syncBusyAll() {
          for (const entry of entries.values()) syncBusy(entry);
        }

        /* ---- popover shell ---- */

        function openPopover(entry) {
          if (bulk.open && bulk.phase !== 'running') closeBulk();
          if (active && active !== entry) closePopover(active);
          ensurePopover(entry);
          active = entry;
          entry.li.classList.add('pue-open');
          entry.li.style.zIndex = '3';
          entry.button.setAttribute('aria-expanded', 'true');
          entry.view.confirm = false;
          const cached = fresh(versionCache.get(entry.name));
          if (cached) {
            entry.view.list = cached;
            entry.view.phase = 'listed';
            entry.view.installed = cached.installed || '';
            pickDefault(entry);
            render(entry);
          } else {
            loadVersions(entry);
          }
          position(entry);
        }

        function closePopover(entry, options) {
          if (!entry) return;
          hideNotes(entry);
          if (entry.popover) {
            entry.popover.remove();
            entry.popover = null;
            entry.body = null;
            entry.foot = null;
            entry.chip = null;
            entry.bubble = null;
            entry.bubbleRow = null;
          }
          entry.li.classList.remove('pue-open');
          entry.li.style.zIndex = '';
          entry.button.setAttribute('aria-expanded', 'false');
          if (active === entry) active = null;
          if (options && options.restoreFocus) {
            try {
              entry.button.focus();
            } catch {}
          }
        }

        function ensurePopover(entry) {
          if (entry.popover) return entry.popover;
          const popover = el('div', {
            class: 'pue-pop',
            role: 'dialog',
            'aria-modal': 'false',
            'aria-label': t('entryLabel', { name: entry.name }),
          });
          const chip = el('span', { class: 'pue-chip' });
          chip.hidden = true;
          const title = el('span', { class: 'pue-title', title: entry.name }, entry.name);
          const close = el('button', {
            class: 'pue-x',
            type: 'button',
            'aria-label': t('close'),
            onclick: (event) => {
              event.stopPropagation();
              closePopover(entry, { restoreFocus: true });
            },
          }, '×');
          const stamp = readFlag('pueDebug')
            ? el('span', { class: 'pue-build', title: t('buildHint') }, BUILD)
            : null;
          const head = el('div', { class: 'pue-head' }, title, chip, stamp, close);
          const body = el('div', { class: 'pue-body' });
          const foot = el('div', { class: 'pue-foot' });
          popover.append(head, body, foot);
          popover.addEventListener('pointerdown', (event) => event.stopPropagation());
          popover.addEventListener('click', (event) => event.stopPropagation());
          popover.addEventListener('keydown', (event) => onPopoverKeydown(entry, event));
          entry.slot.append(popover);
          entry.popover = popover;
          entry.body = body;
          entry.foot = foot;
          entry.chip = chip;
          return popover;
        }

        /* ---- version data ---- */

        function fresh(recorded) {
          if (!recorded) return null;
          return Date.now() - recorded.at < VERSION_TTL ? recorded.list : null;
        }

        async function loadVersions(entry, force) {
          const name = entry.name;
          const cached = force ? null : fresh(versionCache.get(name));
          if (cached) {
            entry.view.list = cached;
            entry.view.phase = 'listed';
            entry.view.installed = cached.installed || '';
            pickDefault(entry);
            render(entry);
            return;
          }
          entry.view.phase = 'loading';
          entry.view.confirm = false;
          render(entry);
          try {
            const list = await listVersions(name, versionPending);
            entry.view.list = list;
            if (list.status === 'listed') {
              versionCache.set(name, { list, at: Date.now() });
              entry.view.phase = 'listed';
              entry.view.installed = list.installed || '';
              pickDefault(entry);
            } else {
              entry.view.phase = 'refused';
              entry.view.installed = '';
            }
          } catch (error) {
            entry.view.phase = 'error';
            entry.view.error = userMessage(error);
            warn(`listVersions(${name})`, error);
          }
          render(entry);
        }

        /* The gateway mounts a namespace as its own fiber when a contribution is
         * mounted; a module that materialized earlier can lose that race. Poll
         * briefly instead of failing the click, and never poll while a popover is
         * closed. */
        /* The tiers are tried in order, and a tier that THROWS is skipped for the
         * next one instead of ending the click. That matters because the first
         * two tiers exist only to keep the call in-process; the last tier is the
         * one that always works on a page same-origin with its Host. */
        function managerTiers() {
          const tiers = [];
          const service = readService(ctx, MANAGER_SERVICE);
          if (service) tiers.push({ name: 'service', manager: service });
          const rpc = managerFromConnection();
          if (rpc) tiers.push({ name: 'rpc', manager: rpc });
          const wire = managerFromFetch();
          if (wire) tiers.push({ name: 'fetch', manager: wire });
          return tiers;
        }

        /* A read may be retried on the next tier after ANY failure: the only cost
         * is a second lookup. A mutation may not. If the Host accepted
         * `updateBundle` and the answer was lost on the way back, retrying would
         * dispatch a second update, so a mutation only moves to the next tier
         * while the failure proves the request never left the page. */
        const NEVER_SENT = /without inject|cannot get property|has no active Connection|is not a function|not a function/i;

        async function viaTiers(method, args, options = {}) {
          const { mutating = false, timeoutMs = 6000 } = options;
          const deadline = Date.now() + timeoutMs;
          const failures = [];
          for (;;) {
            const tiers = managerTiers();
            if (tiers.length === 0) {
              if (Date.now() >= deadline) break;
              await new Promise((resolve) => setTimeout(resolve, 200));
              continue;
            }
            for (const tier of tiers) {
              try {
                return await tier.manager[method](...args);
              } catch (error) {
                const raw = messageOf(error);
                failures.push(`${tier.name}: ${raw}`);
                if (mutating && !NEVER_SENT.test(raw)) {
                  failures.push('mutation not retried');
                  break;
                }
              }
            }
            break;
          }
          const detail = failures.length ? ` · ${failures.join(' | ')}` : '';
          throw new Error(`${t('rpcUnavailable')}（pue ${BUILD} · ${diagnostics()}${detail}）`);
        }

        function listVersions(name, pending, force) {
          const shared = force ? null : pending.get(name);
          if (shared) return shared;
          const task = (async () => {
            const answer = await viaTiers('listVersions', [name, {}]);
            if (answer && answer.ok === false) {
              throw new Error((answer.error && (answer.error.message || answer.error.code)) || t('unknown'));
            }
            return answer && answer.value ? answer.value : answer;
          })().finally(() => pending.delete(name));
          pending.set(name, task);
          return task;
        }

        function pickDefault(entry) {
          const list = entry.view.list;
          if (!list || list.status !== 'listed') {
            entry.view.selected = null;
            return;
          }
          const shown = filterPrerelease(list.versions, entry.view.showPre);
          const first = shown.find((item) => !installBlocker(item));
          if (entry.view.selected && !shown.some((item) => item.version === entry.view.selected)) {
            entry.view.selected = null;
          }
          if (!entry.view.selected && first) entry.view.selected = first.version;
        }

        /* ---- rendering ---- */

        function render(entry) {
          if (!entry.popover || !entry.body || !entry.foot) return;
          const view = entry.view;
          entry.chip.hidden = !view.installed;
          entry.chip.textContent = view.installed ? t('installedAt', { version: view.installed }) : '';
          entry.body.replaceChildren(...bodyNodes(entry));
          entry.foot.replaceChildren(...footNodes(entry));
          if (entry.bubbleRow && entry.bubbleRow.isConnected) positionNotes(entry, entry.bubbleRow);
          else hideNotes(entry);
          position(entry);
        }

        function bodyNodes(entry) {
          const view = entry.view;
          if (view.phase === 'loading') {
            return [el('div', { class: 'pue-loading' }, el('span', { class: 'pue-spin' }), t('checking'))];
          }
          if (view.phase === 'refused') {
            const reason = (view.list && view.list.reason) || t('unknown');
            return [el('div', { class: 'pue-loading' }, reason)];
          }
          if (view.phase === 'error') {
            return [
              el('div', { class: 'pue-loading' }, view.error || t('network')),
              el('div', { class: 'pue-hint' }, t('serviceHint')),
            ];
          }
          if (view.phase === 'running') return [stepsNode(entry)];
          if (view.phase === 'done') return [outcomeNode(entry)];
          return [listNode(entry)];
        }

        function listNode(entry) {
          const view = entry.view;
          const list = view.list || { versions: [] };
          const shown = filterPrerelease(list.versions, view.showPre);
          if (!shown.length) {
            return el('div', { class: 'pue-loading' }, list.versions && list.versions.length ? t('noneInstallable') : t('latest'));
          }
          const selectedId = view.selected ? `${entry.uid}-opt-${view.selected}` : undefined;
          const listbox = el('ul', {
            class: 'pue-list',
            role: 'listbox',
            'aria-label': t('versions'),
            'aria-activedescendant': selectedId,
            onkeydown: (event) => onListKeydown(entry, event),
          });
          for (const item of shown) {
            const row = rowNode(entry, item);
            listbox.append(el('li', { class: 'pue-li', role: 'none' }, row));
          }
          return listbox;
        }

        function rowNode(entry, item) {
          const view = entry.view;
          const blocker = installBlocker(item);
          const selected = view.selected === item.version;
          const tags = el('span', { class: 'pue-row-main' },
            el('span', { class: 'pue-v' }, item.version),
            item.prerelease ? el('span', { class: 'pue-tag' }, t('prerelease')) : null,
            item.deprecated ? el('span', { class: 'pue-tag', 'data-tone': 'warn' }, t('deprecated')) : null,
            item.incompatible ? el('span', { class: 'pue-tag', 'data-tone': 'error' }, t('blocked')) : null,
            item.publishedAt ? el('span', { class: 'pue-date' }, formatDate(item.publishedAt)) : null,
            el('span', { class: 'pue-tick', 'aria-hidden': 'true' }, '✓'),
          );
          const children = [tags];
          if (blocker) children.push(el('span', { class: 'pue-why' }, blocker === 'notBundle' ? t('notBundle') : t('blocked')));
          const row = el('button', {
            class: 'pue-row',
            type: 'button',
            role: 'option',
            id: `${entry.uid}-opt-${item.version}`,
            'aria-selected': selected ? 'true' : 'false',
            'aria-disabled': blocker ? 'true' : 'false',
            'data-version': item.version,
            onclick: (event) => {
              event.stopPropagation();
              if (blocker) return;
              view.selected = item.version;
              view.confirm = false;
              render(entry);
            },
          }, children);
          wireNotes(entry, item, row);
          return row;
        }

        function stepsNode(entry) {
          const view = entry.view;
          const run = view.run || { from: '', to: '', registry: '' };
          const steps = planSteps(run.from, run.to, run.registry);
          const rows = steps.map((step, index) => {
            const state = stepState(index, view.current);
            const glyph = state === 'done' ? '✓' : state === 'failed' ? '×' : state === 'active' ? '·' : '·';
            return el('div', { class: 'pue-step', 'data-state': state },
              el('span', { class: 'pue-glyph' },
                state === 'active' ? el('span', { class: 'pue-spin' }) : glyph),
              t(step.labelKey, step.params));
          });
          return el('div', { class: 'pue-steps' }, rows);
        }

        function outcomeNode(entry) {
          const view = entry.view;
          const outcome = view.outcome || { kind: 'lost', reason: '' };
          const tone = outcome.kind === 'done'
            ? 'success'
            : ['restart', 'restored', 'removeFailed', 'refused'].includes(outcome.kind) ? 'warn' : 'error';
          const params = {
            from: outcome.from || (view.run && view.run.from) || '',
            to: outcome.to || (view.run && view.run.to) || '',
            version: outcome.to || (view.run && view.run.to) || '',
            reason: outcome.reason || '',
          };
          const detailKey = `${outcome.kind}Detail`;
          let detail = t(detailKey, params);
          if (detail === detailKey) detail = '';
          if (outcome.kind === 'refused' || outcome.kind === 'lost') {
            if (outcome.reason) detail = outcome.reason;
          }
          const children = [
            el('div', { class: 'pue-out-title' }, t(outcome.kind, params)),
            detail ? el('div', { class: 'pue-out-detail' }, detail) : null,
          ];
          if (view.output) {
            children.push(el('details', {},
              el('summary', {}, t('output')),
              el('pre', {}, view.output)));
          }
          return el('div', { class: 'pue-out', 'data-tone': tone }, children);
        }

        function footNodes(entry) {
          const view = entry.view;
          if (view.phase === 'loading') return [];
          if (view.phase === 'running') {
            return [el('div', { class: 'pue-actions' },
              el('div', { class: 'pue-info' }, t('running')),
              el('span', { class: 'pue-spacer' }),
              el('span', { class: 'pue-spin' }))];
          }
          if (view.phase === 'done') {
            return [el('div', { class: 'pue-actions' },
              el('span', { class: 'pue-spacer' }),
              el('button', {
                class: 'pue-primary',
                type: 'button',
                onclick: (event) => {
                  event.stopPropagation();
                  closePopover(entry, { restoreFocus: true });
                },
              }, t('finish')))];
          }
          if (view.phase === 'refused' || view.phase === 'error') {
            return [el('div', { class: 'pue-actions' },
              el('span', { class: 'pue-spacer' }),
              el('button', {
                class: 'pue-ghost',
                type: 'button',
                onclick: (event) => {
                  event.stopPropagation();
                  versionCache.delete(entry.name);
                  loadVersions(entry, true);
                },
              }, t('retry')))];
          }

          const list = view.list || { versions: [] };
          const info = [];
          if (list.registry) info.push(el('span', {}, `${t('registry')} ${shortRegistry(list.registry)}`));
          if (list.omitted > 0) info.push(el('span', {}, t('omitted', { count: list.omitted })));
          const hidden = filterPrerelease(list.versions, false).length !== (list.versions || []).length;

          if (view.confirm && view.selected) {
            return [
              el('div', { class: 'pue-confirm' }, t('confirmText', { from: view.installed, to: view.selected })),
              el('div', { class: 'pue-actions' },
                el('span', { class: 'pue-spacer' }),
                el('button', {
                  class: 'pue-ghost',
                  type: 'button',
                  onclick: (event) => {
                    event.stopPropagation();
                    view.confirm = false;
                    render(entry);
                  },
                }, t('cancel')),
                el('button', {
                  class: 'pue-primary',
                  type: 'button',
                  onclick: (event) => {
                    event.stopPropagation();
                    runUpdate(entry);
                  },
                }, t('confirm'))),
            ];
          }

          const primary = el('button', {
            class: 'pue-primary',
            type: 'button',
            disabled: !view.selected,
            onclick: (event) => {
              event.stopPropagation();
              if (!view.selected) return;
              view.confirm = true;
              render(entry);
            },
          }, view.selected ? t('updateTo', { version: view.selected }) : t('noneInstallable'));

          return [
            info.length ? el('div', { class: 'pue-info' }, info) : null,
            el('div', { class: 'pue-actions' },
              hidden
                ? el('button', {
                  class: 'pue-ghost',
                  type: 'button',
                  'aria-pressed': view.showPre ? 'true' : 'false',
                  onclick: (event) => {
                    event.stopPropagation();
                    view.showPre = !view.showPre;
                    pickDefault(entry);
                    render(entry);
                  },
                }, view.showPre ? t('hidePrerelease') : t('showPrerelease'))
                : null,
              el('span', { class: 'pue-spacer' }),
              primary),
          ].filter(Boolean);
        }

        /* ---- notes bubble ---- */

        function wireNotes(entry, item, row) {
          row.addEventListener('pointerenter', () => {
            clearTimeout(hover.close);
            clearTimeout(hover.open);
            hover.open = setTimeout(() => drawNotes(entry, item, row), HOVER_OPEN_MS);
          });
          row.addEventListener('pointerleave', () => {
            clearTimeout(hover.open);
            scheduleHideNotes(entry);
          });
          row.addEventListener('focus', () => {
            clearTimeout(hover.close);
            clearTimeout(hover.open);
            drawNotes(entry, item, row);
          });
          row.addEventListener('blur', () => scheduleHideNotes(entry));
        }

        function scheduleHideNotes(entry) {
          clearTimeout(hover.close);
          hover.close = setTimeout(() => hideNotes(entry), HOVER_CLOSE_MS);
        }

        function hideNotes(entry) {
          clearTimeout(hover.close);
          clearTimeout(hover.open);
          if (entry && entry.bubble) {
            entry.bubble.remove();
            entry.bubble = null;
            entry.bubbleRow = null;
          }
        }

        function drawNotes(entry, item, row) {
          if (!entry.popover || !row.isConnected) return;
          let bubble = entry.bubble;
          if (!bubble) {
            bubble = el('div', { class: 'pue-notes', role: 'tooltip', id: `${entry.uid}-notes` });
            bubble.addEventListener('pointerenter', () => clearTimeout(hover.close));
            bubble.addEventListener('pointerleave', () => scheduleHideNotes(entry));
            entry.popover.append(bubble);
            entry.bubble = bubble;
          }
          entry.bubbleRow = row;
          row.setAttribute('aria-describedby', bubble.id);
          bubble.replaceChildren(...notesNodes(entry, item));
          markScrollable(bubble);
          positionNotes(entry, row);
          if (!item.__notes) {
            loadNotes(entry, item).then(() => {
              if (entry.bubble === bubble && entry.bubbleRow === row) {
                bubble.replaceChildren(...notesNodes(entry, item));
                markScrollable(bubble);
                positionNotes(entry, row);
              }
            });
          }
        }

        /* A masked fade says "there is more"; a hard cut says "this is broken". */
        function markScrollable(bubble) {
          if (!bubble) return;
          if (bubble.scrollHeight > bubble.clientHeight + 1) bubble.dataset.scrollable = 'true';
          else delete bubble.dataset.scrollable;
        }

        function positionNotes(entry, row) {
          const bubble = entry.bubble;
          if (!bubble) return;
          const popover = entry.popover;
          bubble.style.top = '0px';
          const limit = Math.max(0, (popover ? popover.clientHeight : 360) - bubble.offsetHeight);
          bubble.style.top = `${Math.min(Math.max(0, row.offsetTop), limit)}px`;
        }

        function notesNodes(entry, item) {
          const notes = item.__notes;
          const date = notes && notes.kind === 'release'
            ? formatDate(notes.release.publishedAt)
            : formatDate(item.publishedAt);
          const head = el('div', { class: 'pue-notes-head' },
            el('span', { class: 'pue-notes-v' }, item.version),
            date ? el('span', { class: 'pue-notes-date' }, t('publishedAt', { date })) : null,
            notes && notes.kind === 'release' && notes.release.url
              ? el('a', {
                class: 'pue-notes-link',
                href: notes.release.url,
                target: '_blank',
                rel: 'noreferrer noopener',
              }, t('viewOnGitHub'))
              : null);

          if (!notes) {
            return [head, el('div', { class: 'pue-notes-body' },
              el('span', { class: 'pue-spin' }), ' ', t('notesLoading'))];
          }
          if (notes.kind === 'release') {
            const body = stripMarkdown(notes.release.body);
            return [head, el('div', { class: 'pue-notes-body' }, body || t('noNotes'))];
          }
          const facts = [
            [t('factVersion'), item.version],
            [t('factDate'), formatDate(item.publishedAt)],
            [t('factTags'), (item.tags || []).join(', ') || '—'],
            [t('factBundle'), item.bundle ? t('yes') : t('no')],
          ];
          if (item.incompatible) {
            const peers = item.incompatible.requirements && Array.isArray(item.incompatible.requirements)
              ? item.incompatible.requirements.join(', ')
              : String(item.incompatible.runtimeVersion || '');
            facts.push([t('factNeeds'), peers || `${item.incompatible.name} ${item.incompatible.version}`]);
          }
          return [
            head,
            el('div', { class: 'pue-facts' }, facts.map(([key, value]) => el('div', { class: 'pue-fact' },
              el('span', { class: 'pue-fact-k' }, key),
              el('span', { class: 'pue-fact-v' }, String(value || '—'))))),
            el('div', { class: 'pue-notes-empty' }, t('noNotes')),
          ];
        }

        /* ---- release notes data ---- */

        async function loadNotes(entry, item) {
          if (item.__notes) return item.__notes;
          const registry = (entry.view.list && entry.view.list.registry) || DEFAULT_REGISTRY;
          let repo = null;
          try {
            repo = await repoFor(entry.name, registry);
          } catch (error) {
            warn(`registry(${entry.name})`, error);
          }
          if (repo && !blockedRepos.has(repo)) {
            try {
              const releases = await releasesFor(repo);
              const release = matchRelease(releases, item.version);
              if (release) {
                item.__notes = { kind: 'release', release };
                return item.__notes;
              }
            } catch (error) {
              if (error && (error.status === 403 || error.status === 429)) blockedRepos.add(repo);
              warn(`releases(${repo})`, error);
            }
          }
          item.__notes = { kind: 'facts' };
          return item.__notes;
        }

        async function repoFor(name, registry) {
          const cached = repoCache.get(name);
          if (cached && Date.now() - cached.at < RELEASES_TTL) return cached.repo;
          const url = `${String(registry).replace(/\/+$/, '')}/${name.replace('/', '%2F')}/latest`;
          const meta = await fetchJson(url);
          const repo = repoFromUrl(meta && meta.repository);
          repoCache.set(name, { repo, at: Date.now() });
          return repo;
        }

        async function releasesFor(repo) {
          const cached = notesCache.get(repo);
          if (cached && Date.now() - cached.at < RELEASES_TTL) return cached.map;
          const stored = readSession(`pue:releases:${repo}`);
          if (stored && Date.now() - stored.at < RELEASES_TTL) {
            notesCache.set(repo, { map: stored.map, at: stored.at });
            return stored.map;
          }
          /* Some repositories publish enormous release bodies (the whole page
           * can pass 800 KB). A full page is asked first; when that answer is
           * too slow or arrives truncated, the smaller page is asked instead of
           * giving up on the notes entirely. */
          let payload;
          try {
            payload = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=50`);
          } catch (error) {
            payload = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=10`);
          }
          const map = {};
          for (const release of Array.isArray(payload) ? payload : []) {
            const version = versionOfTag(release.tag_name) || versionOfTag(release.name);
            if (!version || map[version]) continue;
            map[version] = {
              version,
              tag: release.tag_name || '',
              name: release.name || '',
              body: release.body || '',
              publishedAt: release.published_at || release.created_at || '',
              url: release.html_url || '',
            };
          }
          notesCache.set(repo, { map, at: Date.now() });
          writeSession(`pue:releases:${repo}`, { at: Date.now(), map });
          return map;
        }

        async function fetchJson(url) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
          try {
            const response = await fetch(url, {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              credentials: 'omit',
              mode: 'cors',
              cache: 'no-cache',
            });
            if (!response.ok) {
              const error = new Error(`HTTP ${response.status}`);
              error.status = response.status;
              throw error;
            }
            return await response.json();
          } finally {
            clearTimeout(timer);
          }
        }

        function readSession(key) {
          try {
            const raw = sessionStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        }

        function writeSession(key, value) {
          try {
            const text = JSON.stringify(value);
            if (text.length > 120000) return;
            sessionStorage.setItem(key, text);
          } catch {}
        }

        /* ---- update ---- */

        async function runUpdate(entry) {
          const view = entry.view;
          if (!view.selected || !view.list || running || bulk.phase === 'running') return;
          const from = view.list.installed || '';
          const to = view.selected;
          const registry = view.list.registry || undefined;
          const requestId = makeRequestId();
          running = { requestId, entry, from, to, registry, current: 'checking' };
          view.confirm = false;
          view.phase = 'running';
          view.current = 'checking';
          view.run = { from, to, registry };
          view.outcome = null;
          view.output = '';
          render(entry);
          syncBusyAll();
          let answer;
          try {
            answer = await viaTiers('updateBundle', [entry.name, to, { registry, requestId }], { mutating: true });
          } catch (error) {
            answer = { ok: false, error: { message: userMessage(error) } };
          }
          const outcome = outcomeOf(answer);
          view.outcome = outcome;
          view.output = outputOf(answer);
          view.phase = 'done';
          view.current = null;
          running = null;
          versionCache.delete(entry.name);
          render(entry);
          syncBusyAll();
          if (outcome.kind === 'done' || outcome.kind === 'restart') {
            setTimeout(() => {
              if (!disposed) schedule();
            }, 600);
          }
        }

        /* ---- bulk update: the toolbar's "N plugins can be updated" button ---- */

        /* The official note is React state: it exists only while every check has
         * finished, so pressing Refresh makes it vanish. The button therefore has
         * to come and go with the note instead of being mounted once, exactly
         * like the per-card buttons. Losing the note must never abandon a run
         * that is already in flight. */
        function ensureBulkButton() {
          const toolbar = document.querySelector(SEL.toolbar);
          const note = toolbar ? toolbar.querySelector(SEL.note) : null;
          if (!note) {
            if (bulk.button && bulk.button.isConnected) bulk.button.remove();
            bulk.button = null;
            bulk.anchor = toolbar || null;
            if (!toolbar && bulk.phase !== 'running') closeBulk();
            else if (bulk.open) positionBulk();
            return;
          }
          if (bulk.button && bulk.button.isConnected) {
            if (bulk.button.previousElementSibling !== note) note.after(bulk.button);
            bulk.anchor = note;
            syncBulkButton();
            return;
          }
          const button = el('button', {
            class: 'pue-all',
            type: 'button',
            'aria-haspopup': 'dialog',
            'aria-expanded': 'false',
            title: t('allLabel'),
            onpointerdown: (event) => event.stopPropagation(),
            onclick: (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (bulk.open) closeBulk({ restoreFocus: true });
              else openBulk();
            },
          }, t('all'));
          note.after(button);
          bulk.button = button;
          bulk.anchor = note;
          syncBulkButton();
        }

        function syncBulkButton() {
          if (!bulk.button) return;
          bulk.button.disabled = bulk.phase === 'running';
          bulk.button.setAttribute('aria-expanded', bulk.open ? 'true' : 'false');
        }

        function openBulk() {
          if (bulk.open) return;
          if (active) closePopover(active);
          bulk.open = true;
          ensureBulkPanel();
          syncBulkButton();
          if (!bulk.items.length && bulk.phase !== 'running' && bulk.phase !== 'done') loadBulk();
          else renderBulk();
        }

        function closeBulk(options) {
          const wasOpen = bulk.open;
          bulk.open = false;
          hideBulkNotes();
          if (bulk.panel) {
            bulk.panel.remove();
            bulk.panel = null;
            bulk.body = null;
            bulk.foot = null;
            bulk.host.popover = null;
          }
          if (bulk.phase === 'done') {
            bulk.phase = 'idle';
            bulk.items = [];
            bulk.index = 0;
            bulk.total = 0;
            bulk.currentName = '';
          }
          syncBulkButton();
          if (wasOpen && options && options.restoreFocus && bulk.button) {
            try {
              bulk.button.focus();
            } catch {}
          }
        }

        function ensureBulkPanel() {
          if (bulk.panel) return bulk.panel;
          const head = el('div', { class: 'pue-panel-head' },
            el('span', { class: 'pue-panel-title' }, t('allTitle')),
            el('button', {
              class: 'pue-x',
              type: 'button',
              'aria-label': t('close'),
              onclick: (event) => {
                event.stopPropagation();
                closeBulk({ restoreFocus: true });
              },
            }, '×'));
          const body = el('div', { class: 'pue-panel-body' });
          const foot = el('div', { class: 'pue-bulk-foot' });
          const panel = el('div', {
            class: 'pue-panel',
            role: 'dialog',
            'aria-modal': 'false',
            'aria-label': t('allTitle'),
          }, head, body, foot);
          panel.addEventListener('pointerdown', (event) => event.stopPropagation());
          panel.addEventListener('click', (event) => event.stopPropagation());
          panel.addEventListener('keydown', onPanelKeydown);
          document.body.append(panel);
          bulk.panel = panel;
          bulk.body = body;
          bulk.foot = foot;
          bulk.host.popover = panel;
          return panel;
        }

        /* Same source as the official page (`pluginManager/listBundles`); reading
         * the DOM would only see the cards that happen to be rendered, and the
         * note counts packages that may be far below the fold. */
        function unwrapAnswer(answer) {
          if (answer && answer.ok === false) {
            const error = answer.error || {};
            throw new Error(error.message || error.code || t('unknown'));
          }
          if (answer && Object.prototype.hasOwnProperty.call(answer, 'value')) return answer.value;
          return answer;
        }

        async function loadBulk() {
          bulk.phase = 'loading';
          bulk.error = '';
          bulk.items = [];
          bulk.expanded = null;
          renderBulk();
          try {
            const bundles = unwrapAnswer(await viaTiers('listBundles', []));
            bulk.items = updatableBundles(bundles).map((bundle) => ({
              name: bundle.name,
              from: bundle.from,
              to: '',
              list: null,
              phase: 'idle',
              state: 'idle',
              error: '',
              outcome: null,
            }));
            bulk.phase = bulk.items.length ? 'listed' : 'empty';
            for (const item of bulk.items) primeBulkVersions(item);
          } catch (error) {
            bulk.phase = 'error';
            bulk.error = userMessage(error);
            warn('listBundles', error);
          }
          renderBulk();
          syncBulkButton();
        }

        /* Versions load in the background so the list is usable immediately and
         * every row already knows its default target by the time a run starts. */
        function primeBulkVersions(item, force) {
          const cached = force ? null : fresh(versionCache.get(item.name));
          /* An empty list may just mean the registry call failed on the Host.
           * Trusting it would hide a real update for the whole TTL. */
          if (cached && ((cached.versions && cached.versions.length) || 0) > 0) {
            applyBulkList(item, cached);
            if (bulk.open) renderBulk();
            return Promise.resolve(item);
          }
          item.phase = 'loading';
          item.error = '';
          return listVersions(item.name, versionPending, force).then((list) => {
            if (disposed) return item;
            if (list && list.status === 'listed' && (list.versions || []).length > 0) {
              versionCache.set(item.name, { list, at: Date.now() });
            }
            applyBulkList(item, list);
            if (bulk.open) renderBulk();
            return item;
          }).catch((error) => {
            if (disposed) return item;
            item.phase = 'error';
            item.error = userMessage(error);
            warn(`listVersions(${item.name})`, error);
            if (bulk.open) renderBulk();
            return item;
          });
        }

        function applyBulkList(item, list) {
          item.list = list || null;
          if (!list || list.status !== 'listed') {
            item.phase = list && list.status === 'refused' ? 'refused' : 'error';
            item.to = '';
            return;
          }
          item.phase = 'listed';
          const shown = filterPrerelease(list.versions, bulk.showPre);
          /* Same rule the official page applies: the default target is the
           * newest version that is a bundle, installable here, and not
           * deprecated. Everything else stays listed but unselected. */
          const pick = shown.find((candidate) => !installBlocker(candidate) && !candidate.deprecated);
          item.to = pick ? pick.version : '';
        }

        function renderBulk() {
          if (!bulk.panel || !bulk.body || !bulk.foot) return;
          /* A version check finishing in the background rebuilds this body and
           * therefore replaces the row the notes bubble is pinned to. Remember
           * which version it described, then re-attach it to the equivalent row
           * so hovering does not blink out mid-read. */
          const pinned = bulk.host.bubbleKey;
          bulk.body.replaceChildren(...bulkBodyNodes());
          bulk.foot.replaceChildren(...bulkFootNodes());
          const row = pinned ? rowFor(pinned) : null;
          if (row && bulk.host.bubble) {
            bulk.host.bubbleRow = row;
            row.setAttribute('aria-describedby', bulk.host.bubble.id);
            positionFixedNotes(bulk.host.bubble, row);
          } else {
            hideBulkNotes();
          }
          positionBulk();
        }

        function rowFor(key) {
          if (!bulk.body || !key) return null;
          const item = [...bulk.body.querySelectorAll('.pue-bulk-item')]
            .find((node) => node.getAttribute('data-name') === key.name);
          if (!item) return null;
          return [...item.querySelectorAll('.pue-row')]
            .find((node) => node.getAttribute('data-version') === key.version) || null;
        }

        function bulkBodyNodes() {
          if (bulk.phase === 'loading') {
            return [el('div', { class: 'pue-loading' }, el('span', { class: 'pue-spin' }), t('allChecking'))];
          }
          if (bulk.phase === 'error') {
            return [el('div', { class: 'pue-panel-empty' },
              el('div', {}, bulk.error || t('network')),
              el('div', {}, el('button', {
                class: 'pue-ghost',
                type: 'button',
                onclick: () => loadBulk(),
              }, t('allRetry'))))];
          }
          if (bulk.phase === 'empty') return [el('div', { class: 'pue-panel-empty' }, t('allEmpty'))];
          if (bulk.phase === 'done') return [bulkDoneNodes()];
          const rows = bulkRows(bulk.items);
          if (rows.length === 0) return [el('div', { class: 'pue-panel-empty' }, t('allEmpty'))];
          return [el('ul', { class: 'pue-bulk', role: 'list' }, rows.map((item) => bulkItemNode(item)))];
        }

        function bulkItemNode(item) {
          const open = bulk.expanded === item.name;
          const busy = bulk.phase === 'running';
          const moved = item.to && item.to !== item.from;
          const pick = el('button', {
            class: 'pue-bulk-pick',
            type: 'button',
            'aria-expanded': open ? 'true' : 'false',
            'aria-label': t('allPick'),
            'data-state': item.phase === 'listed' ? 'ready'
              : (item.phase === 'error' || item.phase === 'refused') ? 'error' : 'loading',
            disabled: busy || item.state === 'running',
            onclick: (event) => {
              event.stopPropagation();
              toggleBulkItem(item);
            },
          }, item.phase === 'listed' ? (item.to || t('allPick'))
            : (item.phase === 'error' || item.phase === 'refused') ? t('retry') : t('checking'));
          const head = el('div', {
            class: 'pue-bulk-head',
            role: 'button',
            tabindex: busy ? undefined : '0',
            onclick: () => {
              if (!busy) toggleBulkItem(item);
            },
            onkeydown: (event) => {
              if (event.target !== head) return;
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              if (!busy) toggleBulkItem(item);
            },
          },
          bulkStateNode(item),
          el('span', { class: 'pue-bulk-name', title: item.name }, item.name),
          el('span', { class: 'pue-bulk-from' }, item.from || '—'),
          moved ? el('span', { class: 'pue-bulk-arrow' }, '→') : null,
          pick);
          const node = el('div', {
            class: 'pue-bulk-item',
            'data-name': item.name,
            'data-open': open ? 'true' : 'false',
            'data-state': item.state,
          }, head);
          if (item.error) node.append(el('div', { class: 'pue-bulk-note', 'data-tone': 'error' }, item.error));
          else if (item.phase === 'listed' && !item.to && item.state === 'idle') {
            /* Listed but nothing installable here: say it once, up front, instead
             * of letting the run silently skip the package later. */
            const versions = (item.list && item.list.versions) || [];
            node.append(el('div', { class: 'pue-bulk-note' },
              versions.length ? t('noneInstallable') : t('latest')));
          }
          if (open) node.append(bulkVersionsNode(item));
          return el('li', { role: 'none' }, node);
        }

        /* Mirrors the card: opening a surface re-reads its versions when the
         * cache is stale. Without this an item whose very first check failed
         * stays dead — the panel re-renders the same message on every click and
         * no request is ever made again. */
        function toggleBulkItem(item) {
          const opening = bulk.expanded !== item.name;
          bulk.expanded = opening ? item.name : null;
          hideBulkNotes();
          if (opening && bulk.phase !== 'running' && item.state !== 'running') primeBulkVersions(item);
          renderBulk();
        }

        function bulkStateNode(item) {
          if (item.state === 'done') return el('span', { class: 'pue-bulk-state', 'data-tone': 'done' }, '✓');
          if (item.state === 'failed') return el('span', { class: 'pue-bulk-state', 'data-tone': 'failed' }, '×');
          if (item.state === 'running') return el('span', { class: 'pue-bulk-state' }, el('span', { class: 'pue-spin' }));
          if (item.state === 'skipped') return el('span', { class: 'pue-bulk-state' }, '–');
          return el('span', { class: 'pue-bulk-state' });
        }

        /* Reuses the card's version row so both surfaces show the same tags,
         * dates, blockers and release-note tooltips. */
        function bulkVersionsNode(item) {
          const box = el('div', { class: 'pue-bulk-versions' });
          if (item.phase === 'idle' || item.phase === 'loading') {
            box.append(el('div', { class: 'pue-loading' }, el('span', { class: 'pue-spin' }), t('checking')));
            return box;
          }
          if (item.phase === 'refused' || item.phase === 'error') {
            box.append(el('div', { class: 'pue-loading' },
              item.error || (item.list && item.list.reason) || t('unknown')));
            /* The card offers the same escape hatch. A failed version check is
             * recoverable; leaving it with no button strands the row forever. */
            box.append(el('div', { class: 'pue-actions' },
              el('span', { class: 'pue-spacer' }),
              el('button', {
                class: 'pue-ghost',
                type: 'button',
                onclick: (event) => {
                  event.stopPropagation();
                  versionCache.delete(item.name);
                  primeBulkVersions(item, true);
                },
              }, t('retry'))));
            return box;
          }
          const list = item.list || { versions: [] };
          const shown = filterPrerelease(list.versions, bulk.showPre);
          if ((list.versions || []).some((candidate) => candidate && candidate.prerelease)) {
            box.append(el('button', {
              class: 'pue-ghost',
              type: 'button',
              onclick: (event) => {
                event.stopPropagation();
                bulk.showPre = !bulk.showPre;
                for (const other of bulk.items) {
                  if (other.phase === 'listed') applyBulkList(other, other.list);
                }
                hideBulkNotes();
                renderBulk();
              },
            }, bulk.showPre ? t('hidePrerelease') : t('showPrerelease')));
          }
          if (!shown.length) {
            box.append(el('div', { class: 'pue-loading' },
              list.versions && list.versions.length ? t('noneInstallable') : t('latest')));
            return box;
          }
          const listbox = el('ul', { class: 'pue-list', role: 'listbox', 'aria-label': t('versions') });
          for (const candidate of shown) {
            listbox.append(el('li', { class: 'pue-li', role: 'none' }, versionRow({
              item,
              selected: item.to,
              onPick: (version) => {
                item.to = version;
                hideBulkNotes();
                renderBulk();
              },
            }, candidate)));
          }
          box.append(listbox);
          return box;
        }

        function bulkDoneNodes() {
          return el('div', { class: 'pue-bulk-done' }, bulkRows(bulk.items).filter((item) => item.state !== 'idle').map((item) => {
            const tone = item.state === 'failed' ? 'failed' : item.state === 'done' ? 'done' : '';
            const detail = item.state === 'done'
              ? (item.to || '')
              : item.state === 'skipped'
                ? t('allSkipped')
                : (item.error || t('allFailed'));
            return el('div', { class: 'pue-bulk-line', 'data-tone': tone },
              el('span', { class: 'pue-bulk-name', title: item.name }, item.name),
              el('span', {}, detail));
          }));
        }

        function bulkFootNodes() {
          if (bulk.phase === 'running') {
            return [
              el('div', { class: 'pue-bulk-note' },
                t('allProgress', { index: bulk.index, total: bulk.total, name: bulk.currentName || '—' })),
              el('div', { class: 'pue-actions' },
                el('span', { class: 'pue-spacer' }),
                el('button', {
                  class: 'pue-ghost',
                  type: 'button',
                  onclick: () => {
                    /* A request already sent cannot be recalled; the flag only
                     * stops the next package, which is the safe thing to promise. */
                    bulk.cancelled = true;
                    renderBulk();
                  },
                }, t('allStop'))),
            ];
          }
          if (bulk.phase === 'done') {
            const summary = bulkSummary(bulkRows(bulk.items));
            const detail = t('allDoneDetail', summary)
              + (summary.skipped ? ` · ${t('allSkippedDetail', { count: summary.skipped })}` : '');
            return [
              el('div', { class: 'pue-bulk-note' },
                summary.failed ? `${t('allPartial')} · ${detail}` : detail),
              el('div', { class: 'pue-actions' },
                el('span', { class: 'pue-spacer' }),
                el('button', {
                  class: 'pue-primary',
                  type: 'button',
                  onclick: () => closeBulk({ restoreFocus: true }),
                }, t('finish'))),
            ];
          }
          if (bulk.phase !== 'listed') return [];
          const targets = bulkTargets(bulk.items);
          const ready = targets.filter((item) => item.to).length;
          /* Rows whose version read never landed are re-read by the run itself,
           * so a batch with no target yet is still runnable. A disabled button
           * reading "update 0" is exactly how a real update looks undetected. */
          const stuck = targets.length - ready;
          const label = t('allRun', { count: targets.length });
          return [
            el('div', { class: 'pue-bulk-note' },
              stuck && ready ? `${t('allHint')} · ${t('allStuck', { count: stuck })}` : t('allHint')),
            el('div', { class: 'pue-actions' },
              el('span', { class: 'pue-spacer' }),
              el('button', {
                class: 'pue-primary',
                type: 'button',
                disabled: targets.length === 0,
                onclick: () => runBulk(),
              }, label)),
          ];
        }

        /* One request at a time, strictly sequential: `updateBundle` rewrites the
         * same profile, so concurrent installs would fight over it. The card-level
         * `running` slot stays untouched — a bulk run drives this panel's own
         * progress line instead of opening a card popover. */
        async function runBulk() {
          if (bulk.phase === 'running') return;
          const rows = bulkTargets(bulk.items);
          if (rows.length === 0) return;
          bulk.phase = 'running';
          bulk.cancelled = false;
          bulk.currentName = '';
          bulk.index = 0;
          bulk.total = 0;
          bulk.expanded = null;
          hideBulkNotes();
          renderBulk();
          syncBulkButton();
          /* A row whose version read failed or was still in flight is not the
           * same thing as "nothing to install". Skipping it silently is what
           * makes a real update look undetected, so re-read it first. */
          for (const item of rows) {
            if (bulk.cancelled || item.to || item.phase === 'listed') continue;
            bulk.currentName = item.name;
            renderBulk();
            await primeBulkVersions(item, true);
            if (disposed) return;
          }
          bulk.total = rows.filter((item) => item.to).length;
          bulk.currentName = '';
          renderBulk();
          for (const item of rows) {
            if (item.state !== 'idle') continue;
            if (bulk.cancelled) {
              item.state = 'skipped';
              renderBulk();
              continue;
            }
            if (!item.to) {
              item.state = 'skipped';
              item.error = item.phase === 'listed' ? t('noneInstallable') : t('unknown');
              renderBulk();
              continue;
            }
            bulk.index += 1;
            bulk.currentName = item.name;
            item.state = 'running';
            item.error = '';
            renderBulk();
            const registry = (item.list && item.list.registry) || undefined;
            const requestId = makeRequestId();
            let answer;
            try {
              answer = await viaTiers('updateBundle', [item.name, item.to, { registry, requestId }], { mutating: true });
            } catch (error) {
              answer = { ok: false, error: { message: userMessage(error) } };
            }
            if (disposed) return;
            const outcome = outcomeOf(answer);
            item.outcome = outcome;
            const ok = outcome.kind === 'done' || outcome.kind === 'restart';
            item.state = ok ? 'done' : 'failed';
            item.error = ok ? '' : bulkOutcomeText(outcome);
            versionCache.delete(item.name);
            renderBulk();
            if (ok) schedule();
          }
          for (const item of bulkRows(bulk.items)) {
            if (item.state !== 'idle') continue;
            item.state = 'skipped';
            item.error = item.phase === 'listed' ? t('noneInstallable') : t('unknown');
          }
          bulk.phase = 'done';
          bulk.currentName = '';
          renderBulk();
          syncBulkButton();
          schedule();
        }

        /* Every outcome the official page can report, in one place. */
        function bulkOutcomeText(outcome) {
          if (!outcome) return t('unknown');
          if (outcome.kind === 'done') return t('done', { version: outcome.to });
          if (outcome.kind === 'restart') return t('restart', { version: outcome.to });
          if (outcome.kind === 'refused') return t('refused', { version: outcome.to });
          if (outcome.kind === 'removeFailed') return t('removeFailed', { version: outcome.from });
          if (outcome.kind === 'restored') return t('restored', { version: outcome.from });
          if (outcome.kind === 'broken') return t('broken');
          return outcome.reason ? `${t('lost')} · ${outcome.reason}` : t('lost');
        }

        function onPanelKeydown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (bulk.host.bubble) hideBulkNotes();
            else if (bulk.phase === 'running') {
              bulk.cancelled = true;
              renderBulk();
            } else closeBulk({ restoreFocus: true });
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...bulk.panel.querySelectorAll('button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        }

        function positionBulk() {
          const panel = bulk.panel;
          if (!panel) return;
          const anchor = bulk.button && bulk.button.isConnected ? bulk.button : bulk.anchor;
          const rect = anchor && anchor.isConnected
            ? anchor.getBoundingClientRect()
            : { left: window.innerWidth - 24, right: window.innerWidth - 24, top: 48, bottom: 48 };
          panel.removeAttribute('data-flip');
          const width = panel.offsetWidth;
          const height = panel.offsetHeight;
          const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
          let top = rect.bottom + 6;
          if (top + height > window.innerHeight - 8 && rect.top - 6 - height >= 8) {
            top = rect.top - 6 - height;
            panel.setAttribute('data-flip', 'up');
          }
          panel.style.left = `${left}px`;
          panel.style.top = `${Math.max(8, top)}px`;
        }

        /* The panel scrolls, so its tooltip is placed in viewport space
         * (`data-fixed`) instead of at `row.offsetTop` inside a clipped box. */
        function positionFixedNotes(bubble, row) {
          if (!bubble || !row) return;
          const rect = row.getBoundingClientRect();
          const width = bubble.offsetWidth || 320;
          const height = bubble.offsetHeight || 200;
          const left = rect.left - width - 8;
          const right = rect.right + 8;
          const x = left >= 8 ? left : Math.min(right, window.innerWidth - width - 8);
          const y = Math.max(8, Math.min(rect.top, window.innerHeight - 8 - height));
          bubble.style.left = `${Math.max(8, x)}px`;
          bubble.style.top = `${y}px`;
        }

        function hideBulkNotes() {
          clearTimeout(bulk.hover.open);
          clearTimeout(bulk.hover.close);
          bulk.host.bubbleKey = null;
          if (bulk.host.bubble) {
            bulk.host.bubble.remove();
            bulk.host.bubble = null;
            bulk.host.bubbleRow = null;
          }
        }

        function slugOf(name) {
          return String(name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pkg';
        }

        /* The card's row renderer, with the panel supplying the target and the
         * tooltip host: rows here must not rerender the card's own popover. */
        function versionRow(spec, candidate) {
          const blocker = installBlocker(candidate);
          const selected = spec.selected === candidate.version;
          const tags = el('span', { class: 'pue-row-main' },
            el('span', { class: 'pue-v' }, candidate.version),
            candidate.prerelease ? el('span', { class: 'pue-tag' }, t('prerelease')) : null,
            candidate.deprecated ? el('span', { class: 'pue-tag', 'data-tone': 'warn' }, t('deprecated')) : null,
            candidate.incompatible ? el('span', { class: 'pue-tag', 'data-tone': 'error' }, t('blocked')) : null,
            candidate.publishedAt ? el('span', { class: 'pue-date' }, formatDate(candidate.publishedAt)) : null,
            el('span', { class: 'pue-tick', 'aria-hidden': 'true' }, '✓'));
          const children = [tags];
          if (blocker) {
            children.push(el('span', { class: 'pue-why' },
              blocker === 'notBundle' ? t('notBundle') : t('blocked')));
          }
          const row = el('button', {
            class: 'pue-row',
            type: 'button',
            role: 'option',
            'aria-selected': selected ? 'true' : 'false',
            'aria-disabled': blocker ? 'true' : 'false',
            'data-version': candidate.version,
            onclick: (event) => {
              event.stopPropagation();
              if (blocker) return;
              spec.onPick(candidate.version);
            },
          }, children);
          wireBulkNotes(spec.item, candidate, row);
          return row;
        }

        function wireBulkNotes(item, candidate, row) {
          row.addEventListener('pointerenter', () => {
            clearTimeout(bulk.hover.close);
            clearTimeout(bulk.hover.open);
            bulk.hover.open = setTimeout(() => drawBulkNotes(item, candidate, row), HOVER_OPEN_MS);
          });
          row.addEventListener('pointerleave', () => {
            clearTimeout(bulk.hover.open);
            scheduleHideBulkNotes();
          });
          row.addEventListener('focus', () => {
            clearTimeout(bulk.hover.close);
            clearTimeout(bulk.hover.open);
            drawBulkNotes(item, candidate, row);
          });
          row.addEventListener('blur', () => scheduleHideBulkNotes());
        }

        function scheduleHideBulkNotes() {
          clearTimeout(bulk.hover.close);
          bulk.hover.close = setTimeout(() => hideBulkNotes(), HOVER_CLOSE_MS);
        }

        function drawBulkNotes(item, candidate, row) {
          if (!bulk.panel || !row.isConnected) return;
          let bubble = bulk.host.bubble;
          if (!bubble) {
            bubble = el('div', { class: 'pue-notes', role: 'tooltip', 'data-fixed': 'true' });
            bubble.addEventListener('pointerenter', () => clearTimeout(bulk.hover.close));
            bubble.addEventListener('pointerleave', () => scheduleHideBulkNotes());
            bulk.panel.append(bubble);
            bulk.host.bubble = bubble;
          }
          bulk.host.bubbleRow = row;
          bulk.host.bubbleKey = { name: item.name, version: candidate.version };
          bulk.host.name = item.name;
          bulk.host.view.list = item.list;
          if (!bubble.id) bubble.id = `pue-notes-${slugOf(item.name)}`;
          row.setAttribute('aria-describedby', bubble.id);
          bubble.replaceChildren(...notesNodes(bulk.host, candidate));
          markScrollable(bubble);
          positionFixedNotes(bubble, row);
          if (!candidate.__notes) {
            loadNotes(bulk.host, candidate).then(() => {
              /* The pointer may have moved on (or the row been rebuilt) while
               * the release notes were fetched; only repaint if this bubble is
               * still describing the very same version. */
              const key = bulk.host.bubbleKey;
              if (bulk.host.bubble !== bubble || !key || key.version !== candidate.version) return;
              const live = bulk.host.bubbleRow;
              if (!live || !live.isConnected) return;
              bubble.replaceChildren(...notesNodes(bulk.host, candidate));
              markScrollable(bubble);
              positionFixedNotes(bubble, live);
            });
          }
        }

        /* ---- keyboard & pointer plumbing ---- */

        function onListKeydown(entry, event) {
          const rows = [...entry.body.querySelectorAll('.pue-row:not([aria-disabled="true"])')];
          if (!rows.length) return;
          const index = rows.indexOf(document.activeElement);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            const next = rows[(index + step + rows.length) % rows.length];
            next.focus();
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            rows[event.key === 'Home' ? 0 : rows.length - 1].focus();
          }
        }

        function onPopoverKeydown(entry, event) {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (entry.bubble) hideNotes(entry);
            else closePopover(entry, { restoreFocus: true });
            return;
          }
          if (event.key !== 'Tab') return;
          const focusable = [...entry.popover.querySelectorAll('button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])')];
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        }

        function onDocumentPointerDown(event) {
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (bulk.open) {
            if (bulk.panel && bulk.panel.contains(target)) return;
            if (bulk.button && bulk.button.contains(target)) return;
            if (bulk.host.bubble && bulk.host.bubble.contains(target)) return;
            /* A run keeps its panel: closing it would hide the only progress
             * line the user has. */
            if (bulk.phase !== 'running') {
              closeBulk();
              if (!active) return;
            }
          }
          if (!active) return;
          if (active.slot.contains(target)) return;
          if (active.popover && active.popover.contains(target)) return;
          closePopover(active);
        }

        function onDocumentKeydown(event) {
          if (event.key !== 'Escape') return;
          if (bulk.open) {
            if (bulk.host.bubble) hideBulkNotes();
            else if (bulk.phase === 'running') {
              bulk.cancelled = true;
              renderBulk();
            } else closeBulk({ restoreFocus: true });
            return;
          }
          if (!active) return;
          if (active.bubble) {
            hideNotes(active);
            return;
          }
          closePopover(active, { restoreFocus: true });
        }

        function onViewportChange() {
          if (bulk.open) {
            positionBulk();
            if (bulk.host.bubbleRow) positionFixedNotes(bulk.host.bubble, bulk.host.bubbleRow);
          }
          if (!active) return;
          position(active);
          if (active.bubbleRow) positionNotes(active, active.bubbleRow);
        }

        function position(entry) {
          const popover = entry.popover;
          if (!popover) return;
          popover.removeAttribute('data-flip');
          const host = scope();
          const bound = host ? host.getBoundingClientRect().bottom : window.innerHeight;
          const anchor = entry.slot.getBoundingClientRect();
          const height = popover.offsetHeight;
          const fitsBelow = anchor.bottom + 6 + height <= bound - 8;
          if (!fitsBelow && anchor.top - 6 - height >= 8) popover.setAttribute('data-flip', 'up');
        }

        function warn(...args) {
          try {
            console.warn(`[${NS}]`, ...args);
          } catch {}
        }
      }

      return {
        /* Only `locale` is required. Declaring `remote` + `remote.pluginManager`
         * would also work (the gateway proxy needs both names), but a required
         * service that never mounts parks this whole module — and then the card
         * gets no button at all, which is the worse failure. `ctx.get()` reads the
         * same services without that coupling. */
        name: NS,
        inject: ['locale'],
        apply,
      };
    },
  };

  /* Never let a duplicate registration abort the whole batch.
   *
   * The Host composes the boot graph into ONE classic script per batch. If two
   * graph rows ever name this same bundle (observed after a package rename: the
   * old row lives on in the Host's in-memory table until a restart, so both
   * `@local/old-name` and `dsh-plugin-update-entry` point at these bytes), the
   * batch embeds the script twice. The second execution calls
   * `__ModuleLoader__.load` for an id the first execution already registered, and
   * the loader throws `duplicate factory registration for "<id>"`. That throw
   * escapes a classic script and stops the batch, so every package scheduled
   * after us silently fails to register as well — one stale row takes down other
   * people's plugins.
   *
   * A duplicate registration carries no new information (same id, same factory,
   * same bytes), so swallowing exactly that error keeps the rest of the batch
   * loadable. Every other failure still propagates: a real load error must stay
   * loud. The match is narrow on purpose — the loader's own message plus our own
   * package id — so an unrelated duplicate from another bundle is never hidden.
   *
   * A page reload after HMR invalidation is NOT affected: `invalidate()` drops the
   * factory first, so the next `load` for this id succeeds and never reaches the
   * catch.
   */
  try {
    window.__ModuleLoader__.load(REGISTRATION);
  } catch (error) {
    const message = String((error && error.message) || error || '');
    if (!(message.includes('duplicate factory registration') && message.includes(PACKAGE_ID))) throw error;
  }

  function readFlag(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  }
})();
