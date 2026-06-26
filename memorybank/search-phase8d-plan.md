# Search Phase 8d — Fix "clicking the search box jumps the conversation to the FIRST result" + add a header search button

> **STATUS: ✅ DONE — code + tests + lint + macOS rebuild + reinstall to /Applications all complete (session 33, 2026-06-26).**
> Installed `/Applications/Element.app` webapp.asar md5 = `830de88ff12bc33f5f81c28c8e84ec76` (== new dist), contains
> `searchResultsListShown` ×3 (Phase 8d) and `steppingTarget` ×38 (8b/8c retained), built Jun 26 16:40. Committed locally
> (NOT pushed — prior-phase pattern; push to main is harness-blocked anyway).
> Done: bug fix (8d.1) + header search button (8d.2), both TDD RED→GREEN. RoomView-test 76/76 (incl. 2 new Phase 8d
> tests), RoomHeader-test 48/48 (1 new test + snapshot updated for the new button), SearchSessionStore/RoomSearchHeader/
> RoomSearchResults 47/47, RoomSearchNavigationViewModel 16/16. prettier ✓, eslint ✓ (changed files), tsc apps/web ✓
> (only the 4 pre-existing matrix-js-sdk 41.8.0 errors), i18n:lint ✓ (no new keys — reused `action|search`). Diff:
> src +34/-3 (RoomView.tsx +18/-3, RoomHeader.tsx +16). Build log: scratchpad/build-macos-phase8d.log.
> NOTE: dropped the subagent's suggested PostHog `trackInteraction("WebRoomHeaderButtonsSearchButton")` — that name is
> NOT in @matrix-org/analytics-events@0.36.1's InteractionName union, so it would fail tsc. No analytics on the button.
> Trigger: user reports on the packaged macOS build (verified to CONTAIN Phase 8c — installed
> `/Applications/Element.app` webapp.asar has `steppingTarget` ×19, md5-identical to `apps/desktop/dist`, so this is
> NOT the stale-app artifact that fooled us in 8c). Two asks:
> 1. **Bug:** after clicking a result (jumps to it), reopening the list, clicking another result, then clicking the
>    search box again, the conversation JUMPS BACK TO THE FIRST result originally clicked. User-confirmed symptom
>    (AskUserQuestion): *"Box-click jumps to 1st result"*.
> 2. **Feature:** add a search (magnifier) button to the room header, **left of the call buttons** (Telegram-style),
>    that **opens & focuses** the in-room search bar (⌘F equivalent). Rebuild & reinstall to /Applications after.

