# Phase 7.4 — PR Partition Analysis (search vs desktop vs private)

> **STATUS: analysis complete, branch-building DEFERRED.** The fork's `origin` is a private Gitea, not
> GitHub, so no upstream PR can be opened yet (user decision, session 37). This doc is the actionable
> categorization to derive the PR branches **when GitHub is connected**. Decisions locked: **two PRs**
> (search UX + macOS desktop), local branches only, no push.

## Method (ground truth)

The fork was merged into `upstream/develop` at `29d823f`, so **`git diff upstream/develop HEAD` IS the PR
surface** — the 366 U-only upstream files don't appear (HEAD == develop there); only the fork's net
changes remain. Total: **156 code files** + 35 non-code (docs/private/lock).

Branch base is **`3294bcc`** (the source-drop root, byte-identical tree to `v1.12.22`), NOT the `v1.12.22`
tag — the Phase-7.5 graft removal severed `v1.12.22` as a git-ancestor. So the plan's
`git rebase --onto upstream/develop v1.12.22 …` must read **`… 3294bcc …`**. (Recommended derivation is
snapshot-per-feature, not replay — see bottom.)

## EXCLUDE from every PR (private / docs / vendor)

- `CLAUDE.md`, `.claude/**`
- `memorybank/**` (27 files), `scratchpad/**` (3 build scripts)
- `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.gitignore` — regenerate/derive per branch, never hand-carry
- **Private feature — do NOT upstream:** `8737ed4` "bake config.json into local macOS build" + the
  committed `apps/web/config.json` (white-label/offline config baking; MDM precedence). This is the fork's
  private superset, not an element-hq contribution.

## SEARCH PR — in-room search UX (Telegram-parity)

`packages/shared-components/`:
- `src/room/search/SearchMatchNavigation/{SearchMatchNavigation.tsx,.module.css,.test.tsx,index.ts}`
- `src/index.ts` (export the new component), `src/room/timeline/DateSeparatorView/index.ts`

`apps/web/src/`:
- Core: `Searching.ts`, `stores/SearchSessionStore.ts`, `contexts/RoomContext.ts`,
  `stores/right-panel/RightPanelStore.ts`, `dispatcher/actions.ts`,
  `dispatcher/payloads/SearchMatchStepPayload.ts`
- Components: `components/structures/{RoomView,RoomSearchView,FilePanel,MessagePanel,TimelinePanel,RightPanel,LoggedInView}.tsx`,
  `components/views/rooms/{RoomSearchHeader,RoomSearchResults,EventTile,RoomHeader/RoomHeader}.tsx`,
  `components/views/right_panel/{RoomSearchJumpToDate,RoomSearchOrderToggle,RoomSearchSenderFilter,RoomFilesView,RoomSummaryCardView}.tsx`,
  `components/viewmodels/right_panel/RoomSummaryCardViewModel.tsx`,
  `components/views/elements/SearchWarning.tsx`
- ViewModels: `viewmodels/search/{RoomSearchNavigationViewModel,RoomSearchSenderFilterViewModel}.ts`,
  `viewmodels/right_panel/RoomFilesViewModel.ts`,
  `viewmodels/room/timeline/{DateSeparatorViewModel.tsx,event-tile/EventTileViewModel.ts,event-tile/EventTileDerivedState.ts}`
- Utils/toasts: `utils/{FileCategory,jumpToDate.tsx,scrollBehavior?}`, `toasts/InRoomSearchNudgeToast.ts`
  (note: `scrollBehavior.ts` is DESKTOP — see below)
- CSS: `res/css/_components.pcss`, `res/css/views/rooms/{_RoomSearchHeader,_RoomSearchResults,_EventTile,_EventBubbleTile}.pcss`,
  `res/css/views/right_panel/{_RoomFilesView,_RoomSummaryCard}.pcss`
- Settings registration for Cmd+F-default / jump-to-date / relevance-order — see cross-bucket `Settings.tsx`
- **Deletion:** `RoomSearchAuxPanel.tsx` + its test + `_RoomSearchAuxPanel.pcss` + `_components.pcss` import
  + `knip.ts` entry + `timeline.spec.ts:807` (DONE on `upstream-sync`, session 37). The search PR removes
  upstream's `RoomSearchAuxPanel` because the new top-bar search supersedes it.
- All matching `apps/web/test/unit-tests/**` + `__snapshots__` for the above (RoomView, RoomSearchView,
  RoomSearchHeader, RoomSearchResults, FilePanel, RoomFilesView, jumpToDate, SearchSessionStore, etc.)

