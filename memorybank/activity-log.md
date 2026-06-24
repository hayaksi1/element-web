# Activity Log

## 2026-06-24 (session 10) — Batched multi-phase: 3.2, 6.1, 6.3, 4.1 (+ triage of 1.4/2.3/3.5/6.2)

### Context / pick
- On `main`, working tree clean, `origin/main` == `main` == `11e2bcf` (sessions 1–9 all pushed). User directive:
  "handle multiple phases this session to finish quickly, use subagents." So: triage everything remaining in parallel,
  then implement the real in-repo fixes concurrently on disjoint files.

### Triage (8-agent parallel workflow → structured verdicts; the 3.2 agent errored, researched manually)
- **fix-now:** 3.2 (#32267), 6.1 (#32362 only), 6.3 (#32018), 4.1 (#32253).
- **skip-mischaracterized / track-upstream (skeptic check, cf. #32288):**
  - **1.4 #32426** mute hotkey: ⌘D works for legacy 1:1 (`LegacyCallView.onNativeKeyDown`) but voice rooms/group calls
    use Element Call as a **cross-origin iframe widget**; the keydown never reaches element-web's document. Reproduces on
    web. Belongs upstream in element-call. No desktop-file involvement.
  - **2.3 #32184** Nightly update: `updater.ts` feed handling is correct; failure is native **Squirrel.Mac/ShipIt**
    bundle-swap, reproduces on mainline, self-heals on retry. Same class as #32404. No JS fix.
  - **3.5 #32352** tray-exit-during-call: tray `app.quit()` → `beforeQuit` sets `appQuitting=true` → close handler stops
    hiding → `window-all-closed` → exit. Already force-quits; no in-repo blocker. Ancient (riot-web 1.5.12/Linux).
  - **6.2 #32351/#32337/#32284** config: the **session-7 shallow-`Object.assign` hypothesis is REFUTED** (high conf).
    The asar config has no top-level `jitsi`/`integrations`, so `Object.assign` has nothing to clobber, and the renderer
    deep-merges defaults (`SdkConfig.ts:81` lodash `mergeWith`). Real causes: #32284 = integration-manager + casing,
    #32337 = upstream SDK race + Electron `.well-known` cache, #32351 = **feature gap** (no system-wide config path).

### Fixes shipped (4 parallel implementation agents, disjoint files, TDD)
- **3.2 (#32267)** [window-close.ts](../apps/desktop/src/window-close.ts) NEW pure `resolveWindowCloseBehavior` →
  `quit`/`hide-app`/`hide-window`; darwin close handler now `app.hide()` (⌘W ≡ ⌘H — maintainer dbkr's stated intent;
  **not** a prompt, which he rejected). Tray/non-darwin path unchanged. 8 tests. Commit `57ef7d5`.
- **6.1 (#32362)** [save-image.ts](../apps/desktop/src/save-image.ts) NEW `saveImageToFile(url,filePath,session)` uses
  `webContents.session.fetch()` so the `media-auth.ts` `webRequest` interceptors (URL rewrite + Bearer) apply (was the
  main-process **global `fetch()`** → 401/404 on authenticated media). #32355 already renderer-fixed. 7 tests. Commit `872c2af`.
- **6.3 (#32018)** [macos-titlebar.ts](../apps/desktop/src/macos-titlebar.ts) drag strips 13–24px → **32px**; CSS extracted
  to pure `buildTitleBarCss()`. 11 tests. Commit `d6002f4`.
- **4.1 (#32253)** [SearchWarning.tsx](../apps/web/src/components/views/elements/SearchWarning.tsx) warns while Seshat is
  still crawling (`currentRoom() !== null`), `changedCheckpoint`-subscribed auto-clear, new i18n key. 6 tests. Commit `90207fd`.

### Adversarial review (18-agent workflow: 4 fixes × 3 lenses → per-finding skeptic) — 2 confirmed (both low), applied
- **3.2:** `app.hide()` leaves `BrowserWindow.isVisible()` true (NSApp-level hide), so the `second-instance` relaunch
  handler's `if (!isVisible()) show()` would skip and leave the window hidden on that (narrow) path. **Fix:** `app.show()`
  (darwin-only no-op) before the visibility checks. (The common dock-relaunch path already recovers via `app.on("activate")`.)
- **4.1:** the partial-index warning mounts dynamically mid-session → not announced to screen readers. **Fix:** `role="status"`
  on that container only (+ a test asserting the role). 6.1 and 6.3 had **zero** findings; 4 other 4.1 findings dismissed
  as non-blocking (e.g. `currentRoom()` is an imperfect proxy for an unloaded-room checkpoint — accepted, by design).

### Verification
- Desktop `vitest run`: **171/171** (14 files; +3 new: window-close 8, save-image 7, macos-titlebar 11). `tsc`/`eslint
  --max-warnings 0`/`prettier --check`/**knip** clean. (Fixed 2 eslint `explicit-function-return-type` nits post-agent.)
- Web `SearchWarning` Jest **8/8** (re-run independently). Web `tsc`: only the 4 pre-existing vendored matrix-js-sdk
  errors (none in our file). eslint/prettier/`matrix-i18n-lint` clean.
- **Not verifiable here (manual macOS QA):** ⌘W app-hide UX, the drag feel, authenticated-media save on a live build.

### Recommended next session
- **#32351** system-wide config path (a feature; confirm path with maintainers) — the only actionable remnant of 6.2.
- PR shortlist #33954 / #33955+#33956; **6.4 #32315** smooth-scroll; **3.6 #32273** download-toast freeze (verify repro).

## 2026-06-24 (session 9) — Phase 3.3: insource window-state restore (#32228 / #32360)

### Context / pick
- Working tree clean, on `main`, 1 commit ahead of `origin/main` (session-8 Phase 3.4 `1e06fa8`, unpushed). Picked
  Phase 3.3 — top recommended in-repo + unit-testable window/lifecycle item.

### Research (6-agent workflow: gh + dep audit + code-map + upstream-PR scan → structured synthesis)
- **#32228** ("remember window size", OPEN since 2022, S-Minor/O-Frequent): the unmaintained `electron-window-state@5.0.3`
  only writes state in its `closed` handler. Element's macOS `close` handler does `e.preventDefault()` + hide (window
  never destroyed), so `closed` never fires → geometry only flushed on a real quit, lost on crash/force-quit. Secondary:
  the lib's strict `display.bounds` full-containment check resets menu-bar/notch/multi-monitor layouts to defaults.
- **#32360** ("always starts in fullscreen"): reported mostly on **Linux tiling WMs** (the macOS framing is wrong). The
  lib persists `isFullScreen` and re-applies it via `setFullScreen(true)` on launch; the flag is sticky (Element quits
  without un-fullscreening; tiling WMs report `isFullScreen()=true` spuriously).
- Verdict: **replace the dep** (maintainer t3chguy explicitly suggests insourcing, cf. VS Code). No upstream PR to adopt.

### Fix shipped (TDD: RED → GREEN)
- NEW [window-state.ts](../apps/desktop/src/window-state.ts) — pure helpers `boundsAreValid` / `isVisibleOnSomeDisplay`
  (workArea overlap ≥100px each axis, not strict containment) / `resolveRestoreState` / `captureState`, plus a
  `WindowStateManager` class (constructor reads `Store.instance.get("windowState")`; `getRestoreState(displays)`;
  `persist(win)` with a destroyed-window `try/catch`; `monitor(win)` debounces resize/move and immediately persists
  maximize/unmaximize/leave-full-screen, cancelling the timer on `closed`).
- [store.ts](../apps/desktop/src/store.ts): new exported `WindowBounds` / `PersistedWindowState` (`{bounds?, isMaximized?}`)
  + `StoreData.windowState` + JSON schema (bounds requires x/y/width/height; `additionalProperties:false`).
- [electron-main.ts](../apps/desktop/src/electron-main.ts): dropped `import windowStateKeeper`; added `screen`; window
  created from `windowState.getRestoreState(screen.getAllDisplays())`; ready-to-show restores **maximized only** (no
  `setFullScreen`); `monitor()` attached; synchronous `persist()` in the `close` handler and before the Cmd+Q `app.exit()`.
- [package.json](../apps/desktop/package.json) + `pnpm-lock.yaml`: removed `electron-window-state` (electron-store@11
  already present; no new dep).
- **Fullscreen is deliberately NOT restored** (VS Code `restoreFullscreen:false` precedent) — the definitive #32360 fix.

### Adversarial review (21-agent workflow, 4 dimensions → per-finding skeptic) — 17 findings, 10 confirmed
- **CRITICAL (high-confidence, acted on):** the first cut still restored fullscreen, so quitting *while* fullscreen via
  `app.quit()` (`appQuitting=true` skips the un-fullscreen branch) persisted `isFullScreen:true` → #32360 unfixed on the
  real-quit path. Three findings converged on this. **Resolution: stop restoring fullscreen entirely** (stronger than the
  reviewers' "normalise the flag on quit"; also kills the async `setFullScreen(false)` race and the appQuitting asymmetry).
- **Applied (others):** destroyed-window `try/catch` + `closed`→clearTimeout (stale-timer teardown crash); Cmd+Q
  `app.exit()` geometry flush (app.exit fires no `close`); test-quality — 100px overlap boundary (was untested,
  off-by-one `>=`→`>` survived), debounce **coalescing** proof (single-event test couldn't tell a debounce from a
  per-event timer), end-to-end leave-full-screen capture, destroyed-window guard.
- **Documented, not fixed (with rationale):** legacy `window-state.json` ignored → one-time reset on upgrade
  (self-healing; migration not worth the I/O risk for S-Minor); the `electron-main.ts` close/exit glue stays unit-untested
  by repo convention (logic lives in `window-state.ts`); the schema is machine-written only so the conf/AJV validation
  can't be meaningfully unit-tested against the in-memory store mock.

### Verification
- `vitest run` (apps/desktop): **145 pass / 11 files** (+43 in `window-state.test.ts`). `tsc --noEmit`: clean.
  `eslint --max-warnings 0` (4 changed src + test): clean. prettier `--check`: clean. **knip** (root): clean (dep removed).
- Not verifiable here: real macOS multi-monitor restore + the live launch geometry (manual QA on a signed build).

### Recommended next session
- **Phase 3.2** Cmd-W orphan-window prompt (#32267) — verify the exact repro first (darwin `close` already hides).
- **Phase 3.3 follow-up (optional):** best-effort one-shot migration importing the legacy `window-state.json` to avoid
  the one-time geometry reset on upgrade.
- **Phase 5.3 (#32288)** only after a live-build re-confirm; PR shortlist **#33955+#33956** Seshat backfill resilience.

## 2026-06-24 (session 6) — Phase 3.1 macOS warnBeforeExit default → opt-in (#32287)

### Context / pick
- Session 5's Phase 0.3 work was already committed+pushed as `01e11ec` (an external actor committed it with
  an equivalent message while this session started; the working tree was clean). Re-verified before continuing:
  `StorageManager-test` 17/17 pass, eslint/prettier clean.
- Researched the next-priority Phase 1.2/1.3 screen-share issues first (#32398, #32075) via `gh` + the Electron
  42.3.3 type defs. **Finding (changed the plan):** the catalogue mis-scoped them as in-repo macOS fixes. Electron
  42.3.3 `setDisplayMediaRequestHandler({useSystemPicker:true})` docs (`electron.d.ts:13167-13171`) confirm that on
  **macOS 15+ the system picker is used and the handler is NOT invoked** — so the "two pickers fight on macOS"
  premise is wrong; the tree already ships `{useSystemPicker:true}`. #32398 (2017→2026, X-Blocked/Z-Upstream/A-Jitsi)
  is largely fixed by the Electron-42 bump (recent issue comments confirm the system picker now appears); #32075 is a
  native Wayland/PipeWire **segfault** (`base_capturer_pipewire.cc ScreenCastPortal failed`, `core dumped`), mostly
  Linux/upstream, maintainers suggest closing as a dup. **User chose to pivot to Phase 3.1.**

### Fix shipped (TDD: RED → GREEN)
- Root cause: `warnBeforeExit` defaulted to `true` everywhere (schema `store.ts` + `store.get("warnBeforeExit", true)`
  in the ⌘Q handler), so macOS users got a confirm dialog on ⌘Q — contrary to the native convention that ⌘Q quits
  immediately (#32287, open since 2021, T-Enhancement; maintainer t3chguy resisted a *global* off-by-default but users
  specifically want the macOS native behaviour). The ⌘Q path is real: `exitShortcuts` (electron-main.ts:225-230)
  matches `darwin && meta && !control && Q`; the `before-input-event` handler (line 459) `preventDefault()`s it
  (shadowing the menu `role:"quit"` accelerator) and shows the dialog when `shouldWarnBeforeExit`.
- Change — **platform-aware default**, explicit user choice always preserved:
  - [store.ts](../apps/desktop/src/store.ts): new `Store.shouldWarnBeforeExit()` → `this.get("warnBeforeExit",
    process.platform !== "darwin")` (false on darwin, true elsewhere); schema `default` also made
    `process.platform !== "darwin"` for consistency with the method + sibling settings.
  - [electron-main.ts](../apps/desktop/src/electron-main.ts):470 — `store.get("warnBeforeExit", true)` →
    `store.shouldWarnBeforeExit()`.
  - [settings.ts](../apps/desktop/src/settings.ts):31 — the `Electron.warnBeforeExit` read bridge →
    `Store.instance?.shouldWarnBeforeExit()`.
  - [Settings.tsx](../apps/web/src/settings/Settings.tsx):1500 — web fallback `default: true` → `default: !IS_MAC`
    (`IS_MAC` already imported from `../Keyboard`, via `navigator.platform`) so the toggle's pre-load fallback matches
    the macOS platform default. No-op on jsdom/Linux (IS_MAC=false), differs only on real macOS.
- Tests [store.test.ts](../apps/desktop/src/store.test.ts): new `describe("shouldWarnBeforeExit (#32287)")` (6 tests):
  darwin/win32/linux unset defaults, darwin explicit opt-in, win32 + linux explicit opt-out; per-test
  `Object.defineProperty(process,"platform")` override. Self-contained `beforeAll` inits the Store singleton if needed.

### Adversarial review (workflow) — 20 agents, 4 lenses → per-finding skeptic verifiers
- 16 findings, 15 "real". Applied receiving-code-review rigor (evaluated each, not blind agreement). Acted on **2**:
  (1) **test-ordering dependency** — my describe relied on the prior suite's `beforeAll` initialising `Store.instance`
  (would crash under a `-t` filter) → added a self-contained `beforeAll`. (2) **Settings.tsx web default** mismatched
  the new macOS platform default → `default: !IS_MAC`. **Rejected as out-of-scope:** the menu `role:"quit"` bypass of
  the warn dialog (pre-existing; my change makes macOS *more* consistent, and "fixing" it would *expand* warnings —
  the opposite of #32287). **Kept:** the redundant-but-harmless schema default (matches sibling-setting style; conf's
  `get(key,default)` uses the explicit fallback, so the method is the source of truth). Skipped a hypothetical
  non-boolean-stored-value test (type/schema-prevented).

### Verification
- `vitest run` (apps/desktop): **360 pass / 43 files** (store.test.ts 12/12; +6 new). (3 playwright browser-mode files
  don't run here — pre-existing `chrome-headless-shell` not installed; unrelated.)
- prettier `--check` (5 files): clean. eslint `--max-warnings 0` (4 desktop + Settings.tsx): clean. desktop
  `tsc --noEmit`: clean. web `tsc`: only the 4 pre-existing vendored matrix-js-sdk errors (none in Settings.tsx).
- Not verifiable here: real macOS ⌘Q behaviour on a signed build (pure-logic default flip, fully unit-covered).

### Known limitation (documented, not fixed)
- Menu **File→Quit / app-menu Quit** (`vectormenu.ts` `role:"quit"`) bypasses the `before-input-event` warn path on
  all platforms — pre-existing. On macOS with the new default this is harmless (both quit immediately); it only
  diverges if a user explicitly re-enables the warning. Out of scope for #32287 (which wants *fewer* macOS warnings).

### Recommended next session
- **Phase 2.2** non-writable `/Applications` auto-update guidance (#32404), or **Phase 5.3** remove "99+" dock badge
  cap (#32288, clean small macOS fix), or the PR adopt shortlist (**#33954** arm64 AES build flag, **#33957**
  timeline-reset guard — both low-effort, validated in `upstream-pr-review.md`).

## 2026-06-24 (session 5) — Phase 0.3 web StorageManager.tryPersistStorage hardening (#32198/#32108/#32472)

### Goal

Continue the phase plan: Phase 0.3 — harden web-side `StorageManager.tryPersistStorage()` so the browser is
asked to make storage durable and a denial is acted upon, mitigating the IndexedDB-eviction → forced-logout /
recovery-key-every-restart data-loss cluster.

### Research (multi-agent workflow: gh + firecrawl + context7 + Explore)

- **Root cause confirmed:** #32198 and #32108 are the `checkConsistency()` IndexedDB-eviction branch
  (richvdh + OP logs: "Data exists in local storage and crypto is marked as initialised but no data found in
  crypto store. IndexedDB storage has likely been evicted by the browser!"). The crypto store lives in IndexedDB;
  a non-"persistent" origin is evicted LRU under storage pressure → key loss → forced logout. #32472
  (recovery-key-every-restart) is the deterministic per-boot `session_restore` failure — more likely the
  pickle-key/safeStorage path (already mitigated by Phase 0.1, 25cd00a) than opportunistic eviction.
- **The gap:** `tryPersistStorage()` called `navigator.storage.persist()` but only **logged** the boolean —
  never acted on `false`, never warned, never distinguished desktop. Merged PR #31299 already moved the call into
  `onLoggedIn` so it fires on every session restore (→ a `persisted()` short-circuit is worthwhile).
- **Electron persist() reality:** Electron does NOT auto-grant; `persist()` runs Chromium's durable-storage
  heuristic and **commonly returns false** on a custom-scheme (`vector:`) renderer (no engagement/bookmark/notif
  signal). There is **NO main-process API** to force durability (`persistent-storage` is not in the
  `setPermissionRequestHandler` enum; no `session` quota-grant). Only lever: notifications permission. So the
  web-side change is the realistic ceiling — improves observability + warns, cannot itself make storage durable.
- **Conventions verified:** desktop marker `!!window.electron` (typed `@types/global.d.ts:127`); `no-floating-promises`
  OFF in `src/` (only playwright) so the fire-and-forget caller needs no `void`; tests are **Jest** (`-test.ts`,
  `jest-fixed-jsdom`, `fake-indexeddb/auto`) and jsdom lacks `navigator.storage` (must `Object.defineProperty`);
  `logger.warn` IS captured by rageshakes (`rageshake.ts:50` `warn:"W"`); i18n via `pnpm i18n` (not needed here).

### Fix shipped (TDD)

- [StorageManager.ts](../apps/web/src/utils/StorageManager.ts): `tryPersistStorage()` →
  `async (): Promise<boolean>`. Order: (1) if `navigator.storage.persist` exists — try `persisted()` first and
  short-circuit `return true` if already durable (query failure is caught and **does not block** the request);
  else `await persist()`, log, and on `false` call `warnPersistenceDenied()`; return the boolean. (2) Safari
  `document.requestStorageAccess` fallback (await in try/catch). (3) else "Persistence unsupported" → false.
  Whole body wrapped in try/catch → `error(...)` + return false, so it **never rejects**. New `warn()` helper +
  `warnPersistenceDenied()` (desktop note gated on `window.electron`).
- Call site `MatrixChat.tsx:1550` unchanged (bare fire-and-forget; the now-Promise never rejects).
- **No i18n / no UI / no toast** — deliberate (see phases.md session 5 rationale: false-alarm flood + maintainer
  dialog-fatigue). "Recovery before forced logout" deferred (evicted crypto store is unrecoverable).
- Tests [StorageManager-test.ts](../apps/web/test/unit-tests/utils/StorageManager-test.ts): +11 (17 total).

### Adversarial review (workflow) — caught test-quality gaps (no source bugs)

- 20 agents (3 review dimensions → per-finding skeptic verifiers). 17 findings → **3 confirmed real, all
  test-quality**: (1) the throw test didn't assert `logger.error` and the symmetric `persisted()`-rejects path
  was untested; (2) no test for `storage` present but `.persist` absent → Safari fallback; (3) no test for
  `persist` present but `persisted` absent → short-circuit skipped. All three fixed. While fixing (1) I added a
  **resilience improvement** (query failure no longer blocks the request) via a proper RED→GREEN cycle.
  (First review run aborted on transient 529 Overloaded; re-ran — did not treat the empty result as "clean".)

### Verification

- Jest (apps/web, via local `transformIgnorePatterns` override allowing matrix-js-sdk's `.pnpm` symlink):
  `utils/StorageManager-test` **17 pass**; `Lifecycle-test` **41 pass / 5 skipped** (no regression).
- `eslint --max-warnings 0` (both files): clean. `prettier --check`: clean. `tsc --noEmit -p apps/web/tsconfig.json`:
  no StorageManager errors (the 4 pre-existing **vendored matrix-js-sdk** errors remain — unrelated, documented).
- Not verifiable here: real desktop eviction behaviour (needs storage-pressure on a packaged build). The change
  is a pure-logic prevention/observability guard fully covered by unit tests.

### Environment note

- The prior session's `scratchpad/webjest.sh` helper was lost (session-specific scratchpad). Recreated it; Jest 30
  renamed `--testPathPattern` → `--testPathPatterns`. Helper now in this session's scratchpad.

### Recommended next session

- **Phase 1.2/1.3** screen-share picker (#32398/#32075), **3.1** macOS `warnBeforeExit` (#32287), or **2.2**
  `/Applications` auto-update guidance (#32404). Also a **main-process follow-up for 0.3**: coax Chromium to grant
  durable storage on desktop (notifications-permission signal) so `persist()` returns true.

---

## 2026-06-24 — Upstream PR review (no code changes)

### Goal

Review open `element-hq/element-web` PRs for improvements relevant to the macOS-desktop remediation
effort; note good ones in the memory bank for implementation after user confirmation.

### Method

Multi-agent workflow (28 subagents): dumped all **95 open PRs**, curated **13 overlapping candidates**,
analyzed each (PR body + full diff + local-code cross-check), adversarially **verified** every verdict,
ran a dedicated **Seshat-cluster-vs-our-circuit-breaker** impact analysis (incl. an empirical 3-way
merge), then synthesized. The `A-Electron` label is **not applied to PRs** (issues only), so overlap was
judged by content.

### Key finding

The fresh **Seshat cluster #33954–#33958** (all by maintainer ara4n, 2026-06-24) targets **#32119**
(CPU spike) + index completeness — our **Phase 4** — and is **complementary, NOT a supersession** of our
Phase 0.2 circuit-breaker (3d5ce8b, #33501 = error-_dialog_ flood). Verified: `onSync` auto-merges
cleanly with #33955; only a trivial private-field block conflict (keep both). Path: **combine**.

### Output (notes only — nothing implemented)

- New: [upstream-pr-review.md](upstream-pr-review.md) — adopt shortlist, Seshat cluster verdict,
  per-PR notes, ordered next actions.
- Adopt/adapt shortlist: **#33954** (arm64 AES build flag, low), **#33957** (timeline-reset guard, low),
  **#33955+#33956** (backfill resilience + progress UI, high), **#33048** (N-gram tokenizer for #32038,
  medium). Track: #33958, #33932, #32804, #33951, #33637. Skip: #33635, #33699, #33724.
- Corrected two wrong curator mappings: #33637→#32288 (wrong platform+direction) and #33699→#32355/#32362.

### Verification

- No source changed; working tree clean before this review. PR/diff facts pulled via `gh` against
  `element-hq/element-web`. All recommendations are pending the user's confirmation before implementation.

---

## 2026-06-24 — macOS Desktop issue research + first critical fixes

### Goal

Detect macOS Element Desktop (`apps/desktop`) problems from GitHub issues, record them in the
memory bank with a prioritised phase plan, and fix the highest-priority problems.

### Research (firecrawl + GitHub)

- Discovered the repo pivot: **`element-hq/element-desktop` is archived** (2 open issues). Active
  desktop issues live in **`element-hq/element-web`** under label `A-Electron` (452 open; ~96 macOS).
- Ran a multi-agent workflow (firecrawl over the GitHub search API, 20 query dimensions):
  **237 unique issues harvested → 118 classified → top 18 deep code-mapped** against `apps/desktop/src`.
- Catalogue: [macos-desktop-problems.md](macos-desktop-problems.md) (45 ranked problems).
- Phase plan (highest→lowest): [phases.md](phases.md) (Phases 0–6).

### Fixes shipped this session (TDD, all tested)

**1. Phase 0.1 — Pickle-key transient-decrypt → permanent session loss** (#32521, #32715, #32198 secondary) 🔴

- Root cause: `SafeStorageWriter.get()` swallowed `safeStorage.decryptString` failures and returned
  `undefined` (indistinguishable from "no secret"); `ipc.ts getPickleKey` then returned `null`
  (renderer uses default pickle key) and `createPickleKey` **overwrote** the still-valid ciphertext —
  turning a transient OS-keychain hiccup into permanent session/crypto loss.
- Change:
    - `apps/desktop/src/store.ts`: new exported `SafeStorageDecryptionError`; `SafeStorageWriter.get()`
      now **throws** it on decrypt failure (vs returning `undefined`); added `StorageWriter.has()` and
      `Store.isSecretUndecryptable()`; basic_text migration loop skips undecryptable keys instead of
      writing `undefined` over them.
    - `apps/desktop/src/ipc.ts`: `createPickleKey` refuses to overwrite an existing-but-undecryptable
      secret (returns `null`, preserves it for recovery); `getPickleKey` comment clarified.
    - Renderer contract verified safe: `Lifecycle.ts` already does `getPickleKey(...) ?? undefined` and
      `createPickleKey` already returns `string | null`.
- Tests: `apps/desktop/src/store.test.ts` (6), `apps/desktop/src/ipc.test.ts` (4).

**2. Phase 2.1 — Start-at-login not working** (#32303) 🟡 O-Frequent

- Root cause: delegated to the unmaintained `auto-launch@^5.0.5` package (fragile macOS LaunchAgent
  plist path resolution for `.app` bundles; reported enabled but never launched).
- Change: rewrote `apps/desktop/src/auto-launch.ts` onto Electron native
  `app.setLoginItemSettings`/`getLoginItemSettings`. Preserved the public API (`AutoLaunch.instance`,
  `getState`, `setState`, `AutoLaunchState`) and `--hidden`/minimised behaviour; Windows path uses
  Squirrel's `Update.exe --processStart` so it survives app updates. Removed `auto-launch` &
  `@types/auto-launch` deps (package.json), their patch (`patches/@types__auto-launch.patch`),
  the `pnpm-workspace.yaml` patch entry, and regenerated `pnpm-lock.yaml`.
- Tests: `apps/desktop/src/auto-launch.test.ts` (6).

### Verification

- `vitest run` (apps/desktop): **33 passed / 7 files** (3 new test files + 4 existing).
- `tsc --noEmit` (src): clean. `eslint --max-warnings 0` (changed files): clean.
- `prettier --write` applied. `knip`: clean (no unused/missing deps from the removal).
- `pnpm install` succeeds and lockfile is consistent.
- Not verifiable here: real macOS GUI behaviour (keychain races, OS login items). The pickle-key fix
  is a pure-logic safety guard fully covered by unit tests; the auto-launch wiring/`--hidden` mapping
  is unit-tested but the actual OS login-item effect needs manual QA on a signed macOS build.

### Environment notes

- `pnpm` is not on PATH; use `corepack pnpm`. The repo `postinstall` calls bare `pnpm`, so a shim
  (`pnpm` → `corepack pnpm`) on PATH is needed for `pnpm install`/scripts to succeed.
- Ran vitest via `apps/desktop/node_modules/.bin/vitest` to avoid pnpm's deps re-check.

### Recommended next session

- **Phase 0.2** Seshat error-dialog circuit-breaker (#33501) — apps/web `EventIndex.ts`, high-confidence, unit-testable.
- **Phase 1.1** macOS media (mic/cam) permissions (#32373) — `electron-main.ts` permission handlers + `electron-builder.ts` `NS*UsageDescription`.

## 2026-06-24 (session 2) — Commit/push + Phase 0.2 Seshat dialog circuit-breaker

### Goal

1. Commit & push the session-1 macOS desktop fixes. 2. Continue the phase plan — fix Phase 0.2.

### 1. Commit & push (done)

- Committed the 13 staged files (Phase 0.1 + 2.1 + memorybank) as `25cd00a`
  _"fix(desktop): macOS data-loss & start-at-login fixes (Phase 0.1, 2.1)"_ and pushed to `origin/main`
  (gitea). Re-ran the 3 new desktop vitest files first (16 pass) to confirm no regression before committing.

### 2. Phase 0.2 — Seshat error-dialog flood → circuit-breaker (#33501) 🔴 S-Critical

- Root cause (confirmed via firecrawl on the GitHub issue + 20 comments): `EventIndex.onSync` fires on **every**
  `/sync`; any throw in `onSyncInner()` (e.g. the Seshat/Neon `SendError`) called
  `logErrorAndShowErrorDialog` → an error dialog **after every sync**, making the app unusable until restart.
  Introduced by PR #31448 (the dialog was deliberate — maintainer richvdh is against silently swallowing;
  Half-Shot objects to repeated non-actionable dialogs). Agreed middle ground = **show once, then stop**.
- Change ([EventIndex.ts](../apps/web/src/indexing/EventIndex.ts)): added `private indexingErrored` flag.
  `onSync` returns early once errored; the `.catch` now (a) dedupes via the flag (guards racing in-flight syncs),
  (b) sets the flag, (c) `this.stopCrawler()`, (d) shows the dialog **once**. Subsequent failures are logged only.
- Tests ([EventIndex-test.ts](../apps/web/test/unit-tests/indexing/EventIndex-test.ts)): mocked
  `logErrorAndShowErrorDialog`; new `describe("when the sync handler throws (#33501)")` with 2 tests —
  "only shows the error dialog once even if syncs keep failing" and "stops the crawler when indexing errors".
  TDD: confirmed RED first (dialog called 3×, stopCrawler 0×) → GREEN after the fix.

### Verification (Phase 0.2)

- `jest indexing/EventIndex-test`: **4 pass** (2 existing + 2 new). `indexing/ + EventIndexPanel`: **14 pass**.
- prettier: clean (unchanged). eslint `--max-warnings 0` on both files: clean.
- `nx lint:types element-web`: 0 errors in our source. (There are 4 pre-existing type errors **inside vendored
  `matrix-js-sdk@41.8.0` src** — crypto-wasm `.d.ts` + `MSC4108SignInWithQR.ts`; verified identical on the clean
  tree via `git stash`, so unrelated to this change. Environment TS 6.0.3 vs SDK mismatch.)

### Environment notes (web/jest, NEW this session)

- apps/web tests use **Jest** (not vitest). Two prerequisites to run them locally:
    1. Build the workspace deps first: `nx test:unit:prepare element-web` (builds `module-api` + `shared-components`
       into `lib/`/`dist/`; otherwise jest can't resolve `@element-hq/element-web-module-api`).
    2. On this machine `matrix-js-sdk` resolves through a `.pnpm` symlink that `jest.config.ts`'s
       `transformIgnorePatterns` excludes from babel → "Cannot use import statement outside a module". Workaround
       (local only, do NOT commit): pass `--transformIgnorePatterns` adding `matrix-js-sdk|matrix-events-sdk|@matrix-org|oidc-client-ts`
       to the allowlist. Helper saved at `scratchpad/webjest.sh "<testPathPattern>"`. CI doesn't need this.

### Recommended next session (unchanged priority)

- **Phase 1.1** macOS media (mic/cam) permissions (#32373) — `electron-main.ts` + `electron-builder.ts`.
- Then **Phase 0.3** web `StorageManager.tryPersistStorage()`, or **1.2/1.3** screen-share picker.

## 2026-06-24 (session 4) — Phase 1.1 macOS mic/cam permissions (#32373)

(Session 3 was a no-code upstream-PR review; see `memorybank/upstream-pr-review.md`.)

### Goal

Continue the phase plan: fix Phase 1.1 — macOS "Couldn't start capturing media" (mic/cam), #32373, S-Critical.

### Research (multi-agent workflow, firecrawl + context7 + Explore)

- Verified the catalogue was stale: `apps/desktop/src/media-auth.ts` already exists but is **misleadingly
  named** — it handles authenticated media _download_ URLs (rewrites `/media/v3/` → `/client/v1/media/`, adds
  Bearer header), NOT mic/cam permissions. Confirmed NO `setPermissionRequestHandler`/`setPermissionCheckHandler`/
  `askForMediaAccess` anywhere under `apps/desktop/src`.
- Confirmed two-part root cause: (a) packaged Info.plist lacks `NSCameraUsageDescription`/
  `NSMicrophoneUsageDescription` → hardened runtime → macOS never raises the TCC prompt (silent deny/crash);
  (b) main process never calls `systemPreferences.askForMediaAccess`, so Chromium getUserMedia is denied before
  the OS prompts. The existing `build/entitlements.mac.plist` device.camera/audio-input entitlements are
  necessary but NOT sufficient (usage strings are Info.plist keys, added via electron-builder `mac.extendInfo`).
- Critical design constraint surfaced by research: with NO handler today, Electron defaults to **grant-all**.
  Registering a handler overrides that for ALL permission types, so it must be **fail-open**; and media must
  **NOT** be origin-gated because widgets/Jitsi request media from remote-origin iframes (`isMainFrame=false`,
  `webContents=null` in the sync check handler). Origin-gating would have broken widget/Jitsi calls.

### Fix shipped (TDD)

- NEW `apps/desktop/src/media-permissions.ts` — `setupMediaPermissions()`:
    - `setPermissionRequestHandler` (async): for `permission === "media"` on `darwin`, map `details.mediaTypes`
      (audio→microphone, video→camera), de-dupe, and for each `not-determined` device `await askForMediaAccess`.
      Wrapped in try/catch so the native TCC call throwing never strands the request. Then **always** `callback(true)`
      (fail-open) — so non-media perms, off-darwin, and widget media keep the prior grant-all baseline.
    - `setPermissionCheckHandler(() => true)` — sync, fail-open, origin-agnostic (tolerates null webContents).
- Wired `setupMediaPermissions()` into `electron-main.ts` `app.ready` right after `setupMediaAuth`.
- `electron-builder.ts`: added `mac.extendInfo` with `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`
  (plain purpose strings, no `$(PRODUCT_NAME)` macro — electron-builder doesn't expand it in extendInfo).
- Tests `apps/desktop/src/media-permissions.test.ts` (11): registration, mic/cam prompts, no re-prompt when
  granted, no askForMediaAccess off-darwin, fail-open non-media, remote-origin widget media granted, null
  webContents check, **never-hangs-on-reject**, empty mediaTypes.

### Adversarial review (workflow) — caught a real regression before commit

- 3 reviewers + per-finding skeptic verifiers (10 agents). 1 of 7 findings confirmed real (high):
  if `askForMediaAccess` rejected, the async handler aborted before `callback(true)` → getUserMedia hangs
  forever (worse than before). Fixed with try/catch + a RED→GREEN regression test. 6 findings dismissed as
  false positives / acceptable.

### Verification

- `vitest run` (apps/desktop): **44 passed / 8 files** (+11 new in media-permissions.test.ts).
- `tsc --noEmit -p tsconfig.json`: clean (0). `eslint --max-warnings 0` (4 changed files): clean.
  `prettier --check`: clean. Not verifiable here: real macOS TCC prompt on a signed build (needs manual QA).

### Recommended next session

- **0.3** web `StorageManager.tryPersistStorage()` (#32198/#32472/#32108), or **1.2/1.3** screen-share picker
  (#32398/#32075), or **3.1** macOS `warnBeforeExit` default (#32287).

---

## Session 7 (2026-06-24) — Phase 2.2: non-writable install auto-update guidance (#32404)

Continued the phase plan. Picked Phase 2.2 over Phase 5.3 (#32288) after verifying #32288 is mischaracterised
in the catalogue: macOS uses raw `app.badgeCount` (no cap) in `badge.ts`; the only in-code cap is the
favicon/Windows overlay (`favicon.ts:148` → `Nk+` for >999), which doesn't match the reporter's "99+". #32404
is the better-grounded in-repo macOS fix.

### Root cause

On macOS, Squirrel.Mac installs an update by atomically **renaming** a freshly-staged `.app` over the existing
one. That swap needs write access to the directory that **contains** the bundle (not the old bundle's inode). An
admin install into `/Applications` run by a non-admin → that dir is read-only → updates download but never
install (silent failure / endless re-download). The wrapper never detected or surfaced this.

### Fix shipped (TDD)

- `apps/desktop/src/updater.ts`: new exported `isUpdateableLocation()` — darwin-only (else `true`), derives the
  `.app` from `app.getPath("exe")` (up 3 levels), `fs.access(<containing dir>, W_OK)`; `false` on
  EACCES/EPERM/EROFS (fail-closed), `true` on other errno e.g. ENOENT in dev (fail-open). `available()` exported
  and, after EOL checks, calls it; if non-writable → one-time `showToast` (`updater|not_writable_*`, `%(brand)s`)
  + `return false` so `start()` never sets the feed URL / polls.
- `apps/desktop/src/i18n/strings/en_EN.json`: new `updater` group (`matrix-gen-i18n` no-diff).
- `apps/desktop/src/updater.test.ts` (NEW, 8 tests). RED→GREEN.

### Adversarial review (17-agent workflow) — 13 findings, 3 confirmed, all applied

1. **correctness (real):** original predicate checked W_OK on the bundle **and** its parent (AND). Squirrel's
   rename only needs the **parent** dir; gating on the bundle could false-negative (wrongly disable updates) for
   an admin-owned read-only bundle in a user-writable folder. **Fixed:** check the containing dir only. Primary
   #32404 case (`/Applications` non-writable) stays correct.
2. **test quality (real):** mode arg wasn't pinned — an `F_OK` mutation would silently re-break #32404.
   **Fixed:** assert `access` called with `fsConstants.W_OK`.
3. **test quality (real):** `%(brand)s` substitution wiring untested. **Fixed:** assert `_t` called with
   `{ brand: "Element" }`. (Remaining 10 findings were no-defect confirmations / false positives.)

### Verification

- `vitest run` (apps/desktop): **58 passed / 9 files** (+8 new in updater.test.ts).
- `tsc --noEmit -p tsconfig.json`: clean. `eslint --max-warnings 0` (changed files): clean. `prettier --check`:
  clean. `matrix-gen-i18n`/`matrix-i18n-lint`: clean. knip safe (`ignoreExportsUsedInFile:true`; exports used
  in-file). **Not verifiable here:** real Squirrel.Mac install on a signed build (manual macOS QA).

### Session 7 (cont.) — Phase 4.4: adopt upstream PR #33957 (timeline-reset re-seed guard, → #32119)

Continued in the same session. Adopted the low-effort PR-review shortlist item #33957.

- **Root cause:** `apps/web/src/indexing/EventIndex.ts` `onTimelineReset` seeded a backward gap-fill checkpoint
  on **every** `RoomEvent.TimelineReset`. matrix-js-sdk (pinned **41.8.0**) emits it as
  `(room, timelineSet, resetAllTimelines)` and **re-emits** via its ReEmitter from thread/filtered
  `EventTimelineSet`s, so any room with one ancient thread re-inflated the crawl list on every launch →
  contributes to the #32119 startup CPU spike.
- **Fix (faithful port of #33957):** `onTimelineReset(room, timelineSet?: EventTimelineSet)` early-returns when
  `timelineSet && timelineSet !== room.getUnfilteredTimelineSet()` (only the room's own unfiltered live timeline
  re-seeds). Pre-existing `isRoomEncrypted` guard + `addRoomCheckpoint(roomId, false)` unchanged, run after the new
  guard. `EventTimelineSet` was already imported; SDK emit signature confirmed via its `.d.ts`.
- **Tests** (`apps/web/test/unit-tests/indexing/EventIndex-test.ts`, Jest, +3, RED→GREEN): thread/filtered set
  reset → no checkpoint; own live-timeline reset → backward `fullCrawl:false` checkpoint; undefined timelineSet →
  still seeds (guards the `timelineSet &&` short-circuit). **Test-harness gotcha hit & fixed:** `mockClientMethodsRooms`
  sets `isRoomEncrypted: jest.fn()` (→ undefined) — the override must come **after** the spread or the encrypted-room
  guard short-circuits (caught via RED diagnosis: all-0-calls).
- **Adversarial review** (13-agent workflow, 10 findings → 1 confirmed, low/cosmetic): reworded the
  undefined-timelineSet test's "(legacy emitters)" label (pinned SDK never emits undefined `timelineSet`; the test is
  valid branch coverage of the short-circuit). Applied.
- **Verification:** EventIndex Jest **7/7**; `eslint --max-warnings 0` + prettier clean on both files; `tsc` only the
  4 pre-existing node_modules/matrix-js-sdk crypto-wasm errors (none in changed files). **Web Jest local-run:** used
  the `scratchpad/webjest.sh` helper (recreated; appends `matrix-js-sdk` to `transformIgnorePatterns`; Jest 30
  `--testPathPatterns`).

### Recommended next session (as of session 7)

- **Phase 5.3 (#32288)** only after re-confirming against a live build (may be no-op/wontfix — see above).
- PR-review adopt shortlist remainder: **#33954** arm64 AES build flag (validate seshat pin/toolchain first), or the
  larger **#33955+#33956** Seshat backfill resilience (Phase 4.2). Or **Phase 3.4** white launch flash (#32260) /
  **Phase 3.2** Cmd-W orphan prompt (#32267).

## 2026-06-24 (session 8) — Phase 3.4: theme-aware window background (#32260)

### Context / pick
- Working tree clean, on `main`, 4 commits ahead of `origin/main` (510c618 + the three session-7 commits, all
  unpushed). Picked Phase 3.4 (white launch flash) — the top "recommended next" item, in-repo + unit-testable.

### Root cause (firecrawl on the issue + code-mapping)
- The reporter suggested the `ready-to-show` pattern, but `electron-main.ts` **already** uses `show:false` +
  `ready-to-show` → `show()`. The real cause: `backgroundColor:"#fff"` (hard-coded white) + `index.html`'s
  transparent `<body>` ⇒ the first painted frame is the white native bg before the themed CSS applies ⇒ dark-theme
  users see a white→dark flash. The renderer already computes the body bg for the `theme-color` meta
  ([theme.ts:386-389](../apps/web/src/theme.ts)) — reused as the source of the colour.

### Fix shipped (TDD, layered, each layer independently testable)
- **`apps/desktop/src/background-color.ts` (NEW):** pure `resolveBackgroundColor(persisted, prefersDark)` (valid
  persisted colour ⟶ else opaque `nativeTheme` default, dark `#101317` / light `#ffffff` = real Compound
  `--cpd-color-bg-canvas-default`→`--cpd-color-theme-bg`) + `isValidThemeColor()` (opaque hex/rgb/rgba(…,1) only).
- **`store.ts`** optional `backgroundColor` key + schema; **`electron-main.ts`** window bg now uses the helper with
  `nativeTheme.shouldUseDarkColors`; **`ipc.ts`** new `setThemeColor` fire-and-forget handler (validate → skip if
  unchanged → persist + live `setBackgroundColor`); **`preload.cts`** + **`global.d.ts`** allowlist/union;
  **`apps/web/src/theme.ts`** reports the colour via `window.electron?.send("setThemeColor", …)` (guarded).
- Design: first launch → OS appearance (default "match system theme"); later launches → exact persisted colour.

### Adversarial review (49-agent workflow) — 22 findings, 2 confirmed (same root)
1+2. **(confirmed) `isValidThemeColor` accepted alpha** (`#rgba`/`#rrggbbaa`/`rgba(…,a<1)`). A **translucent custom
   theme**'s computed body bg would pass → persisted → transparent native window → blurry fonts / see-through launch,
   violating the opaque-background (blurry-font FAQ) invariant the change itself documents. **Fixed:** validator
   enforces opacity (also kills the ambiguous `RRGGBBAA` vs Electron `AARRGGBB` hex-alpha ordering). Tests updated:
   `#ffff`/`#ffffffff`/`rgba(…,0.5)` moved to rejects + explicit `rgba(0,0,0,0)`/`#0000`/`#00000000` rejects + a
   translucent-persisted-→-fallback case.
- Folded in 1 rejected-but-cheap quality win: skip the redundant synchronous `store.set` disk write when the colour
  is unchanged (switchTheme fires on every theme resolution) + a test. 19 other findings nits/by-design (stale
  single-frame self-corrects on next render; ElectronPlatform-seam preference; out-of-range RGB that
  `getComputedStyle` never emits; no-ReDoS/allowlist-correct confirmations).

### Verification
- Desktop: `vitest run` **102/102** (10 files; new `background-color.test.ts` + ipc/theme additions), `tsc -p
  tsconfig.json` clean, `eslint --max-warnings 0 src` clean, prettier clean.
- Web: `theme-test` Jest **15/15** (+2), `tsc --noEmit` **0 errors**, eslint/prettier clean on changed files.
- **Not verifiable here:** the actual flash on a live signed macOS build (manual QA). Committed on `main` (NOT pushed).

### Recommended next session
- **Phase 3.2** Cmd-W orphan-window prompt (#32267) — verify exact repro first (darwin `close` handler already hides).
- **Phase 3.3** persist/restore maximized & fullscreen (#32228/#32360) — has a unit-testable store component.
- **Phase 5.3 (#32288)** only after re-confirming on a live build; PR shortlist **#33955+#33956** Seshat backfill.

---

## Session 11 (2026-06-24) — batched 6 phases via subagents (+2 document-only)

> (Sessions 9–10 are recorded in `phases.md`, which is the authoritative status. This entry covers session 11.)

Directive: handle ALL of the user-selected "Recommended next session" items (phases.md lines 262-289) with subagents.

**Process:** 8-agent triage workflow (5 structured-schema + 3 re-run as markdown after a StructuredOutput retry cap)
→ 6 implement, 2 document-only. Web phase (6.4) implemented by a background agent (isolated to `apps/web`); all desktop
phases implemented serially in the main loop (electron-main.ts is shared by 3.1 + 6.2, so serial avoids cross-talk),
TDD throughout. Then a 6-reviewer adversarial workflow with per-finding independent skeptic verification → 5 confirmed
findings (4 fix-now + 1 document) → all applied → full re-verification.

**Implemented (all TDD):**
- **6.4 (#32315)** Disable smooth scrolling — `Accessibility.disableSmoothScrolling` setting + pure `scrollBehavior.ts`
  `getScrollBehavior()` (OR of the setting and OS `prefers-reduced-motion`); gates the 3 perceptible JS smooth scrolls.
- **1.2/1.3 (#32398/#32075)** Screen-share defensive hardening — consume-once `consumeDisplayMediaCallback`;
  `getDesktopCapturerSources` try/catch → `[]` (no dangling renderer). Root crash stays upstream/Wayland.
- **#33954** (4.3/#32119) — arm64 `--cfg aes_armv8` RUSTFLAGS in `hak/matrix-seshat/build.ts`. Build-flag only; NEEDS
  native arm64 build QA (low break-risk per review: `aes 0.8.4` declares the cfg, no `-D warnings`).
- **3.6 (#32273)** Download-toast "Open" — `await shell.openPath` + error dialog (`download|unable_to_open_*`) + log;
  pure `resolveUserDownloadAction`. Success-path "freeze" = native macOS focus (documented, not in-repo fixable).
- **3.1 follow-up (#32287)** Menu/tray Quit honour warn-before-exit — pure `confirm-quit.ts` `shouldQuitAfterConfirm`
  + `confirmAndQuit` injected into `vectormenu.ts`/`tray.ts` (no import cycle). ⌘Q unchanged.
- **6.2 (#32351)** System-wide config path + deep-merge — pure `config.ts` (`getConfigCandidatePaths`,
  `loadMergedLocalConfig`, `deepMergeConfig`) wired into `electron-main.ts`; replaces the shallow `Object.assign`.

**Document-only:** 5.3 (#32288) no "99+" cap exists; macOS renders it natively, not overridable via `app.badgeCount`.
0.3 main-process durability — no Electron API; notifications already granted yet `persist()` stays false.

**Review → 5 confirmed findings, all fixed:** (config) malformed MDM config aborted the whole load + blamed the user →
per-layer try/catch (only the user-controlled primary rethrows); (config) nested one-sided `__proto__` unstripped →
recurse into one-sided objects; (config) Linux `/etc` ignores branding → documented intentional; (download) failed
open only logged → added error dialog; (download) handler untested → new `webcontents-handler.test.ts` drives the real
`will-download` flow.

**Verification:** desktop `vitest run` **214/214** (19 files; +5 new test files: config/confirm-quit/displayMediaCallback/
user-download/webcontents-handler), `tsc`/`eslint`/`prettier`/**knip**/i18n clean; web `scrollBehavior` Jest **12/12**,
web tsc (only the 4 pre-existing vendored matrix-js-sdk errors), eslint/prettier/i18n clean. **Not verifiable here:**
live macOS (quit dialogs, ⌘W, screen-share cancel, download-open dialog/focus), the **arm64 seshat native build**
(#33954), and real MDM config paths.

## Session 12 (2026-06-24) — Phase 4.2: Seshat backfill completeness + resilience + progress UI (#33955 + #33956)

Directive: "continue to fix the problems with phases." User chose (via AskUserQuestion) **Phase 4.2 — adapt upstream
PR #33955 (backfill completeness/resilience) + #33956 (indexed/indexing/errored progress UI)** onto our tree, the
recommended next in-repo, unit-testable phase. Fixes **#32266** (no results despite index), **#32011** (search misses
messages), strengthens **#32253**; contributes to **#32119** (startup CPU). All web (`apps/web`, Jest).

**Process:** deep research (fetched both PR diffs via `gh pr diff`, mapped every merge point against our tree) →
careful hand-port (NOT `git apply` — our tree diverged: circuit-breaker #33501 + #33957 timeline guard already present)
→ comprehensive Jest suite → full verification → **5-dimension adversarial review workflow (19 agents, 13 findings → 6
confirmed)** → applied 4 (2 code fixes + 3 gate-pinning tests), documented 1 → re-verify.

**Implemented (`apps/web/src/indexing/EventIndex.ts` + ManageEventIndexDialog.tsx + en_EN.json):**
- **`reconcileMissedRooms()`** (#32266/#32011): once per launch when crypto is ready (gated on `getCrypto()`, retried on
  a later sync if not), scans joined rooms and seeds a fullCrawl backward checkpoint for every encryption-enabled room
  with no indexed events and no queued checkpoint. The one-time `addInitialCheckpoints` only covered rooms present at
  index-creation; rooms joined later / missed (crypto not ready, no token, transient failure) stayed unindexed forever.
- **Crypto-aware `isRoomIndexable()`** (`isEncryptionEnabledInRoom`, not legacy state `isRoomEncrypted`) added to
  `onRoomTimeline` (after the cheap gates), `onRoomStateEvent` (rewritten: type-gate → `reconciliationDone` gate to
  avoid the initial-sync isRoomIndexed flood → indexable → try/catch seed), and `onTimelineReset` (**kept the session-7
  #33957 `timelineSet !== getUnfilteredTimelineSet()` guard**, added indexable). `unindexableRooms` set tracks
  state-encrypted-but-can't-speak rooms (excluded, not errored).
- **Crawler resilience:** permanent 4xx (≥400 <500, except 401/429) → drop checkpoint + `erroredRooms.add`; 401/429/5xx/
  network → retry (push back). A live event in a given-up room clears errored + re-seeds (bounded to crawl rate). A
  successful crawl batch clears errored.
- **Fully-crawled sentinel** (#32119): a backward fullCrawl reaching an empty chunk writes a `fully_crawled`-token
  sentinel checkpoint via `addHistoricEvents([], marker, checkpoint)` instead of deleting; `init()` splits loaded
  checkpoints, hydrating `fullyCrawledRooms` and keeping sentinels OUT of the crawl queue. Stops contentless rooms
  (isRoomIndexed=false forever) being re-crawled every launch. Round-trips through the native seshat wrapper (token is
  opaque). Non-fullCrawl / forward empty chunks still just delete.
- **`hasQueuedCheckpoint()` dedup** in `addRoomCheckpoint` (and reconcile's push — review fix) drops exact-duplicate
  checkpoints stacked by gappy syncs.
- **#33956 progress UI:** `crawlingRooms()` → **`getIndexingStatus()`** returning `{indexing, indexed, errored}` (joined
  encrypted rooms only; excludes invites/left + unindexable); `ManageEventIndexDialog.tsx` renders "N indexed, M
  indexing[, K errored]" (errored line only when >0); new i18n `message_search_room_progress[_errored]`, removed
  `message_search_pending_rooms` + old placeholders (en_EN only — other locales sync via the translation pipeline, as
  upstream #33956 did).

**Deliberately OMITTED:** the upstream `window.mxEventIndexDebug` / `listIndexingRooms()` debug hook (untestable dev-only
tooling needing `window as unknown` casts that fight our lint rules; not part of the correctness fix).

**Adversarial review → 6 confirmed (13 raised; 7 refuted, incl. the "stale-locale i18n" findings correctly rejected as
faithful-to-upstream pipeline behavior). Applied 4, documented 1:**
- **(code) per-room containment:** `getMyMembership()`/`isRoomEncrypted()`/`getLiveTimeline().getPaginationToken()` were
  OUTSIDE reconcile's per-room try/catch → a throw would escape `onSyncInner` and trip our **#33501 global breaker**
  (upstream has no breaker, so harmless there; in our tree it would stop ALL indexing + pop the dialog). Wrapped the
  whole per-room body in one log-and-skip try/catch so the port's "per-room error never trips the global breaker"
  invariant actually holds. + regression test.
- **(code) reconcile dedup:** reconcile's own checkpoint push bypassed `hasQueuedCheckpoint`, so a concurrent
  `onRoomStateEvent` seed during one of reconcile's awaits (flag set before the await) could double-queue a room
  in-memory (wasted crawl, self-correcting). Now reconcile re-checks the LIVE queue via `hasQueuedCheckpoint` before
  pushing.
- **(tests) pinned the new crypto gates:** added negative tests for `onTimelineReset` and `onRoomStateEvent`
  (state-encrypted but crypto-can't-speak → no seed) — previously deleting the gate line passed the suite.
- **Documented, not fixed (matches upstream, self-heals on restart, rare):** if `isEncryptionEnabledInRoom` transiently
  throws for one already-encrypted room during the single reconcile pass, that room's history backfill is skipped until
  next launch (live events still index). Faithful #33955 behavior.

**Verification:** web `EventIndex-test` Jest **29/29** (7 existing reconciled with getMyMembership/getCrypto mocks + 22
new: reconcile×8, crawler error/sentinel×4 incl. `it.each` permanent[400/403/404]/transient[401/429/500], dedup×1,
getIndexingStatus×1, onRoomStateEvent×3, onTimelineReset crypto-gate×1, per-room-containment×1), adjacent
`EventIndexPanel` **10/10**, `tsc -p tsconfig.json` (only the 4 pre-existing vendored matrix-js-sdk errors, 0 in our
files), eslint/prettier/i18n:lint clean. **Not verifiable here:** real Seshat sqlite sentinel round-trip on desktop, the
actual /messages crawl against a live homeserver, and the dialog rendering (no ManageEventIndexDialog test harness
exists — `getIndexingStatus` is unit-tested directly). **Open upstream:** #33955/#33956 are still OPEN; if their API
shifts before merge, re-reconcile. Remaining Phase 4.2 query bugs (#32341/#32258/#32356/#32343) + #33048 N-gram
tokenizer (needs the seshat 4.2.0 bump under the offline constraint) untouched.

### Recommended next session (as of session 12)
- **#33954 native arm64 build QA** — still the one unverified earlier change (build seshat for `aarch64-apple-darwin`,
  confirm `--cfg aes_armv8`, measure CPU).
- **Phase 4.2 remainder:** the discrete query-correctness bugs (#32341 search URL in All Rooms, #32258 upgraded-room
  pre-upgrade history, #32356 edited messages, #32343 non-stopwords) — investigate which are in-repo vs upstream
  matrix-seshat; and **#33048** N-gram tokenizer for CJK search (#32038) after the seshat 4.2.0 bump.
- **Phase 5:** 5.1 macOS DND/Focus (#32383, needs vetted native module — design/spike); 5.2 Sequoia notification-sound
  stacking (#31996, ⚠️).

---

## Session 13 (2026-06-24) — Phase 4.2 query-correctness bugs (#32341, #32258, #32356) + #32343 triaged upstream (web-only)

Picked up the user's "continue to fix the problems with phases" directive against the Phase 4.2 **remaining** discrete
query bugs. Process: a 4-agent **triage workflow** (each researched the live GitHub issue via firecrawl + mapped the
in-repo code path) → TDD implementation in `apps/web/src/Searching.ts` → an 8-dimension (5 review + per-finding verify,
14 agents) **adversarial review workflow** → applied fixes → re-verify. All changes are **read-path only** (no
`EventIndex.ts`/`onSyncInner`/#33501 breaker/#33957 guard/reconcile touch).

- ✅ **#32341** "Search failed: unable to search URL in All Rooms". Root cause = tantivy's `field:value` grammar: a term
  with a colon (`https://github.com`) is parsed as field `https` → `FieldDoesNotExist`; the in-repo amplifier was
  `combinedSearch()` using `Promise.all`, so the Seshat rejection sank the whole All-Rooms search even though the server
  leg succeeded. Fix: `combinedSearch()` → `Promise.allSettled` (degrade to the surviving leg; throw only if BOTH fail),
  and `hardenSeshatSearchTerm()` phrase-wraps a colon-bearing term for the **Seshat leg only** (the homeserver body keeps
  the raw term). Hardener is closed-phrase-aware (review fix: an unbalanced leading quote is escaped+wrapped, not passed
  through to another tantivy syntax error).
- ✅ **#32258** "Upgraded encrypted room search misses pre-upgrade history". Root cause = local search scoped to one
  `room_id`, never walking the upgrade predecessor chain. Fix: `getRoomSearchChain()` walks `room.findPredecessor()`
  (cycle-guarded, depth-cap 20); the single-room path **partitions the chain by per-room encryption** — encrypted rooms
  via Seshat (`chainSearchProcess` runs a per-room Seshat query and k-way merges by recency; paginated per source via a
  `LOCAL_CHAIN_NEXT_BATCH` sentinel + per-room `next_batch` in `seshatChainQueries`), known non-encrypted predecessors via
  the homeserver (`filter.rooms`), merged into the same source pool (review fix: the original cut routed the **whole**
  chain Seshat-only by the current room's encryption, silently dropping an unencrypted predecessor's history).
- ✅ **#32356** "Search doesn't render edited messages". Root cause = the Seshat match for an edit is the `m.replace`
  event, which `haveRendererForEvent` drops, so the count says 1 but nothing renders. **CRITICAL review finding:** simply
  rewriting the edit's content is discarded — the SDK event mapper does `room.findEventById(event_id)` and **reuses the
  live `m.replace` model** for a loaded room. Fix: **re-key the matched result to its target (original) event id** so the
  mapper resolves the renderable original (which already carries the aggregated edit when loaded) and, when the original
  is not loaded, builds a fresh event from the promoted `m.new_content`. Results are de-duped (edit re-keyed to original
  alongside the original itself → one tile) and an empty `m.new_content` is left untouched (no blank tile). Permalink now
  targets the original (also improves #17097).
- ⬆️ **#32343** "Search misses certain non-stopwords" = **UPSTREAM, document-only**: pure native tantivy tokenizer
  (`SimpleTokenizer`+`LowerCaser`+`RemoveLongFilter` 40-byte drop); no in-repo TS query/tokenization bug. Same family as
  #32038 / PR #33048 (N-gram tokenizer, gated on the matrix-seshat 4.2.0 bump under the offline constraint). A TS-side
  term rewrite would diverge the local Seshat term from the verbatim server term and break `combineResponses` merging.
- **Adversarial review → 7 confirmed findings:** 5 fixed (the #32356 mapper-reuse HIGH; the #32258 mixed-encryption MED;
  the #32341 unbalanced-quote LOW; the #32356 duplicate-tile MED via dedup; the #32356 empty-content LOW via guard), 2
  documented as accepted degradation (the #32341 degraded-leg pagination is latent/sticky — sound because each leg ≤
  SEARCH_LIMIT so the degraded first page never overflows `cachedEvents`). 2 further review findings were verified **not
  real** (multi-room count double-count; non-encrypted server-chain dropping).
- **Verify:** `Searching-test` Jest **27/27** (was 3; +24 incl. chain pagination + mixed-encryption), `RoomSearchView-test`
  + `EventIndex-test` **38/38** (no regression), `tsc` only the 4 pre-existing vendored matrix-js-sdk errors, eslint
  `--max-warnings 0` clean, prettier clean, no i18n changes (fixes log via `logger`, no user-facing strings).
- **Not verifiable here:** real Seshat sqlite round-trip + the actual SDK event-mapper reuse path (the test harness stubs
  `processRoomEventsSearch`, so tests assert on the re-keyed raw objects / captured args) + live macOS render — manual QA.
