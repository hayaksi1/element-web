# Phase 3 — Run the grafted merge; adopt the bulk (366 U-only + 19 auto-merges)

> **Risk: MEDIUM. Goal:** execute the 3-way merge so git brings in the 366 upstream-only files and auto-resolves the 19
> non-conflicting overlaps, leaving exactly the 10 hand-conflicts for Phases 4–5. This is where the bulk of upstream
> lands. Read Phases 1–2 first; the graft + integration branch + dep decisions must be in place.

## 3.1 — Start the merge (no auto-commit)

```bash
git switch upstream-sync
git merge --no-commit --no-ff upstream/develop
git status --short | grep -E '^(UU|AA|DU|UD|DD|AU|UA) ' | sort   # the conflicted files
```

Expect the **10 conflicts** from the master plan; everything else is staged (`M`/`A`/`D`) as the merge result.

### Immediately override the lockfile (Phase 2.1)

A text-merged `pnpm-lock.yaml` is invalid even though git auto-merged it. Force upstream's, then regenerate:

```bash
git checkout upstream/develop -- pnpm-lock.yaml pnpm-workspace.yaml
# re-apply fork removals to pnpm-workspace.yaml (delete @types/auto-launch patchedDependencies entry + comment)
rm -f patches/@types__auto-launch.patch
# (apps/desktop/package.json dep removals are applied in Phase 4)
# defer `pnpm install` until after Phase 4 so all package.json deltas are in before one regen
```

## 3.2 — The 19 auto-merged overlaps: REVIEW (git's text-merge ≠ semantic correctness)

These were touched by both sides but git merged them without a conflict marker. Most are genuinely fine, but **review
each** (don't blind-trust). Grouped by who owns the deeper review:

| File                                                     | Why it auto-merged                                                            | Review / owning phase                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------- |
| `apps/web/src/components/structures/RoomView.tsx`        | upstream −10 dead props in fork-untouched regions; fork +533 elsewhere        | **Phase 5** — confirm the 6 dead-prop deletions landed AND all search code intact |
| `apps/web/src/components/views/rooms/EventTile.tsx`      | upstream −1 `layout` prop; fork +7 `isSearchHighlightMatch`                   | Phase 5 — quick check                                                             |
| `apps/web/src/components/structures/LoggedInView.tsx`    | upstream −4 dead IProps; fork +5 nudge                                        | Phase 5 — quick check                                                             |
| `apps/web/.../RoomHeader/RoomHeader.tsx`                 | upstream fragment-unwrap (whitespace); fork +16 search button                 | Phase 5 — confirm search IconButton renders                                       |
| `apps/web/.../rooms/RoomSublist.tsx`                     | upstream fragment removal; fork +3 reduced-motion                             | Phase 5 — smoke                                                                   |
| `apps/web/src/settings/Settings.tsx`                     | disjoint (upstream type rename + JSX tidy; fork +37 search/desktop settings)  | Phase 5 — confirm import block keeps `IS_ELECTRON` + `ReorderableSection`         |
| `apps/web/.../PreferencesUserSettingsTab.tsx`            | disjoint (upstream IProps→EmptyObject; fork +1 toggle)                        | Phase 5                                                                           |
| `apps/web/src/i18n/strings/en_EN.json`                   | key-disjoint (upstream −15 dead keys; fork +30 search keys)                   | Phase 5 — confirm no fork key reverted                                            |
| `packages/shared-components/src/i18n/strings/en_EN.json` | key-disjoint (upstream +DnD/announce; fork +`room                             | search`)                                                                          | Phase 5 |
| `apps/web/res/css/_components.pcss`                      | import-line disjoint (upstream −2; fork +3)                                   | Phase 5 — confirm 3 fork `.pcss` exist                                            |
| `apps/web/test/test-utils/room.ts`                       | upstream import rename; fork +`searchHeaderActive`                            | Phase 5                                                                           |
| `apps/web/test/unit-tests/Notifier-test.ts`              | disjoint (upstream import rename + `mocked()`; fork +110 throttle tests)      | Phase 5 — keep #31996 suite                                                       |
| `apps/web/tsconfig.json`                                 | disjoint (upstream +paths; fork +`noEmit`)                                    | Phase 5                                                                           |
| `apps/desktop/src/preload.cts`                           | disjoint (upstream `IConfigOptions`→`ConfigOptions`; fork +`setThemeColor`)   | **Phase 4**                                                                       |
| `apps/desktop/src/store.ts`                              | disjoint (upstream `export enum Mode` + brand sites; fork +131 seshat/pickle) | **Phase 4** — brand-site decision                                                 |
| `apps/desktop/src/tray.ts`                               | disjoint (upstream getBrand→getConfig; fork +quitHandler)                     | **Phase 4**                                                                       |
| `apps/desktop/src/updater.ts`                            | disjoint (upstream 2 brand sites; fork +55 incl. a 3rd getBrand site)         | **Phase 4** — convert all 3 sites                                                 |
| `apps/desktop/src/vectormenu.ts`                         | disjoint (upstream Help getConfig; fork +onQuit)                              | **Phase 4**                                                                       |
| `apps/desktop/package.json`                              | disjoint (upstream bumps; fork −3 deps)                                       | **Phase 4**                                                                       |

> Practical method to review an auto-merge: `git diff upstream/develop...HEAD -- <file>` shows the merged result vs each
> side, or inspect the staged blob: `git show :<file>`. For the desktop ones, defer to Phase 4 (the brand-accessor
> decision flips several of them).

## 3.3 — The 366 U-only files: spot-verify, don't read all

They're guaranteed-correct take-theirs (fork == base there). The only risk is an upstream file referencing a fork-changed
API. That surfaces as a **tsc error** at Phase 7, not now. Optionally sanity-check the headline upstream features landed:

```bash
git show :apps/web/src/stores/room-list-v3/RoomListStoreV3.ts >/dev/null 2>&1 && echo "room-list DnD present"
ls apps/web/src/i18n/ 2>/dev/null      # languageHandler split (#33948) → new i18n/ modules present
ls apps/desktop/src/args.ts 2>/dev/null # #33827 deeplinks introduced args.ts
```

## 3.4 — Resumability checkpoint

At this point the working tree is **mid-merge** with 10 conflicts. This state persists on disk between sessions. You can:

- continue to Phase 4 now, or
- stop — next session re-opens with `git status` showing the same 10 conflicts.
  **Do not `git commit` until Phases 4–5 resolve all conflicts and Phase 7 is green.**

### Discrete-commit fallback (if you prefer per-phase commits over one merge commit)

Instead of one `git merge`, abort it (`git merge --abort`) and stage groups manually on `upstream-sync`:

```bash
# take-theirs for the 366 U-only files (list in scratchpad/U_only.txt)
git checkout upstream/develop -- $(cat scratchpad/U_only.txt)
git commit -m "chore(sync): adopt 366 upstream-only files (v1.12.22→develop)"
# then per-file 3-way for overlaps using: git merge-file -p <ours> <base> <theirs>
```

This yields cleaner history but more manual bookkeeping. The single-merge path (3.1) is recommended for correctness.

## Verification gate (Phase 3 done when)

- `git status` shows exactly the 10 expected conflicts; all other 385 files staged.
- `pnpm-lock.yaml`/`pnpm-workspace.yaml` overridden to upstream + fork removals re-applied (regen deferred to Phase 4).
- The 19 auto-merge reviews are queued to Phases 4/5 (not yet hand-edited).
