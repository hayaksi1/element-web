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
| 1.2 | #32398 / #32017 | Screen-share: one picker per platform — gate the custom `openDesktopCapturerSourcePicker` behind `process.platform !== 'darwin'` when `useSystemPicker` is honoured; clean cancel path. (Z-Upstream — verify on macOS 15.)                                     | ⏳ planned              |
| 1.3 | #32075          | Guard the screen-share picker toggle crash (stale `displayMediaCallback`).                                                                                                                                                                                     | ⏳ planned              |
| 1.4 | #32426          | Wire toggle-mute hotkey through the menu/accelerator path.                                                                                                                                                                                                     | ⏳ planned              |

## Phase 2 — Auto-launch & auto-update ★ HIGH (frequent, cross-platform)

| #   | Issue  | Action                                                                                                                                                           | Status                   |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 2.1 | #32303 | **Rewrite `auto-launch.ts`** onto native `app.setLoginItemSettings`/`getLoginItemSettings`; preserve `AutoLaunchState` API + `--hidden`/minimised. + unit tests. | ✅ **done this session** |
| 2.2 | #32404 | macOS: detect non-writable install dir (`isUpdateableLocation()` — checks W_OK on the directory **containing** the `.app`, since Squirrel.Mac renames the bundle in place); show a one-time guidance toast (`updater\|not_writable_*`) and disable auto-update instead of silently re-downloading. | ✅ **done (session 7)** |
| 2.3 | #32184 | Investigate Nightly feed/`releases.json` handling in `updater.ts`.                                                                                               | ⏳ planned               |

## Phase 3 — Window / lifecycle / quit UX

| #   | Issue           | Action                                                                               | Status                   |
| --- | --------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| 3.1 | #32287          | `warnBeforeExit` default → opt-in on macOS (CMD+Q immediate by default). Platform-aware default via `Store.shouldWarnBeforeExit()` (false on darwin, true elsewhere); explicit user choice preserved. | ✅ **done (session 6)** |
| 3.2 | #32267          | Cmd-W should not orphan the window without prompting; route through quit/hide logic. | ⏳ planned               |
| 3.3 | #32228 / #32360 | **Replaced the unmaintained `electron-window-state` dep** with an in-repo store-backed `WindowStateManager` (`window-state.ts`). Persists bounds + maximized on every window event through the existing `electron-store` Store (durable), not only on the `closed` event the old lib relied on (which never fires under macOS hide-on-close → #32228). **Fullscreen is no longer restored** (like VS Code's `restoreFullscreen:false`) so the app can't auto-start fullscreen → #32360. Visibility clamp uses workArea + overlap (not strict containment) to survive menu-bar/notch/multi-monitor. | ✅ **done (session 9)** |
| 3.4 | #32260          | **Theme-aware window background** so the native window is painted in the user's theme colour before the web CSS loads. New `background-color.ts` (`resolveBackgroundColor` = valid persisted colour ⟶ else `nativeTheme`-derived opaque default, dark `#101317` / light `#ffffff`); renderer reports its resolved bg via a new `setThemeColor` IPC (persisted + live `setBackgroundColor`). Validator enforces opacity (rejects alpha) to preserve the blurry-font guarantee. | ✅ **done (session 8)** |
| 3.5 | #32352          | Tray "Exit" works during a call.                                                     | ⏳ planned               |
| 3.6 | #32273          | UI freeze after "Open" on download toast (`shell.openPath` / focus).                 | ⏳ planned               |
| 3.7 | #32114          | Crash on close (Ventura/M2).                                                         | ⬆️ track (Electron bump) |
| 3.8 | #32222 / #32223 | White-screen-on-return; single-instance focus after boot.                            | ⬆️ investigate/upstream  |

## Phase 4 — Native search (Seshat) quality cluster

| #   | Issue                                               | Action                                                                                | Status             |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| 4.1 | #32253                                              | Warn the user when searching before indexing is complete.                             | ⏳ planned         |
| 4.2 | #32341 / #32258 / #32266 / #32011 / #32356 / #32343 | Query/index correctness bugs — triage as a batch against `seshat.ts` + matrix-seshat. | ⏳ planned         |
| 4.3 | #32038 / #32119 / #32112 / #32130                   | i18n tokenization, CPU spikes, packaging, Skylake illegal-instruction.                | ⬆️ mostly upstream |
| 4.4 | #33957 (→ #32119)                                   | **Adopted upstream PR #33957:** `onTimelineReset` ignores thread/filtered timeline-set resets (only the room's own unfiltered live timeline re-seeds a gap-fill checkpoint) — stops dead rooms re-inflating the crawl list every launch (a contributor to the #32119 startup CPU spike). | ✅ **done (session 7)** |

