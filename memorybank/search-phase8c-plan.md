# Search Phase 8c — Fix the in-room search "resets itself" bug for real (durable steppingTarget) + stale-app finding

> **STATUS: ✅ code + tests done, lint clean; macOS rebuild + reinstall to /Applications in progress (session 32, 2026-06-26).**
> Trigger: user reports on the packaged macOS build that the Phase 8b fix did NOT work — "After I click one of [the
>
> > results] it goes to the related result. But after I click the search box again to see the results again, it resets
> > itself." Same symptom Phase 8b claimed to fix. User asked to detect & fix, research Telegram, ask clarifying
> > questions, use subagents.

## Investigation (Workflow `search-reset-rootcause-v2`, 5 parallel agents + synthesis)

Two HIGH-confidence root causes:

1. **STALE INSTALLED APP (the dominant real-world cause).** `/Applications/Element.app` was built **2026-06-23 13:43**
   — THREE days before the Phase 8b commit (c444e23, 2026-06-26 02:43). Its `webapp.asar` (bundle hash `00c162f9…`)
   contains **zero** `steppingTarget`/`beginSteppingJump`/`clearSteppingTarget` symbols → it predates ALL of Phase
   8/8b. The fixed bundle (`4b820446…`) existed ONLY in `apps/desktop/dist/` + the new `.dmg`, never installed. Both
   report version `1.12.22`, indistinguishable by version string. So the user had **never actually run** the Phase 8b
   fix. This alone explains the persisting symptom. **Lesson: after any desktop fix, reinstall to /Applications and
   verify the asar bundle hash before retesting.** (Also debunked: Phase 8b blamed the sliding-sync re-dispatch
   `RoomViewStore.tsx:392` as the "dominant trigger", but `feature_simplified_sliding_sync` defaults FALSE
   (`Settings.tsx:600`) so it never fires unless enabled in Labs.)

2. **Genuine remaining race in the Phase 8b code — the clear gate's ELSE-branch.** `RoomView.onRoomViewStoreUpdate`
   had `} else if (!focusedEventId && steppingTarget !== null) { clearSteppingTarget(); }` (old RoomView.tsx:884-890).
   It dropped the durable guard on ANY transient focus-null frame, unable to tell "focus is transiently null because
   our own stepping ViewRoom (PIN to the clicked match) is still queued via `setTimeout(0)`" from "focus is null
   because the clearing ViewRoom legitimately landed and we are idle in the list." Concrete ordering: (A) click a row →
   `onActivateSearchMatch` arms steppingTarget=$M, flips committed mode to Room, queues ViewRoom($M); (B) a background
   RoomViewStore emission (sync / read receipts / `setViewRoomOpts` on RoomLoaded, RoomViewStore.tsx:818) lands BEFORE
   it → else-branch nulls steppingTarget mid-flight; (C) user clicks the search box → `resetFocusedEvent` reads focus
   still null → its `if (roomId && focusedEventId)` guard is false → no re-arm; (D) the queued ViewRoom($M) finally
   pins $M while committed mode is Search and the one-shot flag is already consumed → gate sees `$M !== steppingTarget`(null) →`clear({abort:true})`+`search=undefined` = the EMPTY search bar. jsdom never reproduced it (no
   background emissions) — the Phase 8b tests passed for that reason.

## User decisions (AskUserQuestion, session 32)

- **Result-click UX:** "Keep current flow, fix reset" (NOT a Telegram-desktop persistent-panel redesign).
- **Install:** "Yes — rebuild & replace /Applications/Element.app."
- **Re-click same result:** "Stay on it, keep search open" — a behavior CHANGE: previously re-clicking the
  started/last-stepped result ENDED the search; now it keeps the session alive.

Telegram reference (Firecrawl, tdesktop #30283 maintainer): in-chat message search keeps the SESSION alive after a
result click; desktop's "N messages found" results panel stays open while the conversation jumps+highlights.

## The fix — make steppingTarget fully durable (cleared ONLY by start()/clear())

The Q3 decision removed the ONLY reason the racy else-branch existed (re-arming the gate for "re-click ends search"),
so the fix is simpler AND more robust than the synthesis's PIN/CLEAR-tag proposal:

- `SearchSessionStore.ts`: **removed** `clearSteppingTarget()` (now dead). `steppingTargetEventId` is reset only in
  `start()`/`clear()` — kept across `updateResults()` AND across returns to the list. Updated the field doc comment.
- `RoomView.tsx`: **removed** the else-branch. Now the guard is never nulled on a transient un-pinned frame, so the
  queued jump's $M always equals steppingTarget when it lands → gate excluded → no reset. Corollary (matches Q3):
  re-clicking the same/last result keeps the session alive (its id == the durable target). Rewrote the gate comment.
- `RoomView.tsx` defense-in-depth: the teardown branch now also sets `newState.searchHeaderActive = false`, so a
  GENUINE navigate-away (permalink/notification to an event we didn't pin) fully closes the search header instead of
  leaving an empty bar (the render gate is `searchHeaderActive || search`, line 3089).
- `onSearch` comment (1953) corrected: it pins the pre-search focused event as the durable target to guard the
  clearing window (no longer "so a later click still ends the search").

## TDD / verification

- New RED→GREEN test in RoomView-test "in-room search match stepping": _keeps the search alive when a background
  RoomViewStore update races a result-row click before its jump lands_ — clicks a real dropdown row (fireEvent holds
  the `setTimeout(0)` ViewRoom pending), injects `roomViewStore.emit(UPDATE_EVENT)`, asserts `steppingTarget` survives
  (RED on old: nulled by the else-branch), then back-to-results + `flushPromises` and asserts the session survives.
- Updated behavior tests for the Q3 change: "re-clicking the last-stepped result …" and "clicking the result for the
  event the search was started on" now assert the session STAYS ALIVE (were: ends). Added a `searchHeaderActive===false`
  assertion to the navigate-away test (proves the header fully closes). Relaxed the Phase 8b arrow-step race test's
  incidental "$newer still pinned" assertion (survival no longer depends on the async clear's exact landing moment).
- **271 search tests GREEN across 15 suites** (144 in the 6 core suites + 127 in the other 9). prettier ✓, eslint ✓
  (changed files), tsc apps/web ✓ (only the 4 pre-existing matrix-js-sdk 41.8.0 errors). No new i18n strings.
- Diff: src +13/-19 net logic (RoomView.tsx else-branch removed +1 line; SearchSessionStore clearSteppingTarget
  removed) + comments; tests +144/-? across RoomView-test.
- Build: `scratchpad/build-macos.sh` → log `scratchpad/build-macos-phase8c.log`; then replace /Applications/Element.app
  and verify its asar contains `steppingTarget` (bundle hash should be the NEW one, not `00c162f9…`).

## Follow-ups (defer)

- The edit clear gate (RoomView.tsx ~1387) still uses the one-shot `isSteppingJump()` peek — unchanged, no edit bug
  reported. Same theoretical early-consume race, far smaller window; migrate to the durable comparison if it surfaces.
- Telegram-faithful persistent results panel (Option B in the AskUserQuestion) remains a possible future redesign.
