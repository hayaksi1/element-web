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

## Later slices (next sessions)
- **Slice 3 — Ordering + wrap-around + keyboard.** Define chronological order (down=older), Enter=next /
  Shift+Enter=prev while the search box is focused, optional wrap.
- **Slice 4 — Out-of-window / encrypted edge cases.** Confirm Seshat-result event ids resolve in the live
  timeline (E2EE); contextual back-pagination already handled by TimelineWindow — add tests for a match not in
  the loaded window. All-rooms scope: arrows switch room before jumping.
- **Slice 5 — Polish.** Hide the results list once stepping starts (toggle back via a "list" affordance);
  PostHog tracking; pcss for the active live tile.
