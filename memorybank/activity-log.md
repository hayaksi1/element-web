# Activity Log

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
Phase 0.2 circuit-breaker (3d5ce8b, #33501 = error-*dialog* flood). Verified: `onSync` auto-merges
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
  *"fix(desktop): macOS data-loss & start-at-login fixes (Phase 0.1, 2.1)"* and pushed to `origin/main`
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
  named** — it handles authenticated media *download* URLs (rewrites `/media/v3/` → `/client/v1/media/`, adds
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
