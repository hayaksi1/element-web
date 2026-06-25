# Search Phase 2 — In-timeline match stepping + "k of N" + live highlight — Implementation Plan

> **For agentic workers:** implement task-by-task, TDD (RED → GREEN), commit per slice.
> Authored 2026-06-25 (session 17). Decisions locked: ⌘F default-on (Phase 1, shipped); Phase 2 **complements**
> the `RoomSearchView` list (keep it); arrows **drive the LIVE timeline** (user choice, this session).

**Goal:** Step through in-room search matches in the **live conversation** with up/down arrows + a "k of N"
counter in the search header, reusing the existing `ViewRoom → TimelinePanel.loadTimeline → MessagePanel`
jump+highlight+back-pagination machinery.

**Architecture:** A new MVVM-v2 `RoomSearchNavigationViewModel` (apps/web) owns the match cursor and, on
next/prev, invokes an injected `onActivateMatch` callback. A dumb `SearchMatchNavigation` View
(packages/shared-components) renders the counter + two Compound `IconButton` arrows. `RoomView` owns the
integration: it extracts an ordered match list from `ISearchResults`, feeds it to the VM, and on activation
switches the body to the **live timeline** (Room render mode) while **keeping the search header** (decoupling
"search header visible" from `timelineRenderingType`). The results LIST (`RoomSearchView`) stays as the
initial Search-mode view — complement, not replace.

**Tech Stack:** React, TypeScript (strict, 4-space, 120-col), `@vector-im/compound-web`, BaseViewModel/Snapshot,
Jest (web) with the `transformIgnorePatterns` matrix-js-sdk workaround.

## Global Constraints
- MVVM v2: ViewModel in `apps/web/src/viewmodels/`, dumb View in `packages/shared-components/`, `useViewModel`.
- Offline-only; Compound design system; named exports; tests with every change.
- Do NOT regress the existing Search-mode results list (`RoomSearchView`) or `onCancelSearchClick`.
- Reuse the existing live-timeline jump path: `dispatch(Action.ViewRoom {room_id, event_id, highlighted:true,
  scroll_into_view:true})`. Do not build new back-pagination.

---

## Current reality (verified this session)
- `SearchInfo` (Searching.ts:1065-1102): `searchId, roomId, term, scope, promise, abortController, inProgress,
  count, error`. No cursor.
- `RoomView.onSearch` (1797-1816) sets `timelineRenderingType=Search` + `search`. `onSearchUpdate` (1822-1831)
  merges `count`. `onCancelSearchClick` (1957-1967) clears both.
- Header `RoomSearchAuxPanel` mounted when `timelineRenderingType===Search` (2437-2446); shows `searchInfo.count`.
- Body: `RoomSearchView` list when `state.search` (2545-2557), `hideMessagePanel=true`.
- Live-timeline jump+highlight already works via `Action.ViewRoom {event_id, highlighted, scroll_into_view}` →
  `RoomViewStore` → `TimelinePanel` (`eventId`/`highlightedEventId`) → `loadTimeline` (TimelineWindow
  back-paginates) → `MessagePanel` (`isSelectedEvent`). Same path as reply-jump/permalink; works for E2EE rooms.
- Each `ISearchResults.results[i].context.getEvent()` → `MatrixEvent` exposing `getId()` + `getRoomId()`.

---

## Slice 1 — Live-timeline match stepping foundation — ✅ DONE (session 17, uncommitted)

**Shipped:** all 6 tasks below, TDD + adversarial-reviewed + verified (105 web Jest, 5+7 package vitest, tsc/eslint/
prettier clean). **Documented limitations carried to slice 2** (deliberate, not bugs): stepper enabled only for
**completed, single-room** searches; pagination pauses while stepping (covers the loaded result page); composer/
status-bar stay in search-mode chrome during stepping; a permalink click mid-stepping doesn't auto-exit search (use
✕); no `.stories.tsx` yet (storybook visual-regression baselines are CI-docker-only — add when touching CI).



Delivers: counter + up/down arrows in the header; pressing an arrow jumps the live conversation to the
next/prev match (highlighted), with the search header persisting so stepping continues. Results list kept.

### Task 1 — `SearchMatch` type + `extractSearchMatches` + `SearchInfo` cursor fields
**Files:**
- Modify: `apps/web/src/Searching.ts` (add type, helper, extend `SearchInfo`)
- Test: `apps/web/test/unit-tests/Searching-test.ts` (add `describe("extractSearchMatches")`)

**Produces:**
- `export interface SearchMatch { roomId: string; eventId: string; }`
- `export function extractSearchMatches(results: ISearchResults): SearchMatch[]` — iterates
  `results.results`, pushes `{roomId, eventId}` from `context.getEvent()`; skips events missing id/roomId;
  preserves `results.results` order (newest-first).
- `SearchInfo.matches?: SearchMatch[]` + `SearchInfo.currentMatchIndex?: number` (-1/undefined = none active).

