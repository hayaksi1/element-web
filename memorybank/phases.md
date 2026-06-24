# Element Desktop (macOS) — Phased Remediation Plan

Ordered highest → lowest priority. Priority = severity × frequency × user-impact, weighted toward
defects whose root cause is **fixable in this repo** and **unit-testable** without a live macOS GUI.
See [macos-desktop-problems.md](macos-desktop-problems.md) for full root-cause detail.

Status keys: ✅ done · 🔜 next · ⏳ planned · ⬆️ upstream/track-only · ⚠️ needs design/native module

---

## Phase 0 — Critical data-loss & launch blockers ★ HIGHEST

The worst class: users silently lose their session / encrypted history.

| #   | Issue                    | Action                                                                                                                                                                                                                                                                                                                                                                       | Status                   |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0.1 | #32521 / #32715 / #32198 | **Pickle-key transient-decrypt guard** in `store.ts` + `ipc.ts`: distinguish absent vs undecryptable; never overwrite an undecryptable secret. + unit tests.                                                                                                                                                                                                                 | ✅ **done this session** |
| 0.2 | #33501                   | Seshat error-dialog **circuit-breaker** in apps/web `EventIndex.ts` (show the dialog once, then stop indexing — no flood after every `/sync`).                                                                                                                                                                                                                               | ✅ **done (session 2)**  |
| 0.3 | #32198 / #32472 / #32108 | Harden web-side `StorageManager.tryPersistStorage()` (act on the `persistent` boolean; warn on desktop). Now async→`Promise<boolean>`, `persisted()` short-circuit, resilient query, desktop-aware `logger.warn` on denial, never rejects. "Recovery before forced logout" deferred (an evicted crypto store can't be recovered; dialog already directs key-backup restore). | ✅ **done (session 5)**  |

## Phase 1 — Calls / media (screen-share + mic/camera) ★ HIGH

Blocks core real-time comms; #32398 is the single highest-impact issue (97).

| #   | Issue           | Action                                                                                                                                                                                                                                                         | Status                  |
| --- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1.1 | #32373          | macOS media permissions: `setPermissionCheckHandler`/`RequestHandler` (**fail-open, NOT origin-scoped** so widget/Jitsi media survives), `askForMediaAccess` on darwin, add `NS*UsageDescription` via `mac.extendInfo` in `electron-builder.ts`. + unit tests. | ✅ **done (session 4)** |
| 1.2 | #32398 / #32017 | Screen-share: one picker per platform — gate the custom `openDesktopCapturerSourcePicker` behind `process.platform !== 'darwin'` when `useSystemPicker` is honoured; clean cancel path. (Z-Upstream — verify on macOS 15.)                                     | ✅ **defensive hardening done (session 11)**; root crash stays upstream/Wayland |
| 1.3 | #32075          | Guard the screen-share picker toggle crash (stale `displayMediaCallback`).                                                                                                                                                                                     | ✅ **defensive hardening done (session 11)**: consume-once `displayMediaCallback.ts` + `getSources` try/catch in `ipc.ts`; native Wayland/PipeWire segfault stays upstream |
| 1.4 | #32426          | Wire toggle-mute hotkey through the menu/accelerator path.                                                                                                                                                                                                     | ❌ skip-mischaracterized (session 10): NOT a desktop bug. ⌘D mute works for legacy 1:1 calls (`LegacyCallView.onNativeKeyDown`); voice rooms/group calls use Element Call as a cross-origin **iframe widget** so the keydown never reaches element-web's document. Reproduces on web too. Belongs upstream in element-call; no `vectormenu.ts`/`electron-main.ts`/`ipc.ts` involvement. |

## Phase 2 — Auto-launch & auto-update ★ HIGH (frequent, cross-platform)

| #   | Issue  | Action                                                                                                                                                           | Status                   |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 2.1 | #32303 | **Rewrite `auto-launch.ts`** onto native `app.setLoginItemSettings`/`getLoginItemSettings`; preserve `AutoLaunchState` API + `--hidden`/minimised. + unit tests. | ✅ **done this session** |
| 2.2 | #32404 | macOS: detect non-writable install dir (`isUpdateableLocation()` — checks W_OK on the directory **containing** the `.app`, since Squirrel.Mac renames the bundle in place); show a one-time guidance toast (`updater\|not_writable_*`) and disable auto-update instead of silently re-downloading. | ✅ **done (session 7)** |
| 2.3 | #32184 | Investigate Nightly feed/`releases.json` handling in `updater.ts`.                                                                                               | ⬆️ track-upstream (session 10): `updater.ts` feed/channel handling is **correct and not Nightly-specific** (feed = `update_base_url + macos/releases.json`). The real failure is native **Squirrel.Mac/ShipIt** bundle-swap ("Couldn't remove owned bundle … doesn't exist"), reproduces on mainline, self-heals on retry. Same native fragility class as #32404 (already partly mitigated). No in-repo JS fix. |

## Phase 3 — Window / lifecycle / quit UX

