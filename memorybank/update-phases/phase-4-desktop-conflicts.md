# Phase 4 — Desktop conflicts (#33468 config-de-global + #33827 deeplinks)

> ✅ **DONE & VERIFIED — session 38 (2026-06-26).** All 7 desktop conflicts resolved (decision A: getBrand→getConfig().brand;
> SPDX restored to upstream tri-license on config.ts/config.test.ts). Phase 4.5 regen done (lockfile clean). GREEN:
> `lint:types` (5 tsc projects) EXIT 0, desktop vitest 309/309, `lint:js` EXIT 0, oxfmt clean, Codex cross-check no issues.
> renderer-recovery.ts getBrand sweep pulled forward from Phase 6. Desktop staged; still mid-merge (only 3 web/Phase-5
> files left). ⚠️ Deeplink path (#33827) needs Phase 7 manual macOS QA. **Next: Phase 5.** See activity-log session 38.

> **Risk: HIGH — this is the ONLY hard cluster in the whole sync.** 8 of the 10 real conflicts are here. Goal: adopt
> upstream's "no `global.vectorConfig`" architecture while preserving **100%** of the fork's macOS desktop behavior
> (config-path baking, deep-merge, window-state, quit UX, media perms, renderer recovery, save-image, native loginItem,
> pickle-key guard, seshat resilience). Cross-checked by the Codex sidecar (`scratchpad/codex_config_merge.md`).

## 4.0 — The one idea that drives the whole cluster

Upstream **#33468** (`f9343e5458`) eliminates the `global.vectorConfig` global. It:

- moves all config loading **out of `electron-main.ts` into `config.ts`**, which now exports
  `loadConfig(localConfigPath): Promise<ConfigOptions>`, `getConfig(): ConfigOptions`, `ConfigOptions`, `DEFAULTS`,
  `applyDefaults`; **removes `getBrand()` and `global.vectorConfig`** (and deletes `IConfigOptions`/`var vectorConfig`
  from `@types/global.d.ts`);
- introduces a new **`apps/desktop/src/args.ts`** (`getArgs`, `Args`, `getArgsForProtocolRegistration`) — argv parsing
  leaves `electron-main.ts`;
- switches every consumer (`ipc/tray/vectormenu/webcontents/store/updater/auto-launch`) from `global.vectorConfig.*` →
  `getConfig().*`.

**#33827** (`2ae7d90190`, deeplinks) additionally rewrites `electron-main.ts` + adds `protocol.ts` changes:
`protocolHandler.initialise(args)` now returns a boolean `hasDeeplink`; the initial `loadURL('vector://…/webapp/')` is
gated behind `if (!hasDeeplink)`. `protocol.ts` and `args.ts` are **fork-untouched → take upstream wholesale.**

**Decision that flips half this cluster — recommended (A):** adopt upstream's `getConfig()` and **drop the fork's
`getBrand()`**, converting all fork `getBrand()`/`global.vectorConfig.brand` call sites to `getConfig().brand`. The fork
still references the removed symbols in **7 files**, including fork-only files (`renderer-recovery.ts`, plus the
in-conflict `tray.ts`/`updater.ts`/`store.ts`/`electron-main.ts`) — Phase 6 sweeps the fork-only ones. Fallback (B) keeps
the fork's `getBrand()` config.ts and drops upstream's brand edits, but diverges from upstream and complicates the PR.

> **Merge these files together, not in isolation** — `config.ts` is the lynchpin; if it's resolved by taking only one
> side, every file here breaks at `tsc`.

## 4.1 — `config.ts` (STRUCTURAL — the hardest file; Codex-verified recipe)

**Upstream:** config.ts becomes the home of loading: `ConfigOptions`, module-local `let config`, `DEFAULTS`,
`applyDefaults`, `loadConfig` (asar load, homeserver-strip, `Object.assign` override, SyntaxError dialog, `/webapp`
module-path rewrite), `getConfig`. Removes `getBrand`.
**Fork:** appended pure helpers for MDM/machine-wide config (#32351): `getConfigCandidatePaths` (explicit wins; else
per-user `userData` over machine-wide darwin `/Library/Application Support/<product>`, win32 `%PROGRAMDATA%`, linux
`/etc/element-desktop`), `deepMergeConfig` (recursive, arrays/primitives replace, strips `__proto__`/`prototype`/
`constructor`), `loadMergedLocalConfig` (layered, user wins, malformed MDM layer skipped+logged, malformed primary
rethrows). Fork's actual loader still lived in `electron-main.ts`.

**Merge recipe (take upstream skeleton, re-implant fork helpers):**

1. Start from **upstream** `config.ts` (keep `ConfigOptions`/`DEFAULTS`/`applyDefaults`/`config`/`loadConfig`/`getConfig`).
2. Keep the fork's helpers verbatim: `getConfigCandidatePaths`, `deepMergeConfig`, `loadMergedLocalConfig`,
   `ConfigPathOptions`, `isPlainObject`, `FORBIDDEN_KEYS`, `LocalConfigFilename`. Import `JsonObject` from `./utils.js`.
3. Inside `loadConfig`, **replace** upstream's single-path `loadLocalConfigFile(localConfigPath)` with
   `loadMergedLocalConfig({ platform: process.platform, userDataPath: app.getPath('userData'),
productName: app.getName(), env: process.env, explicitLocation: localConfigPath })`.
4. **Replace** upstream's `config = Object.assign(config, localConfig)` with
   `config = deepMergeConfig(config, localConfig as JsonObject) as ConfigOptions`.
5. Keep upstream's homeserver-conflict strip (delete baked `default_hs_url`/`default_is_url`/`default_server_name`/
   `default_server_config` when local config sets a server) — this preserves the fork's "default server" fix.