- [ ] Write failing test: results with 2 events → 2 matches in order; event missing id skipped; empty → [].
- [ ] Run → FAIL (extractSearchMatches not defined).
- [ ] Implement helper + types.
- [ ] Run → PASS. Commit folded into slice.

### Task 2 — `RoomSearchNavigationViewModel` (cursor + actions)
**Files:**
- Create: `apps/web/src/viewmodels/search/RoomSearchNavigationViewModel.ts`
- Test: `apps/web/test/unit-tests/viewmodels/search/RoomSearchNavigationViewModel-test.ts`

**Interfaces — Produces:**
```ts
export interface RoomSearchNavigationSnapshot {
    current: number;      // 1-based position of focused match, 0 if none active
    total: number;        // matches.length
    canPrevious: boolean; // index > 0
    canNext: boolean;     // index < total-1
}
export interface RoomSearchNavigationProps {
    onActivateMatch(match: SearchMatch, index: number): void;
}
export class RoomSearchNavigationViewModel
    extends BaseViewModel<RoomSearchNavigationSnapshot, RoomSearchNavigationProps> {
    public constructor(props: RoomSearchNavigationProps);
    public setMatches(matches: SearchMatch[]): void; // resets index to -1, updates snapshot, no activation
    public readonly next: () => void;       // clamp index+1, snapshot, onActivateMatch(match,index)
    public readonly previous: () => void;   // clamp index-1, snapshot, onActivateMatch(match,index)
}
```
Behaviour: `current = index < 0 ? 0 : index+1`. `next()` from index -1 → 0 (first activation). No-op (no
activation) when clamped at an end. `setMatches([])` → total 0, both arrows disabled.

- [ ] RED tests: initial snapshot (0/0, both false); setMatches(3) → 0/3, canNext true canPrevious false;
  next from -1 activates index 0, snapshot 1/3; next×2 → 3/3 canNext false; next at end → no extra
  onActivateMatch call; previous symmetric; setMatches resets index.
- [ ] Implement extending BaseViewModel; arrow-fn actions; `this.snapshot.set(...)`; call `this.props.onActivateMatch`.
- [ ] GREEN.

### Task 3 — `SearchMatchNavigation` dumb View
**Files:**
- Create: `packages/shared-components/src/room/search/SearchMatchNavigation/SearchMatchNavigation.tsx`
- Test: `packages/shared-components/src/room/search/SearchMatchNavigation/SearchMatchNavigation.test.tsx`
- Modify: `packages/shared-components/src/index.ts` (export the View + its snapshot/actions/VM types)

**Interfaces — Consumes:** `RoomSearchNavigationSnapshot` (re-declared in the package as
`SearchMatchNavigationViewSnapshot`) + actions `next`/`previous` via a `ViewModel<Snapshot, Actions>` `vm` prop.
**Produces:** `export function SearchMatchNavigation({ vm }): ReactElement` — renders
`{current} / {total}` (Compound text) and two `IconButton`s (chevron-up = previous, chevron-down = next),
disabled per `canPrevious`/`canNext`, `aria-label` "Previous match"/"Next match". Hidden (renders null) when
`total === 0`.

- [ ] RED test: render with MockViewModel snapshot {current:2,total:5,canPrevious:true,canNext:true} → shows
  "2 / 5", both buttons enabled; click up → `previous` called; click down → `next` called; total 0 → renders nothing;
  canNext false → next button disabled.
- [ ] Implement using Compound `IconButton` + chevron icons; `useViewModel(vm)`.
- [ ] GREEN.

### Task 4 — Wire into `RoomSearchAuxPanel` header
**Files:**
- Modify: `apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx` (accept + render `navigationVm`)
- Test: `apps/web/test/unit-tests/components/views/rooms/RoomSearchAuxPanel-test.tsx` (extend/create)

**Consumes:** the View from Task 3 + a `RoomSearchNavigationViewModel` instance via new optional prop
`navigationVm?: ViewModel<RoomSearchNavigationSnapshot, …>`.
- [ ] RED test: pass a mock nav VM with total>0 → counter + arrows render in the summary; no VM → unchanged.
- [ ] Implement: render `<SearchMatchNavigation vm={navigationVm} />` beside the count when provided.
- [ ] GREEN.

### Task 5 — `RoomView` integration (the decoupling + activation)
**Files:**
- Modify: `apps/web/src/components/structures/RoomView.tsx`
- Test: extend `apps/web/test/unit-tests/components/structures/RoomView-test.tsx` where feasible.

Changes:
1. Construct `this.searchNavVm = new RoomSearchNavigationViewModel({ onActivateMatch: this.onActivateSearchMatch })`
   (lazily on first search; dispose in `componentWillUnmount`).
2. `onSearchUpdate`: when `searchResults` present, `this.searchNavVm.setMatches(extractSearchMatches(searchResults))`
   and store `matches` on `state.search`.
3. `onActivateSearchMatch = (match, index) => { setState({ timelineRenderingType: Room,
   search: {...search, currentMatchIndex: index} }); dispatch(ViewRoom {room_id: match.roomId,
   event_id: match.eventId, highlighted: true, scroll_into_view: true, metricsTrigger: undefined}); }`.
