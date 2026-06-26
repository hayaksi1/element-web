# Activity Log

## 2026-06-25 (session 24) — Search Phase 3 slice 1: jump-to-date in the search header (MSC3030) + desktop default-on

Directive: "continue the task, read memorybank." Phase 2 (slices 1–6) confirmed complete & pushed (`origin/main` =
`6ef35f8`; the earlier "ahead 1" was a stale tracking ref). **User decisions (AskUserQuestion):** Phase 3 = **jump-to-date
first** (slice 1); `from:` backend = client-side post-filter (slice 2); slice-1 shape = **search-bar control + flip
`feature_jump_to_date` desktop-default-on**; placement = **search bar header beside the input**.

### Plan correction (Understand workflow, 6 agents → verified by hand)
`search-improvement-plan.md` was **wrong** that "jump-to-date is unused / MSC3030 unwired." A complete jump-to-date
ALREADY EXISTS: `DateSeparatorViewModel.pickDate` → `client.timestampToEvent(roomId, ts, Direction.Forward)` →
`dispatch(ViewRoom{event_id,highlighted})`, surfaced on timeline date separators + `/jumptodate`, gated by labs flag
`feature_jump_to_date` (default off) + `ServerSupportUnstableFeatureController` (MSC3030). So slice 1 = **surface it in
search + enable on desktop**, not a from-scratch build (mirrors Phase 1's hidden-feature fix). Full design in
**`memorybank/search-phase3-plan.md`**.

### Shipped (TDD RED→GREEN per task)
- **A — settings flip.** `feature_jump_to_date` default `false` → `!!IS_ELECTRON` ([Settings.tsx:559]). Controller
  unchanged → desktop-on **iff** server supports MSC3030; web + unsupporting servers stay off. Tests: Electron/web
  default + a controller-instance lock (review finding).
- **B — extract `jumpToDateInRoom`.** New `apps/web/src/utils/jumpToDate.tsx` = the verbatim `pickDate` body
  (timestampToEvent + room-switch guard + ViewRoom + error dialogs + bug-report). `DateSeparatorViewModel.pickDate`
  now delegates; `onBugReport` + the jump-only imports removed (existing 36 DateSeparator tests stay green = regression
  proof). +9 util tests.
- **C — search-header control.** New `apps/web/src/components/views/right_panel/RoomSearchJumpToDate.tsx`: a calendar
  `IconButton` + the **reused** shared `DateSeparatorContextMenuView` (newly exported from the shared barrel), driven by
  a per-room `DateSeparatorViewModel` (`useCreateAutoDisposedViewModel`), rendered only when `jumpToEnabled`. Mounted in
  `RoomSummaryCardView` header beside `<Search>` (Flex + flex-1 Box; `.mx_RoomSummaryCard_searchInput{min-width:0}`),
  **keyed by `room.roomId`** so the VM tracks the room. New i18n `room|search|jump_to_date_button`. +4 component +2
  mounting tests.

### Crux (verified, no extra wiring)
A date pick dispatches a **plain** `Action.ViewRoom`+`event_id` (NOT a stepping jump). RoomView's slice-6 clear gate
([RoomView.tsx:840-848]) turns a non-stepping focused-event during Search into "end search → Room mode → live timeline
at that event" — so jump-to-date works identically whether or not a text search is active. Zero search-exit wiring.

### Adversarial review (5-lens workflow → per-finding Opus verify; 13 agents)
8 findings → **3 confirmed (all low, all test-quality — no runtime bugs), 5 refuted.** refactor-parity returned EMPTY
(extraction is behaviourally exact). Applied all 3: (1) assert the setting keeps its MSC3030 controller; (2) cover the
non-NOT_FOUND `MatrixError` + `HTTPError` error branches; (3) a keyed-remount test proving a room switch rebinds the VM.
Refuted (correctly): "re-pick same date = no-op" (resetJumpToEvent flips `scroll_into_view`→false so a re-pick re-fires);
frozen `ts`/Date.now() (cosmetic); lifecycle untested (covered at the hook level); date-separators-now-interactive
(intended + MSC3030-gated, has tests); `highlighted:true` not asserted (gate keys on event_id, structurally guaranteed).

### Verification (all green)
Affected web Jest: featureJumpToDateDefault 3, jumpToDate 9, DateSeparatorViewModel 36, RoomSearchJumpToDate 4,
RoomSummaryCardView 25, RightPanel 22 — all pass. shared-components vitest logic 15/15 (the 5 `DateSeparatorView.stories`
**visual** pixel-snapshots fail identically with my change stashed → pre-existing env flakes, unrelated). `tsc` only the
4 vendored matrix-js-sdk errors; eslint `--max-warnings 0` + prettier + i18n clean. Jest via `scratchpad/webjest.sh`.
**Local-only gotcha:** `DateSeparatorContextMenuView` is consumed from the shared-components **dist**, so a
`pnpm -C packages/shared-components run build` was needed to test locally; dist is gitignored (CI rebuilds), so the commit
carries only the src barrel export. **Not verifiable here:** real MSC3030 server round-trip on a live desktop build.

### WHERE I LEFT OFF — Phase 3 slice 2 next
- **Slice 2 — `from:`/sender filter** (Compound chip/member-picker in the search header; homeserver `IRoomEventFilter.senders`
  + Seshat client-side post-filter w/ over-fetch — decision locked). Then jump-to-date polish if wanted → Phase 4 media
  tabs → Phase 5 reach/ranking. PostHog metric for the search calendar still deferred (analytics-events schema gap).
- Slice 1 committed this session; **push pending user OK** (per recent convention).

## 2026-06-25 (session 23) — Search Phase 2 slice 6: cross-room/all-rooms/predecessor stepping via a SearchSessionStore (+ stale-initialEventId fix)

Directive: "continue the task, read memorybank." Slices 1–5 committed (HEAD `d1998d7`, working tree clean — the
session-22 plan's "committed+pushed" for slice 5 was accurate). Picked up **Slice 6**, the largest/HIGH-risk piece:
make in-timeline match stepping survive RoomView's room-id-keyed remount so it works cross-room (all-rooms scope +
upgraded predecessor rooms). **User decision (AskUserQuestion):** include all-rooms scope in this slice.

### Architecture (mapped first via a 6-agent Understand workflow, then verified by hand)
RoomView is keyed by room id (`LoggedInView.tsx:737`), so a cross-room `ViewRoom` unmounts/remounts it and destroyed
the in-instance search session. Fix: lift the session into a **new singleton `apps/web/src/stores/SearchSessionStore.ts`**
(plain `EventEmitter`, UIStore-style `static get instance`, self-registers `defaultDispatcher` for
`Action.OnLoggedOut → clear({abort:true})`). It owns `{searchId, roomId?, term, scope, promise, abortController?,
matches[] (cross-room, unfiltered, newest-first), currentMatchIndex(-1=none), highlights[], count?, inProgress, error?}`
plus a transient `steppingJump` flag (not emitted). `RoomSearchNavigationViewModel` now reads/writes the store via
`disposables.trackListener` (state moved off the instance, so it survives the remount). `state.search` stays as
RoomView's per-mount render mirror, **re-seeded from the store in the constructor** when the focused match is in this
room (no results-list flash).

### Shipped (TDD RED→GREEN per task)
- **SearchSessionStore** (+18 Jest): `start` (aborts+replaces previous), `updateResults` (resets cursor + steppingJump),
  `setCurrentMatchIndex` (no-op-guarded), `clear({abort})`, `begin/consume/isSteppingJump`, `hasActiveSession`,
  `getSnapshot`, logout reset.
- **VM migration** (+16): reads store; `next/previous` compute the wrapped index, `beginSteppingJump`+`setCurrentMatchIndex`,
  then `onActivateMatch`. Disposal removes the store listener (factory in the test prevents singleton listener leak).
- **RoomView**: `onSearch`→`store.start`; `onSearchUpdate`→`store.updateResults` with the **full** `extractSearchMatches`
  (REMOVED the slice-4 `.filter(current-room)` + `scope===Room` gate → predecessor + all-rooms steppable);
  `onActivateSearchMatch` flips Room mode + dispatch (VM already flagged); `onCancelSearchClick`→`store.clear({abort:true})`
  (the only real abort); `onBackToSearchResults`→`setCurrentMatchIndex(-1)` + `resetFocusedEvent`; constructor rehydration.
- **Clear gates**: result-click teardown is a **positive gate** (`Search && !consumeSteppingJump() && getInitialEventId()`)
  + `resetFocusedEvent()` (flag-guarded no-`event_id` ViewRoom) on `onSearch` AND `onBackToSearchResults` so the timeline
  is never pinned while idle in the list — fixes the deferred stale-`initialEventId` re-click no-op **and** lets clicking
  the event the search was started on end the search. `EditEvent` clear guarded by `!isSteppingJump()`.
- **Tests**: reversed the slice-4 "does not step to a predecessor room" + "does not enable stepper for all-rooms" tests
  to assert the new cross-room behaviour; added remount-rehydrate, result-click-clears, stale-id-fix, started-on-event-
  clears, abort-not-on-unmount, edit-during-stepping-jump. RoomView-test **70**.

### Key bug found & fixed mid-implementation (not by the review)
The first clear-gate cut keyed on `this.state.initialEventId !== newState.initialEventId`, which is **racy** across the
rapid `onRoomViewStoreUpdate` calls the back-to-results self-dispatch triggers (the component-state mirror is read stale).
Replaced with a fixed `searchStartEventId` baseline, then — after the review (below) — with the cleaner positive gate +
`resetFocusedEvent`.

### Adversarial review (4-lens workflow: races / store-lifecycle / regression / test-quality → per-finding Opus verify)
34 agents. **All** race/lifecycle "criticals" REFUTED (dispatcher-leak, VM listener-leak, multiple-update races,
constructor `getRoomId` race, lingering-session re-appear, back-to-results race — JS run-to-completion + the structural
gate guards hold). **One real (narrow) bug:** the `searchStartEventId` baseline left a result-click on the event the
search was *started on* as a no-op → **fixed** by switching to the positive gate + `resetFocusedEvent` (also removed the
baseline field). Closed 3 test gaps; added a `setCurrentMatchIndex` no-op double-emit guard. (A verify-subagent had
injected two brittle `FINDING-REPRO` tests calling private methods into RoomView-test — removed them.)

### Verification (all green)
175 search-related web Jest + 75 adjacent; `tsc` only the 4 pre-existing vendored matrix-js-sdk errors; eslint
`--max-warnings 0` + prettier clean; no new i18n. Jest via the `--transformIgnorePatterns` workaround (`scratchpad/webjest.sh`,
allowlist incl. `@element-hq/web-shared-components`). **Not verifiable here:** real Seshat cross-room round-trip + the
actual LoggedInView remount on a live build (the unit tests simulate the remount via a fresh mount + seeded store).

### Next
Commit prepared (`feat(web): cross-room/all-rooms search stepping via SearchSessionStore (search Phase 2 slice 6)`);
**push pending user OK** (per recent-session convention). Then **Phase 3** (from:/jump-to-date filters) → Phase 4
(searchable media tabs) → Phase 5 (reach/ranking/health-check). PostHog stepping metric still deferred (needs an upstream
`Interaction` name in `@matrix-org/analytics-events`).

## 2026-06-25 (session 21) — Search Phase 2 slice 4: out-of-window/encrypted edge cases + predecessor-chain stepping safety

Directive: "continue the task, read memorybank to detect where you are." Slices 1–3 done & committed (HEAD `277d3a8`);
next was slice 4 (out-of-window/encrypted edge cases + all-rooms scope).

### Key finding that reshaped the slice (verified in code, not assumed)
`RoomView` is **keyed by room id** — `LoggedInView.tsx:737` `<RoomView key={currentRoomId} />` — so a cross-room
`ViewRoom` **unmounts/remounts** RoomView and destroys the in-instance search session (`searchNavVm` + `state.search`;
there is **no** search store). `RoomView.tsx:770-771` even states the assumption ("roomID will not change for the
lifetime of the RoomView instance"). ⇒ the plan's one-liner *"All-rooms scope: arrows switch room before jumping"* is
**not a slice** — it needs a `SearchSessionStore` that survives the remount (HIGH risk). **Asked the user** → decision:
**"Defer with design"** — ship the safe edge-case half now, re-scope all-rooms as a dedicated **Slice 6**.

### The real bug slice 4 fixes (predecessor-chain × room-keyed RoomView)
A `SearchScope.Room` search **also searches upgraded predecessor rooms** (#32258, `getRoomSearchChain` →
`eventIndexSearch` Seshat leg / server leg in `Searching.ts`), so its completed results can contain matches whose
event lives in a **different (predecessor) room** — commonly an **E2EE** upgraded room. Slice-1's stepper assumed Room
scope = current room, so stepping such a match would `dispatch(ViewRoom {room_id: predecessorRoom})` → unmount the
room-keyed RoomView → **lose the session**. This is the concrete "encrypted edge case."

### Shipped (TDD RED→GREEN for the production change; 3-lens adversarial-review workflow)
- **Production fix (11 lines):** `RoomView.onSearchUpdate` filters the steppable match list to
  `m.roomId === this.getRoomId()`. Predecessor matches stay in the results list (`RoomSearchView` renders the full
  set) but are excluded from the "k of N" **live** stepper. Common non-upgraded case = no-op. `state.search.matches`
  set to the same filtered list → slice-2 highlight derivation stays consistent.
- **Out-of-window:** no production change (built generically in slice 1 — `ViewRoom {event_id,…}` →
  `loadTimeline` → fresh `TimelineWindow(eventId)` back-paginates context, E2EE decryption included). Locked with a
  test that steps to a deeper match and asserts request-by-id + session survival.
- **Tests:** two new `RoomView-test` tests placed in the **early** `in-room search match stepping` describe (a
  pre-existing cross-test isolation leak crashes whichever mount-heavy test runs *last* in the later describes — a
  client-less RoomView re-renders into `shouldEncryptRoomWithSingle3rdPartyInvite`; early placement keeps state clean,
  and it's their correct semantic home). RED proven: predecessor test fails ("0 of 2" not "0 of 1") without the
  filter. Plus a `Searching-test` characterizing `extractSearchMatches` as scope-agnostic/cross-room.

### Verification (all green)
93 web Jest pass (Searching 30 + RoomView 63, via `corepack pnpm -C apps/web exec jest … --transformIgnorePatterns`
workaround); `tsc` only the 4 pre-existing vendored matrix-js-sdk errors; eslint `--max-warnings 0` + prettier clean;
no new i18n; exactly 3 files changed (1 prod + 2 test).

### Next
Slice 5 (hide list while stepping, PostHog, pcss) → **Slice 6** = all-rooms + predecessor cross-room stepping via the
`SearchSessionStore` (design written in `search-phase2-plan.md`) → Phases 3–5. Commit prepared; push pending user OK.

## 2026-06-25 (session 17) — Search Phase 2 slice 1: in-timeline match stepping (k-of-N + live-timeline arrows)

Directive: "continue where you left off" → Search **Phase 2** (the biggest Telegram-parity win). User decision this
session: arrows should **drive the LIVE timeline** (not step the results list). Followed brainstorming-done →
writing-plans (`memorybank/search-phase2-plan.md`) → TDD per task → adversarial review → fix → verify.

> ⚠️ **STATE: slice-1 work is UNCOMMITTED** (HEAD `d0f086a`, which is the unpushed Phase-1B toast). Phase-1A
> `cdce4a2` is pushed; `d0f086a` (Phase 1B) + this slice are local only. Commit prepared; **push to `main` pending
> user OK** (per recent-session convention).

### Architecture mapped first (4 parallel Explore agents)
Key unlocks: the live-timeline **jump+highlight+back-pagination already exists** via `dispatch(Action.ViewRoom
{room_id,event_id,highlighted,scroll_into_view})` → RoomViewStore → TimelinePanel.loadTimeline (TimelineWindow) →
MessagePanel `isSelectedEvent` (same path as reply/permalink; works E2EE). Search **replaces** the timeline
(`timelineRenderingType=Search` shows RoomSearchView list, hides MessagePanel) and L782-791 of
`onRoomViewStoreUpdate` **clears search on a result click** — the core obstacle to keeping the cursor alive.

### Shipped (TDD, MVVM-v2), slice 1
- **`Searching.ts`**: `SearchMatch {roomId,eventId}`, pure `extractSearchMatches(results)` (preserves order, skips
  id-less), `SearchInfo.matches?`/`currentMatchIndex?`. (+3 Jest)
- **`apps/web/src/viewmodels/search/RoomSearchNavigationViewModel.ts`** (extends BaseViewModel): cursor (index, -1=none),
  `setMatches`/`next`/`previous`, snapshot `{current,total,canPrevious,canNext}`, calls injected `onActivateMatch`. (+9)
- **`packages/shared-components/.../SearchMatchNavigation/`** dumb View: "k of N" + 2 Compound chevron IconButtons,
  renders null when total 0; package i18n keys `room|search|{match_position,next_match,previous_match}`; barrel +
  root index export. (+5 vitest)
- **`RoomSearchAuxPanel`**: new optional `navigationVm` → renders `<SearchMatchNavigation>`; hides the (differently-
  counted) "N results found" summary while stepping. (+3 Jest)
- **`RoomView`** integration: constructs/disposes `searchNavVm`; `onActivateSearchMatch` flips
  `timelineRenderingType→Room` **before** the async ViewRoom dispatch (so the L782 "clear on result click" branch is
  skipped → search survives) + sets `currentMatchIndex`; header decoupled (renders when `search && (Search-mode ||
  stepping)`); body shows the live timeline when `currentMatchIndex>=0` (else the list). `onSearchUpdate` enables the
  stepper **only for completed, single-room searches**. (+2 Jest incl. mutation-proven "search survives the jump")

### Adversarial review (3 parallel agents: correctness / MVVM / regression) → applied the real fixes
Confirmed + **fixed**: (a) "k of N" vs "N results" two-number contradiction → hide summary while stepping; (b) All-
rooms stepping would jump cross-room and unmount RoomView, losing the session → **restrict stepper to Room scope**;
(c) partial/aborted count + currentMatchIndex/VM desync → **enable stepper only when search complete**, reset index
with matches. Refuted: dedup/null-id (already guarded). **Accepted + DOCUMENTED as slice-2 limits** (in the plan):
pagination pauses while stepping (stepper covers the loaded result page); composer/status-bar stay in search-mode
chrome during stepping; a permalink click mid-stepping doesn't auto-exit search (use ✕). **Skipped** `.stories.tsx`:
the storybook **visual-regression** baselines are committed per-platform (`__vis__/linux`) and only generatable in
CI's `playwright-screenshots` docker — not locally — so a story would add an unverifiable vis test; behavior is fully
covered by the unit test (omitting a story is CI-safe). *(Accidentally `rm -rf`'d the committed `__vis__` baselines
mid-cleanup; restored via `git checkout`.)*

### Verification (all green)
- Web Jest (helper `scratchpad/webjest.sh`): **105 pass / 5 suites** (Searching, RoomSearchNavigationViewModel,
  RoomSearchAuxPanel, RoomView, + 1). Package vitest **unit** project: SearchMatchNavigation **5** + RoomListSearchView
  **7**. `tsc` app+package: **0** non-vendored errors. `eslint --max-warnings 0` + `prettier --check`: clean (app +
  package). i18n gen (app + package): keys consistent, app strings correctly carry no package-only keys.
- **Not verifiable here:** real Seshat/live round-trip on a packaged build; the storybook visual-regression (CI-only).

### Next (slice 2+, in `search-phase2-plan.md`)
Live in-bubble highlight on the focused match tile; ordering/wrap/keyboard (Enter=next); out-of-window + All-rooms +
pagination-while-stepping; show composer/affordance to return to the list. Then Phase 3 (from:/jump-to-date) → 4 → 5.


## 2026-06-25 (session 15) — Finish session-14 deferred review-fixes (renderer-recovery TODO B + C); re-verify the whole session-14 changeset

Directive: "continue where you left off, check memorybank." Picked up the two deferred review-fix TODOs the
session-14 entry left documented-but-not-done, re-verified the entire (still-uncommitted) session-14 changeset,
and adversarially reviewed the new delta.

> ⚠️ **STATE: session-14 + session-15 work is STILL ALL UNCOMMITTED** (HEAD still `21cb669`). The two deferred
> TODOs are now **DONE**; this **supersedes** the session-14 checkpoint warning's "(B)+(C) not done." Commit + push
> still pending the user's OK (push to `main`).

### Implemented the deferred review fixes (TDD: RED → GREEN), desktop-only
- **(B) Capped relaunch recovery** [renderer-recovery.ts](../apps/desktop/src/renderer-recovery.ts): new
  `RendererRecovery.recoverIfCrashed()` — for the user-initiated **dock `activate` / `second-instance`** relaunch
  paths, reloads a *crashed* renderer but routes through the **same** attempt cap as `render-process-gone` (reuses
  `decideRendererRecoveryAction` with `reason:"crashed"`, after `isDestroyed`/`isCrashed` gates), so a relaunch can no
  longer re-arm a crash loop the recovery already gave up on (at cap → error dialog, not yet-another reload). Extracted
  the reload/dialog/ignore switch into a shared `private performAction()` (both `onRenderProcessGone` and
  `recoverIfCrashed` call it — the `reload` branch records the attempt, so the cap is fed BOTH ways).
  `setupRendererRecovery()` now **returns** the instance. [electron-main.ts](../apps/desktop/src/electron-main.ts):
  module-level `let rendererRecovery`; assigned at the setup call site; the inline uncapped
  `if (...isCrashed()) ...reload()` at the `activate` (~L597) and `second-instance` (~L660) handlers replaced with
  `rendererRecovery?.recoverIfCrashed()` (safe no-op before window creation, exactly like the old `mainWindow?` guard;
  the subsequent `show()`/visibility/`focus()`/darwin `app.show()` logic is unchanged).
- **(C) + review test** [renderer-recovery.test.ts](../apps/desktop/src/renderer-recovery.test.ts): widened the
  non-crash-reason `decide…` test to include `abnormal-exit`/`memory-eviction` → `"ignore"` (both confirmed valid
  members of Electron's `RenderProcessGoneDetails["reason"]` union, `electron.d.ts:11756`); added `unresponsive`-at-cap
  → `showDialog`; +5 `recoverIfCrashed` tests (under-cap reload, not-crashed no-op, **at-cap → dialog not reload**,
  destroyed no-op, quitting no-op); +`setupRendererRecovery` returns-instance test. renderer-recovery **21 → 31 tests**.

### Adversarial review of the delta (focused 3-lens workflow, 6 agents, per-finding refutation) → 1 real, fixed
- **Confirmed (test gap, medium; production code CORRECT):** the at-cap `recoverIfCrashed` test exercised only the
  cap's **read** direction (cap filled via `render-process-gone`, then one `recoverIfCrashed`). Nothing pinned the
  **write** direction — that `recoverIfCrashed`'s OWN reloads record an attempt. The reviewer empirically proved a
  mutation (reload-without-`attempts.push`) **survived all 30 tests**. **Fixed:** new test exhausts the cap *through*
  `recoverIfCrashed` itself (CAP reloads, then CAP+1th → no reload + dialog once) — has teeth (fails under the mutation,
  passes against correct code). renderer-recovery **31 → 32 tests** (no production change — the code was already right).
- **Refuted (2):** the correctness and regression lenses found no genuine defect (cap routing correct; no `activate`/
  `second-instance` behavior lost; undefined-ref path safe).

### Verification (FINAL, all green — re-ran the WHOLE session-14 changeset, not just the delta)
- **Desktop:** `node_modules/.bin/vitest run` → **267 pass / 22 files** (renderer-recovery 21→**32**). `tsc --noEmit`
  clean; `eslint --max-warnings 0` + `prettier --check` clean on **all** changed/new desktop files; `matrix-gen-i18n`
  **no diff**.
- **Web** (helper recreated at `scratchpad/webjest.sh`): `Notifier-test` **54**; `SeshatIndexManager-test|EventIndexPeg-test|
  EventIndex-test|Searching-test` **61 / 4 suites**; `tsc` only the **4 pre-existing vendored matrix-js-sdk** errors;
  eslint/prettier clean; `matrix-gen-i18n src res` **no diff**.
- **CORRECTION to the session-14 entry:** its "Desktop … **567 pass / 57 of 60 files** (3 browser-mode unrun)" figure is
  **WRONG**. `apps/desktop/src` has **exactly 22 `*.test.ts` files** and **no** browser-mode/playwright vitest config —
  all 22 run. The true desktop number was **257** at the session-14 checkpoint (now **267** after session-15's +10 tests).
  The "60 files / 3 unrun" was a session-14 hallucination; ignore it.

### Next
1. **Commit + push** the combined session-14 + session-15 work (still uncommitted; user must confirm the push to `main`).
   Prepared message: `feat(web,desktop): N-gram search tokenizer, notif-sound throttle & renderer crash auto-recovery
   (session 14–15, #33048/#32038, #31996, #32222)`.
2. Backlog: **#33954** native arm64 seshat build QA (only unverified earlier change); **#33048 follow-up** — per-user
   tokenizer dropdown + confirm-reindex dialog (MVVM-v2); **5.1** macOS DND (native module); residual upstream items
   (3.7 #32114 Electron teardown; 5.2 Sequoia OS-banner-sound).

## 2026-06-25 (session 14) — Batched: N-gram search tokenizer (#33048/#32038), notif-sound throttle (#31996), renderer crash auto-recovery (#32222), #32114 document-only

Directive: "continue to fix the problems with phases." Picked up the remaining un-analyzed candidates.

> ⚠️ **STATE AT CHECKPOINT (mid-session, user requested /compact): ALL WORK IS UNCOMMITTED** in the
> working tree and **fully verified green**. The commit+push was prepared but **the push was blocked by
> the auto-mode classifier** (user's last message only asked to write memorybank), so **nothing was
> committed** — HEAD is still `21cb669`. **To resume: re-run the final verification (below), then commit +
> push** the message drafted in this session (see the prepared `feat(web,desktop): … session 14` message)
> **after the user confirms.** Then optionally apply the two deferred review-fix TODOs (B + C below).

### Triage (4-agent workflow → structured verdicts; all verified against gh + the real code)
- **#33048 N-gram tokenizer (#32038 CJK / #32343 non-stopwords): fix-now, high conf.** **KEY UNBLOCK:** the
  memorybank claimed this was blocked on a seshat 4.2.0 bump, but `apps/desktop/package.json` already pins
  `matrix-seshat 4.3.0`, the `aarch64-apple-darwin` `.node` is built, and the binding ALREADY exposes
  `tokenizerMode`/`ngramMinSize`/`ngramMaxSize` (`.hak/hakModules/matrix-seshat/index.js:155-162`; Rust
  `~/.cargo/.../seshat-4.3.0/src/config.rs:219` `TokenizerMode::Ngram`). **Offline mandate satisfied — no fetch.**
- **#31996 notif-sound stacking: fix-now, low effort.** Renderer Web-Audio path, no throttle.
- **#32222 white-screen-after-return: track-upstream + in-repo MITIGATION.** Crash is upstream Chromium/GPU;
  the in-repo gap = no `render-process-gone`/`unresponsive` handler → permanent dead window.
- **#32114 crash-on-close: document-only.** Electron already 42.3.3 (14 majors past the crashing 1.11.58);
  native NSMenu/V8 teardown use-after-free, no in-repo lever; catalogue's "tray.destroy on quit" is a no-op
  on darwin (no tray on macOS). Recorded; not actioned.

### Implemented (all TDD; #31996 + #32222 via parallel background agents on disjoint files; #33048 led in main loop)
- **#33048 (Phase 4.3, web+desktop):** new `tokenizerMode` device+CONFIG setting (`Settings.tsx`, default
  `"language"`, literal-union `IBaseSetting<"language"|"ngram">`, `LEVELS_DEVICE_ONLY_SETTINGS_WITH_CONFIG`)
  threaded `EventIndexPeg.initEventIndex` (reads `getValueAt(DEVICE,"tokenizerMode")`, passed at BOTH call
  sites incl. the userVersion-0 recreate) → `BaseEventIndexManager` → `SeshatIndexManager` → IPC `args[2]` →
  `seshat.ts`. New pure DI modules **`seshat-config.ts`** (`normalizeTokenizerMode`, `createSeshatConfig`,
  `DEFAULT_TOKENIZER_MODE`, `NGRAM_MIN/MAX_SIZE=2/4`) + **`seshat-index.ts`** (`initEventIndex(path,passphrase,
  mode,deps)` — DI'd). **Design (safer than upstream PR #33048's subset):** the tokenizer is baked into the
  on-disk schema, so the desktop persists the active mode in `Store("seshatTokenizerMode")` and, when it
  changes, **deletes the index dir BEFORE constructing** so seshat rebuilds cleanly with the new tokenizer (the
  index is a rebuildable local cache — NO message history lost; the crawler + session-12 `reconcileMissedRooms`
  re-populate; default `"language"` means existing users are never disrupted; a freshly-emptied index re-checkpoints
  via the existing `isEventIndexEmpty()`→`needsInitialCheckpoints` path, so **EventIndex.ts is NOT touched**).
  Pre-existing `ReindexError` recovery preserved (SeshatRecovery now also gets the tokenizer config). **DEFERRED**
  (documented, not done): the per-user dropdown UI + the destructive-reindex confirm dialog (upstream's class
  components, not MVVM-v2) — for now the setting is reachable via `config.json` `{"setting_defaults":{"tokenizerMode":"ngram"}}`
  (`getValueAt(DEVICE,…)` falls through DEVICE→CONFIG→DEFAULT — verified in `SettingsStore` `LEVEL_ORDER`).
  Files: `@types/matrix-seshat.d.ts` (IConfig +tokenizerMode/ngram), `seshat-config.ts`(+test), `seshat-index.ts`(+test),
  `seshat.ts`, `store.ts`; web `Settings.tsx`, `BaseEventIndexManager.ts`, `EventIndexPeg.ts`, `SeshatIndexManager.ts`,
  `i18n/strings/en_EN.json` (`settings|security|message_search_tokenizer_mode`), +`SeshatIndexManager-test.ts`/`EventIndexPeg-test.ts`.
- **#31996 (Phase 5.2, web):** `Notifier.playAudioNotification` now throttles per **resolved sound** (a
  `Map<soundKey, lastMs>`, `NOTIFICATION_SOUND_THROTTLE_MS=1000`, keyed on `sound?.url ?? "default"`, AFTER the
  silence gate) so a wake-from-sleep backlog of IDENTICAL sounds coalesces to one play while two DIFFERENT sounds
  within the window both still play. Honest scope: does NOT fix the macOS-Sequoia `silent:true`-ignored OS-banner
  variant. Files: `Notifier.ts`, `Notifier-test.ts`.
- **#32222 (Phase 3.8, desktop):** new **`renderer-recovery.ts`** (`setupRendererRecovery(win)`, pure
  `decideRendererRecoveryAction`, `RendererRecovery` class): auto-reload on `render-process-gone` for crash-class
  reasons only (`crashed`/`oom`/`launch-failed`/`integrity-failure`; EXCLUDES `clean-exit`/`killed`/`abnormal-exit`/
  `memory-eviction`), suppressed during `global.appQuitting`/`isDestroyed`, rolling cap **3 reloads / 60s → error
  dialog** (`renderer_crash` i18n); `unresponsive` reloads at most once/window; `isCrashed()`-gated reload-before-show
  in `activate`/`second-instance`. **MITIGATION of an upstream crash, not a root-cause fix** (stated in code). Files:
  `renderer-recovery.ts`(+test), `electron-main.ts`, desktop `i18n/strings/en_EN.json`.

### Adversarial review (5-agent workflow) → NO real correctness/data-loss/crash bugs; applied the genuine quality fixes
Verified findings (all `isRealBug=false` except test-coverage gaps): **APPLIED** — (A) Notifier throttle re-keyed
**per-sound-URL** so distinct custom-room sounds aren't suppressed [R3#1]; (E) **dropped the Store `enum`** on
`seshatTokenizerMode` (brick-risk: conf `clearInvalidConfig:false` rejects ALL reads on a bad value; matches sibling
keys) [R1#3]; (F) `deleteContents` now `afs.rm(…,{recursive,force})` (future-proofs the rebuild) [R1#5]; (G) warn on a
coerced/typo'd config `tokenizerMode` [R1#4]; (D) added the combined mode-change+ReindexError seshat test; Notifier
boundary + distinct-sound + silence-not-armed tests. **DEFERRED (review-recommended, NOT done — TODO next session):**
- **(B)** Route the inline `activate`/`second-instance` `isCrashed()&&reload()` in `electron-main.ts:596,657` through a
  new capped `RendererRecovery.recoverIfCrashed()` (have `setupRendererRecovery` RETURN the instance; store a module
  ref) so a user-initiated relaunch can't re-arm an already-given-up crash loop [R4#1, R5#4]. Low severity (user-initiated).
- **(C)** Add renderer-recovery tests: assert excluded reasons (`abnormal-exit`/`memory-eviction`) → `"ignore"` (the
  reload test is self-referential over `CRASH_REASONS` so widening it survives) [R5#1]; and the `unresponsive`-at-cap →
  `showDialog` branch [R5#2]. (Medium-rated TEST gaps; the SOURCE is correct.)
**Documented-not-fixed (rejected as speculative/by-convention):** R1#2 IndexError-not-ReindexError sniffing (fragile;
not triggerable today — the up-front delete prevents any tokenizer mismatch); R4#2 unresponsive-dialog de-dupe (Electron
fires `unresponsive` once/hang); R5#7 `seshat.ts` IPC-glue test (native-module integration boundary, like the other 15
IPC cases); R2 pre-existing garbled `BaseEventIndexManager` JSDoc.

### Verification (FINAL, all green — re-run these to resume)
- Desktop: `apps/desktop/node_modules/.bin/vitest run` → **567 pass / 57 of 60 files** (the 3 unrun = pre-existing
  playwright browser-mode, `chrome-headless-shell` not installed — NOT a regression). `tsc --noEmit -p tsconfig.json`
  clean. `eslint --max-warnings 0` + `prettier --check` clean on changed files.
- Web (via `scratchpad/webjest.sh`, recreated each session — EXTEND `jest.config.ts`'s `transformIgnorePatterns`
  allowlist, do NOT replace; Jest 30 `--testPathPatterns`): `SeshatIndexManager-test|EventIndexPeg-test|EventIndex-test|
  Searching-test` **61 pass**; `Notifier-test` **54 pass**; `SearchWarning-test` green. Web `tsc` only the 4 pre-existing
  vendored matrix-js-sdk errors. eslint/prettier clean; web i18n gen produces **no diff** (key consistent).
- **Not verifiable here (manual QA):** real Seshat ngram sqlite round-trip + CJK search; live macOS wake-from-sleep
  sound; a real renderer crash + reload; #33954 native arm64 build.

### Next (recommended)
1. **Commit + push** this session's work (uncommitted; user must confirm the push to `main`).
2. Apply deferred review fixes **(B)** + **(C)** above.
3. Remaining backlog: **#33954** native arm64 build QA (only unverified earlier change); **#33048 follow-up** — the
   per-user tokenizer dropdown + confirm-reindex dialog (MVVM-v2); **5.1** macOS DND (native module); **5.2** any
   residual Sequoia OS-banner-sound variant (OS-only); **3.7** #32114 (upstream Electron, documented).



### Context / pick
- On `main`, working tree clean, `origin/main` == `main` == `11e2bcf` (sessions 1–9 all pushed). User directive:
  "handle multiple phases this session to finish quickly, use subagents." So: triage everything remaining in parallel,
  then implement the real in-repo fixes concurrently on disjoint files.

### Triage (8-agent parallel workflow → structured verdicts; the 3.2 agent errored, researched manually)
- **fix-now:** 3.2 (#32267), 6.1 (#32362 only), 6.3 (#32018), 4.1 (#32253).
- **skip-mischaracterized / track-upstream (skeptic check, cf. #32288):**
  - **1.4 #32426** mute hotkey: ⌘D works for legacy 1:1 (`LegacyCallView.onNativeKeyDown`) but voice rooms/group calls
    use Element Call as a **cross-origin iframe widget**; the keydown never reaches element-web's document. Reproduces on
    web. Belongs upstream in element-call. No desktop-file involvement.
  - **2.3 #32184** Nightly update: `updater.ts` feed handling is correct; failure is native **Squirrel.Mac/ShipIt**
    bundle-swap, reproduces on mainline, self-heals on retry. Same class as #32404. No JS fix.
  - **3.5 #32352** tray-exit-during-call: tray `app.quit()` → `beforeQuit` sets `appQuitting=true` → close handler stops
    hiding → `window-all-closed` → exit. Already force-quits; no in-repo blocker. Ancient (riot-web 1.5.12/Linux).
  - **6.2 #32351/#32337/#32284** config: the **session-7 shallow-`Object.assign` hypothesis is REFUTED** (high conf).
    The asar config has no top-level `jitsi`/`integrations`, so `Object.assign` has nothing to clobber, and the renderer
    deep-merges defaults (`SdkConfig.ts:81` lodash `mergeWith`). Real causes: #32284 = integration-manager + casing,
    #32337 = upstream SDK race + Electron `.well-known` cache, #32351 = **feature gap** (no system-wide config path).

### Fixes shipped (4 parallel implementation agents, disjoint files, TDD)
- **3.2 (#32267)** [window-close.ts](../apps/desktop/src/window-close.ts) NEW pure `resolveWindowCloseBehavior` →
  `quit`/`hide-app`/`hide-window`; darwin close handler now `app.hide()` (⌘W ≡ ⌘H — maintainer dbkr's stated intent;
  **not** a prompt, which he rejected). Tray/non-darwin path unchanged. 8 tests. Commit `57ef7d5`.
- **6.1 (#32362)** [save-image.ts](../apps/desktop/src/save-image.ts) NEW `saveImageToFile(url,filePath,session)` uses
  `webContents.session.fetch()` so the `media-auth.ts` `webRequest` interceptors (URL rewrite + Bearer) apply (was the
  main-process **global `fetch()`** → 401/404 on authenticated media). #32355 already renderer-fixed. 7 tests. Commit `872c2af`.
- **6.3 (#32018)** [macos-titlebar.ts](../apps/desktop/src/macos-titlebar.ts) drag strips 13–24px → **32px**; CSS extracted
  to pure `buildTitleBarCss()`. 11 tests. Commit `d6002f4`.
- **4.1 (#32253)** [SearchWarning.tsx](../apps/web/src/components/views/elements/SearchWarning.tsx) warns while Seshat is
  still crawling (`currentRoom() !== null`), `changedCheckpoint`-subscribed auto-clear, new i18n key. 6 tests. Commit `90207fd`.

### Adversarial review (18-agent workflow: 4 fixes × 3 lenses → per-finding skeptic) — 2 confirmed (both low), applied
- **3.2:** `app.hide()` leaves `BrowserWindow.isVisible()` true (NSApp-level hide), so the `second-instance` relaunch
  handler's `if (!isVisible()) show()` would skip and leave the window hidden on that (narrow) path. **Fix:** `app.show()`
  (darwin-only no-op) before the visibility checks. (The common dock-relaunch path already recovers via `app.on("activate")`.)
- **4.1:** the partial-index warning mounts dynamically mid-session → not announced to screen readers. **Fix:** `role="status"`
  on that container only (+ a test asserting the role). 6.1 and 6.3 had **zero** findings; 4 other 4.1 findings dismissed
  as non-blocking (e.g. `currentRoom()` is an imperfect proxy for an unloaded-room checkpoint — accepted, by design).

### Verification
- Desktop `vitest run`: **171/171** (14 files; +3 new: window-close 8, save-image 7, macos-titlebar 11). `tsc`/`eslint
  --max-warnings 0`/`prettier --check`/**knip** clean. (Fixed 2 eslint `explicit-function-return-type` nits post-agent.)
- Web `SearchWarning` Jest **8/8** (re-run independently). Web `tsc`: only the 4 pre-existing vendored matrix-js-sdk
  errors (none in our file). eslint/prettier/`matrix-i18n-lint` clean.
- **Not verifiable here (manual macOS QA):** ⌘W app-hide UX, the drag feel, authenticated-media save on a live build.

### Recommended next session
- **#32351** system-wide config path (a feature; confirm path with maintainers) — the only actionable remnant of 6.2.
- PR shortlist #33954 / #33955+#33956; **6.4 #32315** smooth-scroll; **3.6 #32273** download-toast freeze (verify repro).

## 2026-06-24 (session 9) — Phase 3.3: insource window-state restore (#32228 / #32360)

### Context / pick
- Working tree clean, on `main`, 1 commit ahead of `origin/main` (session-8 Phase 3.4 `1e06fa8`, unpushed). Picked
  Phase 3.3 — top recommended in-repo + unit-testable window/lifecycle item.

### Research (6-agent workflow: gh + dep audit + code-map + upstream-PR scan → structured synthesis)
- **#32228** ("remember window size", OPEN since 2022, S-Minor/O-Frequent): the unmaintained `electron-window-state@5.0.3`
  only writes state in its `closed` handler. Element's macOS `close` handler does `e.preventDefault()` + hide (window
  never destroyed), so `closed` never fires → geometry only flushed on a real quit, lost on crash/force-quit. Secondary:
  the lib's strict `display.bounds` full-containment check resets menu-bar/notch/multi-monitor layouts to defaults.
- **#32360** ("always starts in fullscreen"): reported mostly on **Linux tiling WMs** (the macOS framing is wrong). The
  lib persists `isFullScreen` and re-applies it via `setFullScreen(true)` on launch; the flag is sticky (Element quits
  without un-fullscreening; tiling WMs report `isFullScreen()=true` spuriously).
- Verdict: **replace the dep** (maintainer t3chguy explicitly suggests insourcing, cf. VS Code). No upstream PR to adopt.

### Fix shipped (TDD: RED → GREEN)
- NEW [window-state.ts](../apps/desktop/src/window-state.ts) — pure helpers `boundsAreValid` / `isVisibleOnSomeDisplay`
  (workArea overlap ≥100px each axis, not strict containment) / `resolveRestoreState` / `captureState`, plus a
  `WindowStateManager` class (constructor reads `Store.instance.get("windowState")`; `getRestoreState(displays)`;
  `persist(win)` with a destroyed-window `try/catch`; `monitor(win)` debounces resize/move and immediately persists
  maximize/unmaximize/leave-full-screen, cancelling the timer on `closed`).
- [store.ts](../apps/desktop/src/store.ts): new exported `WindowBounds` / `PersistedWindowState` (`{bounds?, isMaximized?}`)
  + `StoreData.windowState` + JSON schema (bounds requires x/y/width/height; `additionalProperties:false`).
- [electron-main.ts](../apps/desktop/src/electron-main.ts): dropped `import windowStateKeeper`; added `screen`; window
  created from `windowState.getRestoreState(screen.getAllDisplays())`; ready-to-show restores **maximized only** (no
  `setFullScreen`); `monitor()` attached; synchronous `persist()` in the `close` handler and before the Cmd+Q `app.exit()`.
- [package.json](../apps/desktop/package.json) + `pnpm-lock.yaml`: removed `electron-window-state` (electron-store@11
  already present; no new dep).
- **Fullscreen is deliberately NOT restored** (VS Code `restoreFullscreen:false` precedent) — the definitive #32360 fix.

### Adversarial review (21-agent workflow, 4 dimensions → per-finding skeptic) — 17 findings, 10 confirmed
- **CRITICAL (high-confidence, acted on):** the first cut still restored fullscreen, so quitting *while* fullscreen via
  `app.quit()` (`appQuitting=true` skips the un-fullscreen branch) persisted `isFullScreen:true` → #32360 unfixed on the
  real-quit path. Three findings converged on this. **Resolution: stop restoring fullscreen entirely** (stronger than the
  reviewers' "normalise the flag on quit"; also kills the async `setFullScreen(false)` race and the appQuitting asymmetry).
- **Applied (others):** destroyed-window `try/catch` + `closed`→clearTimeout (stale-timer teardown crash); Cmd+Q
  `app.exit()` geometry flush (app.exit fires no `close`); test-quality — 100px overlap boundary (was untested,
  off-by-one `>=`→`>` survived), debounce **coalescing** proof (single-event test couldn't tell a debounce from a
  per-event timer), end-to-end leave-full-screen capture, destroyed-window guard.
- **Documented, not fixed (with rationale):** legacy `window-state.json` ignored → one-time reset on upgrade
  (self-healing; migration not worth the I/O risk for S-Minor); the `electron-main.ts` close/exit glue stays unit-untested
  by repo convention (logic lives in `window-state.ts`); the schema is machine-written only so the conf/AJV validation
  can't be meaningfully unit-tested against the in-memory store mock.

### Verification
- `vitest run` (apps/desktop): **145 pass / 11 files** (+43 in `window-state.test.ts`). `tsc --noEmit`: clean.
  `eslint --max-warnings 0` (4 changed src + test): clean. prettier `--check`: clean. **knip** (root): clean (dep removed).
- Not verifiable here: real macOS multi-monitor restore + the live launch geometry (manual QA on a signed build).

### Recommended next session
- **Phase 3.2** Cmd-W orphan-window prompt (#32267) — verify the exact repro first (darwin `close` already hides).
- **Phase 3.3 follow-up (optional):** best-effort one-shot migration importing the legacy `window-state.json` to avoid
  the one-time geometry reset on upgrade.
- **Phase 5.3 (#32288)** only after a live-build re-confirm; PR shortlist **#33955+#33956** Seshat backfill resilience.

## 2026-06-24 (session 6) — Phase 3.1 macOS warnBeforeExit default → opt-in (#32287)

### Context / pick
- Session 5's Phase 0.3 work was already committed+pushed as `01e11ec` (an external actor committed it with
  an equivalent message while this session started; the working tree was clean). Re-verified before continuing:
  `StorageManager-test` 17/17 pass, eslint/prettier clean.
- Researched the next-priority Phase 1.2/1.3 screen-share issues first (#32398, #32075) via `gh` + the Electron
  42.3.3 type defs. **Finding (changed the plan):** the catalogue mis-scoped them as in-repo macOS fixes. Electron
  42.3.3 `setDisplayMediaRequestHandler({useSystemPicker:true})` docs (`electron.d.ts:13167-13171`) confirm that on
  **macOS 15+ the system picker is used and the handler is NOT invoked** — so the "two pickers fight on macOS"
  premise is wrong; the tree already ships `{useSystemPicker:true}`. #32398 (2017→2026, X-Blocked/Z-Upstream/A-Jitsi)
  is largely fixed by the Electron-42 bump (recent issue comments confirm the system picker now appears); #32075 is a
  native Wayland/PipeWire **segfault** (`base_capturer_pipewire.cc ScreenCastPortal failed`, `core dumped`), mostly
  Linux/upstream, maintainers suggest closing as a dup. **User chose to pivot to Phase 3.1.**

### Fix shipped (TDD: RED → GREEN)
- Root cause: `warnBeforeExit` defaulted to `true` everywhere (schema `store.ts` + `store.get("warnBeforeExit", true)`
  in the ⌘Q handler), so macOS users got a confirm dialog on ⌘Q — contrary to the native convention that ⌘Q quits
  immediately (#32287, open since 2021, T-Enhancement; maintainer t3chguy resisted a *global* off-by-default but users
  specifically want the macOS native behaviour). The ⌘Q path is real: `exitShortcuts` (electron-main.ts:225-230)
  matches `darwin && meta && !control && Q`; the `before-input-event` handler (line 459) `preventDefault()`s it
  (shadowing the menu `role:"quit"` accelerator) and shows the dialog when `shouldWarnBeforeExit`.
- Change — **platform-aware default**, explicit user choice always preserved:
  - [store.ts](../apps/desktop/src/store.ts): new `Store.shouldWarnBeforeExit()` → `this.get("warnBeforeExit",
    process.platform !== "darwin")` (false on darwin, true elsewhere); schema `default` also made
    `process.platform !== "darwin"` for consistency with the method + sibling settings.
  - [electron-main.ts](../apps/desktop/src/electron-main.ts):470 — `store.get("warnBeforeExit", true)` →
    `store.shouldWarnBeforeExit()`.
  - [settings.ts](../apps/desktop/src/settings.ts):31 — the `Electron.warnBeforeExit` read bridge →
    `Store.instance?.shouldWarnBeforeExit()`.
  - [Settings.tsx](../apps/web/src/settings/Settings.tsx):1500 — web fallback `default: true` → `default: !IS_MAC`
    (`IS_MAC` already imported from `../Keyboard`, via `navigator.platform`) so the toggle's pre-load fallback matches
    the macOS platform default. No-op on jsdom/Linux (IS_MAC=false), differs only on real macOS.
- Tests [store.test.ts](../apps/desktop/src/store.test.ts): new `describe("shouldWarnBeforeExit (#32287)")` (6 tests):
  darwin/win32/linux unset defaults, darwin explicit opt-in, win32 + linux explicit opt-out; per-test
  `Object.defineProperty(process,"platform")` override. Self-contained `beforeAll` inits the Store singleton if needed.

### Adversarial review (workflow) — 20 agents, 4 lenses → per-finding skeptic verifiers
- 16 findings, 15 "real". Applied receiving-code-review rigor (evaluated each, not blind agreement). Acted on **2**:
  (1) **test-ordering dependency** — my describe relied on the prior suite's `beforeAll` initialising `Store.instance`
  (would crash under a `-t` filter) → added a self-contained `beforeAll`. (2) **Settings.tsx web default** mismatched
  the new macOS platform default → `default: !IS_MAC`. **Rejected as out-of-scope:** the menu `role:"quit"` bypass of
  the warn dialog (pre-existing; my change makes macOS *more* consistent, and "fixing" it would *expand* warnings —
  the opposite of #32287). **Kept:** the redundant-but-harmless schema default (matches sibling-setting style; conf's
  `get(key,default)` uses the explicit fallback, so the method is the source of truth). Skipped a hypothetical
  non-boolean-stored-value test (type/schema-prevented).

### Verification
- `vitest run` (apps/desktop): **360 pass / 43 files** (store.test.ts 12/12; +6 new). (3 playwright browser-mode files
  don't run here — pre-existing `chrome-headless-shell` not installed; unrelated.)
- prettier `--check` (5 files): clean. eslint `--max-warnings 0` (4 desktop + Settings.tsx): clean. desktop
  `tsc --noEmit`: clean. web `tsc`: only the 4 pre-existing vendored matrix-js-sdk errors (none in Settings.tsx).
- Not verifiable here: real macOS ⌘Q behaviour on a signed build (pure-logic default flip, fully unit-covered).

### Known limitation (documented, not fixed)
- Menu **File→Quit / app-menu Quit** (`vectormenu.ts` `role:"quit"`) bypasses the `before-input-event` warn path on
  all platforms — pre-existing. On macOS with the new default this is harmless (both quit immediately); it only
  diverges if a user explicitly re-enables the warning. Out of scope for #32287 (which wants *fewer* macOS warnings).

### Recommended next session
- **Phase 2.2** non-writable `/Applications` auto-update guidance (#32404), or **Phase 5.3** remove "99+" dock badge
  cap (#32288, clean small macOS fix), or the PR adopt shortlist (**#33954** arm64 AES build flag, **#33957**
  timeline-reset guard — both low-effort, validated in `upstream-pr-review.md`).

## 2026-06-24 (session 5) — Phase 0.3 web StorageManager.tryPersistStorage hardening (#32198/#32108/#32472)

### Goal

Continue the phase plan: Phase 0.3 — harden web-side `StorageManager.tryPersistStorage()` so the browser is
asked to make storage durable and a denial is acted upon, mitigating the IndexedDB-eviction → forced-logout /
recovery-key-every-restart data-loss cluster.

### Research (multi-agent workflow: gh + firecrawl + context7 + Explore)

- **Root cause confirmed:** #32198 and #32108 are the `checkConsistency()` IndexedDB-eviction branch
  (richvdh + OP logs: "Data exists in local storage and crypto is marked as initialised but no data found in
  crypto store. IndexedDB storage has likely been evicted by the browser!"). The crypto store lives in IndexedDB;
  a non-"persistent" origin is evicted LRU under storage pressure → key loss → forced logout. #32472
  (recovery-key-every-restart) is the deterministic per-boot `session_restore` failure — more likely the
  pickle-key/safeStorage path (already mitigated by Phase 0.1, 25cd00a) than opportunistic eviction.
- **The gap:** `tryPersistStorage()` called `navigator.storage.persist()` but only **logged** the boolean —
  never acted on `false`, never warned, never distinguished desktop. Merged PR #31299 already moved the call into
  `onLoggedIn` so it fires on every session restore (→ a `persisted()` short-circuit is worthwhile).
- **Electron persist() reality:** Electron does NOT auto-grant; `persist()` runs Chromium's durable-storage
  heuristic and **commonly returns false** on a custom-scheme (`vector:`) renderer (no engagement/bookmark/notif
  signal). There is **NO main-process API** to force durability (`persistent-storage` is not in the
  `setPermissionRequestHandler` enum; no `session` quota-grant). Only lever: notifications permission. So the
  web-side change is the realistic ceiling — improves observability + warns, cannot itself make storage durable.
- **Conventions verified:** desktop marker `!!window.electron` (typed `@types/global.d.ts:127`); `no-floating-promises`
  OFF in `src/` (only playwright) so the fire-and-forget caller needs no `void`; tests are **Jest** (`-test.ts`,
  `jest-fixed-jsdom`, `fake-indexeddb/auto`) and jsdom lacks `navigator.storage` (must `Object.defineProperty`);
  `logger.warn` IS captured by rageshakes (`rageshake.ts:50` `warn:"W"`); i18n via `pnpm i18n` (not needed here).

### Fix shipped (TDD)

- [StorageManager.ts](../apps/web/src/utils/StorageManager.ts): `tryPersistStorage()` →
  `async (): Promise<boolean>`. Order: (1) if `navigator.storage.persist` exists — try `persisted()` first and
  short-circuit `return true` if already durable (query failure is caught and **does not block** the request);
  else `await persist()`, log, and on `false` call `warnPersistenceDenied()`; return the boolean. (2) Safari
  `document.requestStorageAccess` fallback (await in try/catch). (3) else "Persistence unsupported" → false.
  Whole body wrapped in try/catch → `error(...)` + return false, so it **never rejects**. New `warn()` helper +
  `warnPersistenceDenied()` (desktop note gated on `window.electron`).
- Call site `MatrixChat.tsx:1550` unchanged (bare fire-and-forget; the now-Promise never rejects).
- **No i18n / no UI / no toast** — deliberate (see phases.md session 5 rationale: false-alarm flood + maintainer
  dialog-fatigue). "Recovery before forced logout" deferred (evicted crypto store is unrecoverable).
- Tests [StorageManager-test.ts](../apps/web/test/unit-tests/utils/StorageManager-test.ts): +11 (17 total).

### Adversarial review (workflow) — caught test-quality gaps (no source bugs)

- 20 agents (3 review dimensions → per-finding skeptic verifiers). 17 findings → **3 confirmed real, all
  test-quality**: (1) the throw test didn't assert `logger.error` and the symmetric `persisted()`-rejects path
  was untested; (2) no test for `storage` present but `.persist` absent → Safari fallback; (3) no test for
  `persist` present but `persisted` absent → short-circuit skipped. All three fixed. While fixing (1) I added a
  **resilience improvement** (query failure no longer blocks the request) via a proper RED→GREEN cycle.
  (First review run aborted on transient 529 Overloaded; re-ran — did not treat the empty result as "clean".)

### Verification

- Jest (apps/web, via local `transformIgnorePatterns` override allowing matrix-js-sdk's `.pnpm` symlink):
  `utils/StorageManager-test` **17 pass**; `Lifecycle-test` **41 pass / 5 skipped** (no regression).
- `eslint --max-warnings 0` (both files): clean. `prettier --check`: clean. `tsc --noEmit -p apps/web/tsconfig.json`:
  no StorageManager errors (the 4 pre-existing **vendored matrix-js-sdk** errors remain — unrelated, documented).
- Not verifiable here: real desktop eviction behaviour (needs storage-pressure on a packaged build). The change
  is a pure-logic prevention/observability guard fully covered by unit tests.

### Environment note

- The prior session's `scratchpad/webjest.sh` helper was lost (session-specific scratchpad). Recreated it; Jest 30
  renamed `--testPathPattern` → `--testPathPatterns`. Helper now in this session's scratchpad.

### Recommended next session

- **Phase 1.2/1.3** screen-share picker (#32398/#32075), **3.1** macOS `warnBeforeExit` (#32287), or **2.2**
  `/Applications` auto-update guidance (#32404). Also a **main-process follow-up for 0.3**: coax Chromium to grant
  durable storage on desktop (notifications-permission signal) so `persist()` returns true.

---

## 2026-06-24 — Upstream PR review (no code changes)

### Goal

Review open `element-hq/element-web` PRs for improvements relevant to the macOS-desktop remediation
effort; note good ones in the memory bank for implementation after user confirmation.

### Method

Multi-agent workflow (28 subagents): dumped all **95 open PRs**, curated **13 overlapping candidates**,
analyzed each (PR body + full diff + local-code cross-check), adversarially **verified** every verdict,
ran a dedicated **Seshat-cluster-vs-our-circuit-breaker** impact analysis (incl. an empirical 3-way
merge), then synthesized. The `A-Electron` label is **not applied to PRs** (issues only), so overlap was
judged by content.

### Key finding

The fresh **Seshat cluster #33954–#33958** (all by maintainer ara4n, 2026-06-24) targets **#32119**
(CPU spike) + index completeness — our **Phase 4** — and is **complementary, NOT a supersession** of our
Phase 0.2 circuit-breaker (3d5ce8b, #33501 = error-_dialog_ flood). Verified: `onSync` auto-merges
cleanly with #33955; only a trivial private-field block conflict (keep both). Path: **combine**.

### Output (notes only — nothing implemented)

- New: [upstream-pr-review.md](upstream-pr-review.md) — adopt shortlist, Seshat cluster verdict,
  per-PR notes, ordered next actions.
- Adopt/adapt shortlist: **#33954** (arm64 AES build flag, low), **#33957** (timeline-reset guard, low),
  **#33955+#33956** (backfill resilience + progress UI, high), **#33048** (N-gram tokenizer for #32038,
  medium). Track: #33958, #33932, #32804, #33951, #33637. Skip: #33635, #33699, #33724.
- Corrected two wrong curator mappings: #33637→#32288 (wrong platform+direction) and #33699→#32355/#32362.

### Verification

- No source changed; working tree clean before this review. PR/diff facts pulled via `gh` against
  `element-hq/element-web`. All recommendations are pending the user's confirmation before implementation.

---

## 2026-06-24 — macOS Desktop issue research + first critical fixes

### Goal

Detect macOS Element Desktop (`apps/desktop`) problems from GitHub issues, record them in the
memory bank with a prioritised phase plan, and fix the highest-priority problems.

### Research (firecrawl + GitHub)

- Discovered the repo pivot: **`element-hq/element-desktop` is archived** (2 open issues). Active
  desktop issues live in **`element-hq/element-web`** under label `A-Electron` (452 open; ~96 macOS).
- Ran a multi-agent workflow (firecrawl over the GitHub search API, 20 query dimensions):
  **237 unique issues harvested → 118 classified → top 18 deep code-mapped** against `apps/desktop/src`.
- Catalogue: [macos-desktop-problems.md](macos-desktop-problems.md) (45 ranked problems).
- Phase plan (highest→lowest): [phases.md](phases.md) (Phases 0–6).

### Fixes shipped this session (TDD, all tested)

**1. Phase 0.1 — Pickle-key transient-decrypt → permanent session loss** (#32521, #32715, #32198 secondary) 🔴

- Root cause: `SafeStorageWriter.get()` swallowed `safeStorage.decryptString` failures and returned
  `undefined` (indistinguishable from "no secret"); `ipc.ts getPickleKey` then returned `null`
  (renderer uses default pickle key) and `createPickleKey` **overwrote** the still-valid ciphertext —
  turning a transient OS-keychain hiccup into permanent session/crypto loss.
- Change:
    - `apps/desktop/src/store.ts`: new exported `SafeStorageDecryptionError`; `SafeStorageWriter.get()`
      now **throws** it on decrypt failure (vs returning `undefined`); added `StorageWriter.has()` and
      `Store.isSecretUndecryptable()`; basic_text migration loop skips undecryptable keys instead of
      writing `undefined` over them.
    - `apps/desktop/src/ipc.ts`: `createPickleKey` refuses to overwrite an existing-but-undecryptable
      secret (returns `null`, preserves it for recovery); `getPickleKey` comment clarified.
    - Renderer contract verified safe: `Lifecycle.ts` already does `getPickleKey(...) ?? undefined` and
      `createPickleKey` already returns `string | null`.
- Tests: `apps/desktop/src/store.test.ts` (6), `apps/desktop/src/ipc.test.ts` (4).

**2. Phase 2.1 — Start-at-login not working** (#32303) 🟡 O-Frequent

- Root cause: delegated to the unmaintained `auto-launch@^5.0.5` package (fragile macOS LaunchAgent
  plist path resolution for `.app` bundles; reported enabled but never launched).
- Change: rewrote `apps/desktop/src/auto-launch.ts` onto Electron native
  `app.setLoginItemSettings`/`getLoginItemSettings`. Preserved the public API (`AutoLaunch.instance`,
  `getState`, `setState`, `AutoLaunchState`) and `--hidden`/minimised behaviour; Windows path uses
  Squirrel's `Update.exe --processStart` so it survives app updates. Removed `auto-launch` &
  `@types/auto-launch` deps (package.json), their patch (`patches/@types__auto-launch.patch`),
  the `pnpm-workspace.yaml` patch entry, and regenerated `pnpm-lock.yaml`.
- Tests: `apps/desktop/src/auto-launch.test.ts` (6).

### Verification

- `vitest run` (apps/desktop): **33 passed / 7 files** (3 new test files + 4 existing).
- `tsc --noEmit` (src): clean. `eslint --max-warnings 0` (changed files): clean.
- `prettier --write` applied. `knip`: clean (no unused/missing deps from the removal).
- `pnpm install` succeeds and lockfile is consistent.
- Not verifiable here: real macOS GUI behaviour (keychain races, OS login items). The pickle-key fix
  is a pure-logic safety guard fully covered by unit tests; the auto-launch wiring/`--hidden` mapping
  is unit-tested but the actual OS login-item effect needs manual QA on a signed macOS build.

### Environment notes

- `pnpm` is not on PATH; use `corepack pnpm`. The repo `postinstall` calls bare `pnpm`, so a shim
  (`pnpm` → `corepack pnpm`) on PATH is needed for `pnpm install`/scripts to succeed.
- Ran vitest via `apps/desktop/node_modules/.bin/vitest` to avoid pnpm's deps re-check.

### Recommended next session

- **Phase 0.2** Seshat error-dialog circuit-breaker (#33501) — apps/web `EventIndex.ts`, high-confidence, unit-testable.
- **Phase 1.1** macOS media (mic/cam) permissions (#32373) — `electron-main.ts` permission handlers + `electron-builder.ts` `NS*UsageDescription`.

## 2026-06-24 (session 2) — Commit/push + Phase 0.2 Seshat dialog circuit-breaker

### Goal

1. Commit & push the session-1 macOS desktop fixes. 2. Continue the phase plan — fix Phase 0.2.

### 1. Commit & push (done)

- Committed the 13 staged files (Phase 0.1 + 2.1 + memorybank) as `25cd00a`
  _"fix(desktop): macOS data-loss & start-at-login fixes (Phase 0.1, 2.1)"_ and pushed to `origin/main`
  (gitea). Re-ran the 3 new desktop vitest files first (16 pass) to confirm no regression before committing.

### 2. Phase 0.2 — Seshat error-dialog flood → circuit-breaker (#33501) 🔴 S-Critical

- Root cause (confirmed via firecrawl on the GitHub issue + 20 comments): `EventIndex.onSync` fires on **every**
  `/sync`; any throw in `onSyncInner()` (e.g. the Seshat/Neon `SendError`) called
  `logErrorAndShowErrorDialog` → an error dialog **after every sync**, making the app unusable until restart.
  Introduced by PR #31448 (the dialog was deliberate — maintainer richvdh is against silently swallowing;
  Half-Shot objects to repeated non-actionable dialogs). Agreed middle ground = **show once, then stop**.
- Change ([EventIndex.ts](../apps/web/src/indexing/EventIndex.ts)): added `private indexingErrored` flag.
  `onSync` returns early once errored; the `.catch` now (a) dedupes via the flag (guards racing in-flight syncs),
  (b) sets the flag, (c) `this.stopCrawler()`, (d) shows the dialog **once**. Subsequent failures are logged only.
- Tests ([EventIndex-test.ts](../apps/web/test/unit-tests/indexing/EventIndex-test.ts)): mocked
  `logErrorAndShowErrorDialog`; new `describe("when the sync handler throws (#33501)")` with 2 tests —
  "only shows the error dialog once even if syncs keep failing" and "stops the crawler when indexing errors".
  TDD: confirmed RED first (dialog called 3×, stopCrawler 0×) → GREEN after the fix.

### Verification (Phase 0.2)

- `jest indexing/EventIndex-test`: **4 pass** (2 existing + 2 new). `indexing/ + EventIndexPanel`: **14 pass**.
- prettier: clean (unchanged). eslint `--max-warnings 0` on both files: clean.
- `nx lint:types element-web`: 0 errors in our source. (There are 4 pre-existing type errors **inside vendored
  `matrix-js-sdk@41.8.0` src** — crypto-wasm `.d.ts` + `MSC4108SignInWithQR.ts`; verified identical on the clean
  tree via `git stash`, so unrelated to this change. Environment TS 6.0.3 vs SDK mismatch.)

### Environment notes (web/jest, NEW this session)

- apps/web tests use **Jest** (not vitest). Two prerequisites to run them locally:
    1. Build the workspace deps first: `nx test:unit:prepare element-web` (builds `module-api` + `shared-components`
       into `lib/`/`dist/`; otherwise jest can't resolve `@element-hq/element-web-module-api`).
    2. On this machine `matrix-js-sdk` resolves through a `.pnpm` symlink that `jest.config.ts`'s
       `transformIgnorePatterns` excludes from babel → "Cannot use import statement outside a module". Workaround
       (local only, do NOT commit): pass `--transformIgnorePatterns` adding `matrix-js-sdk|matrix-events-sdk|@matrix-org|oidc-client-ts`
       to the allowlist. Helper saved at `scratchpad/webjest.sh "<testPathPattern>"`. CI doesn't need this.

### Recommended next session (unchanged priority)

- **Phase 1.1** macOS media (mic/cam) permissions (#32373) — `electron-main.ts` + `electron-builder.ts`.
- Then **Phase 0.3** web `StorageManager.tryPersistStorage()`, or **1.2/1.3** screen-share picker.

## 2026-06-24 (session 4) — Phase 1.1 macOS mic/cam permissions (#32373)

(Session 3 was a no-code upstream-PR review; see `memorybank/upstream-pr-review.md`.)

### Goal

Continue the phase plan: fix Phase 1.1 — macOS "Couldn't start capturing media" (mic/cam), #32373, S-Critical.

### Research (multi-agent workflow, firecrawl + context7 + Explore)

- Verified the catalogue was stale: `apps/desktop/src/media-auth.ts` already exists but is **misleadingly
  named** — it handles authenticated media _download_ URLs (rewrites `/media/v3/` → `/client/v1/media/`, adds
  Bearer header), NOT mic/cam permissions. Confirmed NO `setPermissionRequestHandler`/`setPermissionCheckHandler`/
  `askForMediaAccess` anywhere under `apps/desktop/src`.
- Confirmed two-part root cause: (a) packaged Info.plist lacks `NSCameraUsageDescription`/
  `NSMicrophoneUsageDescription` → hardened runtime → macOS never raises the TCC prompt (silent deny/crash);
  (b) main process never calls `systemPreferences.askForMediaAccess`, so Chromium getUserMedia is denied before
  the OS prompts. The existing `build/entitlements.mac.plist` device.camera/audio-input entitlements are
  necessary but NOT sufficient (usage strings are Info.plist keys, added via electron-builder `mac.extendInfo`).
- Critical design constraint surfaced by research: with NO handler today, Electron defaults to **grant-all**.
  Registering a handler overrides that for ALL permission types, so it must be **fail-open**; and media must
  **NOT** be origin-gated because widgets/Jitsi request media from remote-origin iframes (`isMainFrame=false`,
  `webContents=null` in the sync check handler). Origin-gating would have broken widget/Jitsi calls.

### Fix shipped (TDD)

- NEW `apps/desktop/src/media-permissions.ts` — `setupMediaPermissions()`:
    - `setPermissionRequestHandler` (async): for `permission === "media"` on `darwin`, map `details.mediaTypes`
      (audio→microphone, video→camera), de-dupe, and for each `not-determined` device `await askForMediaAccess`.
      Wrapped in try/catch so the native TCC call throwing never strands the request. Then **always** `callback(true)`
      (fail-open) — so non-media perms, off-darwin, and widget media keep the prior grant-all baseline.
    - `setPermissionCheckHandler(() => true)` — sync, fail-open, origin-agnostic (tolerates null webContents).
- Wired `setupMediaPermissions()` into `electron-main.ts` `app.ready` right after `setupMediaAuth`.
- `electron-builder.ts`: added `mac.extendInfo` with `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`
  (plain purpose strings, no `$(PRODUCT_NAME)` macro — electron-builder doesn't expand it in extendInfo).
- Tests `apps/desktop/src/media-permissions.test.ts` (11): registration, mic/cam prompts, no re-prompt when
  granted, no askForMediaAccess off-darwin, fail-open non-media, remote-origin widget media granted, null
  webContents check, **never-hangs-on-reject**, empty mediaTypes.

### Adversarial review (workflow) — caught a real regression before commit

- 3 reviewers + per-finding skeptic verifiers (10 agents). 1 of 7 findings confirmed real (high):
  if `askForMediaAccess` rejected, the async handler aborted before `callback(true)` → getUserMedia hangs
  forever (worse than before). Fixed with try/catch + a RED→GREEN regression test. 6 findings dismissed as
  false positives / acceptable.

### Verification

- `vitest run` (apps/desktop): **44 passed / 8 files** (+11 new in media-permissions.test.ts).
- `tsc --noEmit -p tsconfig.json`: clean (0). `eslint --max-warnings 0` (4 changed files): clean.
  `prettier --check`: clean. Not verifiable here: real macOS TCC prompt on a signed build (needs manual QA).

### Recommended next session

- **0.3** web `StorageManager.tryPersistStorage()` (#32198/#32472/#32108), or **1.2/1.3** screen-share picker
  (#32398/#32075), or **3.1** macOS `warnBeforeExit` default (#32287).

---

## Session 7 (2026-06-24) — Phase 2.2: non-writable install auto-update guidance (#32404)

Continued the phase plan. Picked Phase 2.2 over Phase 5.3 (#32288) after verifying #32288 is mischaracterised
in the catalogue: macOS uses raw `app.badgeCount` (no cap) in `badge.ts`; the only in-code cap is the
favicon/Windows overlay (`favicon.ts:148` → `Nk+` for >999), which doesn't match the reporter's "99+". #32404
is the better-grounded in-repo macOS fix.

### Root cause

On macOS, Squirrel.Mac installs an update by atomically **renaming** a freshly-staged `.app` over the existing
one. That swap needs write access to the directory that **contains** the bundle (not the old bundle's inode). An
admin install into `/Applications` run by a non-admin → that dir is read-only → updates download but never
install (silent failure / endless re-download). The wrapper never detected or surfaced this.

### Fix shipped (TDD)

- `apps/desktop/src/updater.ts`: new exported `isUpdateableLocation()` — darwin-only (else `true`), derives the
  `.app` from `app.getPath("exe")` (up 3 levels), `fs.access(<containing dir>, W_OK)`; `false` on
  EACCES/EPERM/EROFS (fail-closed), `true` on other errno e.g. ENOENT in dev (fail-open). `available()` exported
  and, after EOL checks, calls it; if non-writable → one-time `showToast` (`updater|not_writable_*`, `%(brand)s`)
  + `return false` so `start()` never sets the feed URL / polls.
- `apps/desktop/src/i18n/strings/en_EN.json`: new `updater` group (`matrix-gen-i18n` no-diff).
- `apps/desktop/src/updater.test.ts` (NEW, 8 tests). RED→GREEN.

### Adversarial review (17-agent workflow) — 13 findings, 3 confirmed, all applied

1. **correctness (real):** original predicate checked W_OK on the bundle **and** its parent (AND). Squirrel's
   rename only needs the **parent** dir; gating on the bundle could false-negative (wrongly disable updates) for
   an admin-owned read-only bundle in a user-writable folder. **Fixed:** check the containing dir only. Primary
   #32404 case (`/Applications` non-writable) stays correct.
2. **test quality (real):** mode arg wasn't pinned — an `F_OK` mutation would silently re-break #32404.
   **Fixed:** assert `access` called with `fsConstants.W_OK`.
3. **test quality (real):** `%(brand)s` substitution wiring untested. **Fixed:** assert `_t` called with
   `{ brand: "Element" }`. (Remaining 10 findings were no-defect confirmations / false positives.)

### Verification

- `vitest run` (apps/desktop): **58 passed / 9 files** (+8 new in updater.test.ts).
- `tsc --noEmit -p tsconfig.json`: clean. `eslint --max-warnings 0` (changed files): clean. `prettier --check`:
  clean. `matrix-gen-i18n`/`matrix-i18n-lint`: clean. knip safe (`ignoreExportsUsedInFile:true`; exports used
  in-file). **Not verifiable here:** real Squirrel.Mac install on a signed build (manual macOS QA).

### Session 7 (cont.) — Phase 4.4: adopt upstream PR #33957 (timeline-reset re-seed guard, → #32119)

Continued in the same session. Adopted the low-effort PR-review shortlist item #33957.

- **Root cause:** `apps/web/src/indexing/EventIndex.ts` `onTimelineReset` seeded a backward gap-fill checkpoint
  on **every** `RoomEvent.TimelineReset`. matrix-js-sdk (pinned **41.8.0**) emits it as
  `(room, timelineSet, resetAllTimelines)` and **re-emits** via its ReEmitter from thread/filtered
  `EventTimelineSet`s, so any room with one ancient thread re-inflated the crawl list on every launch →
  contributes to the #32119 startup CPU spike.
- **Fix (faithful port of #33957):** `onTimelineReset(room, timelineSet?: EventTimelineSet)` early-returns when
  `timelineSet && timelineSet !== room.getUnfilteredTimelineSet()` (only the room's own unfiltered live timeline
  re-seeds). Pre-existing `isRoomEncrypted` guard + `addRoomCheckpoint(roomId, false)` unchanged, run after the new
  guard. `EventTimelineSet` was already imported; SDK emit signature confirmed via its `.d.ts`.
- **Tests** (`apps/web/test/unit-tests/indexing/EventIndex-test.ts`, Jest, +3, RED→GREEN): thread/filtered set
  reset → no checkpoint; own live-timeline reset → backward `fullCrawl:false` checkpoint; undefined timelineSet →
  still seeds (guards the `timelineSet &&` short-circuit). **Test-harness gotcha hit & fixed:** `mockClientMethodsRooms`
  sets `isRoomEncrypted: jest.fn()` (→ undefined) — the override must come **after** the spread or the encrypted-room
  guard short-circuits (caught via RED diagnosis: all-0-calls).
- **Adversarial review** (13-agent workflow, 10 findings → 1 confirmed, low/cosmetic): reworded the
  undefined-timelineSet test's "(legacy emitters)" label (pinned SDK never emits undefined `timelineSet`; the test is
  valid branch coverage of the short-circuit). Applied.
- **Verification:** EventIndex Jest **7/7**; `eslint --max-warnings 0` + prettier clean on both files; `tsc` only the
  4 pre-existing node_modules/matrix-js-sdk crypto-wasm errors (none in changed files). **Web Jest local-run:** used
  the `scratchpad/webjest.sh` helper (recreated; appends `matrix-js-sdk` to `transformIgnorePatterns`; Jest 30
  `--testPathPatterns`).

### Recommended next session (as of session 7)

- **Phase 5.3 (#32288)** only after re-confirming against a live build (may be no-op/wontfix — see above).
- PR-review adopt shortlist remainder: **#33954** arm64 AES build flag (validate seshat pin/toolchain first), or the
  larger **#33955+#33956** Seshat backfill resilience (Phase 4.2). Or **Phase 3.4** white launch flash (#32260) /
  **Phase 3.2** Cmd-W orphan prompt (#32267).

## 2026-06-24 (session 8) — Phase 3.4: theme-aware window background (#32260)

### Context / pick
- Working tree clean, on `main`, 4 commits ahead of `origin/main` (510c618 + the three session-7 commits, all
  unpushed). Picked Phase 3.4 (white launch flash) — the top "recommended next" item, in-repo + unit-testable.

### Root cause (firecrawl on the issue + code-mapping)
- The reporter suggested the `ready-to-show` pattern, but `electron-main.ts` **already** uses `show:false` +
  `ready-to-show` → `show()`. The real cause: `backgroundColor:"#fff"` (hard-coded white) + `index.html`'s
  transparent `<body>` ⇒ the first painted frame is the white native bg before the themed CSS applies ⇒ dark-theme
  users see a white→dark flash. The renderer already computes the body bg for the `theme-color` meta
  ([theme.ts:386-389](../apps/web/src/theme.ts)) — reused as the source of the colour.

### Fix shipped (TDD, layered, each layer independently testable)
- **`apps/desktop/src/background-color.ts` (NEW):** pure `resolveBackgroundColor(persisted, prefersDark)` (valid
  persisted colour ⟶ else opaque `nativeTheme` default, dark `#101317` / light `#ffffff` = real Compound
  `--cpd-color-bg-canvas-default`→`--cpd-color-theme-bg`) + `isValidThemeColor()` (opaque hex/rgb/rgba(…,1) only).
- **`store.ts`** optional `backgroundColor` key + schema; **`electron-main.ts`** window bg now uses the helper with
  `nativeTheme.shouldUseDarkColors`; **`ipc.ts`** new `setThemeColor` fire-and-forget handler (validate → skip if
  unchanged → persist + live `setBackgroundColor`); **`preload.cts`** + **`global.d.ts`** allowlist/union;
  **`apps/web/src/theme.ts`** reports the colour via `window.electron?.send("setThemeColor", …)` (guarded).
- Design: first launch → OS appearance (default "match system theme"); later launches → exact persisted colour.

### Adversarial review (49-agent workflow) — 22 findings, 2 confirmed (same root)
1+2. **(confirmed) `isValidThemeColor` accepted alpha** (`#rgba`/`#rrggbbaa`/`rgba(…,a<1)`). A **translucent custom
   theme**'s computed body bg would pass → persisted → transparent native window → blurry fonts / see-through launch,
   violating the opaque-background (blurry-font FAQ) invariant the change itself documents. **Fixed:** validator
   enforces opacity (also kills the ambiguous `RRGGBBAA` vs Electron `AARRGGBB` hex-alpha ordering). Tests updated:
   `#ffff`/`#ffffffff`/`rgba(…,0.5)` moved to rejects + explicit `rgba(0,0,0,0)`/`#0000`/`#00000000` rejects + a
   translucent-persisted-→-fallback case.
- Folded in 1 rejected-but-cheap quality win: skip the redundant synchronous `store.set` disk write when the colour
  is unchanged (switchTheme fires on every theme resolution) + a test. 19 other findings nits/by-design (stale
  single-frame self-corrects on next render; ElectronPlatform-seam preference; out-of-range RGB that
  `getComputedStyle` never emits; no-ReDoS/allowlist-correct confirmations).

### Verification
- Desktop: `vitest run` **102/102** (10 files; new `background-color.test.ts` + ipc/theme additions), `tsc -p
  tsconfig.json` clean, `eslint --max-warnings 0 src` clean, prettier clean.
- Web: `theme-test` Jest **15/15** (+2), `tsc --noEmit` **0 errors**, eslint/prettier clean on changed files.
- **Not verifiable here:** the actual flash on a live signed macOS build (manual QA). Committed on `main` (NOT pushed).

### Recommended next session
- **Phase 3.2** Cmd-W orphan-window prompt (#32267) — verify exact repro first (darwin `close` handler already hides).
- **Phase 3.3** persist/restore maximized & fullscreen (#32228/#32360) — has a unit-testable store component.
- **Phase 5.3 (#32288)** only after re-confirming on a live build; PR shortlist **#33955+#33956** Seshat backfill.

---

## Session 11 (2026-06-24) — batched 6 phases via subagents (+2 document-only)

> (Sessions 9–10 are recorded in `phases.md`, which is the authoritative status. This entry covers session 11.)

Directive: handle ALL of the user-selected "Recommended next session" items (phases.md lines 262-289) with subagents.

**Process:** 8-agent triage workflow (5 structured-schema + 3 re-run as markdown after a StructuredOutput retry cap)
→ 6 implement, 2 document-only. Web phase (6.4) implemented by a background agent (isolated to `apps/web`); all desktop
phases implemented serially in the main loop (electron-main.ts is shared by 3.1 + 6.2, so serial avoids cross-talk),
TDD throughout. Then a 6-reviewer adversarial workflow with per-finding independent skeptic verification → 5 confirmed
findings (4 fix-now + 1 document) → all applied → full re-verification.

**Implemented (all TDD):**
- **6.4 (#32315)** Disable smooth scrolling — `Accessibility.disableSmoothScrolling` setting + pure `scrollBehavior.ts`
  `getScrollBehavior()` (OR of the setting and OS `prefers-reduced-motion`); gates the 3 perceptible JS smooth scrolls.
- **1.2/1.3 (#32398/#32075)** Screen-share defensive hardening — consume-once `consumeDisplayMediaCallback`;
  `getDesktopCapturerSources` try/catch → `[]` (no dangling renderer). Root crash stays upstream/Wayland.
- **#33954** (4.3/#32119) — arm64 `--cfg aes_armv8` RUSTFLAGS in `hak/matrix-seshat/build.ts`. Build-flag only; NEEDS
  native arm64 build QA (low break-risk per review: `aes 0.8.4` declares the cfg, no `-D warnings`).
- **3.6 (#32273)** Download-toast "Open" — `await shell.openPath` + error dialog (`download|unable_to_open_*`) + log;
  pure `resolveUserDownloadAction`. Success-path "freeze" = native macOS focus (documented, not in-repo fixable).
- **3.1 follow-up (#32287)** Menu/tray Quit honour warn-before-exit — pure `confirm-quit.ts` `shouldQuitAfterConfirm`
  + `confirmAndQuit` injected into `vectormenu.ts`/`tray.ts` (no import cycle). ⌘Q unchanged.
- **6.2 (#32351)** System-wide config path + deep-merge — pure `config.ts` (`getConfigCandidatePaths`,
  `loadMergedLocalConfig`, `deepMergeConfig`) wired into `electron-main.ts`; replaces the shallow `Object.assign`.

**Document-only:** 5.3 (#32288) no "99+" cap exists; macOS renders it natively, not overridable via `app.badgeCount`.
0.3 main-process durability — no Electron API; notifications already granted yet `persist()` stays false.

**Review → 5 confirmed findings, all fixed:** (config) malformed MDM config aborted the whole load + blamed the user →
per-layer try/catch (only the user-controlled primary rethrows); (config) nested one-sided `__proto__` unstripped →
recurse into one-sided objects; (config) Linux `/etc` ignores branding → documented intentional; (download) failed
open only logged → added error dialog; (download) handler untested → new `webcontents-handler.test.ts` drives the real
`will-download` flow.

**Verification:** desktop `vitest run` **214/214** (19 files; +5 new test files: config/confirm-quit/displayMediaCallback/
user-download/webcontents-handler), `tsc`/`eslint`/`prettier`/**knip**/i18n clean; web `scrollBehavior` Jest **12/12**,
web tsc (only the 4 pre-existing vendored matrix-js-sdk errors), eslint/prettier/i18n clean. **Not verifiable here:**
live macOS (quit dialogs, ⌘W, screen-share cancel, download-open dialog/focus), the **arm64 seshat native build**
(#33954), and real MDM config paths.

## Session 12 (2026-06-24) — Phase 4.2: Seshat backfill completeness + resilience + progress UI (#33955 + #33956)

Directive: "continue to fix the problems with phases." User chose (via AskUserQuestion) **Phase 4.2 — adapt upstream
PR #33955 (backfill completeness/resilience) + #33956 (indexed/indexing/errored progress UI)** onto our tree, the
recommended next in-repo, unit-testable phase. Fixes **#32266** (no results despite index), **#32011** (search misses
messages), strengthens **#32253**; contributes to **#32119** (startup CPU). All web (`apps/web`, Jest).

**Process:** deep research (fetched both PR diffs via `gh pr diff`, mapped every merge point against our tree) →
careful hand-port (NOT `git apply` — our tree diverged: circuit-breaker #33501 + #33957 timeline guard already present)
→ comprehensive Jest suite → full verification → **5-dimension adversarial review workflow (19 agents, 13 findings → 6
confirmed)** → applied 4 (2 code fixes + 3 gate-pinning tests), documented 1 → re-verify.

**Implemented (`apps/web/src/indexing/EventIndex.ts` + ManageEventIndexDialog.tsx + en_EN.json):**
- **`reconcileMissedRooms()`** (#32266/#32011): once per launch when crypto is ready (gated on `getCrypto()`, retried on
  a later sync if not), scans joined rooms and seeds a fullCrawl backward checkpoint for every encryption-enabled room
  with no indexed events and no queued checkpoint. The one-time `addInitialCheckpoints` only covered rooms present at
  index-creation; rooms joined later / missed (crypto not ready, no token, transient failure) stayed unindexed forever.
- **Crypto-aware `isRoomIndexable()`** (`isEncryptionEnabledInRoom`, not legacy state `isRoomEncrypted`) added to
  `onRoomTimeline` (after the cheap gates), `onRoomStateEvent` (rewritten: type-gate → `reconciliationDone` gate to
  avoid the initial-sync isRoomIndexed flood → indexable → try/catch seed), and `onTimelineReset` (**kept the session-7
  #33957 `timelineSet !== getUnfilteredTimelineSet()` guard**, added indexable). `unindexableRooms` set tracks
  state-encrypted-but-can't-speak rooms (excluded, not errored).
- **Crawler resilience:** permanent 4xx (≥400 <500, except 401/429) → drop checkpoint + `erroredRooms.add`; 401/429/5xx/
  network → retry (push back). A live event in a given-up room clears errored + re-seeds (bounded to crawl rate). A
  successful crawl batch clears errored.
- **Fully-crawled sentinel** (#32119): a backward fullCrawl reaching an empty chunk writes a `fully_crawled`-token
  sentinel checkpoint via `addHistoricEvents([], marker, checkpoint)` instead of deleting; `init()` splits loaded
  checkpoints, hydrating `fullyCrawledRooms` and keeping sentinels OUT of the crawl queue. Stops contentless rooms
  (isRoomIndexed=false forever) being re-crawled every launch. Round-trips through the native seshat wrapper (token is
  opaque). Non-fullCrawl / forward empty chunks still just delete.
- **`hasQueuedCheckpoint()` dedup** in `addRoomCheckpoint` (and reconcile's push — review fix) drops exact-duplicate
  checkpoints stacked by gappy syncs.
- **#33956 progress UI:** `crawlingRooms()` → **`getIndexingStatus()`** returning `{indexing, indexed, errored}` (joined
  encrypted rooms only; excludes invites/left + unindexable); `ManageEventIndexDialog.tsx` renders "N indexed, M
  indexing[, K errored]" (errored line only when >0); new i18n `message_search_room_progress[_errored]`, removed
  `message_search_pending_rooms` + old placeholders (en_EN only — other locales sync via the translation pipeline, as
  upstream #33956 did).

**Deliberately OMITTED:** the upstream `window.mxEventIndexDebug` / `listIndexingRooms()` debug hook (untestable dev-only
tooling needing `window as unknown` casts that fight our lint rules; not part of the correctness fix).

**Adversarial review → 6 confirmed (13 raised; 7 refuted, incl. the "stale-locale i18n" findings correctly rejected as
faithful-to-upstream pipeline behavior). Applied 4, documented 1:**
- **(code) per-room containment:** `getMyMembership()`/`isRoomEncrypted()`/`getLiveTimeline().getPaginationToken()` were
  OUTSIDE reconcile's per-room try/catch → a throw would escape `onSyncInner` and trip our **#33501 global breaker**
  (upstream has no breaker, so harmless there; in our tree it would stop ALL indexing + pop the dialog). Wrapped the
  whole per-room body in one log-and-skip try/catch so the port's "per-room error never trips the global breaker"
  invariant actually holds. + regression test.
- **(code) reconcile dedup:** reconcile's own checkpoint push bypassed `hasQueuedCheckpoint`, so a concurrent
  `onRoomStateEvent` seed during one of reconcile's awaits (flag set before the await) could double-queue a room
  in-memory (wasted crawl, self-correcting). Now reconcile re-checks the LIVE queue via `hasQueuedCheckpoint` before
  pushing.
- **(tests) pinned the new crypto gates:** added negative tests for `onTimelineReset` and `onRoomStateEvent`
  (state-encrypted but crypto-can't-speak → no seed) — previously deleting the gate line passed the suite.
- **Documented, not fixed (matches upstream, self-heals on restart, rare):** if `isEncryptionEnabledInRoom` transiently
  throws for one already-encrypted room during the single reconcile pass, that room's history backfill is skipped until
  next launch (live events still index). Faithful #33955 behavior.

**Verification:** web `EventIndex-test` Jest **29/29** (7 existing reconciled with getMyMembership/getCrypto mocks + 22
new: reconcile×8, crawler error/sentinel×4 incl. `it.each` permanent[400/403/404]/transient[401/429/500], dedup×1,
getIndexingStatus×1, onRoomStateEvent×3, onTimelineReset crypto-gate×1, per-room-containment×1), adjacent
`EventIndexPanel` **10/10**, `tsc -p tsconfig.json` (only the 4 pre-existing vendored matrix-js-sdk errors, 0 in our
files), eslint/prettier/i18n:lint clean. **Not verifiable here:** real Seshat sqlite sentinel round-trip on desktop, the
actual /messages crawl against a live homeserver, and the dialog rendering (no ManageEventIndexDialog test harness
exists — `getIndexingStatus` is unit-tested directly). **Open upstream:** #33955/#33956 are still OPEN; if their API
shifts before merge, re-reconcile. Remaining Phase 4.2 query bugs (#32341/#32258/#32356/#32343) + #33048 N-gram
tokenizer (needs the seshat 4.2.0 bump under the offline constraint) untouched.

### Recommended next session (as of session 12)
- **#33954 native arm64 build QA** — still the one unverified earlier change (build seshat for `aarch64-apple-darwin`,
  confirm `--cfg aes_armv8`, measure CPU).
- **Phase 4.2 remainder:** the discrete query-correctness bugs (#32341 search URL in All Rooms, #32258 upgraded-room
  pre-upgrade history, #32356 edited messages, #32343 non-stopwords) — investigate which are in-repo vs upstream
  matrix-seshat; and **#33048** N-gram tokenizer for CJK search (#32038) after the seshat 4.2.0 bump.
- **Phase 5:** 5.1 macOS DND/Focus (#32383, needs vetted native module — design/spike); 5.2 Sequoia notification-sound
  stacking (#31996, ⚠️).

---

## Session 13 (2026-06-24) — Phase 4.2 query-correctness bugs (#32341, #32258, #32356) + #32343 triaged upstream (web-only)

Picked up the user's "continue to fix the problems with phases" directive against the Phase 4.2 **remaining** discrete
query bugs. Process: a 4-agent **triage workflow** (each researched the live GitHub issue via firecrawl + mapped the
in-repo code path) → TDD implementation in `apps/web/src/Searching.ts` → an 8-dimension (5 review + per-finding verify,
14 agents) **adversarial review workflow** → applied fixes → re-verify. All changes are **read-path only** (no
`EventIndex.ts`/`onSyncInner`/#33501 breaker/#33957 guard/reconcile touch).

- ✅ **#32341** "Search failed: unable to search URL in All Rooms". Root cause = tantivy's `field:value` grammar: a term
  with a colon (`https://github.com`) is parsed as field `https` → `FieldDoesNotExist`; the in-repo amplifier was
  `combinedSearch()` using `Promise.all`, so the Seshat rejection sank the whole All-Rooms search even though the server
  leg succeeded. Fix: `combinedSearch()` → `Promise.allSettled` (degrade to the surviving leg; throw only if BOTH fail),
  and `hardenSeshatSearchTerm()` phrase-wraps a colon-bearing term for the **Seshat leg only** (the homeserver body keeps
  the raw term). Hardener is closed-phrase-aware (review fix: an unbalanced leading quote is escaped+wrapped, not passed
  through to another tantivy syntax error).
- ✅ **#32258** "Upgraded encrypted room search misses pre-upgrade history". Root cause = local search scoped to one
  `room_id`, never walking the upgrade predecessor chain. Fix: `getRoomSearchChain()` walks `room.findPredecessor()`
  (cycle-guarded, depth-cap 20); the single-room path **partitions the chain by per-room encryption** — encrypted rooms
  via Seshat (`chainSearchProcess` runs a per-room Seshat query and k-way merges by recency; paginated per source via a
  `LOCAL_CHAIN_NEXT_BATCH` sentinel + per-room `next_batch` in `seshatChainQueries`), known non-encrypted predecessors via
  the homeserver (`filter.rooms`), merged into the same source pool (review fix: the original cut routed the **whole**
  chain Seshat-only by the current room's encryption, silently dropping an unencrypted predecessor's history).
- ✅ **#32356** "Search doesn't render edited messages". Root cause = the Seshat match for an edit is the `m.replace`
  event, which `haveRendererForEvent` drops, so the count says 1 but nothing renders. **CRITICAL review finding:** simply
  rewriting the edit's content is discarded — the SDK event mapper does `room.findEventById(event_id)` and **reuses the
  live `m.replace` model** for a loaded room. Fix: **re-key the matched result to its target (original) event id** so the
  mapper resolves the renderable original (which already carries the aggregated edit when loaded) and, when the original
  is not loaded, builds a fresh event from the promoted `m.new_content`. Results are de-duped (edit re-keyed to original
  alongside the original itself → one tile) and an empty `m.new_content` is left untouched (no blank tile). Permalink now
  targets the original (also improves #17097).
- ⬆️ **#32343** "Search misses certain non-stopwords" = **UPSTREAM, document-only**: pure native tantivy tokenizer
  (`SimpleTokenizer`+`LowerCaser`+`RemoveLongFilter` 40-byte drop); no in-repo TS query/tokenization bug. Same family as
  #32038 / PR #33048 (N-gram tokenizer, gated on the matrix-seshat 4.2.0 bump under the offline constraint). A TS-side
  term rewrite would diverge the local Seshat term from the verbatim server term and break `combineResponses` merging.
- **Adversarial review → 7 confirmed findings:** 5 fixed (the #32356 mapper-reuse HIGH; the #32258 mixed-encryption MED;
  the #32341 unbalanced-quote LOW; the #32356 duplicate-tile MED via dedup; the #32356 empty-content LOW via guard), 2
  documented as accepted degradation (the #32341 degraded-leg pagination is latent/sticky — sound because each leg ≤
  SEARCH_LIMIT so the degraded first page never overflows `cachedEvents`). 2 further review findings were verified **not
  real** (multi-room count double-count; non-encrypted server-chain dropping).
- **Verify:** `Searching-test` Jest **27/27** (was 3; +24 incl. chain pagination + mixed-encryption), `RoomSearchView-test`
  + `EventIndex-test` **38/38** (no regression), `tsc` only the 4 pre-existing vendored matrix-js-sdk errors, eslint
  `--max-warnings 0` clean, prettier clean, no i18n changes (fixes log via `logger`, no user-facing strings).
- **Not verifiable here:** real Seshat sqlite round-trip + the actual SDK event-mapper reuse path (the test harness stubs
  `processRoomEventsSearch`, so tests assert on the re-keyed raw objects / captured args) + live macOS render — manual QA.

## Session 16 (2026-06-25) — P1: #33954 arm64 AES build verification (was the only unverified landed change)

Host: this machine is the target — Apple Silicon **M4 Pro / aarch64**, Rust **1.95.0**, Node 24.15, rustup target
`aarch64-apple-darwin` installed. So #33954 ("needs native arm64 build QA" since session 11) is now QA-able locally.

- **Finding (regression caught):** the **previously-built** `index.node` (Jun 24 19:38, the one in
  `.hak/hakModules/` and inside `dist/mac-arm64/Element.app`) was built **WITHOUT** the flag — its `aes` crate
  fingerprint recorded `rustflags: []`, i.e. the shipped artifact used the **software** AES path. #33954's benefit
  had never actually been compiled into a build. (The flag landed in `hak/matrix-seshat/build.ts` session 11, but no
  rebuild had exercised it.)
- **Mechanism proof (standalone):** built a throwaway crate depending on `aes =0.8.4` for `aarch64-apple-darwin`,
  with and without `RUSTFLAGS="--cfg aes_armv8"`. Both compile clean (exit 0, no errors; aes 0.8.4 self-declares the
  cfg so **no unexpected-cfg warning**). Disassembly (`otool -tvV`): **WITHOUT flag = 0** ARMv8 AES instructions;
  **WITH flag = 42** (`aese.16b`/`aesmc.16b`/…). Confirms the crate genuinely gates its ARMv8 hardware backend on
  `cfg(all(target_arch="aarch64", aes_armv8))` (verified in `aes-0.8.4/src/{lib,autodetect,hazmat}.rs`).
- **Real seshat rebuild (faithful to build.ts):** ran `yarn run build-bundled` with `RUSTFLAGS="--cfg aes_armv8"`
  in `.hak/matrix-seshat/aarch64-apple-darwin/build` (= exactly what `build.ts` sets on arm64; `getTargetArch()→arm64`
  confirmed; mac `wantsStaticSqlCipher()→true`). **Exit 0 in ~36s, no errors, no aes_armv8 warnings.** New
  `index.node` aes fingerprint now records `rustflags: ['--cfg','aes_armv8']`. ARMv8 AES instruction count in the
  artifact: **225 → 426** (+201). (The 225 baseline is the bundled **C sqlcipher** which always uses HW AES on arm64;
  the +201 delta is the **Rust `aes` crate** flipping from software to hardware — exactly what the flag controls.)
- **Functional smoke test (HW-AES binary, two-process):** writer creates an **encrypted** Seshat index (passphrase →
  AES encrypt), adds an event, `commit(true)`, exits (releases the single-writer tantivy lock). Reader reopens with
  the **correct** passphrase → decrypts → `search({search_term:"hardware"})` returns **1 hit with the correct body**;
  reopen with a **wrong** passphrase is correctly **rejected** (`DatabaseUnlockError("Invalid…")`). Full
  encrypt→commit→reopen→decrypt→search round-trip works on the hardware-AES binary; key derivation is enforced.
  (Native arg contract gotcha for future tests: async `search` wants `{ search_term, limit, before_limit,
  after_limit, order_by_recency }` — snake_case `search_term`, NOT `searchTerm`; the JS `searchSync(term,…)` positional
  variant downcasts oddly. element-web calls `eventIndex.search(args[0])` from `seshat.ts:204`.)
- **Artifact state:** propagated the new HW-AES `index.node` to `.hak/hakModules/matrix-seshat/index.node` (what hak's
  copy step does). The cargo cache is now warm WITH the flag, so a later `corepack pnpm run build:native` is a fast
  reproducible no-op producing the same HW-AES artifact. **NOTE:** the packaged `dist/mac-arm64/Element.app` still
  contains the OLD software-AES `index.node` — re-run electron-builder (see build recipe) to ship the HW version.
- **Still needs the live app (manual QA, in `manual-qa-checklist.md`):** the actual **CPU-drop measurement** under
  sustained encrypted-room indexing (Activity Monitor on the Seshat thread) — that's the one piece that needs the
  running GUI + a real workload, not automatable here. Compile + correctness + crypto round-trip are all proven.

### Session 16 (cont.) — P2: manual QA playbook authored (live GUI execution deferred to user)

- P2 ("manual macOS GUI QA of the ~15 not-unit-testable landed fixes") **cannot be executed autonomously** (needs real
  clicks, multi-monitor, TCC prompts, encrypted rooms). Authored **`memorybank/manual-qa-checklist.md`** — a build+run
  recipe plus per-issue repro steps and expected results, grouped A–E by priority (data-loss → calls → window/lifecycle
  → files/config → search). The user runs it against a freshly repackaged build.

## Session 17 (2026-06-25) — Room search Telegram-parity initiative: research + plan + Phase 1 (⌘F fix)

User report: "⌘F to search in a room doesn't work" + "search isn't as good as Telegram". Ran a 9-agent research
workflow (code-map of shortcut/exec/UI/settings paths + Telegram in-chat/filters/global research + upstream
element-web PR scan + synthesis). Full deliverable: **`memorybank/search-improvement-plan.md`** (root cause, gap
table, 5-phase plan, upstream PR table, open questions). User confirmed via 3 decisions: **⌘F default-ON Desktop
only** (web stays opt-in), **scope = full plan 1–5**, **Phase 2 = complement the list** (keep RoomSearchView).

### What was DONE this session

- ✅ **Phase 1 (TDD + fully verified)** — fixes the reported ⌘F bug. Changes (all UNCOMMITTED — user will review/commit):
  - `apps/web/src/settings/Settings.tsx`: `ctrlFForSearch` default flipped `false` → `!!IS_ELECTRON` (on for the
    desktop app, off on web so the browser find bar is preserved); added `IS_ELECTRON` to the `../Keyboard` import;
    added `description: _td("settings|use_command_f_search_description")` (microcopy under the toggle).
  - `apps/web/src/i18n/strings/en_EN.json`: new key `settings|use_command_f_search_description`.
  - `apps/web/test/unit-tests/KeyBindingsDefaults-test.ts` (NEW): regression test locking the `roomBindings()` gate
    (present when `ctrlFForSearch` true, absent when false). 2/2 pass.
  - `apps/web/test/unit-tests/components/views/settings/tabs/user/__snapshots__/PreferencesUserSettingsTab-test.tsx.snap`:
    updated for the new microcopy (only diff = the description line).
  - Verified: eslint 0; tsc only the 4 pre-existing vendored matrix-js-sdk errors; i18n lint clean; prettier clean.

### Root cause (confirmed, code-level) — for next session

- `ctrlFForSearch` **defaulted to `false`** ([Settings.tsx:956]); `roomBindings()` only registers the `SearchInRoom`
  `{key:'f', ctrlOrCmdKey:true}` combo when that setting is truthy ([KeyBindingsDefaults.ts:116-130]). With it off,
  `getRoomAction` returns undefined → keypress falls through to the OS. **Not** a focus bug (React `onReactKeyDown`
  path covers the focused-composer case at LoggedInView.tsx:512-516,851) and **not** a desktop bug (vectormenu.ts /
  webcontents-handler.ts have no Find item / `findInPage`; electron-main.ts before-input only touches Quit shortcuts).
  Historic "works once then dead" regression (#28221/#28223) is **already fixed here** ([RightPanelStore.ts:95-100]
  re-opens the summary card on `FocusMessageSearch`).

### Upstream PR check (answer to user's question)

- NO open upstream PR fixes a macOS search bug. #28223 (the fix) is already in this fork. Live open items: #22888
  (off-by-default = "users think it's broken"), #24359 (differentiate ⌘F web vs desktop), #27876 (fold into Cmd-K),
  #21640 (fuzzy UI), legacy matrix-react-sdk #4156 (`from:` filter, never merged). Several search-quality issues
  (#32127/#32258/#32266/#32343…) overlap our prior Phase 4.x work.

### WHERE I LEFT OFF / next steps (Phases 2–5 in `search-improvement-plan.md`)

- **Phase 2 (next, biggest win):** in-timeline match stepping + "k of N" counter + live in-bubble highlight, as a
  COMPLEMENT to the existing list (`RoomSearchView.tsx`). Key files: `Searching.ts` (extend `SearchInfo` with
  currentMatchIndex/totalMatches), new ViewModel in `apps/web/src/viewmodels`, dumb arrow+counter View in
  `packages/shared-components`, wire into `RoomSearchAuxPanel.tsx`, apply `BaseHighlighter` (HtmlUtils.tsx) to live
  EventTiles in search mode. Risk: driving the live MessagePanel to arbitrary historical matches needs contextual
  back-pagination + Seshat-result→live-event mapping.
- **Phase 3:** `from:`/sender (homeserver `IRoomEventFilter.senders` already supported; Seshat post-filter in v1) +
  jump-to-date (MSC3030) — Compound filter chips in the search header.
- **Phase 4:** split `FilePanel.tsx` into searchable Media/Files/Links/Music/Voice tabs; index media filenames
  (needs INDEX_VERSION bump + re-backfill — see EventIndex.ts isValidEvent).
- **Phase 5:** portable offline encrypted web search (WASM, packaged locally), recency↔relevance toggle
  (SearchOrderBy.Rank), corrupt-index health check (#32056).

### ⚠️ ENV gotcha (also saved as a memory) — read before running jest next session

- Jest unit tests **cannot run as-installed**: node_modules was installed with pnpm's **symlinked** `.pnpm` layout,
  but `apps/web/jest.config.ts` `transformIgnorePatterns` is written for a **hoisted** layout, so TS-source
  `matrix-js-sdk` is excluded from babel transform → every test dies in `setupTests.ts` with `Cannot use import
  statement outside a module`. Workaround (no committed change): pass a CLI `--transformIgnorePatterns` that adds
  `matrix-js-sdk` to the allowlist. `--preserve-symlinks` is NOT a fix (breaks corepack + pnpm nested resolution).
  Working command shape:
  `corepack pnpm -C apps/web exec jest <testfile> --transformIgnorePatterns 'node_modules/.pnpm/(?!(matrix-js-sdk|mime|uuid|p-retry|is-network-error|react-merge-refs|is-ip|ip-regex|super-regex|function-timeout|time-span|convert-hrtime|clone-regexp|is-regexp|matrix-web-i18n|await-lock|react-virtuoso|lodash|domutils|domhandler|domelementtype|dom-serializer|entities)).+$'`

## Session 18 (2026-06-25) — Room search Phase 1B: web ⌘F discoverability toast (TDD + verified)

User re-reported "⌘F doesn't work" and asked to continue. **Root-caused via systematic debugging:** Phase 1 is
correct — `ctrlFForSearch` default `!!IS_ELECTRON`, `roomBindings()` gate works, bindings recomputed live per
keystroke (no stale cache), `window.electron` genuinely exposed by `apps/desktop/src/preload.cts:39` so on a *rebuilt*
desktop app the shortcut works. The user confirmed they were on a **desktop app not yet rebuilt** → fix simply not
compiled in. Action for user: **rebuild the desktop app** to pick up the (uncommitted) Phase 1 change.

User decision: implement **Phase 1B** (web toast), keep desktop default-on.

### What was DONE this session (all UNCOMMITTED)

- ✅ **Phase 1B (TDD, RED→GREEN, fully verified)** — on the **web** build, pressing Ctrl/Cmd+F while in-room search
  is disabled now shows a **one-time, non-modal toast** offering to enable it, WITHOUT preventing the browser's
  native find-on-page (#33360). Files:
  - NEW `apps/web/src/toasts/InRoomSearchNudgeToast.ts` — `showInRoomSearchNudgeIfNeeded(ev)` gate (returns early on
    Electron, when `ctrlFForSearch` already on, when already shown, or when the combo isn't Ctrl/Cmd+F via
    `isKeyComboMatch({key:Key.F, ctrlOrCmdKey:true})`), and `showInRoomSearchNudgeToast()` using
    `ToastStore.addOrReplaceToast` + `GenericToast` (primary "Enable" → `setValue("ctrlFForSearch", null, ACCOUNT,
    true)`, secondary "Dismiss"; priority 30). Marks a device-local "shown" flag on display so it never nags twice.
  - `apps/web/src/settings/Settings.tsx`: NEW device-only setting `ctrlFForSearchNudgeShown`
    (`LEVELS_DEVICE_ONLY_SETTINGS`, default false) + its `IBaseSetting<boolean>` interface entry.
  - `apps/web/src/components/structures/LoggedInView.tsx`: call `showInRoomSearchNudgeIfNeeded(ev)` from
    `onNativeKeyDown` (the nothing-focused/`document.body` path only, after `onKeyDown`, no preventDefault).
  - `apps/web/src/i18n/strings/en_EN.json`: NEW `room|search|nudge_title` ("Search this room") +
    `room|search|nudge_description`.
  - Tests: NEW `apps/web/test/unit-tests/toasts/InRoomSearchNudgeToast-test.ts` (5: shows/marks-shown, skips when
    enabled, skips when already shown, ignores wrong key, primary-click enables setting) + 2 new wiring tests in
    `LoggedInView-test.tsx` (shows nudge when disabled, no nudge when enabled).

### Verification (this session)

- jest (with the documented `--transformIgnorePatterns` workaround): toast 5/5, LoggedInView suite 35/35 (incl. the
  2 new), KeyBindingsDefaults 2/2, PreferencesUserSettingsTab snapshot 9/9 — all pass.
- `pnpm -C apps/web run i18n:lint` clean; eslint `--max-warnings 0` clean; prettier `--check` clean.
- `tsc --noEmit`: 0 app-source errors (only the 4 pre-existing `node_modules/matrix-js-sdk` env-quirk errors).

### Parallel-work note (user opened a separate session for Phase 2)

- Advised: run Phase 2 in a **separate git worktree** (`git worktree add ../element-phase2 -b phase2-search`) so the
  two sessions don't clobber each other's uncommitted edits. Only real overlap = `en_EN.json` (both add i18n keys)
  and `memorybank/` — trivial conflicts, resolve via `pnpm i18n`. Phase 1/1B is uncommitted; the Phase 2 worktree
  branches from HEAD and won't include it (fine — no logic overlap; commit Phase 1+1B first if a shared base is
  needed).

### WHERE I LEFT OFF — Phase 2 next (unchanged from Session 17 plan)

- Phase 2 (in-timeline match stepping + "k of N" + live highlight, COMPLEMENT to `RoomSearchView`) → P3 from:/date
  filters → P4 searchable media tabs → P5 reach/ranking/health-check. See `search-improvement-plan.md` §5.

## Session 19 (2026-06-25) — Search Phase 2 **slice 2**: live in-bubble highlight while stepping (TDD + reviewed)

Continued the search initiative. Confirmed slices 1/1B are **committed** (dc4ce66, d0f086a, cdce4a2) and the tree was
clean; "where I left off" notes were stale. Implemented **Phase 2 slice 2** end-to-end.

**What it does:** while stepping through search matches in the live timeline, the matched terms now highlight in the
**focused match's real bubble** (`mx_EventTile_searchHighlight`), reusing the existing `EventTile.highlights` →
`HtmlHighlighter` path — zero new render code.

**Approach:** understand-workflow (4 parallel Explore readers) mapped the highlight path → TDD (RED→GREEN) → 3-lens
adversarial-review workflow (correctness / edit-event-mapping / regression-leak) with per-finding verification.

**Files (6, +136/-1):** `Searching.ts` (`extractSearchHighlights` pure helper + `SearchInfo.highlights`);
`MessagePanel.tsx` (`searchHighlights`/`searchHighlightEventId` props → focused tile only in `getTilesForEvent`);
`TimelinePanel.tsx` (forward, optional → other 5 callers unaffected); `RoomView.tsx` (`onSearchUpdate` stores
highlights for completed single-room searches; render derives focused match eventId+terms, **decoupled** from the
transient jump-flash so the highlight persists). Tests in `Searching-test` (4) + `MessagePanel-test` (2).

**Verify:** tsc clean; 129 web Jest pass (Searching 34, MessagePanel 23, RoomView+TimelinePanel 72); eslint/prettier
clean; no new i18n. Ran via the `--transformIgnorePatterns` jest workaround.

**Review outcome:** 2 findings → 1 confirmed (medium-conf), 1 refuted. Confirmed = malformed-edit match (no
`m.new_content.body`) shows no live highlight because `promoteReplacementContent` (intentional #32356 guard) leaves it
keyed to the edit id, absent from the live timeline. **Documented, not fixed** — pre-existing, graceful (no crash),
same as slice 1's jump no-op; fixing would regress the #32356 blank-tile guard. See `search-phase2-plan.md` slice 2.

### WHERE I LEFT OFF — Phase 2 slice 3 next

- Slice 3: chronological ordering + wrap-around + keyboard (Enter=next / Shift+Enter=prev while search box focused).
  Then slice 4 (out-of-window/encrypted edge cases, all-rooms) → slice 5 (hide list while stepping, PostHog, pcss).
- Slice 2 committed this session. (jest needs the `--transformIgnorePatterns` workaround — see memory.)

## Session 20 (2026-06-25) — Search Phase 2 **slice 3**: chronological ordering + wrap-around + keyboard (TDD + reviewed)

Continued the initiative. Confirmed slices 1/1B/2 committed (cdce4a2, d0f086a, dc4ce66, b5d6b8a) and tree clean.
Implemented **Phase 2 slice 3** (the three remaining stepping affordances) end-to-end, TDD per task.

**What it does:** (1) match stepping is now **chronological** (newest-first by event ts) so up/down mean a stable
newer/older; (2) stepping **wraps** at both ends and the arrows stay enabled with ≥1 match; (3) **Enter = next /
Shift+Enter = previous** while the right-panel search box is focused.

**Files:** `Searching.ts` (`extractSearchMatches` sorts by `getTs() ?? 0`, stable); `RoomSearchNavigationViewModel.ts`
(`next`/`previous` wrap; `canPrevious`/`canNext` = total>0); `dispatcher/actions.ts` + new
`payloads/SearchMatchStepPayload.ts`; `RoomSummaryCardViewModel.tsx` (`useSearchInput` dispatches `SearchMatchStep`
on Enter/Shift+Enter, IME-guarded); `RoomView.tsx` (`onAction` `SearchMatchStep` → `searchNavVm.next/previous`).

**Decision (plan's "optional wrap"):** chose **wrap** over clamp — matches the ⌘F/browser-find model from Phase 1 and
keeps Enter-stepping from dead-ending. Clamp is a small `computeSnapshot`+step revert if ever wanted.

**Process:** understand (direct reads + 1 Explore for the search-bar/keyboard infra) → TDD RED→GREEN per task →
**4-dimension adversarial-review workflow** (vm-math / ordering / keyboard-dispatch / tests-conventions) with
per-finding verification → applied 6 confirmed findings (also TDD for the two behavioral ones):
- **NaN-safe ts** (`getTs() ?? 0`): SDK masks an absent `origin_server_ts` with `!`; an undated match would make
  `b.ts-a.ts` NaN and silently corrupt order. Undated now sinks to bottom. (+1 Searching test)
- **IME guard** (`!e.nativeEvent?.isComposing`): don't hijack the Enter that confirms a CJK composition. (+1 test)
- JSDoc fix (app requests `SearchOrderBy.Recent` from both backends — sort is normalising, not rank→recency);
  RoomView stepping tests hardened with a `toBeTruthy()` mount guard + placed early to dodge a **pre-existing**
  suite-wide isolation leak (out of scope); +1 symmetric single-match wrap test.

**Verify:** **124 web Jest** (Searching 36, nav VM 13, RoomSummaryCard 21, RoomView 54) + **5 shared-components
vitest** pass; tsc clean (only the pre-existing matrix-js-sdk wasm-type noise), eslint/prettier clean; i18n no-diff.

**Jest runner gotcha (this session):** the recreated `scratchpad/webjest.sh` MUST use
`corepack pnpm -C apps/web exec jest` — the older `./node_modules/.bin/jest` form mis-resolves the babel config and
fails every suite with "Cannot use import statement outside a module". Pattern: relative
`node_modules/.pnpm/(?!(<allowlist incl. matrix-js-sdk|matrix-events-sdk|@matrix-org|oidc-client-ts|...>)).+$`.

### WHERE I LEFT OFF — Phase 2 slice 4 next
- Slice 4: out-of-window / encrypted edge cases + all-rooms scope (arrows switch room before jumping). Then slice 5
  (hide results list while stepping, PostHog, pcss for the active live tile). Then P3 from:/date filters, P4 media
  tabs, P5 reach/ranking/health-check.
- Slice 3 committed this session (one commit). Push still deferred (origin lacks slices 1/1B/2/3 — user pushes at the
  end of the initiative, not per slice).

## Session 22 (2026-06-25) — Search Phase 2 **slice 5**: polish (dual denominator, back-to-results, active-tile) — TDD + reviewed

Continued the initiative; confirmed slices 1–4 committed (HEAD 38c06eb), tree clean. Implemented **Phase 2 slice 5**
end-to-end, TDD per task, then a 4-lens adversarial-review workflow, applied the safe findings, committed + pushed (user
asked to commit+push this session).

**Process:** understand-workflow (5 parallel Explore readers → mapped RoomSearchAuxPanel dual denominator, RoomView
search glue, PostHog conventions, pcss, nav VM/types) → AskUserQuestion locked 3 UX/policy decisions → TDD RED→GREEN per
task → adversarial-review workflow (state-machine / mvvm-threading / css-ux / tests-i18n; 16 findings → 9 confirmed) →
applied safe fixes → verify → docs → commit+push.

**User decisions (AskUserQuestion):** dual denominator = "keep both, label stepper **loaded**"; PostHog = **defer**
(external immutable analytics-events has no suitable Interaction name); active tile = **new dedicated subtle class**.

**What shipped (3 tasks):**
- **A — dual denominator.** `RoomSearchAuxPanel.tsx` no longer hides the "N results found" summary while stepping;
  shared `match_position` → "%(current)s of %(total)s **loaded**". Both totals now coexist (count = backend estimate,
  stepper = current-room loaded ≤SEARCH_LIMIT) with "loaded" to disambiguate.
- **B — back-to-results affordance.** New `RoomView.onBackToSearchResults` flips `timelineRenderingType`→Search +
  `currentMatchIndex`→undefined (keeps the session alive, unlike `onCancelSearchClick`); a `list-view` `IconButton`
  (`room|search|back_to_results`) renders in the header only while stepping.
- **C — active-tile pcss.** Threaded `isSearchHighlightMatch` (`searchHighlightEventId` match) MessagePanel→EventTile→
  EventTileViewModel(`EventTileDisplayInput`)→`getEventTileClassState`→`mx_EventTile_searchHighlightActive`. CSS reuses the
  `mx_EventTile_selected` subtle-bg + accent-stroke treatment, layout-scoped (group/irc + bubble).

**Adversarial review:** 9/16 confirmed. Applied: CSS robustness (the first cut used an unscoped `$event-selected-color`
bg that was identical to hover / overridden by the mention yellow / invisible in bubble — reusing the selected treatment
fixes all three); pin the "0 of N" counter reset in the back-to-results test; decouple the active-tile test from
`searchHighlights`; accurate comment on the belt-and-braces `setMatches`. Correctly refuted: MVVM threading complete, no
spinner flicker, icon choice is bikeshed.

**DEFERRED to Slice 6 (documented in code + plan): stale `initialEventId`.** After back-to-results the RoomViewStore's
initial event id still points at the last-stepped match (sticky via `getInitialEventId() ?? this.state.initialEventId`),
so re-clicking that **exact same** result is a no-op. The naive fix is unsafe (store still holds it → next store update
trips the clear gate and tears search down); correct fix = the result-click-gate rework Slice 6 does. Medium edge case,
workarounds exist (arrows / different result / ✕).

**Verify:** 224 affected web Jest (RoomView 58, MessagePanel, RoomSearchAuxPanel 11, EventTile) + shared
SearchMatchNavigation vitest 5; tsc clean (only the 4 vendored matrix-js-sdk errors); eslint/prettier/i18n clean. Jest via
recreated `scratchpad/webjest.sh` (allowlist MUST include `@element-hq/web-shared-components`).

**i18n gotcha learned:** apps/web resolves shared-components strings from **src** (webpack `additionalStringsPaths` at
runtime; `test/setup/setupLanguage.ts` in tests), NOT the gitignored `dist`. So "…loaded" ships from the src change alone,
AND apps/web jest renders "…loaded" — every apps/web "k of N" counter assertion was switched to `exact: false` (CI
rebuilds dist, so an exact assertion would break there). The `dist` rebuild done this session was unnecessary (gitignored,
not committed).

### WHERE I LEFT OFF — Phase 2 slice 6 next
- **Slice 6 — All-rooms (+ predecessor-room) cross-room stepping via a `SearchSessionStore`** (large, HIGH risk; design
  in `search-phase2-plan.md`). It also naturally fixes slice-5's deferred stale-`initialEventId` no-op (the result-click
  gate rework) and re-enables the all-rooms `canStep` branch. Then P3 from:/date filters, P4 media tabs, P5
  reach/ranking/health-check. PostHog stepping event still pending an upstream `@matrix-org/analytics-events` schema add.
- Slices 1–5 + slice-5 commit **pushed this session** (user asked to commit+push; origin now has the work).

## Session 25 (2026-06-25) — Search Phase 3 **slice 2**: `from:`/sender filter (TDD + adversarial review)

Continued the search initiative. Confirmed slice 1 (jump-to-date in search) is committed (HEAD `f9adbf3`) and the tree
was clean; the start-of-session git snapshot was stale. Implemented **Phase 3 slice 2** (the `from:`/sender filter)
end-to-end, TDD per task, then a 4-lens adversarial-review workflow.

**Process:** 6-agent `sender-filter-understand` Understand workflow (query-construction / Seshat-merge / search-header-MVVM
/ member-picker-Compound / tests-i18n) → synthesized a file-by-file plan with 11 TDD tasks → verified its `mustVerify`
items against source (icon export, test-file existence, `combinedPagination` Seshat branch) → TDD RED→GREEN per task →
4-lens adversarial-review workflow (backend-correctness / state-mvvm / ui-edge-a11y / tests-i18n; 6 confirmed, 3 refuted)
→ triaged findings (receiving-code-review skill) → applied fixes → re-verified.

**What shipped** (locked decisions from session 24 honoured: homeserver `IRoomEventFilter.senders` native + Seshat
over-fetch client-side post-filter, no native rebuild; Compound member-picker in the search header). Full detail in
`search-phase3-plan.md` §3. Highlights:
- `Searching.ts`: `senders?` threaded through all search + pagination paths; `filterSeshatResultsBySender` +
  `SESHAT_SENDER_OVERFETCH_LIMIT`; `ISeshatSearchResults.senderFilter` carry for paginated re-filtering. Documented the
  degraded-combined over-fetch cache-overflow as an accepted v1 limitation; count left to the slice-5 dual-denominator.
- State: `senders` on `SearchSessionParams`/`SearchInfo`; `RoomView.onSearchSendersChange` re-search; plumbed through
  RightPanel → RoomSummaryCardView. **Review-found bug:** `searchInfoFromSession` dropped `senders` on remount → fixed +
  regression test (verified RED-without-fix).
- UI: `RoomSearchSenderFilterViewModel` (MVVM v2) + `RoomSearchSenderFilter` Compound multi-select Menu, mounted beside
  jump-to-date. i18n: `room|search|sender_filter_*`.

**Adversarial review (6 confirmed):** fixed a11y count-in-aria-label (#4), empty-`[]` test (#6), test-cast comment (#5);
**refuted-by-test** the rapid multi-select "stale closure" race (#2 — controlled component + React discrete-event flush,
proven by an accumulation test); **pushed back** on the `onSearch` debounce-after-cancel race (#1 — pre-existing, the
`senders` default is `undefined` after cancel = no filter = no regression). **Deferred:** menu-item `inProgress`
disabled/aria-busy state (#3 — behaviour already correct via AbortController+searchId); PostHog; in-picker text-search.

**Verify:** 173 affected web Jest pass (Searching 48, SearchSessionStore 19, RoomSearchSenderFilter 7, VM 2,
RoomSummaryCardView, RoomView 73, RightPanel); tsc clean (only the 4 pre-existing vendored matrix-js-sdk errors);
eslint `--max-warnings 0` / prettier / i18n:lint clean. Jest via `scratchpad/webjest.sh`.

### WHERE I LEFT OFF — Phase 3 done; Phase 4 next
- Phase 3 structured filters complete (slice 1 jump-to-date, slice 2 sender). Next per `search-improvement-plan.md` §5
  is **Phase 4** (searchable typed media tabs — split `FilePanel`, needs INDEX_VERSION bump + re-backfill), or a Phase 3
  polish combining `from:` + jump-to-date + term into one query first. PostHog metrics still pending the upstream
  `@matrix-org/analytics-events` schema add.
- **Slice 2 is UNCOMMITTED** (working tree has the slice-2 changes; jest needs the `--transformIgnorePatterns`
  workaround). Review and commit when ready, per the per-slice commit cadence (slice 1 = `f9adbf3`).

## Session 26 (2026-06-25) — Phase 4: typed, searchable shared-media tabs (CORRECTED SCOPE) — DONE

Phase 3 slice 2 was committed+pushed before this session (`24aaa29` feat + `7ba0e59` docs; origin/main = `7ba0e59`).

**Pivotal correction (verified, not assumed):** the master plan's Phase-4 premise — "`isValidEvent` excludes media-only
events, so filenames aren't indexed → needs INDEX_VERSION bump + full Seshat re-backfill" — is **FALSE**.
`isValidEvent` (EventIndex.ts:555-579) has no media exclusion; media are `m.room.message` with a truthy `content.body`
(every upload sets `body: fileName`, ContentMessages.ts:566) → already pass → **media filenames are ALREADY indexed &
searchable in ⌘F**. Bumping INDEX_VERSION alone is also a no-op (no version-compare code; EventIndexPeg only handles
`userVersion===0`). The only genuine gap (split-format received media: body=caption, filename=realname) can't be fixed
cleanly anyway — native Seshat indexes `body` only → needs a Rust/Hak rebuild. Surfaced this; **user (away) chose the
corrected scope: typed+searchable tabs, NO re-backfill.**

**Built (TDD, 7-agent Understand + 5-lens adversarial review):** see `memorybank/search-phase4-plan.md` §4a for the full
file list + review outcomes. Core: additive optional `TimelinePanel.eventFilter` (filters the *displayed* list only;
full window kept for pagination) ← `RoomFilesView` (MVVM v2: `RoomFilesViewModel` {activeCategory, searchTerm}, Compound
`ChatFilter` tab row + `Search`, arrow/Home/End keyboard nav) ← `FilePanel`. Pure `utils/FileCategory.ts` classifies
All/Media/Files/Music/Voice (**Links deferred** — `contains_url` data source ≠ hyperlinks-in-text).

**Review:** 24 findings → 2 confirmed & FIXED (empty-state guard ignored the filter → blank panel on no-match tab/search;
listbox had no keyboard nav), 20 adversarially refuted, 0 deferred. **Verified:** 75 affected Jest green; tsc clean (4
vendored only); eslint/prettier/i18n:lint clean. Committed + pushed at end of session.

## Session 27 (2026-06-25) — Search Phase 5 **slice 1**: relevance-vs-recency order toggle (TDD + adversarial review)

User away; pre-authorised "choose the recommended / closest-to-Telegram option". Picked Phase 5's one concrete,
user-facing, self-contained deliverable: a **Recent / Relevant result-order toggle** in the search header. Evidence base:
a 5-agent Understand workflow (`phase5-relevance-understand`) tracing result-ordering across all 4 search paths +
the `senders` threading template. Full design: `memorybank/search-phase5-plan.md`.

**Correctness crux (the whole reason this is sliced the way it is):** only the **single-source pass-through** paths
honour a backend order — server-only (`order_by: Rank`) and Seshat-single-room (`order_by_recency: false` →
tantivy/BM25 relevance). The **combined (All-rooms)** and **chain (predecessor)** paths re-sort client-side by recency
(`compareEvents`) and their sliding-window/k-way-merge pagination invariant only holds for recency-sorted legs — so
honouring Rank there would silently corrupt cross-page order. Resolved **by construction**: `order` (default
`SearchOrderBy.Recent`) is threaded ONLY into the single-source legs; `combinedSearch`/`chainSearchProcess` never
receive it (forced recency, documented; merge-by-rank redesign deferred to slice 5.3).

**Built (TDD, RED verified first):** `Searching.ts` — `order` threaded eventSearch → eventIndexSearch →
serverSideSearch(Process)/localSearch(Process)/buildSeshatSearchArgs; `SearchInfo.order` + `SearchSessionParams.order`
(session identity, preserved by start/updateResults); `searchInfoFromSession` carries `order` (the slice-2
dropped-`senders` bug analog); `RoomView.onSearch` order param (defaults from session → term/scope/sender changes
preserve it) + `onSearchOrderChange`; prop chain RoomView → RightPanel → RoomSummaryCardView → new dumb View
`RoomSearchOrderToggle.tsx` (Compound `Menu` + 2 `RadioMenuItem`, `IconButton` `chevron-up-down`, controlled, active
aria-label + indicator dot). 4 i18n `room|search|order_*` keys. Stepping (`extractSearchMatches`) stays chronological
under Rank by design.

**Review:** 5-lens adversarial workflow (`phase5-slice1-review`, 19 agents) → **7 confirmed / 7 refuted** (refuted set
correctly included the documented all-rooms deferral). Applied: a11y active-state aria-label (`order_toggle_button_active`,
mirroring the sender filter), `key={room.roomId}`, refreshed `extractSearchMatches` doc comment, deduped test helper, +
4 added tests (order survives cross-room remount; chain-path force-recency leak guard; order preserved across a
sender-filter change; indicator-dot present/absent). **Verified:** 207 Jest across 8 suites; tsc clean (4 vendored only);
eslint/prettier/i18n:lint clean. **Decision logged:** portable offline encrypted **web** search stays **Desktop-only**
(offline-only/no-CDN constraint; multi-week spike). Committed + pushed at end of session.

## Session 35 (2026-06-26) — Search Phase 8e: result-click "no flash / no in-bubble highlight / lands at bottom not centered" (TDD + Codex + adversarial review)

User reported on the packaged macOS build: clicking a result row in the Telegram-style dropdown navigates to the right
message, but (1) it does NOT flash/blink, (2) the matched term is NOT highlighted in the bubble, (3) it lands near the
BOTTOM ("end of chat history") instead of centered — so you can't tell which message is the result. User asked me to
research, delegate to Codex, use subagents, ask clarifying questions. **Decisions (AskUserQuestion):** highlight feel =
**flash + keep term (Telegram-style)** (quick whole-message flash that fades ~1.2s, matched word stays highlighted while
focused); centered (confirmed); **rebuild + reinstall to /Applications**.

**Process:** read the memorybank (phases 6–8d2) instead of re-deriving; followed systematic-debugging + TDD. Ran a
parallel investigation **workflow** (`search-result-jump-investigation`, 5 readers + Firecrawl Telegram + a Codex
agent), then a **Codex MCP read-only trace** and a **deterministic-jsdom-repro subagent** — they CONVERGED. **Refuted two
plausible-but-wrong leads before fixing** (the kind that derailed Phase 8b): (a) a Haiku "NaN pixelOffset" theory —
disproved by reading `ScrollPanel.scrollToToken(token, pixelOffset = 0, …)`: JS default params apply to `undefined`, so
it's `0`, not NaN, and `initTimeline` already uses `offsetBase = 0.5` (center) when `eventPixelOffset == null` →
centering math was always correct; (b) "onSearchUpdate fires during stepping" — disproved by `RoomView.tsx:2881`: the
`RoomSearchView` data engine that drives `onSearchUpdate` is UNMOUNTED while a match is focused.

**Confirmed root cause (deterministic repro "COND-F"):** all three symptoms are ONE race.
`searchResultsListShown` (onRoomViewStoreUpdate) and `isSteppingSearchMatch` + `searchHighlightEventId` (render) derived
from the **volatile** `state.search.currentMatchIndex`. On the packaged build the real async search settles *at/after*
the click; that settled `onSearchUpdate(false, results, …)` nulls the cursor (`RoomView.tsx:2052` local → undefined +
`SearchSessionStore.updateResults` store → -1). A constant background `RoomViewStore` emission then runs
`onRoomViewStoreUpdate`, sees `searchResultsListShown` true mid-jump and takes the clobber branch
(`RoomView.tsx:778-780`): forces `isInitialEventHighlighted = false` (**no flash**), makes `isSteppingSearchMatch` false
→ drops `searchHighlights`/`searchHighlightEventId` (**no in-bubble term highlight**) and re-mounts the dropdown overlay
so the live timeline reads as buried (**not centered**). jsdom's mocked `Promise.resolve` settles BEFORE the click so the
window never opens — why phases 8/8b/8c/8d/8d2 never caught it.

**Fix — durable `focusedMatch` signal (mirrors the proven steppingTarget pattern):** `SearchSessionStore.ts` — new
`focusedMatchEventId` + getter `focusedMatch`, set in `setCurrentMatchIndex` BEFORE the no-op guard (index>=0 →
matches[index].eventId, else null), reset by `start()`/`clear()` AND when the focused match drops out of a fresh result
set (coherent fall-back to the list — Codex review fix). `updateResults` now RE-DERIVES `currentMatchIndex` from
`focusedMatchEventId` (`findIndex` by event id) instead of always -1, so a settled result mid-step keeps the cursor + the
"k of N" counter on the focused match. `RoomView.tsx` — `searchResultsListShown`, `isSteppingSearchMatch`,
`searchHighlightEventId` now derive from `SearchSessionStore.instance.focusedMatch`; `onSearchUpdate` syncs the local
mirror to the store value while focused (keeps `RoomSearchHeader` affordances correct). Centering then falls out for
free (the else-branch sets `pixelOffset = undefined` → offsetBase 0.5).

**The actual blink:** there was **NO flash/keyframe animation in the fork** (`_EventTile.pcss` had only a static
`mx_EventTile_selected`/`searchHighlightActive` tint + a literal `TODO: ultimately we probably want some transition on
here`). **Delegated to Codex MCP (workspace-write), refined by me:** added `@keyframes mx_EventTile_searchFlash`
($event-selected-color → transparent, 1200ms ease-out, fill forwards) gated to `prefers-reduced-motion: no-preference`,
applied to the focused-match tile (`.mx_EventTile_line` / bubble `::before`), overriding the shared selected tint so it
FADES and only the inline `.mx_EventTile_searchHighlight` matched word stays. `prefers-reduced-motion: reduce` → static
tint fallback (a11y). Permalink (`.mx_EventTile_selected` alone) + edit (`.mx_EventTile_isEditing`) styling untouched.

**TDD (RED→GREEN):** SearchSessionStore-test — new "focusedMatch (durable stepping marker)" block (7 tests incl. survives
updateResults, re-derives index on shift, clears when the match drops out). RoomView-test — new Phase 8e test reproduces
COND-F (click → settled `onSearchUpdate` while focused → background `emit(UPDATE_EVENT)`) and asserts the flash
(`isInitialEventHighlighted`), centered scroll (`initialEventScrollIntoView` true + `initialEventPixelOffset` undefined),
stepping survival and dropdown-hidden — RED pre-fix (isInitialEventHighlighted flipped false).

**Review:** Codex MCP adversarial review of the full diff → 1 Medium (focusedMatch/cursor split if the focused match
vanishes) FIXED + tested; 2 Low (test didn't pin pixelOffset → added; flash won't re-fire on re-activating the SAME
already-focused event → accepted, stepping to *different* matches re-fires as tiles are keyed by event id — deferred).
A subagent ran a 17-suite regression sweep.

**Verified:** **374 jest / 17 suites green** (32 SearchSessionStore + 85 RoomView + adjacent EventTile 142, MessagePanel,
TimelinePanel, Spotlight, Searching, HtmlUtils, RoomSearch*); 45 snapshots pass; stylelint/eslint/tsc (only the 4
pre-existing matrix-js-sdk 41.8.0 vendored errors)/prettier/i18n:lint clean; no new i18n keys. Src+CSS diff +333/-21
across `SearchSessionStore.ts`, `RoomView.tsx`, `_EventTile.pcss`, `_EventBubbleTile.pcss` (+ 2 tests). **macOS app
rebuilt** via `scratchpad/build-macos.sh` (log `scratchpad/build-macos-phase8e.log`) and **reinstalled to
/Applications/Element.app** — new `webapp.asar` md5 `80cf21e70752f6faee15ea12188bf23c` (was `b6100554…` = Phase 8d2),
verified to contain `focusedMatch ×49` + `mx_EventTile_searchFlash ×63`. Plan: `memorybank/search-phase8e-plan.md`.
Committed + pushed at end of session. **Known limitation (defer):** re-flash on re-activating the SAME already-focused
event needs a JS animation-restart token (CSS alone can't); reduced-motion users get a static tint, not a flash (a11y).

## Session 36 (2026-06-26) — Upstream-sync planning: port element-web v1.12.22 → develop into the fork (research + phased plan only)

User: the fork was created from the **v1.12.22 source tarball** + ~48 custom commits (Telegram search + macOS desktop);
upstream has moved on; bring the fork up to date with `element-hq/element-web` so a clean PR can be sent — **without
breaking ANY built feature**. Asked me to clone upstream to tmp, use subagents, and write a comprehensive phased plan to
`memorybank/update-phases/` for execution in later sessions. Mid-session the user added: use **Codex as a sidecar**
(42%/5h budget, track it). **This session is PLANNING ONLY — nothing implemented.**

**Investigation (all empirical, not estimated):** cloned upstream to `/tmp/element-web-upstream` (561M, 659 tags), added
it as remote `upstream`, fetched `develop` + tag `v1.12.22`. Established the fork is a **source drop with zero shared git
ancestry** (root commit 3294bcc == v1.12.22 + CLAUDE.md, **0 code diff**) → so plain merge/rebase won't work, but
**v1.12.22 is a perfect synthetic 3-way merge base** (graft it). Computed the delta: **70 commits / 395 files**
(v1.12.22..develop), ~80% dependency/CI maintenance; v1.12.22 is a clean ancestor of develop AND the latest release tag;
target = develop (also the PR base). Computed the three file sets: U-only 366 (bulk adopt), C-only 150 (keep + API-drift
check), overlap 29. Ran a real **`git merge-tree`** (base v1.12.22) → **only 10 actual conflicts** (not 29): 8 are the
desktop config-de-globalling (#33468 + #33827 deeplinks), web side = DateSeparator import (#33948) + EventIndex test
relocation (#33898, jest→vitest); the EventIndexPeg-test conflict is a dir-rename false-positive. Confirmed jest survives
on develop (vitest migration is additive — fork's ~60 jest tests safe) and prettier→oxfmt (#33844; config byte-identical
→ low churn).

**Analysis (ultracode):** ran a **12-agent Workflow** (`element-upstream-sync-analysis`, 443K tokens, 142 tool calls) —
1 commit-categorizer + 8 per-cluster conflict analysts + 3 cross-cutting (oxfmt, jest/vitest, dependency/API-drift), each
reading both diffs + the memorybank for feature intent and emitting structured merge strategies. Full report archived at
the session task output `tasks/w4nxrcs4x.output`. Used the **Codex sidecar (1 call, read-only)** to independently
cross-check the single hardest file `config.ts` (#33468) — it confirmed the structural+semantic classification and caught
a ripple: #33468 removes `getBrand()`/`global.vectorConfig`, breaking even **fork-only** files (renderer-recovery.ts,
tray.ts, updater.ts). Agents corrected several of my hint guesses: upstream's RoomView/RoomHeader/RoomSublist edits are
just the #33946 Sonar dead-code tidy in fork-untouched regions (so **all web/search clusters are LOW risk, zero search
logic conflicts**); the only genuinely HIGH-risk cluster is desktop #33468/#33827.

**Deliverable:** wrote **`memorybank/update-phases/`** — README + master plan + 7 self-contained phase files (756 lines):
(1) setup/graft/integration-branch, (2) deps+lockfile-regen+toolchain decisions [matrix-js-sdk **keep 41.8.0**, adopt
oxfmt, keep jest], (3) run the grafted `git merge` + adopt 366 U-only + review 19 auto-merges, (4) **desktop conflicts**
(per-file recipes for #33468 config-de-global + #33827 deeplinks, Codex-verified), (5) web conflicts + search auto-merge
verification, (6) API-drift sweep / snapshots / knip --strict / oxfmt normalize / CLAUDE.md update, (7) full green-gate +
macOS QA (reuses `manual-qa-checklist.md`) + PR prep. Recorded the initiative in long-term memory
(`upstream-sync-initiative.md` + MEMORY.md). Ground-truth scratchpad: `empirical_facts.md`, `codex_config_merge.md`,
`{U_only,C_only,I_conflict_surface,changelog_70}.txt`. **Decisions flagged (recommended defaults set):** matrix-js-sdk
pin, oxfmt vs prettier, PR shape (merge now / rebase-onto-develop later), SPDX header. **Codex budget used this session:
1 call.** Committed + pushed at end of session.

## Session 37 (2026-06-26) — Upstream-sync EXECUTION begins: Phase 1 (graft/branch/dry-run) + Phase 2 SDK-drift scan

User: read `memorybank/update-phases/` and **execute Phase 1**; use subagents/tools carefully so the heavily-worked
codebase (search + macOS desktop) isn't broken; follow CLAUDE.md. Clarified: pushes go to **gitea** (`origin`), GitHub
`element-hq/element-web` is upstream (latest develop == `ed768f6`). The phased plan itself was committed on `main`
(`9636d3b` "docs(memorybank): comprehensive upstream-sync plan") since session 36 → **fork tip is now `9636d3b`, not
`862383cd`**.

**Phase 1 — setup/graft/integration-branch (DONE, LOW risk, no fork code touched):**
- Re-pointed `upstream` remote from the `/tmp/element-web-upstream` mirror to the real
  `https://github.com/element-hq/element-web.git`; `git ls-remote` confirmed GitHub's live develop tip == local
  `upstream/develop` == `ed768f69e1` (= "ed768f6") — **no advancement**, develop objects already fully in the local
  object store (so the merge no longer depends on `/tmp` surviving).
- **1.2 pristine-base gate PASSED:** `git diff v1.12.22 3294bcc` shows ONLY `.claude/settings.json` + `CLAUDE.md`
  (132 insertions, **0 code diffs**) → the fork base is byte-identical to v1.12.22, a perfect synthetic merge-base.
- **1.3 graft:** `git replace --graft 3294bcc v1.12.22`. NB the **tag-object** SHA is `6bfc4ddfef` but it peels to the
  **commit** `94636e8d` (RiotRobot "v1.12.22", Jun 23 2026) — `git merge-base` returns the commit, so the phase-1 doc's
  "should resolve to 6bfc4ddfef" was a cosmetic tag-vs-commit conflation. Verified: ROOT's effective parent is now
  `94636e8d`; `merge-base HEAD upstream/develop` == `94636e8d`; v1.12.22 is a clean **linear** ancestor of develop
  (70 ahead / **0** behind). (Briefly chased a false "MISMATCH" from comparing the tag SHA to the commit SHA — resolved.)
- **1.4:** created integration branch **`upstream-sync`** off fork HEAD; `main` untouched at `9636d3b`, tree clean.
- **1.5 dry-run:** `git merge-tree --merge-base=v1.12.22 HEAD upstream/develop` → **exactly the 10 predicted conflicts**
  (8 desktop: config.ts/.test, ipc.ts/.test, electron-main, auto-launch, webcontents-handler; 2 web: DateSeparatorViewModel
  import, EventIndex.test relocation; + the EventIndexPeg-test dir-rename file-location false-positive). The 11th-looking
  grep line was the suggested move-target inside conflict #10's sentence, not a separate file. **Plan confirmed; merge NOT
  yet run** (that's Phase 3).
- Verification gate: all 6 checks PASS (merge-base==v1.12.22, on upstream-sync, tree clean, main==9636d3b, graft ref
  present, upstream→GitHub). Rollback if needed: `git switch main && git branch -D upstream-sync && git replace -d 3294bcc…`.

**Phase 2 — deps/toolchain (STARTED; investigation done, decisions recorded; no code merged — execution is Phase 3):**
- Cleared the plan's flagged **matrix-js-sdk open risk** via a read-only subagent scan of all `v1.12.22..develop` changed
  TS files. **VERDICT: SAFE to keep `41.8.0`** (high confidence). Installed version confirmed 41.8.0 (pnpm store +
  lockfile). Of 258 changed .ts/.tsx, 114 import matrix-js-sdk; only 8 files introduced 12 "new" symbol names and **all 12
  exist in 41.8.0** (`EmptyObject`, `MapWithDefault`, `logger` are the only genuinely-modern ones — all present; the rest
  — `MatrixClient`/`Room`/`ClientEvent`/`MatrixEvent`/`SyncState`/`Direction`/`EventTimeline`/`EventType`/`IEvent` — only
  looked new because test files reshuffled imports). No new SDK subpath introduced. 41.8.0 is the **same-week** release
  line as the merge target (no 41→42 major gap), so the floating develop pin is unnecessary. **Residual caveat:**
  member-level usage on already-imported types can't be proven pre-merge read-only → closed by the `tsc` gate in Phase 7.
- **Decisions (recommended defaults, per the plan we co-authored):** keep **matrix-js-sdk 41.8.0** (evidence above);
  **adopt oxfmt** (upstream #33844 deletes prettier; `.oxfmtrc.jsonc` byte-identical to fork prettier settings → near-zero
  churn; CLAUDE.md `lint:prettier-fix`→`lint:fmt-fix` to update in Phase 6); **keep jest** (develop's vitest migration is
  additive — fork's ~60 jest tests safe, no action). knip `--strict` (#33893) flagged as the real lint risk → fix in
  Phase 6. Lockfile strategy (take upstream lock+workspace wholesale, re-apply fork's auto-launch/electron-window-state
  removals, regen via `pnpm install`) is **staged for Phase 3**. Checkpoint committed + pushed to `origin/upstream-sync`.