6. Drop the fork's `getBrand()` (decision A); callers move to `getConfig().brand`.

- **Open Qs:** (a) confirm `app.getName()`/`process.platform` are valid at that startup point (after
  `app.setPath('userData', …)`); if not, thread a `ConfigPathOptions` arg into `loadConfig` instead of deriving inside.
  (b) **SPDX header** — fork dropped `GPL-3.0-only OR`; decide keep vs revert (Decision §00.7.4).
  (c) confirm the `JsonObject ↔ ConfigOptions` cast satisfies `noImplicitAny`.

## 4.2 — `config.test.ts` (add/add → UNION)

Both sides created this file. **Union into one:** keep the fork's helper suites (`getConfigCandidatePaths`,
`deepMergeConfig`, `loadMergedLocalConfig` — darwin/win32/linux paths, proto-pollution, malformed-layer behavior) AND
upstream's `loadConfig`/`getConfig` suites. Dedupe the identical `node:fs`/`node:fs/promises` memfs mocks; **add**
upstream's `vi.mock('electron')` (+ `app.getName()` to the mock, needed now that `loadConfig` routes through
`loadMergedLocalConfig`). Add a homeserver-conflict test (local `default_server_name` removes baked `default_hs_url`).
Resolve SPDX once to match `config.ts`. Runner: `pnpm -C apps/desktop test` (vitest).

## 4.3 — `electron-main.ts` (STRUCTURAL — #33468 −167 lines + #33827)

**Take upstream as the structural base, re-apply fork feature deltas on top:**

1. Re-add fork imports: `nativeTheme`, `screen` (to the electron import), `WindowStateManager`, `shouldQuitAfterConfirm`,
   `setupMediaPermissions`, `RendererRecovery`/`setupRendererRecovery`, `resolveBackgroundColor`,
   `resolveWindowCloseBehavior`. Do **not** re-add `windowStateKeeper`, `minimist`, `fs`, `loadJsonFile`.
2. Keep upstream's `const args = getArgs(protocolHandler)` / `app.setPath('userData', args.userDataPath)` /
   `Store.initialize(args.storageMode)` and `config = await loadConfig(args.localConfigPath)`. The fork's
   loadLocalConfigFile/deepMerge logic now lives in `config.ts` (4.1), NOT here.
3. Re-add module-scope `let rendererRecovery`.
4. Rewrite the fork's `confirmQuit()` to read brand from `getConfig().brand` (import `getConfig`), not
   `global.vectorConfig.brand`. Keep `confirmAndQuit()`.
5. Keep `tray.setQuitHandler(confirmAndQuit)` and `Menu.setApplicationMenu(buildMenuTemplate(confirmAndQuit))`.
6. Replace upstream's `windowStateKeeper` block with the fork's `WindowStateManager`/`getRestoreState`; set
   `backgroundColor: resolveBackgroundColor(store.get('backgroundColor'), nativeTheme.shouldUseDarkColors)`; map
   x/y/width/height to `restoreState.bounds`.