| #   | Issue           | Action                                                                               | Status                   |
| --- | --------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| 3.1 | #32287          | `warnBeforeExit` default → opt-in on macOS (CMD+Q immediate by default). Platform-aware default via `Store.shouldWarnBeforeExit()` (false on darwin, true elsewhere); explicit user choice preserved. | ✅ **done (session 6)**; **follow-up done (session 11)**: the menu File/app-menu Quit and tray Quit used Electron `role:"quit"` / direct `app.quit()`, **bypassing** the warn dialog that ⌘Q/Ctrl+Q showed (silent on Windows/Linux where warn is the default). New pure `confirm-quit.ts` `shouldQuitAfterConfirm`; all quit entry points now route through one `confirmAndQuit` (DI into `vectormenu.ts`/`tray.ts`, no import cycle). ⌘Q path unchanged (`app.exit()` + geometry persist). |
| 3.2 | #32267          | Cmd-W should not orphan the window without prompting; route through quit/hide logic. | ✅ **done (session 10)**: NOT a prompt (maintainer dbkr rejected that). On darwin the close handler now hides the whole **app** (`app.hide()`, ⌘W ≡ ⌘H) instead of just the window, so another app becomes active rather than leaving Element frontmost with an empty menu bar ("limbo"). New pure `resolveWindowCloseBehavior()` (`window-close.ts`); tray/non-darwin unchanged. Also `app.show()` in the second-instance handler (app.hide leaves `isVisible()` true). |
| 3.3 | #32228 / #32360 | **Replaced the unmaintained `electron-window-state` dep** with an in-repo store-backed `WindowStateManager` (`window-state.ts`). Persists bounds + maximized on every window event through the existing `electron-store` Store (durable), not only on the `closed` event the old lib relied on (which never fires under macOS hide-on-close → #32228). **Fullscreen is no longer restored** (like VS Code's `restoreFullscreen:false`) so the app can't auto-start fullscreen → #32360. Visibility clamp uses workArea + overlap (not strict containment) to survive menu-bar/notch/multi-monitor. | ✅ **done (session 9)** |
| 3.4 | #32260          | **Theme-aware window background** so the native window is painted in the user's theme colour before the web CSS loads. New `background-color.ts` (`resolveBackgroundColor` = valid persisted colour ⟶ else `nativeTheme`-derived opaque default, dark `#101317` / light `#ffffff`); renderer reports its resolved bg via a new `setThemeColor` IPC (persisted + live `setBackgroundColor`). Validator enforces opacity (rejects alpha) to preserve the blurry-font guarantee. | ✅ **done (session 8)** |
| 3.5 | #32352          | Tray "Exit" works during a call.                                                     | ❌ skip-mischaracterized (session 10): the tray Quit path already force-quits — `tray.ts` `app.quit()` → `beforeQuit` sets `appQuitting=true` (no preventDefault) → close handler stops hiding → `window-all-closed` → exit. No in-repo handler (`Call.beforeUnload`, `ElectronPlatform` before-quit) blocks unload. Ancient (riot-web 1.5.12/Linux); any residual is the element-call widget (upstream). |
| 3.6 | #32273          | UI freeze after "Open" on download toast (`shell.openPath` / focus).                 | ✅ **partial (session 11)**: the in-repo defect (a `void`-discarded `shell.openPath` error → a failed "Open" was silent) is fixed — the handler now `await`s `openPath` and shows an error dialog (`download\|unable_to_open_*`) + logs. New pure `resolveUserDownloadAction` (`user-download.ts`). The success-path "freeze" is the opened app taking foreground focus — **native macOS, not in-repo fixable**. |
| 3.7 | #32114          | Crash on close (Ventura/M2).                                                         | ⬆️ track (Electron bump) |
| 3.8 | #32222 / #32223 | White-screen-on-return; single-instance focus after boot.                            | ⬆️ investigate/upstream  |

## Phase 4 — Native search (Seshat) quality cluster

| #   | Issue                                               | Action                                                                                | Status             |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| 4.1 | #32253                                              | Warn the user when searching before indexing is complete.                             | ✅ **done (session 10)**: `SearchWarning.tsx` now shows a polite-live-region notice when the Seshat index exists but is **still crawling** (`EventIndex.currentRoom() !== null`), subscribing to `changedCheckpoint` so it auto-clears. Renderer-only; new i18n `seshat\|warning_kind_search_partial`. **Session 12 (#33956):** the `ManageEventIndexDialog` progress readout now uses `getIndexingStatus()` → "N indexed, M indexing[, K errored]" (replacing the confusing "N out of M" / "awaiting indexing"). |
| 4.2 | #32341 / #32258 / #32266 / #32011 / #32356 / #32343 | Query/index correctness bugs — triage as a batch against `seshat.ts` + matrix-seshat. | 🟡 **partial — #32266/#32011 done (session 12)**: adapted upstream **PR #33955** into `apps/web/src/indexing/EventIndex.ts` — once-per-launch `reconcileMissedRooms()` (crypto-ready-gated) seeds a fullCrawl checkpoint for every joined, encryption-enabled room with no indexed events and no queued checkpoint (closes the "joined-later / missed-at-create → unindexed forever → no results despite index" gap); crypto-aware `isRoomIndexable()` on the live/state/reset handlers (keeps the #33957 `timelineSet` guard); permanent-vs-transient crawler error classification + `erroredRooms` (self-healing on a live event); `fully_crawled` sentinel checkpoint so contentless rooms aren't re-crawled every launch; `hasQueuedCheckpoint` dedup. Re-applied on top of our #33501 circuit-breaker (reconcile runs inside `onSyncInner`; per-room body wrapped so a single room can't trip the global breaker — review fix). 29 Jest tests. **Remaining (still ⏳):** #32341 (search URL in All Rooms), #32258 (upgraded-room pre-upgrade history — needs predecessor/tombstone traversal, NOT covered by #33955), #32356 (edited messages), #32343 (non-stopwords) — discrete query bugs to triage in-repo vs upstream matrix-seshat. |
| 4.3 | #32038 / #32119 / #32112 / #32130                   | i18n tokenization, CPU spikes, packaging, Skylake illegal-instruction.                | ⬆️ mostly upstream; ✅ **#33954 adopted (session 11)**: arm64 `--cfg aes_armv8` RUSTFLAGS in `hak/matrix-seshat/build.ts` (hardware AES on Apple Silicon, ~10-20× CPU saving). Build-flag only — **needs native arm64 build QA** (not unit-testable). |
| 4.4 | #33957 (→ #32119)                                   | **Adopted upstream PR #33957:** `onTimelineReset` ignores thread/filtered timeline-set resets (only the room's own unfiltered live timeline re-seeds a gap-fill checkpoint) — stops dead rooms re-inflating the crawl list every launch (a contributor to the #32119 startup CPU spike). | ✅ **done (session 7)** |

