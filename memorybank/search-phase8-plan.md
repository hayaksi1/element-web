# Search Phase 8 — Fix 2 reported in-room search result-click bugs (macOS desktop)

> **STATUS: ✅ code + tests done, lint clean; macOS rebuild in progress (session 30, 2026-06-26).**
> Trigger: user reports on the packaged macOS build, after Phase 6/7 landed the Telegram-style dropdown:
> (1) clicking a result row "didn't go properly which one i wanted to go to" and "doesn't show which one i clicked";
> (2) "can't see the dropdown menu again after i click one of the result. When i click Enter again it goes to the next
> search result. When i click the search box again it shows the dropdown again."
>
> User decision (AskUserQuestion, session 30): **Option B — "Jump & step, easy return"** for the post-click behaviour
> (clicking a row jumps into the conversation with a CORRECT "k of N" counter; clicking the search box — or the
> existing back-to-list icon — reopens the full list). NOT the "keep list open (Telegram-faithful)" option. Build
> target: **rebuild the unsigned arm64 macOS .app + .dmg**.

## Investigation (3-agent workflow, adversarial verify + Firecrawl Telegram research)

Root causes were verified by an adversarial workflow (`search-click-bug-investigation`, 3 agents): a Bug-1 refuter, a
Bug-2 tracer, and a Firecrawl Telegram-UX researcher. Bug 1 claim survived refutation (`claimConfirmed:true`).

- **Bug 1 — confirmed root cause.** The dropdown **row-click path bypasses the SearchSessionStore stepping
  protocol**. `onSearchResultClick` → `onActivateSearchMatch` ([RoomView.tsx:2025]) wrote only the LOCAL
  `state.search.currentMatchIndex` and dispatched `ViewRoom`. It did **not** call
  `SearchSessionStore.beginSteppingJump()` nor `setCurrentMatchIndex(index)` — unlike the arrow/Enter path
  (`RoomSearchNavigationViewModel.activate`, lines 87-93) and `onBackToSearchResults` (RoomView.tsx:2218). The
  "k of N" counter is store-backed (`computeSnapshot` reads `store.currentMatchIndex`/`store.matches`), so after a
  click it stayed **"0 of N"** (symptom: "doesn't show which one i clicked"), and the next Enter-step read the stale
  store cursor `-1` → `next()` returns index `0` (newest) instead of clicked+1 (symptom: "goes to next search
  result" from the wrong anchor). Teardown-race ruled out: React flushes the synchronous `timelineRenderingType=Room`
  setState before the async (`setTimeout(0)`) ViewRoom dispatch, so the clear gate (RoomView.tsx:865, requires
  `===Search`) never fires.
- **Bug 2 — by-design hide + UX gap.** Clicking a row sets `currentMatchIndex ≥ 0` →
  `isSteppingSearchMatch` true → the dropdown render gate (`this.state.search && !isSteppingSearchMatch`,
  RoomView.tsx:2819) skips `RoomSearchResults`, showing the live timeline. The only ways back were the small
  "back to results" `ListIcon` (RoomSearchHeader.tsx:190) or re-running the search. The `Search` input had **no
  onFocus/onClick**, so "click the search box → list reappears" did NOT actually work (the user was likely hitting
  the adjacent list icon, or re-typing+Enter). Option B closes this gap.
- **Telegram reference (Firecrawl, medium confidence).** In-chat message search keeps a **persistent left-column
  results list**; clicking a result keeps the list open while the conversation jumps + highlights, with a header
  ↑/↓ stepper over the same matches. (Sources: tdesktop #26443, #10464.) Element's layout is a top-overlay dropdown,
  so we chose the pragmatic Option B (jump + easy return) rather than a persistent overlay.

## Slice 8.1 — Bug 1: row click syncs the shared store cursor

- `RoomView.tsx` `onActivateSearchMatch` (2025): before the ViewRoom dispatch, call
  `SearchSessionStore.instance.beginSteppingJump()` then `setCurrentMatchIndex(index)` — mirroring the nav VM's
  `activate()`. Makes the store-backed counter show `(index+1) of N` and anchors the next Enter-step on the clicked
  row. Idempotent no-ops on the arrow/Enter path (already set with the same index → `setCurrentMatchIndex` guards on
  equality). Also fixes cross-room clicks (the rehydrated local index now matches the store on remount).
- Test (`RoomView-test.tsx`, "Telegram-style search header (Phase 6)" describe): 2-result search; click the SECOND
  row ($older, index 1); assert `SearchSessionStore.instance.currentMatchIndex === 1` and header reads "2 of 2"
  (RED before fix: store stayed -1 / "0 of 2").

## Slice 8.2 — Bug 2: clicking the search box reopens the list while stepping

- `RoomSearchHeader.tsx`: add `onClick` on the `Search` input → `if (isSteppingMatch) onBackToResults?.()`.
  Uses a real **click** (not onFocus) so the programmatic autofocus after a cross-room stepping remount can't
  spuriously exit stepping. The explicit `ListIcon` back-to-results button is kept. `isSteppingMatch` already exists
  (line 130). `Search` forwards `...props` to its `<input>`, so onClick reaches it.
- Tests (`RoomSearchHeader-test.tsx`): clicking the box with `searchInfo.currentMatchIndex:0` calls `onBackToResults`
  once (RED before fix); clicking with no focused match does NOT.

## Verification

- `scratchpad/webjest.sh`: **130 web jest pass across 5 suites** (RoomView-test, RoomSearchHeader-test,
  RoomSearchResults-test, RoomSearchNavigationViewModel, SearchSessionStore). 13 snapshots pass.
- Lint: prettier ✓, eslint ✓ (changed files), tsc ✓ (only the 4 pre-existing matrix-js-sdk 41.8.0 source errors),
  i18n:lint ✓. No `.pcss` touched (stylelint N/A). No new i18n keys.
- Diff: +9/+9 source lines (RoomView.tsx, RoomSearchHeader.tsx) + tests. Surgical, no behaviour change to the
  arrow/Enter/back-to-results paths.
- Build: `scratchpad/build-macos.sh` (local apps/web webpack → stage → asar → electron-builder, arm64 unsigned).

## Follow-ups (defer)

- Optional: highlight the last-opened row when the list is reopened (Option B leaves the counter as the indicator).
- Telegram-faithful "persistent list" (Option A) remains a possible future redesign if the top-overlay layout is
  reworked into a side panel.