7. Keep the fork's `ready-to-show` maximize/monitor, the rewritten `before-input-event` (with `windowState.persist`),
   the rewritten `close` handler (`resolveWindowCloseBehavior` → quit/hide-app/hide + persist, macOS `app.hide` #32267),
   `setupRendererRecovery`, `setupMediaPermissions()`.
8. **Adopt #33827:** `const hasDeeplink = protocolHandler.initialise(args); if (!hasDeeplink) loadURL(...)` —
   replaces the fork's base-era `protocolHandler.initialise(userDataPath)`. Take `protocol.ts`/`args.ts` wholesale.
9. Keep the fork's `activate`/`second-instance` additions (`rendererRecovery?.recoverIfCrashed()` + `app.show()`),
   merged with upstream's bodies.
    > ⚠️ The deeplink path (#33827) has **never been exercised by the fork** → fresh manual QA (Phase 7).
    > Recommend a **Codex cross-check of this file's final merge** at execution time (it's the second-hardest after config.ts).

## 4.4 — The mechanical desktop files (disjoint hunks — apply both sides)

| File                     | Upstream edit                                                                                                                          | Fork edit                                                                                                       | Action                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ipc.ts`                 | `import { getConfig }`; `ipcMain.handle('getConfig', getConfig)`                                                                       | `setThemeColor` handler, pickle-key guard, `getDesktopCapturerSources` try/catch, `consumeDisplayMediaCallback` | apply both; only ensure config.ts exports `getConfig`                                                                  |
| `ipc.test.ts` (add/add)  | 36-line `describe('getConfig')`                                                                                                        | 225-line fork suite (pickle/setThemeColor/capturer/displayMedia)                                                | **UNION** into fork's file; add `vi.mock('./config.js')` + assert `ipcHandlers['getConfig']`; keep fork license header |
| `vectormenu.ts`          | Help submenu `getConfig().brand`/`.help_url` + import                                                                                  | `buildMenuTemplate(onQuit)` signature, both quit items `click: onQuit` (#32287)                                 | apply both; update upstream's `vectormenu.test.ts` to pass a `vi.fn()` onQuit                                          |
| `tray.ts`                | `getBrand`→`getConfig` import; `setToolTip(getConfig().brand)`                                                                         | `quitHandler`/`setQuitHandler` + Quit click                                                                     | apply both; don't re-add unused `getBrand` import                                                                      |
| `store.ts`               | `export const enum Mode`; 2 brand sites → `getConfig().brand`                                                                          | +131 (`seshatTokenizerMode` schema, pickle-key guard)                                                           | apply both; keep `export Mode`; convert brand sites (decision A)                                                       |
| `updater.ts`             | `getBrand`→`getConfig`; 2 EOL-toast brand sites                                                                                        | +55 (`isUpdateableLocation`, `available`, **a 3rd `getBrand()` at `not_writable` toast ~L215**)                 | convert **all 3** sites to `getConfig().brand` (the 3rd is easy to miss → tsc break)                                   |
| `auto-launch.ts`         | one-line `name: getConfig().brand`                                                                                                     | **whole-file rewrite** to native `app.setLoginItemSettings` (no brand)                                          | **keep FORK entirely**; upstream's line no longer exists; add no `getConfig`                                           |
| `webcontents-handler.ts` | `getConfig().web_base_url` one-liner                                                                                                   | `saveImageToFile`/`resolveUserDownloadAction` extraction, removed `nativeImage`/`fs`/`pipeline`                 | apply both (different lines in `onLinkContextMenu`)                                                                    |
| `preload.cts`            | `IConfigOptions`→`ConfigOptions` import+type                                                                                           | `+"setThemeColor"` CHANNELS entry                                                                               | trivial — apply both                                                                                                   |
| `package.json`           | electron 42.4.1, electron-builder 26.15.3, `@types/node` `catalog:`, pacote v22, i18n:lint→oxfmt, drop prettier/eslint-config-prettier | **−3 deps** (`auto-launch`, `electron-window-state`, `@types/auto-launch`)                                      | apply both; keep the 3 removals                                                                                        |

## 4.5 — Finish deps regen (deferred from Phase 3)

After `apps/desktop/package.json` is resolved and all other workspace package.json deltas are in:

```bash
pnpm install            # one deterministic regen with every package.json delta present
git grep -i 'auto-launch\|electron-window-state' pnpm-lock.yaml   # MUST be empty
```

## 4.6 — Stage the cluster

`git add` all 8 conflict files + the reviewed mechanical/auto-merge desktop files. New upstream files
(`args.ts`, `args.test.ts`, `tray.test.ts`, `vectormenu.test.ts`, `protocol.ts`) come in via the merge — confirm staged.

## Verification gate (Phase 4 done when)

- `git status` shows **no remaining desktop conflicts** (the 8 resolved).
- `pnpm -C apps/desktop run build` (tsc) passes — **no lingering `global.vectorConfig`/`getBrand` references** anywhere
  (`git grep -n 'global.vectorConfig\|getBrand(' apps/desktop` → only intended). This is the key signal decision-A is fully applied.
- The fork desktop test suite is green: `pnpm -C apps/desktop test` — `config.test`, `store.test`, `window-state.test`,
  `window-close.test`, `confirm-quit.test`, `renderer-recovery.test`, `background-color.test`, `media-permissions.test`,
  `seshat-*.test`, `ipc.test`, `save-image.test`, `user-download.test`, + upstream's new `args.test`/`tray.test`/
  `vectormenu.test`.
- (Web conflicts still open → Phase 5; full green-gate is Phase 7.)
