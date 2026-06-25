# Search Phase 6 — Telegram-style top-of-chat search bar + results dropdown

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans.
> Steps use checkbox (`- [ ]`) syntax. TDD throughout (jest via `scratchpad/webjest.sh`).
>
> Authored: 2026-06-25 (session 28). Trigger: user reports two bugs on the macOS desktop build —
> (1) "Cmd+F opens the About/room-summary panel instead of a focused search box"; (2) "no Telegram-style
> dropdown of results". User explicitly chose the **Top-of-chat (Telegram-exact)** layout over the surgical
> right-panel option (see AskUserQuestion, session 28), knowing it is the larger redesign.

**Goal:** Move in-room search out of the right-panel "About" card into a Telegram-style search bar that
**replaces the room header** at the top of the chat, with a **dropdown list of result rows** (sender · preview ·
date) below it; clicking a row jumps the live timeline to that message.

**Architecture (low-breakage):** `RoomView` STAYS the search orchestrator. All search state (`this.state.search`),
the handlers (`onSearch`/`onSearchChange`/`onSearchScopeChange`/`onSearchSendersChange`/`onSearchOrderChange`/
`onSearchUpdate`/`onCancelSearchClick`/`onActivateSearchMatch`), the `searchNavVm` stepper, and `SearchSessionStore`
are UNCHANGED. We only relocate the **presentation**: render a new dumb `RoomSearchHeader` View in the header slot
([RoomView.tsx:2979-2985](apps/web/src/components/structures/RoomView.tsx#L2979-L2985)) instead of `<RoomHeader>`, and a
new `RoomSearchResults` dropdown below it. The Phase 2–5 sub-components (`RoomSearchSenderFilter`,
`RoomSearchJumpToDate`, `RoomSearchOrderToggle`, `SearchMatchNavigation`) are **moved**, not rewritten.

**Why this avoids the multi-week risk the fix-scoping agent flagged:** that analysis assumed a new `RoomHeaderVM`
owning search state + a second `SearchSessionStore` subscriber. We avoid both by keeping `RoomView` as the sole
owner and feeding the new Views via props (exactly the props already going to `RightPanel`/`RoomSearchAuxPanel`).

## Global Constraints (verbatim from CLAUDE.md)

- TypeScript strict (`noImplicitAny`); 4-space indent; semicolons; 120-col; named exports; Prettier.
- MVVM v2; Compound design system (`@vector-im/compound-web`); offline-only (no CDNs).
- Tests with every change: `scratchpad/webjest.sh <pattern>` for apps/web jest.
- New search sub-components live in `apps/web` (follow the existing `RoomSearchSenderFilter`/`RoomSearchAuxPanel`
  local pattern — NOT shared-components — because they consume matrix-js-sdk `Room`/`SearchInfo`/`navigationVm`).

## Confirmed behavioural decisions

- **Cmd+F** → opens the **top search bar** (empty, focused). Does NOT open the right panel anymore.
- The right-panel "About" card keeps its non-search content (info/members/files/threads…) — only the search box +
  filters leave it.
- Bar **replaces** `RoomHeader` while search is active (Telegram parity). Esc / cancel restores the normal header.
- The Phase 2–5 in-timeline stepping (live timeline + in-bubble highlight + "k of N" + arrows) is PRESERVED; the
  bar hosts the arrows/counter, the dropdown rows trigger the same `onActivateSearchMatch` jump.
- Web vs desktop: unchanged from Phase 1 — the Cmd+F keybinding is still gated by `ctrlFForSearch`
  (default-on Desktop only), so we do not newly hijack the browser find bar on web.

---

## Slice 6.1 — Top-of-chat search bar (fixes BUG #1) — ✅ DONE & VERIFIED (session 28)

Replace the right-panel + aux-panel search UI with one `RoomSearchHeader` bar in the header slot. Fixes BUG #1
(no more whole-About-panel on Cmd+F). No dropdown yet — results keep rendering via the existing `RoomSearchView`
in the main area until 6.2.

> **Done:** new `RoomSearchHeader.tsx` (+ `_RoomSearchHeader.pcss`) merges the old right-panel search header +
> `RoomSearchAuxPanel` (input + from:/jump-to-date/order filters + count + SearchMatchNavigation stepper + scope
> toggle + cancel; Esc cancels, Enter/Shift+Enter step). RoomView: new `searchHeaderActive` state set on
> FocusMessageSearch + in `onSearch` + rehydrated cross-room; render swaps `RoomHeader`↔`RoomSearchHeader` when
> `searchHeaderActive || search`; stopped feeding search props to `RightPanel`; dropped `RoomSearchAuxPanel` from the
> aux slot. `RightPanelStore` no longer opens RoomSummary on FocusMessageSearch. Focus works (dual autoFocus +
> dispatcher). TDD throughout. **Note:** focus was NEVER the bug (4 "focus" claims refuted by an adversarial
> workflow) — the bug was the whole About card rendering.

**Files:**

- Create: `apps/web/src/components/views/rooms/RoomSearchHeader.tsx` (dumb View: input + filters + count + stepper
    - scope toggle + cancel). Merges the controls from `RoomSummaryCardView`'s search header + `RoomSearchAuxPanel`.
- Create: `apps/web/res/css/views/rooms/_RoomSearchHeader.pcss`; add `@import` in `apps/web/res/css/_components.pcss`.
- Modify: `apps/web/src/components/structures/RoomView.tsx`
    - Add `searchHeaderActive: boolean` to `IRoomState` + initial `false`.
    - `Action.FocusMessageSearch` handler (~1430): `this.setState({ searchHeaderActive: true })` (keep initialText→onSearch).
    - `onCancelSearchClick` (2126): also set `searchHeaderActive: false`.
    - Render: when `searchHeaderActive`, render `<RoomSearchHeader …/>` instead of `<RoomHeader>` (2979-2985).
    - Stop rendering `RoomSearchAuxPanel` in the aux slot (2653-2662) — its content moves into the bar. (Keep the
      `RoomSearchView` results in the main area for now.)
    - Stop passing search props to `<RightPanel>` (2856-2862) → removes the right-panel search box.
- Modify: `apps/web/src/stores/right-panel/RightPanelStore.ts` (95-100): drop the `FocusMessageSearch` →
  RoomSummary open (so the right panel no longer pops). Leave `show`/card logic for other phases untouched.
- Modify: `apps/web/src/components/structures/RightPanel.tsx` + `RoomSummaryCardView.tsx`: make the search props
  optional/unused so the About card renders with NO search header (it already guards on `onSearchChange` presence —
  passing `undefined` hides it). Remove the now-dead `focusRoomSearch` autofocus path or leave inert.
- Test: `apps/web/test/unit-tests/components/views/rooms/RoomSearchHeader-test.tsx` (new);
  `…/structures/RoomView-test.tsx` (bar shows on FocusMessageSearch, hidden after cancel, RightPanel gets no
  search props); `…/stores/RightPanelStore-test.ts` (FocusMessageSearch does not switch to RoomSummary).

**Interfaces:**

- `RoomSearchHeader` props (Produces): `{ room: Room; term: string; onSearchChange(term:string):void;
onCancel():void; searchInfo?: SearchInfo; navigationVm?: SearchMatchNavigationViewModel; scope: SearchScope;
onScopeChange(scope:SearchScope):void; senders: string[]; onSendersChange(s:string[]):void;
order: SearchOrderBy; onOrderChange(o:SearchOrderBy):void; isRoomEncrypted: boolean; autoFocus?: boolean;
onBackToResults?():void; }`. (Consumes nothing new — RoomView already produces every value.)

**Tasks (TDD):**

- [ ] 6.1.1 RED+GREEN `RoomSearchHeader` renders a Compound `Search` input wired to `onSearchChange`, a cancel
      `IconButton` wired to `onCancel`, and Escape-in-input → `onCancel`. (Port `onUpdateSearchInput` Enter/Shift+Enter
      → `Action.SearchMatchStep` dispatch from `RoomSummaryCardViewModel` so keyboard stepping survives.)
- [ ] 6.1.2 RED+GREEN bar shows the "N results found" summary (`room|search|summary`) + `SearchMatchNavigation`
      (when `navigationVm` has matches) + scope toggle link (`room|search|all_rooms_button`/`this_room_button`) +
      `SearchWarning`. (Lift markup from `RoomSearchAuxPanel`.)
- [ ] 6.1.3 RED+GREEN bar mounts `RoomSearchSenderFilter` (keyed by room), `RoomSearchJumpToDate`,
      `RoomSearchOrderToggle` with the moved props.
- [ ] 6.1.4 RED+GREEN RoomView: `searchHeaderActive` state + FocusMessageSearch sets it true; render swaps
      `RoomHeader`↔`RoomSearchHeader`; cancel resets it false.
- [ ] 6.1.5 RED+GREEN RoomView stops feeding search to `RightPanel`; `RoomSearchAuxPanel` no longer in aux slot.
- [ ] 6.1.6 RED+GREEN `RightPanelStore` FocusMessageSearch no longer opens RoomSummary.
- [ ] 6.1.7 pcss for the bar (full-width header row, Compound spacing, filters right-aligned, accent cancel).
- [ ] 6.1.8 `pnpm lint` + `webjest.sh` green; tsc/eslint/prettier/i18n clean. Commit.

---

## Slice 6.2 — Telegram results dropdown (fixes BUG #2) — ✅ DONE & VERIFIED (session 28)

Render result rows directly under the bar, overlaying the live timeline. Clicking a row jumps the timeline.

> **Done:** `extractSearchResultPreviews(results): SearchResultPreview[]` (newest-first, parallel to
> `extractSearchMatches`, carries sender/body/ts) in `Searching.ts`; `previews` threaded through `SearchInfo` +
> `SearchSessionStore` (start/updateResults/snapshot) + `searchInfoFromSession` rehydration + `onSearchUpdate`. New
> dumb `RoomSearchResults.tsx` (+ `_RoomSearchResults.pcss`): avatar + sender name + preview + date rows, empty
> (`room|search|no_results`) / spinner / error states. RoomView mounts it as an **opaque overlay** over the still-
> mounted `RoomSearchView` (kept as the data engine that awaits the promise + drives `onSearchUpdate`); a row click →
> `onSearchResultClick` → `onActivateSearchMatch(matches[i], i)` jumps the live timeline. i18n keys added:
> `room|search|no_results`, `room|search|results_label`. **Type regression caught & fixed:** the new required
> `searchHeaderActive` field broke 3 `IRoomState`/`RoomContextType` constructors (`RoomContext.ts`,
> `test-utils/room.ts`, `SendMessageComposer-test.tsx`) — all given `searchHeaderActive: false`.
>
> **Verification (whole Phase 6):** 260 web Jest across 11 suites; tsc clean (only pre-existing matrix-js-sdk 41.8.0
> source errors remain); eslint/stylelint/prettier/i18n clean.
>
> **Known follow-ups (not blockers):** (a) the overlay double-renders `RoomSearchView` underneath — extract its
> promise-handling into a `useSearchResults` hook so the engine isn't rendered twice; (b) `RoomSummaryCardView` still
> has the (now unused) search-header capability + `focusRoomSearch` prop — dead code to remove; (c) no result
> highlighting / pagination-beyond-first-page in the dropdown yet; (d) result rows show no avatar image (initials
> only). See also 6.3 polish below.

**Files:**

- Create: `apps/web/src/components/views/rooms/RoomSearchResults.tsx` (dumb View: vertical list of compact rows —
  `RoomAvatar`/sender · highlighted preview · relative date; scrollable; empty/loading/error states).
- Modify: `apps/web/src/Searching.ts`: add `extractSearchResultPreviews(results): SearchResultPreview[]` returning
  `{ roomId, eventId, sender, body, ts }[]` (newest-first, same order as `extractSearchMatches`). Add the
  `SearchResultPreview` interface next to `SearchMatch` (1157).
- Modify: `RoomView.tsx` `onSearchUpdate` (1938): also compute previews → carry on `state.search.previews`
  (+ `SearchInfo.previews?: SearchResultPreview[]` in `Searching.ts`; mirror into `SearchSessionStore` like
  `matches`, and re-hydrate in `searchInfoFromSession` — same pattern as the slice-2 `senders` carry).
- Modify: `RoomView.tsx` render: mount `<RoomSearchResults>` below the header when `searchHeaderActive && state.search`
  and not stepping; row click → `this.onActivateSearchMatch({roomId,eventId}, index)`. Decide RoomSearchView:
  keep it reachable (e.g. an "open full results" affordance) or gate it off when the dropdown is shown.
- Create: `apps/web/res/css/views/rooms/_RoomSearchResults.pcss` (absolute/overlay dropdown under the bar,
  max-height, shadow, scroll) + `@import`.
- Test: `RoomSearchResults-test.tsx` (rows render sender/preview/date; click fires callback; empty/loading states);
  `RoomView-test.tsx` (previews populated on update; dropdown shows; click → `onActivateSearchMatch`);
  `Searching-test.ts` (`extractSearchResultPreviews` order + fields).

**Interfaces:**

- `SearchResultPreview = { roomId: string; eventId: string; sender: string; body: string; ts: number }`.
- `RoomSearchResults` props: `{ previews: SearchResultPreview[]; highlights?: string[]; inProgress: boolean;
error?: Error; onResultClick(index:number):void; getMemberName(roomId,sender):string }`.

**Tasks (TDD):** 6.2.1 `extractSearchResultPreviews` RED+GREEN · 6.2.2 thread `previews` through state+store+rehydrate ·
6.2.3 `RoomSearchResults` rows RED+GREEN · 6.2.4 RoomView mounts dropdown + click→jump · 6.2.5 pcss · 6.2.6 lint/jest/commit.

---

## Open follow-ups (defer)

- Browser Cmd+F on web is still gated off by default (`ctrlFForSearch`), so no new hijack — keep it that way.
- `RoomSearchView` (full main-area list): decide keep-as-secondary vs remove once the dropdown lands (6.2).
- Snapshot churn: `RoomSummaryCardView` snapshots lose the search header — update them.
- Possible 6.3: animate the header swap; mobile/narrow layout for the bar's filter row (overflow menu).
