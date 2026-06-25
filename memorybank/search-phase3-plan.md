# Search Phase 3 plan — structured filters (`from:` sender + jump-to-date)

> Authored 2026-06-25 (session 24). Evidence base: 6-agent Understand workflow (`jump-to-date-understand`) over this
> fork + direct code reads. Phase 2 (in-timeline match stepping, slices 1–6) is complete and pushed (`origin/main` =
> `6ef35f8`). User decisions for Phase 3 locked via AskUserQuestion — see below.

---

## 0. Plan correction (important)

`search-improvement-plan.md` §4/§5 claimed **"Jump-to-date: None in search; MSC3030 `timestamp_to_event` unused."**
That is **wrong** — verified by code. A **complete, working jump-to-date already exists** in this fork; it is merely
hidden and not surfaced in search:

- ViewModel: [`DateSeparatorViewModel.pickDate()`](apps/web/src/viewmodels/room/timeline/DateSeparatorViewModel.tsx#L142)
  → `client.timestampToEvent(roomId, ts, Direction.Forward)` → `dispatch(Action.ViewRoom, {event_id, highlighted, room_id})`
  with a room-switch guard + full error dialogs (ConnectionError / M_NOT_FOUND / HTTPError / bug-report).
- UI: clickable timeline **date separators** (chevron + "Jump to date") → `DateSeparatorContextMenuView` menu
  (Last week / Last month / Beginning / custom native `<input type=date>`), plus a **`/jumptodate YYYY-MM-DD`** slash command.
- Gate: labs flag **`feature_jump_to_date`** (default **`false`**, [Settings.tsx:550](apps/web/src/settings/Settings.tsx#L550))
  + `ServerSupportUnstableFeatureController` (MSC3030 `org.matrix.msc3030[.stable]`, stable v1.6) which **forces the value
  to `false` when the server lacks MSC3030** (`getValueOverride` → `forcedValue`).
- SDK (matrix-js-sdk 41.8.0): `timestampToEvent(roomId: string, timestamp: number, dir: Direction): Promise<{event_id: string; origin_server_ts: number}>`;
  `enum Direction { Backward="b", Forward="f" }`.
- Offline-safe date control already exists:
  [`DateSeparatorDatePickerView`](packages/shared-components/src/room/timeline/DateSeparatorView/DateSeparatorDatePickerView.tsx)
  (Compound `TextControl type=date` + `formatDateForInput`). **No new libs needed.**

So Phase 3 slice 1 is **"surface the existing jump-to-date in search + enable it by default on desktop"**, NOT a
from-scratch build. Mirrors Phase 1 (a real feature hidden behind a default-off gate).

---

## 1. Locked decisions (AskUserQuestion, session 24)

1. **Slice order:** **jump-to-date first** (slice 1). `from:`/sender filter becomes **slice 2**.
2. **`from:` backend (for slice 2):** **client-side post-filter** in v1 (homeserver `/search` already supports
   `IRoomEventFilter.senders` natively for unencrypted rooms; Seshat results post-filtered by sender; over-fetch to
   offset `SEARCH_LIMIT=10`). No native binding / index change → no desktop native rebuild.
3. **Slice-1 shape:** **search-bar date-jump control + flip `feature_jump_to_date` to desktop-default-on** (Phase-1
   style, still MSC3030-gated by the existing controller).
4. **Slice-1 placement:** **search bar header, beside the input** (RoomSummaryCardView) — visible the moment search
   opens, so you can jump to a date without typing a term. Telegram-parity.

---

## 2. Slice 1 — Jump-to-date in search (design)

### Architecture rationale (all verified)
- **Reuse, don't rebuild.** Extract `pickDate`'s body into a shared util `jumpToDateInRoom(roomId, ts)`; the search
  control reuses the existing dumb shared Views (`DateSeparatorContextMenuView` + `DateSeparatorDatePickerView`) driven
  by a `DateSeparatorViewModel` instance for the current room (it already implements the shared
  `ViewModel<DateSeparatorViewSnapshot> & DateSeparatorViewActions` interface and gates `jumpToEnabled` on the flag).
- **No search-exit wiring needed.** A date pick dispatches a plain `Action.ViewRoom` with `event_id` (NOT a stepping
  jump). RoomView's slice-6 clear-gate ([RoomView.tsx:840-848](apps/web/src/components/structures/RoomView.tsx#L840))
  already converts a non-stepping `ViewRoom`+`event_id` during `Search` rendering into "end the search, flip to Room,
  show the live timeline at that event." So jump-to-date works identically whether or not a text search is active.
- **VM lifecycle:** `useCreateAutoDisposedViewModel(() => new DateSeparatorViewModel({ roomId, ts }))` (from
  `@element-hq/web-shared-components`), mirroring `DateSeparatorWrapper` in MainGrouper.

### Tasks (TDD RED→GREEN each)

- **A. Settings flip.** `feature_jump_to_date` `default: false` → `default: !!IS_ELECTRON`
  ([Settings.tsx:556](apps/web/src/settings/Settings.tsx#L556)). `IS_ELECTRON` already imported (line 28). Controller
  unchanged → desktop-on **iff** server supports MSC3030; web + unsupported servers stay off. Test mirrors the Phase-1
  `ctrlFForSearch` pattern.
- **B. Extract `jumpToDateInRoom` util.** New `apps/web/src/utils/jumpToDate.ts` exporting
  `jumpToDateInRoom(roomId: string, inputTimestamp: number | string | Date): Promise<void>` = the current `pickDate`
  body (timestampToEvent + room-switch guard + ViewRoom + error dialogs + bug-report). Refactor
  `DateSeparatorViewModel.pickDate` to delegate (existing `DateSeparatorViewModel-test.tsx` proves no regression).
  New unit tests for the util.
- **C. Search-header jump control.** New small apps/web component (e.g.
  `apps/web/src/components/views/right_panel/RoomSearchJumpToDate.tsx`): constructs the per-room
  `DateSeparatorViewModel`, renders a Compound calendar `IconButton` trigger + `DateSeparatorContextMenuView`, rendered
  only when the snapshot's `jumpToEnabled` is true. Mount it in
  [RoomSummaryCardView](apps/web/src/components/views/right_panel/RoomSummaryCardView.tsx#L208) header beside `<Search>`
  (wrap both in a Flex). New i18n for the button tooltip/aria-label (reuse `room|jump_to_date*` for the menu). Tests:
  renders-when-enabled / hidden-when-disabled / picking a date dispatches ViewRoom with the resolved event_id.

### i18n
Reuse `room|jump_to_date`, `room|jump_to_date_beginning`, `room|jump_to_date_prompt`, `action|go`. Add one key for the
search calendar button label (e.g. `room|search|jump_to_date_button`).

### Verification
Jest via `scratchpad/webjest.sh` (allowlist incl. `matrix-js-sdk` + `@element-hq/web-shared-components`); shared
component changes (none expected beyond reuse) via vitest. `tsc --noEmit` (only the 4 pre-existing vendored
matrix-js-sdk errors), eslint `--max-warnings 0`, prettier, `i18n:lint`. **Not verifiable here:** real MSC3030 server
round-trip on a live desktop build (unit tests mock `timestampToEvent`).

### Risks / deferred
- Mid-search date pick relies on the slice-6 clear-gate; covered by a test that dispatches ViewRoom while in Search.
- Combining `from:` + date into one query ("from Alice in March") is **Phase 3 slice 2+**, not slice 1 (slice 1 is a
  pure timeline teleport, matching the plan's "calendar teleports timeline").
- PostHog interaction metric for the search calendar deferred (same upstream `@matrix-org/analytics-events` gap as the
  Phase-2 stepper).

---

## 3. Slice 2 — `from:` / sender filter — **DONE (session 25)**

Shipped end-to-end via TDD + a 4-lens adversarial-review workflow (6 confirmed findings triaged). Evidence base:
6-agent `sender-filter-understand` Understand workflow over Searching.ts / SearchSessionStore / search header / Compound.

**What it does:** a Compound member-picker in the search header (beside jump-to-date) narrows in-room/all-rooms search
to selected senders. Homeserver `/search` leg filters natively (`IRoomEventFilter.senders`); the Seshat (encrypted/
local) leg cannot filter at query time so it **over-fetches** then **post-filters** client-side. Multi-select; the
filter survives cross-room match-stepping remounts.

**Backend (`Searching.ts`):**
- `senders?: string[]` threaded through every search seam: `eventSearch` → `eventIndexSearch` →
  `{serverSideSearchProcess, localSearchProcess, chainSearchProcess, combinedSearch}` → `serverSideSearch`/`localSearch`.
- Homeserver: `serverSideSearch` sets `filter.senders` (rides in the stored `_query` body → server-side pagination
  keeps it for free).
- Seshat: new `const SESHAT_SENDER_OVERFETCH_LIMIT = SEARCH_LIMIT * 5`; `buildSeshatSearchArgs` bumps `limit` when a
  sender filter is active. New `filterSeshatResultsBySender(localResult, senders)` mutates the raw `IResultRoomEvents`
  (matches `result.result.sender`, a full MXID) after `sanitizeSeshatResults`, applied in `localSearch` +
  `fetchChainRoomPage`. New `ISeshatSearchResults.senderFilter` carries the senders so pagination re-applies the
  post-filter (`localPagination`, `combinedPagination`, `chainSearchPagination`). Removed the dead `processResult`
  param from `localSearch`.
- **Accepted v1 limitation (documented in code):** a degraded all-rooms search (homeserver leg failed) that over-fetches
  Seshat can push overflow into `cachedEvents` the single-leg `localPagination` does not drain → some matches surface
  only on a later page. Narrow (sender filter + server-leg failure + >SEARCH_LIMIT matches on page 1). Matches the
  existing degradation note's tone. Count is intentionally NOT recomputed (dual-denominator from slice 5 already shows
  backend `count` vs loaded `matches.length` diverging — sender filter is just another reason).

**State (`SearchSessionStore` + `SearchInfo` + `RoomView`):**
- `senders?` added to `SearchSessionParams` (canonical, survives remount) + `SearchInfo` (the render mirror). `start()`
  spreads it; `updateResults()` preserves it.
- `RoomView.onSearch(term, scope, senders = this.state.search?.senders)` threads senders to `eventSearch` + `start` +
  `setState`. New `onSearchSendersChange` re-runs the search keeping term+scope. **Review-found bug fixed:**
  `searchInfoFromSession` (the remount re-hydration mirror) was dropping `senders` → chip would lose its selection and a
  re-search would silently clear the filter; now carries `senders` (regression test added, verified RED-without-fix).
- Plumbed `onSearchSendersChange` + `searchSenders` down RoomView → `RightPanel` → `RoomSummaryCardView` → the control.

**UI (MVVM v2):**
- `apps/web/src/viewmodels/search/RoomSearchSenderFilterViewModel.ts` (extends shared `BaseViewModel`) — owns the
  candidate catalogue: `room.getJoinedMembers()` minus the current user (`room.myUserId`), sorted by display name.
- `apps/web/src/components/views/right_panel/RoomSearchSenderFilter.tsx` — Compound `Menu` of `CheckboxMenuItem`s
  (multi-select; `onSelect` `preventDefault` keeps the menu open) + a critical "Clear" `MenuItem`; `IconButton` trigger
  (`user-profile` icon) with an `indicator` dot + count-aware aria-label when active. Renders null when the room has no
  other members. Selected senders are CONTROLLED (from the store via props), not VM-owned.

**i18n:** `room|search|sender_filter_button`, `…_button_active` ("…(%(count)s selected)"), `…_clear`, `…_label`.

**Tests (all green, 173 across the affected suites):** Searching-test (+11: every path/pagination/over-fetch/empty-[]),
SearchSessionStore-test (+1), RoomSearchSenderFilterViewModel-test (+2), RoomSearchSenderFilter-test (+7 incl. controlled
multi-select accumulation + aria count), RoomView-test (+2: onSearchSendersChange re-search + senders remount
re-hydration). tsc clean (only the 4 pre-existing vendored matrix-js-sdk errors), eslint/prettier/i18n:lint clean. Jest
via `scratchpad/webjest.sh` (allowlist incl. matrix-js-sdk + @element-hq/web-shared-components).

**Adversarial review (4 lenses → 6 confirmed):** fixed = a11y count in aria-label (#4), empty-`[]` coverage (#6),
test-cast comment (#5); refuted-by-test = the rapid multi-select "stale closure" race (#2 — React flushes discrete
clicks and the control is a controlled component, proven by the accumulation test); pushed back = the `onSearch`
default-param debounce-after-cancel race (#1 — **pre-existing**, not introduced by slice 2; `senders` defaults to
`undefined` after cancel = no filter = no regression). **Deferred (polish):** an `inProgress` disabled/aria-busy state on
the menu items while a search is in flight (#3 — functional behaviour is already correct via AbortController + searchId;
would need threading `inProgress` down the RightPanel chain). PostHog interaction metric for the sender filter deferred
(same upstream analytics-events gap as the stepper / jump-to-date). In-picker member text-search omitted in v1 (a large
room shows a long checkbox list) — future enhancement.

## 4. Slice 3 (next) — Phase 4 searchable media tabs, or Phase 3 combinations
Per the master plan: Phase 3's structured filters (jump-to-date slice 1 + sender slice 2) are done. Next per
`search-improvement-plan.md` §5 is **Phase 4** (split `FilePanel` into searchable Media/Files/Links/Music/Voice tabs;
needs INDEX_VERSION bump + re-backfill to index media filenames). Combining `from:` + jump-to-date + term into one query
("from Alice in March") is a natural Phase 3 polish if wanted before Phase 4.