## Phase 5 — Notifications & badge

| #   | Issue  | Action                                                                        | Status          |
| --- | ------ | ----------------------------------------------------------------------------- | --------------- |
| 5.1 | #32383 | Respect macOS DND/Focus (needs vetted native module + IPC + renderer gating). | ⚠️ needs design |
| 5.2 | #31996 | macOS Sequoia: notification sounds stack after wake.                          | ⏳ investigate  |
| 5.3 | #32288 | Remove "99+" dock badge cap.                                                  | ⏳ planned      |

## Phase 6 — Files, config, title bar, accessibility

| #   | Issue                    | Action                                                                                      | Status          |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- | --------------- |
| 6.1 | #32355 / #32362          | Blob/anchor downloads not promoted to the session pipeline; Save-image-as failure.          | ⏳ planned      |
| 6.2 | #32351 / #32337 / #32284 | config.json override/loading defects (system-wide path, integration manager, jitsi domain). **Session-7 investigation:** root cause is NOT "renderer reads the wrong file" — `loadConfig()` ([electron-main.ts:140](../apps/desktop/src/electron-main.ts)) merges local config.json over the asar config into `global.vectorConfig`, and the renderer fetches the **merged** result via the `getConfig` IPC ([preload.cts:65](../apps/desktop/src/preload.cts), [ElectronPlatform.tsx:227](../apps/web/src/vector/platform/ElectronPlatform.tsx)). Suspect the **shallow `Object.assign`** merge (line 177) clobbering nested objects (`jitsi`, etc.) or the homeserver-strip block (164-175). Needs issue reproduction against a live build before a fix; config-loading isn't main-process unit-testable here. | ⏳ planned (root-cause narrowed) |
| 6.3 | #32018                   | macOS title-bar draggable area too small (`macos-titlebar.ts`).                             | ⏳ planned      |
| 6.4 | #32315                   | Disable smooth scrolling (accessibility).                                                   | ⬆️ web/Chromium |

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

### Recommended next session

- **Phase 3.2** Cmd-W orphan-window prompt (#32267) — route Cmd-W (`role:"close"`) through the quit/hide logic so it
  does not silently quit the app (no-tray non-darwin) without the warn-before-exit prompt. macOS-flagged; verify the
  exact repro first (on darwin the `close` handler already hides the window).
- **Phase 5.3** remove the "99+" dock badge cap (#32288) — but NOTE: investigation this session found the catalogue
  mischaracterised it. macOS uses raw `app.badgeCount` (no cap) in [badge.ts](../apps/desktop/src/badge.ts); the
  only in-code cap is the **favicon/Windows overlay** renderer ([favicon.ts:148](../apps/web/src/favicon.ts) → shows
  `Nk+` for >999, not "99+"). The reporter's "99+" doesn't match current code — likely already changed upstream or
  the in-app badge. Re-confirm against a live build before spending effort; it may be a no-op / wontfix.
- **PR-review adopt shortlist** (see `upstream-pr-review.md`): #33954 arm64 AES build flag + #33957 timeline-reset
  guard (both low-effort), or #33955+#33956 Seshat backfill resilience (high, complements Phase 0.2).
- **Phase 3.3** persist/restore maximized & fullscreen state (#32228/#32360, "always starts in fullscreen") —
  `store.ts` + `electron-window-state`; has a unit-testable store component.
- **Re-scope / skip (session-6 finding):** **Phase 1.2 (#32398)** is largely resolved by the in-tree Electron-42
  `{useSystemPicker:true}` (macOS 15+ uses the native picker; handler not invoked) — residual is upstream/Wayland.
  **Phase 1.3 (#32075)** is a native Wayland/PipeWire segfault (mostly Linux/upstream). Neither is a strong in-repo
  macOS target; only defensive hardening (try/catch on `getDesktopCapturerSources`, empty-source guard, stale-callback
  guard) is in-repo, and the crash itself stays upstream.
- **Known pre-existing limitation (3.1):** the app-menu `role:"quit"` (`vectormenu.ts`) bypasses the warn-before-exit
  dialog on all platforms; harmless on macOS with the new default, only diverges if a user re-enables the warning.
- **Main-process follow-up for 0.3:** investigate coaxing Chromium to grant durable storage on desktop (e.g.
  ensure notifications-permission signal) so `persist()` actually returns true — the only real cure for the
  IndexedDB-eviction flavour of #32198/#32108.
