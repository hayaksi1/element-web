# Search Phase 8e — Fix result-click: no flash, no in-bubble highlight, lands at bottom (not centered)

> **STATUS: ✅ code + tests + lint green; macOS rebuild + reinstall in progress (session 35, 2026-06-26).**
> Trigger: user reports on the packaged macOS build — clicking a result row in the Telegram-style dropdown DOES
> navigate to the right message, but (1) the message does NOT flash/blink, (2) the matched term is NOT highlighted
> in the bubble, (3) it lands near the BOTTOM ("end of chat history") instead of centered — so the user can't tell
> which message is the result.
>
> User decisions (AskUserQuestion, session 35): **Highlight feel = "Flash + keep term (Telegram)"** — a quick
> whole-message flash that fades ~1.2s AND the matched word stays highlighted while focused; **centering = yes**
> (vertically centered, confirmed from the message); **Build = rebuild + reinstall to /Applications**.

## Investigation (Workflow + Codex MCP + 2 background subagents; adversarial)
- Parallel investigation workflow (`search-result-jump-investigation`, 5 readers + Firecrawl Telegram + a Codex
  agent) → then a **deterministic jsdom repro subagent** and a **Codex read-only trace**, which CONVERGED.
- **Refuted** the workflow's first guess (a Haiku "NaN pixelOffset" theory): `ScrollPanel.scrollToToken(token,
  pixelOffset = 0, …)` — JS default params apply to `undefined`, so it is 0, not NaN; `initTimeline` already uses
  `offsetBase = 0.5` (center) when `eventPixelOffset == null`. Centering math was always correct.
- **Refuted** the workflow's second guess (onSearchUpdate fires *during* stepping): the `RoomSearchView` data engine
  that drives `onSearchUpdate` is only mounted when `state.search && !isSteppingSearchMatch` (RoomView.tsx:2881), so
  it is UNMOUNTED while a match is focused.

### Confirmed root cause (deterministic repro COND-F + Codex)
All three symptoms are ONE race. `searchResultsListShown` (onRoomViewStoreUpdate) and `isSteppingSearchMatch` +
`searchHighlightEventId` (render) derived from the **volatile** `state.search.currentMatchIndex`. A **settled**
`onSearchUpdate(false, results, …)` landing *while a match is pinned* (the real async search resolving at/after the
click, or a "load more" page) resets that cursor — `onSearchUpdate` set local `currentMatchIndex: undefined`
(RoomView.tsx:2052) and `SearchSessionStore.updateResults` set store `currentMatchIndex: -1` (line 164). A constant
background `RoomViewStore` emission then ran `onRoomViewStoreUpdate`, saw `searchResultsListShown === true` mid-jump,
and took the clobber branch (RoomView.tsx:778-780): forced `isInitialEventHighlighted = false` (**no flash**), made
`isSteppingSearchMatch` false → dropped `searchHighlights`/`searchHighlightEventId` (**no in-bubble term highlight**)
and re-mounted the dropdown overlay so the live timeline reads as buried at the bottom (**not centered**).
jsdom's mocked `Promise.resolve` settles before the click, so the window never opens — which is why phases 8/8b/8c/8d
never caught it. Separately: there is **no flash/blink CSS animation at all** in this fork (`_EventTile.pcss` had only
a static `mx_EventTile_selected`/`searchHighlightActive` tint + a literal `TODO: ultimately we probably want some
transition on here`).

## The fix — durable focused-match signal (mirrors the proven steppingTarget pattern)
`SearchSessionStore.ts`:
- New `private focusedMatchEventId: string | null` + getter `focusedMatch`. Set in `setCurrentMatchIndex` BEFORE the
  no-op guard (`index >= 0 → matches[index].eventId`, else null). Reset in `start()`/`clear()` AND when the focused
  match drops out of a fresh result set (coherent fall-back to the list — Codex review fix).
- `updateResults` now RE-DERIVES `currentMatchIndex` from `focusedMatchEventId` (`findIndex` by event id) instead of
  always `-1`, so a settled result mid-step keeps the cursor (and the "k of N" counter) on the focused match.

`RoomView.tsx`:
- `searchResultsListShown` (line ~780), `isSteppingSearchMatch` (~2786) and `searchHighlightEventId` (~2945) now derive
  from `SearchSessionStore.instance.focusedMatch` — the DURABLE signal, immune to the volatile cursor being nulled.
- `onSearchUpdate` (line ~2058) syncs the local mirror to `SearchSessionStore.instance.currentMatchIndex` when a match
  is focused (else `undefined`), so `RoomSearchHeader`'s `searchInfo.currentMatchIndex`-driven affordances stay correct
  through the race. Centering then falls out for free (else-branch sets `pixelOffset = undefined` → offsetBase 0.5).

`_EventTile.pcss` / `_EventBubbleTile.pcss` (the actual blink — delegated to **Codex MCP**, refined by me):
- Removed `.mx_EventTile_searchHighlightActive` from the persistent static selected/hover groups; added a one-shot
  `@keyframes mx_EventTile_searchFlash` ($event-selected-color → transparent, 1200ms, ease-out, fill forwards) gated
  to `prefers-reduced-motion: no-preference`, applied to the focused-match tile (`.mx_EventTile_line` / bubble
  `::before`), overriding the shared selected tint so it FADES and only the inline `.mx_EventTile_searchHighlight`
  (matched word) stays. `prefers-reduced-motion: reduce` → static tint fallback (a11y, no animation, still indicated).
  Permalink (`.mx_EventTile_selected` alone) and edit (`.mx_EventTile_isEditing`) styling are untouched.

## TDD / verification
- RED→GREEN. SearchSessionStore-test: new "focusedMatch (durable stepping marker)" block (7 tests incl. survives
  updateResults, re-derives index on shift, clears when the match drops out). RoomView-test: new Phase 8e test
  reproduces COND-F (click → settled `onSearchUpdate` while focused → background `emit(UPDATE_EVENT)`) and asserts the
  flash (`isInitialEventHighlighted`), centered scroll (`initialEventScrollIntoView` true + `initialEventPixelOffset`
  undefined), stepping survival and dropdown-hidden — RED pre-fix (isInitialEventHighlighted flipped false).
- **374 tests GREEN across 17 suites** (32 SearchSessionStore + 85 RoomView + adjacent: EventTile 142, MessagePanel,
  TimelinePanel, Spotlight, Searching, HtmlUtils, RoomSearch*). 45 snapshots pass. prettier ✓, eslint ✓, stylelint ✓,
  tsc apps/web ✓ (only the 4 pre-existing matrix-js-sdk 41.8.0 errors), i18n:lint ✓ (no new keys).
- Codex adversarial review: 1 Medium (focusedMatch/cursor split if the focused match vanishes) → FIXED + tested;
  2 Low (test didn't pin pixelOffset → added; flash won't re-fire on re-activating the SAME already-focused event →
  accepted, stepping to *different* matches re-fires because tiles are keyed by event id — deferred).
- Build: `scratchpad/build-macos-phase8e.log`.

## Verify on packaged build
Reproduce: search → click a result → the message must FLASH once then fade, keep the matched WORD highlighted, and
sit CENTERED in the viewport (not at the bottom). Step with arrows → each different match re-flashes. Reinstall to
/Applications and confirm the new webapp.asar md5 differs from `b6100554cd896899b6cc15d680bb10f6` (Phase 8d2) and
contains `focusedMatch` + `searchFlash`.

## Follow-ups (defer)
- Re-flash on re-activating the SAME focused event needs a JS animation-restart token/key (CSS alone can't).
- Reduced-motion users get a static tint rather than a flash (a11y-correct).
