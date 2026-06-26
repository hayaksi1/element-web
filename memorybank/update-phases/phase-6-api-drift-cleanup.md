# Phase 6 — API-drift sweep, snapshots, knip, oxfmt normalize, docs

> **Risk: MEDIUM. Goal:** with all conflicts resolved (Phases 4–5), make the merged tree _consistent_ — fix fork-only
> files broken by upstream API removals, regenerate snapshots, satisfy `knip --strict`, run the single oxfmt
> normalization, and update CLAUDE.md. This is the bridge from "merged" to "green".

## 6.1 — `getBrand()` / `global.vectorConfig` removal ripple (decision A)

`#33468` removed both symbols. Beyond the Phase-4 conflict files, **fork-only** files still call `getBrand()` and won't
have shown as conflicts (upstream never touched them):

```bash
git grep -n 'getBrand(' apps/desktop          # expect hits in renderer-recovery.ts (~L11, L213) and any others
git grep -n 'global.vectorConfig' apps/desktop apps/web
```

- `apps/desktop/src/renderer-recovery.ts` (L11 import, L213 use) → switch to `import { getConfig }` + `getConfig().brand`.
- Re-check `tray.ts`/`updater.ts`/`store.ts` (Phase 4 should have handled these — verify the `updater.ts` 3rd site).
- `@types/global.d.ts`: upstream deleted `var vectorConfig`/`IConfigOptions`. The fork modified `@types/global.d.ts`
  (it's in C-only) — confirm the merged version doesn't re-introduce them and the fork's own additions survive.
  **Gate:** `git grep -n 'global.vectorConfig\|getBrand(' apps/desktop apps/web` returns only intentional lines (ideally none).

## 6.2 — Snapshot regeneration (compound-web 9.7.0 + upstream markup)

compound-web 9.6→9.7 changes markup (`aria-disabled`) + rebuilds CSS-module hashes (`cpd-*`). Fork-owned snapshots will
go red mechanically:

- `apps/web/test/unit-tests/components/structures/__snapshots__/RoomView-test.tsx.snap`
- `apps/web/test/unit-tests/components/views/rooms/RoomHeader/__snapshots__/RoomHeader-test.tsx.snap`
- `apps/web/test/unit-tests/components/structures/__snapshots__/FilePanel-test.tsx.snap`
- `apps/web/test/unit-tests/components/views/settings/tabs/user/__snapshots__/PreferencesUserSettingsTab-test.tsx.snap`

```bash
pnpm -C apps/web test:unit -u    # regenerate; then EYEBALL the diff — only aria-disabled / cpd-hash churn is expected
```

⚠️ Distinguish **mechanical churn** (accept) from a **real regression** (investigate). If a snapshot loses a fork search
element, that's a bug, not churn.

## 6.3 — knip --strict (`#33893`)

The fork's new exports must be reachable from a knip entry root or knip --strict fails the lint gate.

```bash
pnpm lint:knip 2>&1 | tee /tmp/knip.out    # enumerate REAL failures (don't guess)
```

Likely fixes:

- `packages/shared-components/src/index.ts` must re-export the `SearchMatchNavigation` barrel (knip entry = `src/index.ts`).
- Each new `apps/web/src` module (`SearchSessionStore`, `FileCategory`, `scrollBehavior`, `jumpToDate`,
  `viewmodels/search/*`, `RoomSearch*`, `SearchMatchStepPayload`, `InRoomSearchNudgeToast`) must be imported from a real
  entry-reachable site, not only its `*-test`.
- The 13 new `apps/desktop/src/*` helpers must be imported by the main-process graph (they are, via `electron-main.ts`)
  — confirm none is test-only.
- Last resort only: add a `knip.ts` ignore entry (note it in the PR).
  Also apply the **`#33948` languageHandler import-path update** to fork files that import `languageHandler` if the public
  surface moved: `git grep -n "from .*languageHandler" apps/web/src` → repoint to `apps/web/src/i18n/*` where #33948 split it.

## 6.4 — raw-loader (`#33854`) — verify only

The fork never imported `raw-loader` (grep-verified), so `#33854` (raw-loader → `?raw`) ports cleanly via the U-only
files (`HtmlExport.tsx`, `exportCSS.ts`, jest/webpack config). Just confirm no stale `!!raw-loader!` remains:
`git grep -n 'raw-loader' apps/web` → expect none in fork files.

## 6.5 — oxfmt normalize (ONE pass, as its own commit)

```bash
pnpm install                 # ensure oxfmt ^0.54.0 is present
pnpm lint:fmt-fix            # = oxfmt; reformats the whole tree (incl. fork files)
git add -A && git commit -m "chore(sync): oxfmt normalize after upstream merge"
```

- Config is byte-identical to the old prettier → expect only a **handful** of fork files to change (edge-case
  `quoteProps: consistent` quoting). Keep this as an isolated commit so it's reviewable.
- ⚠️ oxfmt 0.54.0 is early — run `pnpm lint:fmt` (`oxfmt --check`) first to catch any parser failure on heavy-JSX
  `RoomSearch*.tsx` before committing.

## 6.6 — Update CLAUDE.md (the prettier command no longer exists)

- §4 Lint & Test Protocol: `pnpm lint:prettier-fix` → **`pnpm lint:fmt-fix`** (oxfmt). Keep `pnpm lint` / `pnpm test:unit`.
- Optionally note the matrix-js-sdk pin decision and oxfmt adoption in the project rules so future sessions don't run
  the dead prettier command.

## Verification gate (Phase 6 done when)

- No `getBrand()`/`global.vectorConfig` references remain (6.1).
- `pnpm lint:knip` passes (6.3); `pnpm lint:fmt` clean (6.5).
- Snapshots regenerated and the diff is verified as churn-only (6.2).
- CLAUDE.md updated (6.6).