## Root cause (confirmed by code, Opus main-loop trace; the two Haiku workflow agents disagreed and were set aside)
The in-room search pins/un-pins the LIVE timeline via async `ViewRoom` round-trips. Returning to the results list
(`onBackToSearchResults` → `resetFocusedEvent`) dispatches a no-`event_id` `ViewRoom` to un-pin. BUT:
- `onRoomViewStoreUpdate` keeps the LOCAL mirror via `const initialEventId = getInitialEventId() ?? this.state.initialEventId`
  ([RoomView.tsx:760](../apps/web/src/components/structures/RoomView.tsx#L760)). When the un-pin lands,
  `getInitialEventId()` is `null` but `?? this.state.initialEventId` resurrects the just-viewed event — so the local
  pin is **never cleared** on return-to-list.
- On the packaged build, constant background `RoomViewStore` emissions (sync / read receipts / `setViewRoomOpts` on
  RoomLoaded) fire `onRoomViewStoreUpdate` while the un-pin `ViewRoom` is still queued (store still holds the old
  event). Each such frame re-applies `getInitialEventId() ?? local` and re-pins/re-scrolls the live timeline to that
  stale event. The first-clicked result is the one whose pin lingered longest across the click sequence, so reopening
  the list scrolls the conversation back to it. jsdom has no background emissions → never reproduced before.

This is the 4th symptom in the same pin/clear-gate area (Phases 8, 8b, 8c). Per systematic-debugging "3+ fixes →
question the architecture": the fragility is the async pin round-trip + the sticky `?? this.state.initialEventId`
fallback. Scoped fix below removes the stale-resurrection without re-introducing the durable-`steppingTarget` guard
that fixes the "resets itself" bug.

## The fix (slice 8d.1 — bug)
`RoomView.onRoomViewStoreUpdate` ([:760-794](../apps/web/src/components/structures/RoomView.tsx#L760)):
- Compute `searchResultsListShown = this.state.search !== undefined && (this.state.search.currentMatchIndex ?? -1) < 0`
  (search active AND not stepping = the results list is showing; the inverse of `isSteppingSearchMatch`).
- When `searchResultsListShown`, force the live timeline un-pinned: `newState.initialEventId = undefined;
  newState.isInitialEventHighlighted = false;` INSTEAD of the `?? this.state.initialEventId` resurrection. So neither
  a lagging store value nor a stale local mirror can re-pin the conversation while the user is browsing the list.
  Stepping (`currentMatchIndex >= 0`, Room mode) is unaffected — it still pins to the focused match. Search inactive
  is unaffected — permalinks/threads/scroll-restore behave exactly as before. The clear gate ([:877](../apps/web/src/components/structures/RoomView.tsx#L877))
  reads `getInitialEventId()` directly and is untouched; `steppingTarget` is untouched.
- Defense-in-depth: `onBackToSearchResults` setState also clears `initialEventId: undefined, isInitialEventHighlighted:
  false` so the un-pin is immediate/deterministic, not reliant on the async round-trip.

### TDD (RED → GREEN), RoomView-test "in-room search match stepping"
- **Test A (deterministic):** click a result row, click "Back to results", flush → assert `ref.current.state.initialEventId`
  is `undefined` (RED pre-fix: it stays the clicked event via the `??` fallback).
- **Test B (packaged-build race):** click a result (let its jump land → store + local = `$first`); click "Back to
  results" (un-pin `ViewRoom` queued, store still `$first`); inject `roomViewStore.emit(UPDATE_EVENT)` in that window →
  assert local `initialEventId` is NOT re-pinned to `$first` (RED pre-fix: the emission re-applies `$first ?? local`).
- Regression guard: existing tests "ends the search when a result is clicked", "re-clicking the last-stepped result
  … keeps the search alive", "keeps the live timeline visible behind the bounded dropdown", and the 8c race test all
  assert STORE state / session liveness, not local `initialEventId` → unaffected.

## The feature (slice 8d.2 — header search button)
`apps/web/src/components/views/rooms/RoomHeader/RoomHeader.tsx` (call buttons ~line 328). Add an `IconButton` with the
Compound `search` icon (`@vector-im/compound-design-tokens/assets/web/icons/search`) **left of the video/voice call
buttons** (Telegram desktop places the magnifier left of the call button — verified from tdesktop
`history_view_top_bar_widget.cpp`). onClick fires `Action.FocusMessageSearch` via `defaultDispatcher` (the SAME action
⌘F and Spotlight use → opens & focuses the search bar; `searchHeaderActive=true`). Tooltip + aria-label `_t("action|search")`
(existing key). PostHog `trackInteraction` to match the other header buttons. Render under the same non-LocalRoom gate
as the existing buttons.
- TDD: RoomHeader-test — renders a "Search" button; clicking it fires `Action.FocusMessageSearch`.

## Verify / build
- `scratchpad/webjest.sh` for RoomView-test + RoomHeader-test (+ full search suite). `pnpm lint` (tsc/eslint/prettier/i18n).
- Rebuild unsigned arm64 macOS app (`scratchpad/build-macos.sh`), **replace /Applications/Element.app**, verify the new
  webapp.asar md5 differs from the current `1c778da2…` and still contains `steppingTarget`. (8c lesson: verify the
  installed bundle before retesting.)
