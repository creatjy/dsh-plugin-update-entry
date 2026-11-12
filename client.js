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

const PACKAGE_ID = 'dsh-plugin-update-entry';
const NS = 'plugin-update-entry';

/* ------------------------------------------------------------------ *
 * Pure helpers (also exported for `node --test`, see `__pure` below)
 * ------------------------------------------------------------------ */

const BUILD = '1.0.0';

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

window.__ModuleLoader__.load({
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
@media (prefers-reduced-motion:reduce){.pue-pop,.pue-notes{animation:none}.pue-spin{animation-duration:2.4s}}
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
        clearTimeout(hover.open);
        clearTimeout(hover.close);
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
        entry.button.disabled = Boolean(running) || isCardBusy(entry.li);
      }

      function syncBusyAll() {
        for (const entry of entries.values()) syncBusy(entry);
      }

      /* ---- popover shell ---- */

      function openPopover(entry) {
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

      function listVersions(name, pending) {
        const shared = pending.get(name);
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
        if (!view.selected || !view.list || running) return;
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
        if (!active) return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (active.slot.contains(target)) return;
        if (active.popover && active.popover.contains(target)) return;
        closePopover(active);
      }

      function onDocumentKeydown(event) {
        if (!active || event.key !== 'Escape') return;
        if (active.bubble) {
          hideNotes(active);
          return;
        }
        closePopover(active, { restoreFocus: true });
      }

      function onViewportChange() {
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
});

function readFlag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