4. Header: mount `RoomSearchAuxPanel` (with `navigationVm={this.searchNavVm}`) whenever `this.state.search`
   is defined — NOT only when `timelineRenderingType===Search`. Body still renders `RoomSearchView` only when
   `timelineRenderingType===Search`; once stepping starts it's Room mode → live timeline shows.
5. `onCancelSearchClick`: also `this.searchNavVm.setMatches([])` (defensive) — keep clearing `search` + Room mode.

- [ ] Add focused RoomView-test assertions where the suite allows (e.g. activating a match dispatches ViewRoom
  with the right event_id + highlighted/scroll_into_view; header persists in Room mode while `search` set).
- [ ] Manually reason through the render glue (RoomView is large; glue convention mirrors electron-main).

### Task 6 — i18n + verify + adversarial review + commit
- [ ] Add any new i18n keys (`room|search|previous_match`, `…|next_match`, counter aria) to `en_EN.json`;
  run `matrix-gen-i18n` → no diff.
- [ ] `tsc`, `eslint --max-warnings 0`, `prettier --check` clean on all changed files.
- [ ] Web Jest (via `scratchpad/webjest.sh`): Searching-test, RoomSearchNavigationViewModel-test,
  RoomSearchAuxPanel-test, RoomView-test, SearchMatchNavigation.test (shared-components vitest) all green.
- [ ] Adversarial review (workflow) of the slice; apply real findings.
- [ ] Commit: `feat(web): in-room search match stepping (k-of-N + live-timeline arrows) (search Phase 2 slice 1)`.

---

## Slice 2 — Live in-bubble highlight in stepping mode — ✅ DONE (session 19, committed)

**Shipped (TDD RED→GREEN, adversarial-reviewed):** while stepping, the matched terms now highlight in the body of
the **focused match's live tile** (the same `mx_EventTile_searchHighlight` span as the results list), reusing the
existing `EventTile.highlights` → `HtmlHighlighter` path — no new render code.

Files:
- `Searching.ts`: new pure `extractSearchHighlights(results, term)` (enrich + longest-first sort, **non-mutating**,
  mirrors RoomSearchView) + `SearchInfo.highlights?: string[]`.
- `MessagePanel.tsx`: new optional `searchHighlights` / `searchHighlightEventId` props; `getTilesForEvent` applies
  `highlights` to the tile whose id === `searchHighlightEventId` only.
- `TimelinePanel.tsx`: forwards both props (optional → 5 other callers unaffected).
- `RoomView.tsx`: `onSearchUpdate` stores `highlights` (only for completed single-room searches); render derives the
  focused match's eventId + terms when `isSteppingSearchMatch` and threads them down. **Decoupled from the transient
  jump-flash `highlightedEventId`** so the body highlight persists while the match stays focused.

Tests: `Searching-test` extractSearchHighlights (4, incl. non-mutation); `MessagePanel-test` focused-tile-only +
no-leak (2). Full verify: tsc clean, 129 web Jest pass (Searching 34, MessagePanel 23, RoomView+TimelinePanel 72),
eslint/prettier clean. No new i18n.

**Documented limitation (deliberate, not a slice-2 regression):** a *malformed* edit (`m.replace` with missing/
non-string `m.new_content.body`) that becomes a match is NOT re-keyed by `promoteReplacementContent` (its intentional
#32356 blank-tile guard), so its match id is the edit id, which the live timeline never renders (SDK aggregates edits
onto the original). Result: no live highlight for that match — **graceful** (no crash), and identical to slice 1's
jump no-op and the pre-existing results-list non-render for the same case. Not fixed here to avoid regressing the
#32356 guard; revisit only if real malformed edits surface.

## Slice 3 — Ordering + wrap-around + keyboard — ✅ DONE (session 20, TDD, adversarial-reviewed)

**Shipped (RED→GREEN each, then a 4-dimension adversarial-review workflow; 6 confirmed findings applied):**

1. **Chronological ordering.** `extractSearchMatches` (`Searching.ts`) now sorts matches **newest-first by
   `event.getTs()`** (stable tiebreak preserves backend order), so down/next = older and up/previous = newer hold
   regardless of backend order. Review hardening: `getTs() ?? 0` (the SDK masks a possibly-absent
   `origin_server_ts` with `!`; an undated match would make `b.ts-a.ts` NaN and silently corrupt order) — undated
   matches now sink to the bottom; JSDoc corrected (the app requests `SearchOrderBy.Recent` from both backends, so
   the sort is a normalising guarantee, not a rank→recency correction).
