# Search Phase 8d2 — Correct the 8d over-fix: reopening the results list jumped to the LATEST message

> **STATUS: ✅ DONE — code + tests + lint + tsc + macOS rebuild + reinstall to /Applications all complete (session 34,
> 2026-06-26).** Installed `/Applications/Element.app` webapp.asar md5 = `b6100554cd896899b6cc15d680bb10f6` (== new dist,
> was `830de88f…`), contains `searchAnchorEventId` ×1 (8d2) + `steppingTarget` ×6 (8b/8c retained), built Jun 26 17:03.
> Committed locally (NOT pushed — prior-phase pattern; push to main is harness-blocked anyway).
> Follow-up to Phase 8d. 8d fixed "reopening the list jumps to the FIRST result" by forcing the live timeline
> UN-pinned (`initialEventId = undefined`) while the results list shows. The user then reported the flip-side
> symptom on the packaged build: reopening the search box now **jumps the conversation to the LATEST message**
> instead of staying on the message they were just reading. Same defect area, 5th symptom (Phases 8, 8b, 8c, 8d,
> 8d2) → questioned the architecture per systematic-debugging Phase 4.5.

## Root cause (Opus main-loop trace)

`this.state.initialEventId` is the prop that drives `TimelinePanel`'s scroll position
([RoomView.tsx render, eventId={this.state.initialEventId}](../apps/web/src/components/structures/RoomView.tsx)).
The results-list overlay (`RoomSearchResults`) is a **bounded** overlay (Phase 7) — the live timeline shows behind
and below it — so where that timeline sits is user-visible. The list-shown branch in `onRoomViewStoreUpdate` set
`initialEventId`:

- pre-8d: from `getInitialEventId() ?? this.state.initialEventId` → a background emission resurrected a **stale
  earlier match** → jumped to the FIRST-clicked result.
- 8d: forced to `undefined` → **un-pinned** the timeline → it fell to the live bottom → jumped to the **LATEST
  message**.

Both are wrong derivations of the SAME thing: the pin should be the **last-viewed match** so reopening the list
leaves the conversation put. That value is already tracked durably as `SearchSessionStore.steppingTarget` (set by
`beginSteppingJump` on BOTH the result-click path — `onActivateSearchMatch` — and the return-to-list path —
`resetFocusedEvent`; reset ONLY by `start()`/`clear()`).

## The fix (RoomView.tsx)

1. `onRoomViewStoreUpdate` list-shown branch ([~:767-779](../apps/web/src/components/structures/RoomView.tsx#L767)):
   `const searchAnchorEventId = SearchSessionStore.instance.steppingTarget ?? undefined;` and set
   `newState.initialEventId = searchAnchorEventId` (was `undefined`). Stable across background emissions (same value
   every frame → `eventId` prop unchanged → `TimelinePanel` never re-scrolls), immune to the lagged store/state. A
   fresh search with nothing viewed yet → `steppingTarget` null → `undefined` → overlay covers the live bottom (fine).
2. `onBackToSearchResults` ([~:2260](../apps/web/src/components/structures/RoomView.tsx#L2260)):
   `initialEventId: SearchSessionStore.instance.steppingTarget ?? undefined` (was `undefined`) for immediate,
   deterministic anchoring. `resetFocusedEvent` still clears the STORE focused event (so a re-click of the same row
   registers in the clear gate) — it does NOT touch our local anchor.

**Untouched:** the durable-`steppingTarget` clear gate ([:889-902](../apps/web/src/components/structures/RoomView.tsx#L889))
and the `steppingTarget` lifecycle — so the 8b/8c "search resets itself" fix is preserved. The clear gate reads the
STORE's `getInitialEventId()` + `steppingTarget`, not `state.initialEventId`.

## TDD (RoomView-test "in-room search match stepping")

Rewrote the two 8d tests (which asserted the now-wrong `initialEventId === undefined`) + added one:

- "keeps the live timeline anchored to the last-viewed match when returning to the results list (8d2)" — click
  `$older`, Back → `state.initialEventId === "$older"` (RED pre-fix: `undefined`).
- "keeps the conversation on the last-viewed match when a background update races returning to the list (8d2)" —
  click `$older`, fireEvent Back (un-pin pending), inject `roomViewStore.emit(UPDATE_EVENT)` → still `"$older"`
  (NOT first, NOT undefined/latest).
- "anchors the list to the most-recently-viewed match after several result clicks (8d2)" — view `$older`→Back→view
  `$newer`→Back → anchor FOLLOWS to `$newer`, not stuck on the first-clicked `$older`. (This test crashed pre-fix —
  the `undefined` pin drove a crashing re-render path — and is clean post-fix.)

## Results

RoomView-test 84/84 (incl. 3 8d2 tests; also updated 6 stale full-component snapshots that embed the Phase 8d
header Search button — fc04b14 updated RoomHeader-test.snap but not these; net diff = +6 `aria-label="Search"`,
`Chat` +1/-1 re-serialised, nothing else). RoomSearch\*/SearchSessionStore/RoomHeader-test 153/153. prettier ✓,
eslint ✓, tsc apps/web ✓ (only the 4 pre-existing matrix-js-sdk 41.8.0 errors). Build log:
scratchpad/build-macos-phase8d2.log.

## Verify on packaged build

Reproduce the user's flow: search → click a result (jumps to it) → click the search box again → the conversation
must STAY on that message (not jump to the latest message and not to the first result). Reinstall to
/Applications and confirm the new webapp.asar md5 differs from `830de88f…` and contains `searchAnchorEventId`.
