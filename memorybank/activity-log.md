# Activity Log

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

### Recommended next session

- **Phase 5.3 (#32288)** only after re-confirming against a live build (may be no-op/wontfix — see above).
- PR-review adopt shortlist (#33954 arm64 AES, #33957 timeline guard — low-effort), or **Phase 3.4** white
  launch flash (#32260) / **Phase 3.2** Cmd-W orphan prompt (#32267).