Maps to open issues: **#22888, #24359** (Cmd+F default-on), **#27876, #21640** (in-room search UX).

## DESKTOP PR — macOS remediation + Seshat backend

`apps/desktop/**` — all 49 files (config de-global #33468 already reconciled, deeplinks #33827, quit UX,
window-state, media perms, save-image, renderer-recovery, tray, updater, seshat AES #33954, n-gram
seshat-config/seshat-index, store/ipc pickle-key guard, auto-launch native loginItem, …) + their `.test.ts`.

`patches/@types__auto-launch.patch` — pnpm patch backing the `auto-launch.ts` rewrite (`25cd00a`). DESKTOP.

`apps/web/src/` web-side pieces that map to macOS/Seshat issues (NOT search):
- Seshat indexing backend: `indexing/{EventIndex.ts,EventIndex.test.ts,EventIndexPeg.ts,BaseEventIndexManager.ts}`,
  `vector/platform/SeshatIndexManager.ts`, `async-components/views/dialogs/eventindex/ManageEventIndexDialog.tsx`
  (+ `test/unit-tests/indexing/EventIndexPeg-test.ts`, `…/vector/platform/SeshatIndexManager-test.ts`)
- `Notifier.ts` (+test) — notif-sound throttle (#31996), commit `8ca1cfb`
- `utils/scrollBehavior.ts` (+test), `components/views/settings/tabs/user/SessionManagerTab.tsx`,
  `components/views/rooms/RoomSublist.tsx`, `components/views/settings/tabs/user/PreferencesUserSettingsTab.tsx`
  (+snap) — smooth-scrolling (#32315), commit `81096b8`
- `theme.ts` (+test), `@types/global.d.ts` — theme-colour paint / white-flash (#32260), commit `1e06fa8`
- `utils/StorageManager.ts` (+test) — storage durability (#32198), commit `01e11ec`

Maps to issues (per `upstream-pr-review.md`): #33954 (AES), #33957 (timeline-reset), #32119/#32266/#32011
(seshat backfill), #33048/#32038 (n-gram), #32373 (mic/cam), #32287 (quit), #32267 (⌘W), #32228/#32360
(window), #32260 (flash), #32222 (renderer), #32362 (save-image), #32018 (titlebar), #32315 (scroll),
#33501 (seshat dialog), plus the newly-adopted upstream #33827 (deeplinks) already on develop.

## CROSS-BUCKET — must be split by hand (cannot `git checkout` whole-file into one branch)

| File | Why | How to split |
| --- | --- | --- |
| `apps/web/src/settings/Settings.tsx` | registers settings for BOTH (Cmd+F-default, jump-to-date, relevance — search; n-gram tokenizer, smooth-scroll — desktop) | copy only the search setting blocks into the search branch; the seshat/scroll blocks into desktop |
| `apps/web/src/i18n/strings/en_EN.json` | both features add keys (`room\|search\|*` vs seshat/quit/perm strings) | take only each feature's added keys per branch; keep alphabetical sort; run `i18n:sort` |
| `apps/web/package.json`, `apps/web/tsconfig.json`, `packages/shared-components/tsconfig.json` | dep/path changes — search added the shared-components search export + compound usage; desktop added seshat types | include only the deps each branch's code imports |
| `packages/shared-components/src/i18n/strings/en_EN.json` | search-only in practice (SearchMatchNavigation strings) → **search** unless a desktop string snuck in (verify) |

## Derivation recipe (when GitHub is connected)

Recommended = **snapshot-per-feature** (clean diff, not 24 noisy replay commits incl. self-fixes):

```bash
git switch -c pr/search-ux upstream/develop
git checkout HEAD -- <SEARCH file list above>          # reconciled-against-develop versions
# hand-edit the cross-bucket files: keep ONLY search keys/settings/deps
git rm apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx …   # the supersession
pnpm install && pnpm lint && pnpm test:unit && pnpm -C apps/web test:vitest
git commit -m "feat(web): Telegram-style in-room search (stepping, all-rooms, filters, media tabs)"
# repeat for pr/macos-desktop with the DESKTOP file list
```

Because HEAD's code is already reconciled with develop (it lives in the merged tree), `git checkout HEAD --`
of a feature's files onto a develop branch compiles — the merge already cleared API drift. Validate each
branch independently; confirm `git diff upstream/develop pr/<branch>` is feature-only with zero private noise.
Split further into per-issue PRs later if element-hq asks (the issue mapping above is the seam).
