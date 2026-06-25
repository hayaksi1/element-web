# Search Phase 8b — Fix the in-room search dropdown "resets itself" bug (macOS desktop)

> **STATUS: ✅ code + tests done, lint clean; macOS rebuild in progress (session 31, 2026-06-26).**
> Trigger: after Phase 8 landed, the user reported on the packaged macOS build that the search section now works,
> "but when i click to see the dropdown menu, it resets itself" — and clarified "the first enter to see the results
> work but when i click as a second, it reset itself." Screenshots showed a successful stepping state ("2 of 23
> loaded", back-to-results list icon visible) collapsing back to an EMPTY search bar — i.e. the whole search session
> is torn down when returning from a stepped match to the results list.
>
> User was AWAY for this session and asked me to "handle the process by yourself and choose the best option." Also
> asked to fix two unrelated IDE "Problems" (tsconfig — see bottom).

## Investigation (3-agent adversarial workflow `search-reset-rootcause` + my back-to-results-window refinement)

Confirmed root cause (H1, `rootCauseConfirmed: true`): the result-click **clear gate** in
`RoomView.onRoomViewStoreUpdate` ([RoomView.tsx] ~865) depended on an **exactly-once boolean**
`SearchSessionStore.consumeSteppingJump()`. `beginSteppingJump()` was set synchronously, but the paired ViewRoom is
dispatched **async** (`window.setTimeout(_dispatch, 0)`, dispatcher.ts:165). On the packaged build, `RoomViewStore`
emits `UPDATE_EVENT` constantly while a search is active (sync, read receipts, RoomLoaded, setting watchers, and —
the dominant trigger, H2a — the **sliding-sync re-dispatch** at RoomViewStore.tsx:392-414 which re-fires the ViewRoom
without re-arming the flag). Any such emission landing in the gap consumes the one-shot flag early; the real
stepping/return update then sees `wasSteppingJump === false` while `timelineRenderingType === Search` and the timeline
is still pinned to the focused match → the gate fires → `clear({abort:true})` → session torn down = "it resets
itself." jsdom never reproduced it because it has **no background emissions** (the prior Phase-8 back-to-results test
passed for that reason).

**My critical refinement over the workflow's draft:** the user's symptom is specifically the **return-to-results**
window, not the initial click. The workflow proposed `beginSteppingJump(null)` for the clearing nav; that does NOT
cover the window, because before the async clearing ViewRoom lands the timeline is still pinned to the OLD match `$ev`
while target would be `null` → `$ev !== null` still fires. The clearing nav must carry the **event it is clearing
FROM**. Also discovered (via a RED diagnostic): returning to the list **re-mounts the hidden `RoomSearchView` data
engine**, which re-resolves the settled promise and calls `updateResults` again — so `updateResults` must NOT reset
the durable target or it gets nulled right back inside the window.

## The fix — a durable navigation guard (`steppingTarget`) alongside the existing one-shot flag

`SearchSessionStore.ts`:
- New `private steppingTargetEventId: string | null` + getter `get steppingTarget()` + `clearSteppingTarget()`.
- `beginSteppingJump(eventId: string | null)` now records the pinned event id (in addition to the boolean, which is
  KEPT, still consumed once, still used by the **edit gate** `isSteppingJump()` — unchanged behaviour).
- Reset `steppingTargetEventId = null` in `start()` and `clear()` **only** — deliberately NOT in `updateResults()`
  (so it survives the return-to-results re-mount/re-fire).

`RoomView.tsx`:
- Clear gate now also requires `getInitialEventId() !== SearchSessionStore.instance.steppingTarget`. A focused event
  equal to the target is OUR navigation (the match we stepped to, or the event still pinned during the return window)
  → gate skips, immune to the flag being consumed early. `!wasSteppingJump` kept (belt-and-suspenders + still resets
  the boolean for the edit gate).
- New else-branch: when the timeline is un-pinned again (`getInitialEventId()` null) and a target is set, call
  `clearSteppingTarget()`. Race-free (the gate is inert while focus is null) and re-arms the gate so a later **genuine
  re-click** of the previously-stepped/started event still ends the search (keeps the "re-click ends search" and
  "ends search when clicking the start event" tests green).
- `onActivateSearchMatch` → `beginSteppingJump(match.eventId)`; `resetFocusedEvent` → `beginSteppingJump(<the event
  being cleared from>)`.

`RoomSearchNavigationViewModel.activate` → `beginSteppingJump(this.store.matches[index].eventId)`.

## TDD / verification

- New RED→GREEN test in RoomView-test "in-room search match stepping" describe: *keeps the search alive when a
  RoomViewStore update races the return-to-results transition (dropdown reset bug)* — steps into a match, clicks Back
  to results (clearing ViewRoom held async via microtask-only flush), then models two interloping emissions
  (`consumeSteppingJump()` + `roomViewStore.emit(UPDATE_EVENT)`) and asserts the session survives. Confirmed RED on
  pre-fix code (`state.search` undefined), GREEN after. Drains the deferred timer at the end so it can't leak.
- New SearchSessionStore-test "steppingTarget (durable navigation guard)" block: defaults null; survives
  `consumeSteppingJump()`; **persists** across `updateResults`; resets on `start()`/`clear()`.
- Updated all `beginSteppingJump()` callers (3 src + 2 test) to pass the event id.
- Full search surface GREEN: **247 search-related jest** (143 across RoomView/SearchSessionStore/nav-VM/header/results
  + 104 across the other 10 search suites). prettier ✓, eslint ✓ (changed files), tsc apps/web ✓ (only the 4
  pre-existing matrix-js-sdk 41.8.0 errors), shared-components tsc ✓. No new i18n strings.
- Diff: +219/-28 across RoomView.tsx, SearchSessionStore.ts, RoomSearchNavigationViewModel.ts + 2 tests (+ the 2
  tsconfig files below).
- Build: `scratchpad/build-macos.sh` (local apps/web webpack → stage → asar → electron-builder, arm64 unsigned).

## Side task — IDE "Problems" (tsconfig TS5096)

VSCode flagged `apps/web/tsconfig.json` and `packages/shared-components/tsconfig.json`: *"Option
'allowImportingTsExtensions' can only be used when noEmit/emitDeclarationOnly is set."* Both packages set
`allowImportingTsExtensions: true` with `declaration: true` and no `noEmit`. They are type-checked only via
`tsc --noEmit` (CLI passes the flag) and bundled by webpack/vite — `tsc` never emits — but the editor reads
`tsconfig.json` directly without the CLI flag, hence the error. Reproduced TS5096 deterministically in scratchpad and
confirmed `"noEmit": true` clears it with zero CLI behaviour change. Added `"noEmit": true` (with a comment) to both.
The remaining `node_modules/@vector-im/compound-web/tsconfig.json` errors are third-party (it ships a tsconfig
extending an uninstalled `@tsconfig/vite-react`) — not fixable in-repo, harmless to our build.

## Follow-ups (defer)
- The edit clear gate (RoomView.tsx ~1370) still uses the one-shot `isSteppingJump()` peek. It was left as-is (its
  test passes; no edit bug reported) — it has the same theoretical early-consume race but a far smaller window. If an
  edit-during-cross-room-step bug ever surfaces, migrate it to the same durable `steppingTarget` comparison.
