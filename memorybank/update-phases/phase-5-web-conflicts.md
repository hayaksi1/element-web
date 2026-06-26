# Phase 5 — Web conflicts + auto-merge review (all LOW risk)

> **Risk: LOW. Goal:** resolve the 2 web-side conflicts and *verify* (not re-merge) the ~13 web auto-merges so every
> search feature is provably intact. Upstream's web changes in this delta are almost entirely the **#33946 Sonar
> dead-code tidy** (deletes unused props/fragments in regions the fork never touched) plus the **#33948 languageHandler
> split** and the **#33898 test relocation**. **No search logic conflicts.**

## 5.1 — `DateSeparatorViewModel.tsx` (CONFLICT — mechanical import; #33948)
Upstream splits one import line:
`import { _t, getUserLanguage } from "../../../languageHandler";` →
`import { _t } from "../../../languageHandler";` + `import { getUserLanguage } from "../../../i18n/settings";`.
The fork **gutted** this VM (−126: pickDate now delegates to `jumpToDateInRoom` from `utils/jumpToDate.tsx`) and removed
the context lines anchoring upstream's hunk → git conflicts in the import block.
**Resolve:** in the fork's slimmed import block, change the kept line to `import { _t } from "../../../languageHandler";`
and add `import { getUserLanguage } from "../../../i18n/settings";` (still used at L102 `new Intl.RelativeTimeFormat(
getUserLanguage(), …)`). Keep 100% of the fork's gutting/delegation. `apps/web/src/i18n/settings.ts` arrives via the
merge (new upstream file). Behavior identical — only the import *source* changes.
**Test:** `apps/web/test/viewmodels/timeline/DateSeparatorViewModel-test.tsx` untouched by both → run, expect green.

## 5.2 — `indexing/EventIndex` test relocation (CONFLICT — #33898 jest→vitest)
Upstream relocated `apps/web/test/unit-tests/indexing/EventIndex-test.ts` → `apps/web/src/indexing/EventIndex.test.ts`
(vitest, colocated). The fork modified the **old jest path**. Two files surfaced:
- **`apps/web/src/indexing/EventIndex.test.ts`** (content conflict at the new path): adopt upstream's relocated vitest
  file as the base, then re-apply the fork's test additions (the fork's `EventIndex-test.ts` changes — Seshat
  resilience: indexingErrored breaker, reconciliation, timeline-reset guard). Convert `jest.*` → `vi.*` for the ported
  additions (the file now runs under vitest at the `src/**/*.test.ts` location). Verify the fork's specific assertions
  survive.
  - *Alternative if conversion is risky:* keep the fork's jest test at the **old** path
    `apps/web/test/unit-tests/indexing/EventIndex-test.ts` (re-add it) so it keeps running under jest unchanged, and let
    upstream's colocated copy coexist. Simpler but duplicates coverage — prefer the convert-and-relocate path for a clean PR.
- **`apps/web/test/unit-tests/indexing/EventIndexPeg-test.ts`** (dir-rename **FALSE POSITIVE**): upstream did NOT migrate
  this one (not in the 16 relocated). git's directory-rename heuristic over-fired. **Resolve by keeping the fork's file
  at its original path** (`git add` the fork version at `test/unit-tests/indexing/EventIndexPeg-test.ts`); do not move it.

## 5.3 — Auto-merge VERIFY list (git merged cleanly; confirm features, don't re-edit unless wrong)
For each: `git show :<file>` (the staged merge result) and confirm the fork feature + the upstream intent both present.