2. **Wrap-around.** `RoomSearchNavigationViewModel` `next`/`previous` now **wrap** at the ends (next at oldest →
   newest; previous at newest / from the empty cursor → oldest); `canPrevious`/`canNext` are `total > 0` so the
   arrows stay enabled whenever there is ≥1 match. Decision (the plan's "optional wrap"): chose **wrap** over
   clamp — consistent with the ⌘F/browser-find model adopted in Phase 1 and keeps Enter-stepping from
   dead-ending. (Clamp is a small revert of `computeSnapshot` + the two step methods if ever wanted.)
3. **Keyboard.** **Enter = next, Shift+Enter = previous** while the right-panel search box is focused. New
   `Action.SearchMatchStep` + `SearchMatchStepPayload` (`{direction: "next"|"previous"}`), dispatched from
   `useSearchInput.onUpdateSearchInput` (`RoomSummaryCardViewModel.tsx`, mirrors the existing `FocusMessageSearch`
   dispatch pattern) and handled by `RoomView.onAction` → `this.searchNavVm.next()/previous()`. `preventDefault`
   on Enter; the Escape branch was refactored to preserve prior behaviour. Review hardening: guard
   `!e.nativeEvent?.isComposing` so the Enter that **confirms an IME (CJK) composition** is not hijacked.

Files: `Searching.ts`, `viewmodels/search/RoomSearchNavigationViewModel.ts`,
`dispatcher/actions.ts` (+`payloads/SearchMatchStepPayload.ts`),
`components/viewmodels/right_panel/RoomSummaryCardViewModel.tsx`, `components/structures/RoomView.tsx`.
Tests: Searching `extractSearchMatches` (ordering + stable + undated); nav VM rewritten for wrap (both
directions, single-match, empty no-op); `RoomSummaryCardViewModel` Enter/Shift+Enter/IME dispatch; `RoomView`
`SearchMatchStep`→VM delegation; `SearchMatchNavigation.test` name fix. **124 web Jest + 5 shared-components
vitest pass; tsc/eslint/prettier clean; no new i18n.**

**Documented limitations (deliberate, not slice-3 regressions):** keyboard stepping reaches the VM only while a
**completed single-room** search has matches (slice-1 `canStep` gate) — Enter in all-rooms/in-progress scope is a
no-op (VM guards). Focus retention after a jump (so repeated Enter keeps working) is a runtime/UX property to
confirm in manual QA, not unit-testable here. The two new `RoomView` stepping tests were placed early in the
1380-line suite (with a `toBeTruthy()` mount guard) to avoid a **pre-existing** cross-test isolation leak that
nulls the mount when they run last — the leak itself is out of slice-3 scope.

## Slice 4 — Out-of-window / encrypted edge cases + predecessor-chain safety — ✅ DONE (session 21, TDD, adversarial-reviewed)

**Scope decision (user, this session):** "Defer with design." The plan's one-liner *"All-rooms scope: arrows switch
room before jumping"* turned out to be **architecturally infeasible as a slice**: RoomView is keyed by room id
(`LoggedInView.tsx:737` → `<RoomView key={currentRoomId} />`), so any cross-room `ViewRoom` **unmounts/remounts**
RoomView and destroys the in-instance search session (`searchNavVm` + `state.search`; there is no search store). The
code even states the assumption: `RoomView.tsx:770-771` "the roomID will not change for the lifetime of the RoomView
instance." So slice 4 shipped the **safe, complete** edge-case half and re-scoped all-rooms into its own dedicated
**Slice 6 (SearchSessionStore)** below, rather than half-building a multi-week, HIGH-risk cross-room feature.

**Shipped (RED→GREEN for the production change; 3-lens adversarial-review workflow):**

1. **Predecessor-chain stepping safety (the real bug, production fix).** A `SearchScope.Room` search **also searches
   upgraded predecessor rooms** (#32258, `getRoomSearchChain` → `eventIndexSearch`/server leg in `Searching.ts`), so
   its completed results can contain matches whose event lives in a **different (predecessor) room**. Slice-1's
   stepper assumed Room scope = current room only, so stepping into such a match would `dispatch(ViewRoom
   {room_id: predecessorRoom})` → unmount the room-keyed RoomView → **lose the search session** (commonly an E2EE
   upgraded room). **Fix:** `RoomView.onSearchUpdate` now filters the steppable match list to
   `m.roomId === this.getRoomId()`. Predecessor matches stay visible in the results list (`RoomSearchView`, which
   renders the full result set) but are excluded from the "k of N" **live** stepper. The common non-upgraded case
   (`getRoomSearchChain` → `[roomId]`) is unaffected (filter is a no-op). `state.search.matches` is set to the same
   filtered list, so the slice-2 highlight derivation (`matches[currentMatchIndex].eventId`) stays consistent.
2. **Out-of-window reachability (already generic — confirmed + locked by test).** Stepping to any match dispatches
   `ViewRoom {event_id, highlighted, scroll_into_view}`; the SDK's `loadTimeline` builds a fresh
   `TimelineWindow(eventId)` (`TimelinePanel.tsx:1461`) that contextually back-paginates to any event id in the room —
   the same permalink/reply-jump path, which also drives decryption for E2EE/Seshat hits. **No production change**
   (the capability was built generically in slice 1); slice 4 locks the contract with a test that steps to a deeper
   (out-of-window) match and asserts it is requested by id with the session surviving.

**Files:** `apps/web/src/components/structures/RoomView.tsx` (11-line filter + rationale comment, only production
change). Tests: `RoomView-test.tsx` — two new tests in the **early** `in-room search match stepping` describe
("does not step to matches from a predecessor room", "requests an out-of-window match by event id"); `Searching-test.ts`
— `extractSearchMatches` characterization (helper stays scope-agnostic / cross-room; live-timeline scoping is the
caller's job). **Verify: 93 web Jest pass (Searching 30 + RoomView 63); tsc only the 4 pre-existing vendored
matrix-js-sdk errors; eslint/prettier clean; no new i18n.**

**Documented limitations (deliberate):** (a) When predecessors hold matches, the "k of N" live stepper undercounts vs
the list's "N results found" (steppable = current-room subset) — correct, not a bug; Slice 6 makes the rest steppable.
(b) Thread-only matches and the slice-2 malformed-edit case still no-op gracefully (loadTimeline jumps to live end) —
out of scope. (c) The new mount-heavy tests live in the early describe because of a **pre-existing** cross-test
isolation leak (a client-less RoomView re-renders → `shouldEncryptRoomWithSingle3rdPartyInvite` crash) that strikes
whichever mount-heavy test runs last in the later describes; the leak itself is out of slice scope.

## Slice 5 — Polish — ✅ DONE (session 22, TDD, adversarial-reviewed, committed+pushed)

**Shipped (TDD RED→GREEN per task; 4-lens adversarial-review workflow, 9/16 findings confirmed, safe ones applied):**
all three tasks below. Files: `RoomSearchAuxPanel.tsx` (keep summary while stepping + back-to-results `IconButton`,
`list-view` icon, gated on `isSteppingMatch`), `RoomView.tsx` (`onBackToSearchResults`), `MessagePanel.tsx`/`EventTile.tsx`/
`EventTileViewModel.ts`/`EventTileDerivedState.ts` (`isSearchHighlightMatch` → `mx_EventTile_searchHighlightActive`),
`_EventTile.pcss`+`_EventBubbleTile.pcss` (active tile reuses the `mx_EventTile_selected` subtle-bg + accent-stroke
treatment, layout-scoped group/irc + bubble), app i18n `room|search|back_to_results`, shared i18n
`match_position` → "…loaded". **Verify: 224 affected web Jest pass (RoomView 58, MessagePanel, RoomSearchAuxPanel 11,
EventTile) + shared SearchMatchNavigation vitest 5; tsc clean (only the 4 vendored matrix-js-sdk errors); eslint/prettier/
i18n clean.** Jest via `scratchpad/webjest.sh` (the `--transformIgnorePatterns` workaround; allowlist MUST include
`@element-hq/web-shared-components`).

**i18n resolution note (verified):** apps/web reads shared-components strings from **src**, not the gitignored `dist` —
runtime via `webpack.config.ts` `additionalStringsPaths`, tests via `test/setup/setupLanguage.ts`. So "…loaded" ships
from the src change alone (no dist rebuild needed); and because apps/web jest renders "…loaded", ALL apps/web counter
assertions were switched to `exact: false` (else they'd break in CI which rebuilds dist).

**Review findings — applied (safe/valuable):** (a) CSS robustness — the original unscoped `$event-selected-color` bg was
*identical to hover* (default group layout), *overridden by the mention yellow*, and *invisible in bubble*; fixed by
reusing the proven `mx_EventTile_selected` treatment (bg + inset accent stroke) in the layout-scoped blocks. (b) test:
pin the counter reset to "0 of N" after back-to-results; (c) test: active-tile test no longer passes `searchHighlights`
(proves the tile mark depends solely on `searchHighlightEventId`); (d) accurate comment on the (belt-and-braces)
`setMatches` in `onBackToSearchResults`.

**Review finding — DEFERRED to Slice 6 (documented in code + here):** *stale `initialEventId` after back-to-results.*
After stepping then back-to-results, the RoomViewStore's initial event id still points at the last-stepped match and
`getInitialEventId() ?? this.state.initialEventId` (onRoomViewStoreUpdate) keeps it sticky, so **re-clicking that exact
same result is a no-op** (the result-click clear gate keys on an `initialEventId` *change*). The naive fix (clear
`this.state.initialEventId`) is UNSAFE — the store still holds it, so the next store update would trip the gate and tear
the search down. The correct fix is the result-click-gate rework Slice 6 performs when it lifts the search session out of
RoomView. Workarounds today: step via arrows, click a different result, or ✕. (Medium-severity edge case; not a crash /
no data loss.)

**PostHog — DEFERRED (per session-22 user decision):** needs a new `Interaction` name in the external/immutable
`@matrix-org/analytics-events`; do it upstream then `PosthogTrackers.trackInteraction(...)` from
`RoomSearchNavigationViewModel.next/previous`.

### Original task plan (as executed)

**User decisions (session 22, locked via AskUserQuestion):**
- **Dual denominator → "Keep both, label stepper 'loaded'."** Show the results-list summary "N results found"
  (`searchInfo.count`, backend estimate) AND the stepper "k of N **loaded**" simultaneously — most honest. Stop
  hiding the summary while stepping.
- **PostHog → DEFER to a follow-up.** `@matrix-org/analytics-events` (external, immutable from this repo) has **no**
  search-stepping `Interaction` name and `trackEvent<E extends IPosthogEvent>` is type-gated to that union, so a
  properly-typed event needs an **upstream schema PR** (out of this slice's scope). Ship UX now; no PostHog code.
- **Active tile → new subtle dedicated class** `mx_EventTile_searchHighlightActive` using `$event-selected-color`
  (distinct from the yellow `$event-highlight-bg-color` URL-jump flash, so search-stepping reads as its own state).

**Note:** "hide the results list while stepping" is **already shipped** (slice 1: `RoomView.tsx` gates `RoomSearchView`
on `!isSteppingSearchMatch`). The remaining list deliverable is the **"back to results" affordance**.

### Task A — Dual denominator: keep summary + label stepper "loaded"
- Files: `apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx` (remove the `isSteppingMatch ? null :` branch so
  the `room|search|summary` text always renders when `count` defined; remove the now-unused `isSteppingMatch`);
  `packages/shared-components/src/i18n/strings/en_EN.json` key `room|search|match_position`
  `"%(current)s of %(total)s"` → `"%(current)s of %(total)s loaded"`.
- TDD: new RoomSearchAuxPanel test "keeps the summary visible while stepping" (RED: current code hides) → GREEN;
  replace the old "should hide the results-count summary while stepping" test; update `SearchMatchNavigation.test`
  (`packages/shared-components`) "1 of N" → "1 of N loaded".

### Task B — "Back to results" affordance (return from live stepping to the results list)
- New `RoomView.onBackToSearchResults` = setState `{ timelineRenderingType: Search, search:{...search,
  currentMatchIndex: undefined} }` (keeps the session alive — distinct from `onCancelSearchClick` which clears it).
  Pass to `RoomSearchAuxPanel`; render a list `IconButton` (tooltip/aria `room|search|back_to_results`) only while
  `isSteppingMatch`. New app i18n key `room|search|back_to_results`.
- TDD: RoomSearchAuxPanel test "shows back-to-results button while stepping, hidden otherwise; click fires callback";
  RoomView state-flip test where the suite allows (mirror slice-1/3 early-describe mount-guard convention).

### Task C — pcss for the active live tile (`mx_EventTile_searchHighlightActive`)
- Thread "this tile is the focused search match" (`eventId === searchHighlightEventId`) from `MessagePanel.tsx`
  (getTilesForEvent, ~811) → `EventTile` → `EventTileDerivedState.ts` classnames (alongside `mx_EventTile_highlight`).
  pcss: `apps/web/res/css/views/rooms/_EventTile.pcss` new rule `mx_EventTile_searchHighlightActive` →
  `background-color: $event-selected-color` (subtle); verify dark/bubble layouts.
- TDD: `MessagePanel-test` — focused tile gets `mx_EventTile_searchHighlightActive`, others don't; no-leak when not
  stepping. Add EventTileDerivedState assertion if the seam lands there.

### Wrap-up
- i18n: `matrix-gen-i18n` no-diff (app + shared-components); tsc/eslint/prettier clean; full Jest via the
  `--transformIgnorePatterns` workaround; adversarial-review workflow; commit
  `feat(web): search stepping polish — back-to-results, dual-denominator, active-tile (Phase 2 slice 5)`.
- **PostHog follow-up (deferred):** add a `WebRoomTimelineSearchMatchStep` (or similar) Interaction name upstream in
  `@matrix-org/analytics-events`, then `PosthogTrackers.trackInteraction(...)` from
  `RoomSearchNavigationViewModel.next/previous`. Tracked here, not done in slice 5.

## Slice 6 — Cross-room / predecessor / all-rooms stepping via a `SearchSessionStore` — ✅ DONE (session 23, TDD, adversarial-reviewed)

*(Largest, HIGH risk — the deferred half of slice 4. Defining blocker: RoomView is room-id-keyed
(`LoggedInView.tsx:737` `<RoomView key={currentRoomId} />`), so the search session dies on any cross-room jump while
it lives on the component instance.)*

**Shipped:** new singleton `apps/web/src/stores/SearchSessionStore.ts` owns the cross-room session (matches/index/term/
highlights/promise/abortController) + a transient `steppingJump` flag; `RoomSearchNavigationViewModel` reads/writes it
(survives the remount); `RoomView` routes its whole search lifecycle through it, **removed** the slice-4 current-room
filter + `scope===Room` gate (predecessor + all-rooms now steppable), re-hydrates from the store in its constructor
(no list flash), and ends the search on a real result-click.

**Final clear-gate design (changed during review — see below):** the result-click teardown is a **positive gate** —
`timelineRenderingType===Search && !consumeSteppingJump() && roomViewStore.getInitialEventId()` — combined with a
`resetFocusedEvent()` helper (a flag-guarded no-`event_id` ViewRoom) called from **both** `onSearch` and
`onBackToSearchResults` so the live timeline is never pinned to an event while idle in the results list. This both
fixes the deferred stale-`initialEventId` re-click no-op AND lets clicking the event the search was *started on* end
the search. (An earlier `searchStartEventId` baseline was replaced after the adversarial review found it left a
same-event result-click as a no-op.) The `steppingJump` flag is consumed **once per `onRoomViewStoreUpdate`** (not
only inside the gate), so it can't leak to a later genuine click; the `EditEvent` clear is guarded by `isSteppingJump()`.

**Adversarial review (4-lens workflow, 34 agents, per-finding Opus verification):** all race/lifecycle "criticals"
(dispatcher-leak, VM listener-leak, multiple-update races, `getRoomId` constructor race, lingering-session re-appear)
were **refuted**. One real (narrow) bug — the `searchStartEventId` same-event no-clear — **fixed** (positive gate +
`resetFocusedEvent`). Test gaps closed: result-click-on-started-on-event clears, abort-NOT-called-on-unmount,
`EditEvent`-during-stepping-jump leaves the session alive. `setCurrentMatchIndex` no-op double-emit guard added.

**Verify (all green):** 175 search-related web Jest (SearchSessionStore 18, RoomSearchNavigationViewModel 16, RoomView
70, RoomSearchAuxPanel 9, Searching, MessagePanel) + 75 adjacent (RoomSearchView/RoomSummaryCardViewModel/TimelinePanel/
MessagePanel); tsc only the 4 pre-existing vendored matrix-js-sdk errors; eslint `--max-warnings 0` + prettier clean;
no new i18n. Jest via `scratchpad/webjest.sh` (the `--transformIgnorePatterns` workaround; allowlist incl.
`@element-hq/web-shared-components`).

**Documented behaviour (deliberate):** the session persists across plain room navigation (it survives the remount by
design) and re-appears only when the focused match is in the room you land on; it is cleared on cancel/new-term/
result-click/edit/logout. A new term replaces + aborts the previous session (single-session store).

### Original design notes (as implemented)

**User decision (session 23, AskUserQuestion):** include **all-rooms (scope=All)** stepping in this slice (the full
Slice-6 goal; nearly free once the store survives the remount). Self-decided (established precedent): keep the
early-describe test-isolation workaround + add `SearchSessionStore` resets (no root-cause fix this slice); a new term
started mid-step **replaces & aborts** the previous session (single-session store).

### Architecture (verified against current source, session 23 mapping workflow)
- **Source of truth split (lower-risk than a full rewrite):** a new singleton `SearchSessionStore` (plain
  `EventEmitter`, UIStore-style `static get instance`, self-registers `defaultDispatcher.register` for
  `Action.OnLoggedOut → clear({abort:true})`) is the **survives-remount source of truth** AND the VM's data source
  AND the owner of the transient `steppingJump` flag. `RoomView.state.search` stays as the **per-mount render
  mirror**, written in lockstep with the store in each handler and **re-seeded from the store in the constructor** on
  remount (avoids a results-list flash). No `RoomViewStore`/`RoomSearchView`/permalink/`SDKContext` changes.
- **Store shape:** `{ searchId, term, scope, roomId?, promise, abortController?, matches: SearchMatch[] (cross-room,
  UNFILTERED, newest-first), currentMatchIndex (-1 = none focused), highlights: string[], count?, inProgress, error? }`
  + `steppingJump: boolean`. Events: `SearchSessionStoreEvent.Update`. API: `start(info)` (aborts+replaces previous),
  `updateResults({inProgress,matches?,highlights?,count?,error?})` (resets steppingJump), `setCurrentMatchIndex(i)`,
  `beginSteppingJump()`, `consumeSteppingJump()` (read+reset once), `isSteppingJump()` (read-only),
  `clear({abort?=true})`, `hasActiveSession()`, `getSnapshot()`, getters `matches`/`currentMatchIndex`.
- **VM (`RoomSearchNavigationViewModel`):** drop instance `matches`/`index`; subscribe to the store via
  `disposables.trackListener(store, Update, …)`; `computeSnapshot()` reads `store.matches`/`store.currentMatchIndex`;
  `next()/previous()` compute the wrapped index from the store, call `store.beginSteppingJump()` +
  `store.setCurrentMatchIndex(i)`, then keep invoking `props.onActivateMatch(match,i)` (RoomView still owns the
  ViewRoom dispatch). `setMatches()` removed (RoomView writes the store directly).

### Where it inserts in `RoomView.tsx` (current line numbers, session 23)
- `searchNavVm` field (456-458): unchanged construction; the VM now reads the store.
- `onSearch` (1821): `store.start({searchId,term,scope,roomId,promise,abortController})` **before** setState; keep the
  state.search mirror. (start aborts any previous session.)
- `onSearchUpdate` (1849-1890): **remove** the `scope===SearchScope.Room` gate (1854) and the
  `.filter((m)=>m.roomId===currentRoomId)` slice-4 filter (1862-1865). `canStep = !inProgress && results!==null`.
  Push FULL cross-room `extractSearchMatches` into `store.updateResults({matches, highlights, count, inProgress,
  error})`; mirror into state.search.
- `onActivateSearchMatch` (1897-1913): `store.beginSteppingJump(); store.setCurrentMatchIndex(index);` keep the
  synchronous `timelineRenderingType=Room` flip (defense-in-depth) + state.search mirror; dispatch ViewRoom unchanged.
- **Clear Gate 1** (797-804): add `&& !this.context-less store.consumeSteppingJump()` so a stepping jump never tears
  down search; abort via `store.clear({abort:true})` instead of the inline `abortController?.abort()`.
- **Stale-initialEventId fix** in `onBackToSearchResults` (2052): after flipping to Search mode + index→-1, do a
  flag-guarded self-dispatch `ViewRoom {room_id: currentRoom}` (no `event_id`) with `store.beginSteppingJump()` set,
  so Clear Gate 1 consumes the flag (search NOT cleared) but `RoomViewStore.initialEventId` resets to null — then
  re-clicking the *same* last-stepped result registers as an initialEventId change → Gate 1 clears + jumps (no-op gone).
- **Clear Gate 2** (EditEvent, 1296-1310): wrap `search: undefined` in `if (!store.isSteppingJump())`; real edits
  clear via `store.clear({abort:true})`.
- `onCancelSearchClick` (2039): `store.clear({abort:true})` (the ONLY real abort path) + clear state.search mirror.
- **Remount rehydration** in the constructor's initial-state build: if `store.hasActiveSession()` AND the focused
  match (`store.matches[store.currentMatchIndex]`) is in THIS room, seed `state.search` from the store snapshot +
  `timelineRenderingType=Room` (match focused) so the first paint already shows the live timeline + header + arrows.
- `componentWillUnmount` (1076): unchanged — already does NOT abort; the store + session survive the remount.

### Risk register (from the mapping workflow; mitigations baked into the tasks)
HIGH: remount race/flash (→ hydrate in constructor, not post-mount setState); abort-on-remount (→ abort ONLY in
`store.clear({abort:true})`); Clear-Gate-1 misfire (→ `consumeSteppingJump()` + keep the sync Room-mode flip);
cross-test singleton leak (→ `afterEach` store reset + early-describe placement). MEDIUM: Clear-Gate-2 misfire (→
`isSteppingJump()` guard); logout leak (→ `Action.OnLoggedOut` reset); counter/highlight desync (→ both derive from
the single `store.setCurrentMatchIndex`); stale-initialEventId (→ guarded self-dispatch above). LOW: ordering authority
stays `extractSearchMatches`/`extractSearchHighlights`; webjest allowlist (store deps stay within it).

### Tasks (TDD RED→GREEN each)
- **S6-1** `SearchSessionStore` (state, `Update` event, `start`/`updateResults`/`setCurrentMatchIndex`/`clear` +
  abort semantics + `hasActiveSession`/`getSnapshot`) — unit test, singleton reset in `beforeEach`.
- **S6-2** `steppingJump` flag (`begin`/`consume`/`isSteppingJump`, auto-reset on `updateResults`) + `Action.OnLoggedOut`
  reset — unit test.
- **S6-3** Migrate `RoomSearchNavigationViewModel` to read/write the store (drop instance fields; trackListener) —
  unit test rewrite (wrap-around preserved; auto-dispose).
- **S6-4** Route `RoomView` lifecycle through the store (`onSearch`/`onSearchUpdate`/`onCancel`/`onBack`); **remove**
  the scope gate + current-room filter (enable cross-room/predecessor/all-rooms matches) — integration (early describe).
- **S6-5** Clear Gate 1 `consumeSteppingJump` + stale-initialEventId self-dispatch; Clear Gate 2 `isSteppingJump`
  guard — integration: (a) stepping jump doesn't clear; (b) genuine result-click clears; (c) step→back→re-click same
  result jumps (no-op gone); (d) reverse the slice-4 "does not step to predecessor" test → now steps into predecessor.
- **S6-6** Remount-and-rehydrate: constructor seeds state.search from the store; step A→B remounts → stepper
  continues, header/arrows persist, promise not aborted, no list flash — integration (KEY test).
- **S6-7** Test isolation (`afterEach` store reset) + all-rooms stepping test + full verify + adversarial-review
  workflow + commit `feat(web): cross-room/all-rooms search stepping via SearchSessionStore (search Phase 2 slice 6)`.

### PostHog — still DEFERRED (unchanged from slice 5): needs an upstream `Interaction` name in
`@matrix-org/analytics-events` before `PosthogTrackers.trackInteraction(...)` from the VM step methods.