## Phase 5 — Notifications & badge

| #   | Issue  | Action                                                                        | Status          |
| --- | ------ | ----------------------------------------------------------------------------- | --------------- |
| 5.1 | #32383 | Respect macOS DND/Focus (needs vetted native module + IPC + renderer gating). | ⚠️ needs design |
| 5.2 | #31996 | macOS Sequoia: notification sounds stack after wake.                          | ⏳ investigate  |
| 5.3 | #32288 | Remove "99+" dock badge cap.                                                  | ❌ **document-only / wontfix (session 11)**: there is **no "99+" cap in Element's code**. The macOS dock uses raw `app.badgeCount = count` (`badge.ts:47`, no clamp); the in-app badge uses `formatCount` (compact `1K/10K`, never "99+"); the favicon/Windows overlay shows `Nk+` for >999. The "99+" the reporter saw is rendered by **macOS itself** for any dock badge >99 and is **not overridable via Electron's `app.badgeCount`** (a number). Not actionable in-repo. |

## Phase 6 — Files, config, title bar, accessibility

| #   | Issue                    | Action                                                                                      | Status          |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- | --------------- |
| 6.1 | #32355 / #32362          | Blob/anchor downloads not promoted to the session pipeline; Save-image-as failure.          | ✅ **done (session 10)** for **#32362**: right-click "Save image as" used the main-process **global `fetch()`**, bypassing the `media-auth.ts` `session.webRequest` interceptors (URL rewrite + Bearer token) → 401/404 on authenticated media. Now routes via `webContents.session.fetch()` (new pure `saveImageToFile(url,filePath,session)` in `save-image.ts`). **#32355** is **already fixed in the renderer** (`FileBodyViewModel` preventDefault + blob `a.click()` → `will-download` → native Save dialog) — not re-fixed. |
| 6.2 | #32351 / #32337 / #32284 | config.json override/loading defects (system-wide path, integration manager, jitsi domain). **⚠️ Session-7 shallow-`Object.assign` hypothesis REFUTED (session 10 triage, high confidence):** the desktop asar config has **no top-level `jitsi`/`integrations` object**, so `Object.assign(buildConfig, localConfig)` (electron-main.ts:180) has **nothing to clobber** — the user's key is added cleanly, and the renderer then deep-merges DEFAULTS via lodash `mergeWith` (`SdkConfig.ts:81`). Real per-issue causes (from maintainer comments): **#32284** = element-integration-manager always using meet.element.io for a manually-added Jitsi widget + `preferredDomain` vs `preferred_domain` casing (not config merge); **#32337** = upstream renderer/SDK race (`this._managers is undefined`) + Electron stale `.well-known` HTTP cache; **#32351** = a genuine **feature gap** — no system-wide config path exists (`loadLocalConfigFile()` only reads `ELEMENT_DESKTOP_CONFIG_JSON`/`--config`/`userData/config.json`); maintainer wants a new `/Library/Application Support/Element/config.json` (macOS) or `/etc/element-desktop/config.json` (Linux) fallback. **Optional latent-bug hardening (NOT required by any filed issue):** the shallow merge *would* clobber keys nested in BOTH configs (`room_directory`, `features`, `setting_defaults`, `element_call`) — a deep merge in a new `config.ts` helper would prevent that, but no issue exercises it. | ✅ **#32351 done (session 11)** + deep-merge hardening: new pure `config.ts` (`getConfigCandidatePaths` system-wide fallback — macOS `/Library/Application Support/<productName>/config.json`, Windows `%PROGRAMDATA%\<productName>\config.json`, Linux fixed `/etc/element-desktop/config.json`; per-user `userData` wins, explicit `--config`/env bypasses fallback; a malformed **machine-wide** config is skipped+logged, only the user-controlled primary rethrows the existing dialog) + `deepMergeConfig` (replaces the shallow `Object.assign`; nested-merge, array-replace, depth-recursive `__proto__`/`constructor`/`prototype` strip), wired in `electron-main.ts`. **#32337/#32284 remain upstream/docs.** |
| 6.3 | #32018                   | macOS title-bar draggable area too small (`macos-titlebar.ts`).                             | ✅ **done (session 10)**: with `titleBarStyle:"hidden"` the only drag affordance is the injected `-webkit-app-region:drag` `::before` strips, which were 13–24px (florianduros measured 13px). Enlarged `.mx_RoomView` / `.mx_LeftPanel` / `.mx_LeftPanel_newRoomList` / `.mx_SpaceRoomView` `::before` to **32px** (within the empty band above header controls — no element becomes both clickable and draggable). CSS extracted into pure `buildTitleBarCss()` for testing. |
| 6.4 | #32315                   | Disable smooth scrolling (accessibility).                                                   | ✅ **done (session 11)**: new `Accessibility.disableSmoothScrolling` setting (Preferences) + pure `scrollBehavior.ts` helper `getScrollBehavior()` that returns `auto` when the setting OR OS `prefers-reduced-motion` is set. Gates the 3 user-perceptible JS smooth scrolls (RoomSublist ×2, SessionManagerTab); all other sites were already instant. Web/Jest. |