| File | Confirm |
|---|---|
| `RoomView.tsx` | 6 dead-prop deletions landed (`mainSplitContentType` ×4, `promptRejectionOptions` ×2) **and** all search code intact (stepping, k-of-N, SearchSessionStore wiring, results-list anchor, header button). Run `RoomView-test.tsx` + `SearchSessionStore-test.ts`. |
| `EventTile.tsx` | `isSearchHighlightMatch` prop (~L191) + snapshot field (~L909) present; upstream's `layout` prop removed from ReplyChain. |
| `LoggedInView.tsx` | `showInRoomSearchNudgeIfNeeded` import+call present; upstream's `config`/`autoJoin` IProps + `pageType` removed. (Cross-file: MatrixChat.tsx pass-down removal is upstream's same commit — confirm it merged.) |
| `RoomHeader/RoomHeader.tsx` | header **search IconButton** (fires `Action.FocusMessageSearch`) renders left of call buttons; upstream fragment-unwrap kept. Keep fork test at L220 + the `.snap` delta. |
| `RoomSublist.tsx` | `getScrollBehavior()` reduced-motion calls present; `scrollBehavior.ts` exists. |
| `Settings.tsx` | import block has **both** `IS_ELECTRON` (fork) and `ReorderableSection` (upstream rename); fork settings present: `ctrlFForSearch` default `!!IS_ELECTRON`, `ctrlFForSearchNudgeShown`, `feature_jump_to_date` `!!IS_ELECTRON`, `tokenizerMode`, `Accessibility.disableSmoothScrolling`, `Electron.warnBeforeExit` `!IS_MAC`. Confirm `RoomList.OrderedCustomSections` type is `ReorderableSection[]`. |
| `PreferencesUserSettingsTab.tsx` | fork's `Accessibility.disableSmoothScrolling` array entry present; upstream `IProps`→`EmptyObject`. |
| `i18n/strings/en_EN.json` (web) | all ~30 fork search/files keys present; upstream's 15 dead keys (`encryption|udd`, 6 `widget|context_menu`) removed; **no fork key reverted** to upstream's old `doneRooms` form. Run i18n lint. |
| `shared-components/.../en_EN.json` | fork `room|search` block (match_position/next/previous) present; upstream `release_announcement` + `room_list|a11y|drag_*` added; `toggle_unread` reworded. |
| `_components.pcss` | 3 fork `@import`s present (`_RoomFilesView`, `_RoomSearchHeader`, `_RoomSearchResults`); upstream's 2 removed imports gone; the 3 fork `.pcss` files exist. |
| `test-utils/room.ts` | `searchHeaderActive: false` default kept; upstream `jest-mock-vitest-adapter` import rename applied. |
| `Notifier-test.ts` | **keep the +110 #31996 macOS wake-throttle suite** (5 tests, jest.* — do NOT convert to vi.*); upstream import rename + `mocked()` wrap applied. Still runs under jest. |
| `tsconfig.json` | fork `noEmit: true` kept; upstream's 2 `paths` entries (`test-utils-rtl`, `jest-mock-vitest-adapter`) added. |

> Cross-file dependency to confirm staged from the merge: upstream's new `apps/web/test/setup/adapter.ts`,
> `apps/web/src/i18n/*` (languageHandler split incl. `settings.ts`), and the deleted
> `UntrustedDeviceDialog.*`/`RoomCallBanner.*` (their en_EN/css removals depend on the deletions). The fork's
> `RoomSearchView.tsx`/`RoomSearchHeader.tsx` import `languageHandler` — Phase 6 updates those import paths to the new
> `i18n/*` entry points if `#33948` changed the public surface.

## 5.4 — Stage the web cluster
`git add` `DateSeparatorViewModel.tsx`, `src/indexing/EventIndex.test.ts`,
`test/unit-tests/indexing/EventIndexPeg-test.ts`, and any auto-merge files you had to correct.

## Verification gate (Phase 5 done when)
- `git status` shows **zero remaining conflicts** (all 10 resolved). The merge can now be committed once Phase 6/7 pass.
- Search test suites green under jest: `pnpm -C apps/web test:unit -- RoomView SearchSessionStore Searching RoomSearch
  DateSeparatorViewModel EventIndex EventIndexPeg Notifier` (adjust to the runner's filter syntax).
- i18n lint passes (`pnpm -C apps/web run i18n:lint` or repo equivalent) — no orphaned keys.