---

### Session 1 fixes (2026-06-24)

- ✅ **0.1** Pickle-key transient-decrypt data-loss guard (`store.ts`, `ipc.ts`, `store.test.ts`)
- ✅ **2.1** Start-at-login via native Electron loginItem API (`auto-launch.ts`, `auto-launch.test.ts`)

### Session 2 fixes

- ✅ Committed + pushed session 1 work to `origin/main`.
- ✅ **0.2** Seshat error-dialog **circuit-breaker** (`apps/web/src/indexing/EventIndex.ts`): `onSync` now shows
  the error dialog **once**, sets an `indexingErrored` flag, stops the crawler, and skips further indexing —
  fixing the dialog flood (#33501, S-Critical). Tests added to `EventIndex-test.ts` (now 4 pass).

### Session 4 fixes

(Session 3 was an upstream-PR review with no code changes — see `upstream-pr-review.md`.)

- ✅ **1.1** macOS mic/cam permissions (#32373, S-Critical). Two-part root cause confirmed via research workflow:
  (a) packaged Info.plist lacked `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` → under hardened
  runtime macOS never raises the TCC prompt; (b) main process never proactively called `askForMediaAccess`.
  Fix: new `apps/desktop/src/media-permissions.ts` `setupMediaPermissions()` — registers **fail-open**
  `setPermissionRequestHandler` + `setPermissionCheckHandler` and, for `media` on darwin, bridges to TCC via
  `systemPreferences.askForMediaAccess` (audio→mic, video→cam, only when `not-determined`, de-duped, try/catch
  so the callback ALWAYS fires). Wired into `electron-main.ts` after `setupMediaAuth`. Added `mac.extendInfo`
  usage strings in `electron-builder.ts`. **Key constraint:** the handler is deliberately NOT origin-scoped —
  widgets/Jitsi request media from remote-origin iframes (`isMainFrame=false`, `webContents=null` in the check
  handler), so origin-gating would have broken widget calls; fail-open preserves the prior grant-all baseline.
  11 tests in `media-permissions.test.ts`. Adversarial-review workflow caught a hang-on-`askForMediaAccess`-reject
  regression (callback never fired) → fixed with try/catch + regression test before commit.

### Session 5 fixes (2026-06-24)

- ✅ **0.3** Harden web-side `StorageManager.tryPersistStorage()` (#32198/#32108 confirmed IndexedDB-eviction;
  #32472 partial). Root cause confirmed via research workflow: `tryPersistStorage()` requested
  `navigator.storage.persist()` but only **logged** the boolean — never acting on a `false` result. The crypto
  store (Olm/Megolm + cross-signing keys) lives in IndexedDB; if the origin is not "persistent", Chromium evicts
  it LRU under storage pressure → `checkConsistency()` "evicted" branch → `StorageEvictedDialog` forced logout
  (#32198/#32108) and recovery-key re-entry (#32472).
    - Change ([StorageManager.ts](../apps/web/src/utils/StorageManager.ts)): `tryPersistStorage()` is now
      `async (): Promise<boolean>`; checks `navigator.storage.persisted()` first and **short-circuits** (avoids
      re-prompting — onLoggedIn now fires on every session restore via merged PR #31299); a `persisted()` **query
      failure no longer blocks the request**; on denial calls new `warnPersistenceDenied()` (`logger.warn`,
      captured by rageshakes; appends a desktop-specific note gated on `window.electron`); wrapped in try/catch so
      it **never rejects** into the fire-and-forget caller (`MatrixChat.onLoggedIn`, unchanged).
    - **Deliberate decisions** (scrutinised by adversarial review): (a) desktop "warn" = `logger.warn` ONLY, **no
      user-facing toast** — `persist()==false` is common-and-usually-benign on a custom-scheme Electron renderer, so
      a per-login toast would be a false-alarm flood (and maintainers dislike repeated dialogs, cf. Phase 0.2). The
      real post-eviction user prompt already exists via `checkConsistency → StorageEvictedDialog`. (b) "Recovery
      before forced logout" **deferred** — an evicted IndexedDB crypto store cannot be recovered; the only path is
      re-login + key-backup restore, which `error.storage_evicted_description_1` already instructs.
    - **Limit / follow-up:** this is the realistic **web-side ceiling**; it improves observability + warns but
      cannot MAKE storage durable. Research confirmed there is **NO clean Electron main-process API** to force
      per-origin durability (`persistent-storage` is not a grantable permission; no `session` quota-grant method).
      The only documented lever to coax Chromium's heuristic to grant is **holding the notifications permission**
      (Element generally has it). A true durability guarantee is not achievable from JS alone — track as a
      main-process/upstream follow-up.
    - Tests ([StorageManager-test.ts](../apps/web/test/unit-tests/utils/StorageManager-test.ts)): 11 new (17 total
      in file) — short-circuit, granted, denied-web vs denied-desktop note, Safari success/reject, unsupported,
      persist-throws (asserts `logger.error`), persisted-absent, persist-absent→Safari fallback, and resilient
      query-failure (TDD RED→GREEN). Process: research workflow → TDD → 20-agent adversarial review (17 findings →
      3 confirmed real, all test-quality; fixed) → re-verify.

### Session 7 fixes (2026-06-24)

- ✅ **2.2** Non-writable install auto-update guidance (#32404). Root cause: on macOS Squirrel.Mac installs an
  update by atomically **renaming** a freshly-staged `.app` over the old one — that swap needs write access to the
  **directory that contains** the bundle (not the bundle's own inode). When an admin installs into `/Applications`
  and a non-admin runs it, that dir is read-only, so updates download forever but never install (silent failure).
    - Change ([updater.ts](../apps/desktop/src/updater.ts)): new exported `isUpdateableLocation(): Promise<boolean>`
      — darwin-only (returns `true` elsewhere), derives the bundle from `app.getPath("exe")` (`…/Element.app/
      Contents/MacOS/Element` → up 3 = the `.app`), and `fs.access(<containing dir>, W_OK)`. Returns `false` on
      `EACCES`/`EPERM`/`EROFS` (fail-closed), `true` on any other errno e.g. `ENOENT` in dev (fail-open). `available()`
      is now **exported** and, after the existing EOL checks, calls it; if non-writable it fires a **one-time**
      `ipcMain.emit("showToast", …)` (`updater|not_writable_title`/`_description`, `%(brand)s` like the EOL toasts)
      and `return false` so `start()` never sets the feed URL or polls (no wasted re-downloads / Squirrel wedge).
    - i18n ([en_EN.json](../apps/desktop/src/i18n/strings/en_EN.json)): new `updater` group; `matrix-gen-i18n` no-diff.
    - Tests ([updater.test.ts](../apps/desktop/src/updater.test.ts), NEW, 8): off-darwin short-circuit; checks the
      **containing dir** with `W_OK` specifically; **does not gate on the bundle inode** (1 access call, never the
      bundle); EACCES/EROFS/EPERM → false; ENOENT → true (fail-open); `available()` non-writable → false + toast +
      brand-substitution arg asserted; writable → true + no toast.
    - **Adversarial review** (17-agent workflow, 13 findings → 3 confirmed): (1) **correctness** — original code
      checked W_OK on *both* the bundle and its parent (AND); Squirrel's rename only needs the **parent**, so gating
      on the bundle could false-negative (wrongly disable updates) for an admin-owned read-only bundle in a
      user-writable dir → **fixed**: check parent only. (2+3) **test quality** — pin the `access` mode to `W_OK`
      (an `F_OK` mutation would silently re-break #32404) and assert the `_t` brand-substitution arg → **both
      applied**. Primary #32404 case (`/Applications` non-writable) correct throughout.
    - Verification: vitest **58/58** (9 files), `tsc -p tsconfig.json` clean, `eslint --max-warnings 0` clean,
      prettier clean, i18n consistent + lint clean. **Not verifiable here:** real Squirrel.Mac install on a signed
      build (needs manual macOS QA).

### Session 8 fixes (2026-06-24) — Phase 3.4: theme-aware window background (#32260)

White launch flash. **Root cause** (confirmed via firecrawl on the issue + code-mapping): the window is already
`show:false` + shown on `ready-to-show` (the reporter's suggested fix), so that wasn't it. The real cause is the
hard-coded `backgroundColor:"#fff"` (white) combined with `index.html`'s transparent `<body>` — the first painted
frame shows the white native bg before the themed CSS loads, so dark-theme users get a white→dark flash.

- **`apps/desktop/src/background-color.ts` (NEW):** `resolveBackgroundColor(persisted, prefersDark)` — returns a
  **valid persisted** colour, else a `nativeTheme`-derived **opaque** default (dark `#101317` / light `#ffffff`,
  the real Compound `--cpd-color-bg-canvas-default` → `--cpd-color-theme-bg` values). `isValidThemeColor()` accepts
  only **opaque** hex (`#rgb`/`#rrggbb`) and `rgb()`/`rgba(…,1)` — translucency rejected to keep the blurry-font
  guarantee.
- **`store.ts`:** new optional `backgroundColor` string key + schema. **`electron-main.ts`:** window bg now
  `resolveBackgroundColor(store.get("backgroundColor"), nativeTheme.shouldUseDarkColors)`. **`ipc.ts`:** new
  fire-and-forget `setThemeColor` handler (validate → skip if unchanged → `store.set` + live `setBackgroundColor`).
  **`preload.cts` + `apps/web/.../global.d.ts`:** `setThemeColor` added to the CHANNELS allowlist + `ElectronChannel`.
- **`apps/web/src/theme.ts`:** `switchTheme()` now reports the resolved body bg to main via
  `window.electron?.send("setThemeColor", …)` (guarded; no-op on web). **Design:** first launch → OS appearance
  (covers the default "match system theme"); later launches → exact persisted colour (covers manual theme overrides).
- **Adversarial review** (49-agent workflow, 22 findings → **2 confirmed**, same root): the validator accepted
  alpha-channel colours (`#rgba`/`#rrggbbaa`/`rgba(…,a<1)`), which a **translucent custom theme** could feed through
  → transparent native window → blurry fonts / see-through launch. **Fixed:** validator now enforces opacity (also
  removes the ambiguous `RRGGBBAA` vs Electron `AARRGGBB` hex-alpha ordering). Folded in one rejected-but-cheap win:
  skip the redundant synchronous `store.set` disk write when the colour is unchanged. 19 other findings were
  nits/by-design (stale single-frame self-corrects; ElectronPlatform seam; out-of-range RGB `getComputedStyle` never emits).
- **Verification:** desktop vitest **102/102** (10 files), `tsc` clean, `eslint src` clean, prettier clean; web Jest
  `theme-test` **15/15**, web `tsc` 0 errors, web eslint/prettier clean. **Not verifiable here:** the actual flash on
  a live macOS build (manual QA).

### Session 9 fixes (2026-06-24) — Phase 3.3: insource window-state restore (#32228 / #32360)

- ✅ **3.3** Replaced the unmaintained `electron-window-state@^5.0.3` (2018) with a new in-repo
  [window-state.ts](../apps/desktop/src/window-state.ts) `WindowStateManager` modelled on the Phase 2.1 `auto-launch.ts`
  pattern (thin class over pure helpers + the `Store` seam). **Root causes (research workflow, 6 agents):** (#32228)
  the old lib only flushed on the BrowserWindow `closed` event, which never fires under Element's macOS hide-on-close
  (`e.preventDefault()`), so geometry was lost on crash/force-quit; (#32360) it re-applied a sticky persisted
  `isFullScreen` flag on launch (Element quits without un-fullscreening; on Linux tiling WMs `isFullScreen()` is a
  false-positive) → "always starts in fullscreen."
- **Fix:** persist `{bounds, isMaximized}` through the existing `electron-store`-backed `Store` (atomic) on every
  window event (resize/move debounced+coalesced, maximize/unmaximize/leave-full-screen immediate, cancel on `closed`),
  plus a synchronous flush in the `close` handler and before the Cmd+Q `app.exit()`. **Fullscreen is deliberately NOT
  restored** (matches VS Code `window.restoreFullscreen:false`) — the definitive #32360 fix (also dissolves the
  quit-while-fullscreen edge cases). Visibility clamp uses **workArea + overlap** (≥100px each axis), not the old lib's
  strict `display.bounds` containment, so menu-bar/notch/multi-monitor layouts aren't reset. Dropped the dep from
  `package.json` + `pnpm-lock.yaml`.
- **Adversarial review** (21-agent workflow, 17 findings → 10 confirmed): the **critical** finding was that the
  original cut (which DID restore fullscreen) still reproduced #32360 on the `app.quit()`-from-fullscreen path
  (`appQuitting=true` skips the un-fullscreen branch → persists `isFullScreen:true`). Resolved by **not restoring
  fullscreen at all** (stronger than the reviewers' "normalise on quit"). Also applied: destroyed-window `try/catch`
  guard + `closed`→clearTimeout (stale-timer crash), Cmd+Q `app.exit()` flush, and test-quality fixes (100px overlap
  boundary, debounce-coalescing proof, leave-full-screen end-to-end, destroyed-window guard).
- **Deliberately documented, not fixed:** (a) existing users' legacy `window-state.json` is ignored → a **one-time**
  reset to the centred 1024×768 default on upgrade (self-healing on first close; migration deemed not worth the I/O
  risk for an S-Minor issue); (b) the `electron-main.ts` close/exit wiring is thin glue and stays unit-untested by
  repo convention (the testable logic lives in `window-state.ts`).
- **Verification:** desktop `vitest run` **145/145** (11 files; new `window-state.test.ts` = 43), `tsc` clean, `eslint
  --max-warnings 0` clean, prettier clean, **knip clean** (dep removal). **Not verifiable here:** real macOS
  multi-monitor restore + the live launch (manual QA). Committed on `main`.

### Session 10 fixes (2026-06-24) — batched multi-phase: 3.2, 6.1, 6.3, 4.1 (+ triage of 1.4/2.3/3.5/6.2)

Picked up the user's "do multiple phases this session with subagents" directive. Ran a parallel **triage workflow**
(7 candidate phase-groups) → 4 confirmed real & in-repo, 3 mischaracterized/upstream; then **4 parallel implementation
agents** (disjoint files, TDD) → full verification → **18-agent adversarial review** (2 confirmed low findings applied)
→ 4 commits on `main`.

- ✅ **3.2 (#32267)** Cmd-W "limbo" → hide the **app** on macOS, not just the window. New pure
  [window-close.ts](../apps/desktop/src/window-close.ts) `resolveWindowCloseBehavior({appQuitting,hasTray,platform})` →
  `quit`/`hide-app`/`hide-window`; darwin close uses `app.hide()` (⌘W ≡ ⌘H, per maintainer dbkr — explicitly **not** a
  prompt). Tray/non-darwin unchanged. **Review finding applied:** `app.hide()` leaves `BrowserWindow.isVisible()` true,
  so the `second-instance` relaunch handler now calls `app.show()` (darwin-only no-op) first. 8 vitest tests. Commit `57ef7d5`.
- ✅ **6.1 (#32362)** "Save image as" failed on authenticated media — main-process **global `fetch()`** bypasses the
  `media-auth.ts` `session.webRequest` interceptors. New [save-image.ts](../apps/desktop/src/save-image.ts)
  `saveImageToFile(url,filePath,session)` uses `webContents.session.fetch()`. **#32355 already renderer-fixed** (not
  re-touched). 7 vitest tests (regression guard: injected `session.fetch` used, never global). Commit `872c2af`.
- ✅ **6.3 (#32018)** macOS title-bar drag strips 13–24px → **32px** (`.mx_RoomView`/`.mx_LeftPanel`/
  `.mx_LeftPanel_newRoomList`/`.mx_SpaceRoomView` `::before`), within the empty band so no control becomes a drag handle.
  CSS extracted to pure `buildTitleBarCss()`. 11 vitest tests (≥28px regression guard). Commit `d6002f4`.
- ✅ **4.1 (#32253)** [SearchWarning.tsx](../apps/web/src/components/views/elements/SearchWarning.tsx) now warns (polite
  `role="status"` live region — review finding) while Seshat is **still crawling** (`currentRoom() !== null`), subscribing
  to `changedCheckpoint` to auto-clear. New i18n `seshat|warning_kind_search_partial`. 6 Jest tests (8/8). Commit `90207fd`.
- ❌/⬆️ **Triaged-out (skeptic check, mirrors the #32288 precedent):** **1.4 #32426** mute hotkey = element-call iframe,
  not desktop; **2.3 #32184** = native Squirrel.Mac/ShipIt, not the JS feed; **3.5 #32352** tray-exit already
  force-quits; **6.2 #32351/#32337/#32284** = the session-7 shallow-`Object.assign` hypothesis is **REFUTED** (asar config
  has no `jitsi`/`integrations` to clobber; renderer deep-merges) — #32351 is a feature gap (new system config path),
  #32337/#32284 upstream/docs. See the table rows above for full detail.
- **Verification:** desktop `vitest run` **171/171** (14 files; +3 new), `tsc`/`eslint`/`prettier` clean, **knip** clean;
  web `SearchWarning` Jest **8/8**, web `tsc` (only the 4 pre-existing vendored matrix-js-sdk errors), eslint/prettier/i18n
  clean. **Not verifiable here:** live macOS behaviour (⌘W app-hide, the drag feel, authenticated-media save) — manual QA.

### Session 11 fixes (2026-06-24) — batched 6 phases via subagents (+2 document-only)

Picked up the user's "handle all the selected phases this session with subagents" directive (phases.md lines 262-289).
Ran an **8-agent triage workflow** (5 structured + 3 re-run as markdown after a StructuredOutput cap) → 6 implement,
2 document-only; implemented the web phase via a **background agent** and all desktop phases serially (electron-main.ts
is shared by 3.1 + 6.2); then a **6-reviewer adversarial workflow** with per-finding independent verification → **5
confirmed findings (4 fix-now + 1 document)** all applied → full re-verification.

- ✅ **6.4 (#32315)** Disable smooth scrolling — new `Accessibility.disableSmoothScrolling` setting (Preferences,
  `LEVELS_ACCOUNT_SETTINGS`, no controller) + pure [scrollBehavior.ts](../apps/web/src/utils/scrollBehavior.ts)
  `getScrollBehavior()` (returns `auto` when the setting **or** OS `prefers-reduced-motion` is set). Gates the 3
  user-perceptible JS smooth scrolls (`RoomSublist` ×2, `SessionManagerTab`); everything else was already instant; no
  CSS change (the only `scroll-behavior:smooth` is export-only). 12 Jest tests.
- ✅ **1.2/1.3 (#32398/#32075)** Screen-share **defensive hardening** — consume-once
  [displayMediaCallback.ts](../apps/desktop/src/displayMediaCallback.ts) `consumeDisplayMediaCallback` (atomic
  read-and-clear; duplicate/stale `callDisplayMediaCallback` is a safe no-op), and `getDesktopCapturerSources` in
  `ipc.ts` now try/catches `desktopCapturer.getSources` → replies `[]` instead of rejecting the IPC (renderer picker
  cancels cleanly, never dangles). Removed the now-dead `getDisplayMediaCallback`. Root crash stays upstream/Wayland.
- ✅ **#33954** (Phase 4.3 / #32119) — `hak/matrix-seshat/build.ts` appends `--cfg aes_armv8` to RUSTFLAGS when
  `hakEnv.getTargetArch() === "arm64"` (hardware AES on Apple Silicon). Review confirmed: `aes 0.8.4` declares the cfg
  (Cargo auto-registers it for check-cfg, no `-D warnings`), so build-break risk is **low**; universal builds run
  per-arch so x86_64 correctly omits it. **Not unit-testable** (build script) — **needs native arm64 build QA**.
- ✅ **3.6 (#32273)** Download-toast "Open" — the in-repo defect (a `void`-discarded `shell.openPath` error → failed
  "Open" was silent) is fixed: handler is now async, `await`s `openPath`, and on a non-empty error string shows an
  error dialog (`download|unable_to_open_*`) + logs. New pure
  [user-download.ts](../apps/desktop/src/user-download.ts) `resolveUserDownloadAction`. **The success-path "freeze" is
  the opened app stealing foreground focus — native macOS, not in-repo fixable** (honestly documented).
- ✅ **3.1 follow-up (#32287)** Menu/tray Quit now honour warn-before-exit — new pure
  [confirm-quit.ts](../apps/desktop/src/confirm-quit.ts) `shouldQuitAfterConfirm`; one `confirmAndQuit` glue in
  `electron-main.ts` injected into `vectormenu.ts` (`buildMenuTemplate(onQuit)`, `role:"quit"`→`click`, accelerator
  kept — `before-input-event` preventDefault suppresses it) and `tray.ts` (`setQuitHandler`). ⌘Q path unchanged
  (`app.exit()` + geometry persist). No expansion on default config; closes the documented bypass.
- ✅ **6.2 (#32351)** System-wide config path + deep-merge — new pure [config.ts](../apps/desktop/src/config.ts)
  `getConfigCandidatePaths` (mac `/Library/Application Support/<productName>/config.json`, Windows
  `%PROGRAMDATA%\<productName>\config.json`, Linux fixed `/etc/element-desktop/config.json`; per-user wins, explicit
  `--config`/env bypasses) + `loadMergedLocalConfig` (a malformed **machine-wide** config is skipped+logged so it
  can't break the user's session or trigger the user-blaming dialog; only the user-controlled primary rethrows) +
  `deepMergeConfig` (nested-merge, array-replace, depth-recursive `__proto__`/`constructor`/`prototype` strip).
  Replaces the shallow `Object.assign` in `electron-main.ts`. 22 vitest tests.
- ❌ **document-only:** **5.3 (#32288)** — no "99+" cap exists in Element; macOS renders it for any dock badge >99
  and Electron's `app.badgeCount` (a number) can't override it. **0.3 main-process durability** — no Electron API to
  force per-origin durable storage; notifications permission is **already** granted fail-open (`media-permissions.ts`)
  and demonstrably does **not** flip `navigator.storage.persist()`; scheme privileges don't feed the durability
  heuristic. Both not actionable in-repo.
- **Adversarial review → 5 confirmed findings, all resolved:** (config) malformed MDM config aborted the whole load +
  user-blamed → per-layer try/catch; (config) nested one-sided `__proto__` not stripped → recurse into one-sided
  objects; (config) Linux `/etc` path ignores branding → documented as intentional; (download) failed open only
  `console.error`'d → added the error dialog; (download) handler behaviour untested → new
  `webcontents-handler.test.ts` drives the real `will-download` flow to exercise open/fail-dialog/dismiss/re-open.
- **Verification:** desktop `vitest run` **214/214** (19 files; +43 new across 5 new test files), `tsc`/`eslint`/
  `prettier`/**knip**/i18n clean; web `scrollBehavior` Jest **12/12**, web tsc (only the 4 pre-existing vendored
  matrix-js-sdk errors), eslint/prettier/i18n clean. **Not verifiable here:** live macOS (⌘W/quit dialogs, screen-share
  cancel, download-open dialog & focus), the **arm64 seshat native build** (#33954), and real MDM config paths.

### Recommended next session

- **#33954 native QA:** build seshat for `aarch64-apple-darwin` on a real Apple-Silicon Mac and confirm `--cfg
  aes_armv8` compiles + measure the Seshat-thread CPU drop (see `upstream-pr-review.md` §#33954 / the seshat agent's
  validation steps). This is the only unverified piece of session 11.
- **Phase 6.2 / #32351** (if pursued): add a **system-wide config path** fallback in `loadLocalConfigFile()`
  ([electron-main.ts](../apps/desktop/src/electron-main.ts)) — **DONE in session 11** (`config.ts`); if a maintainer
  prefers a different exact path or per-variant Linux dirs, that is the only remaining tweak. The deep-merge hardening
  was also folded in.
- **PR-review adopt shortlist** (see `upstream-pr-review.md`): **#33954 DONE (session 11, needs native build QA)**;
  **#33955 + #33956 Seshat backfill resilience + progress UI DONE (session 12)** — adapted into `EventIndex.ts` /
  `ManageEventIndexDialog.tsx` on top of our #33501 breaker + #33957 guard (29 Jest tests; see Phase 4.2 row & session-12
  activity log). (#33957 timeline-reset guard already adopted session 7.) Remaining shortlist item: **#33048** N-gram
  tokenizer for CJK search (#32038) — needs the matrix-seshat 4.2.0 bump under the offline/package-locally constraint.
- **Main-process follow-up for 0.3:** **investigated & closed (session 11, document-only):** no Electron API forces
  per-origin durable storage; notifications are already granted fail-open (`media-permissions.ts`) yet
  `persist()` still returns false (the JS handlers don't feed Chromium's `DurableStoragePermissionContext`), and
  scheme privileges don't participate in the heuristic. The web-side ceiling (Phase 0.3 `StorageManager` hardening) +
  `StorageEvictedDialog` recovery remain the realistic mitigations. Only an upstream Electron feature or migrating off
  the `vector://` scheme would change it.
- **Still planned / untouched:** Phase 4.2 **remaining** query-correctness bugs (#32341 search-URL-in-All-Rooms, #32258
  upgraded-room pre-upgrade history, #32356 edited messages, #32343 non-stopwords — the backfill-completeness half
  #32266/#32011 is DONE session 12); Phase 5.1 macOS DND/Focus (needs a vetted native module); Phase 5.2 Sequoia
  notification-sound stacking; Phase 3.7/3.8 (Electron-bump / upstream).
