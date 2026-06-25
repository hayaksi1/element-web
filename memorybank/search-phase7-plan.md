# Search Phase 7 — Fix 3 reported in-room search bugs (macOS desktop)

> **STATUS: ✅ DONE & VERIFIED (session 29, 2026-06-26).** All 3 slices implemented; 178 web jest pass across the
> 6 touched suites; tsc/eslint/stylelint/prettier clean. Adversarial review (3 reviewers + verify, 13 findings) →
> 12 refuted, 1 confirmed low-sev bug FIXED: RoomSearchHeader compared the **untrimmed** box value to `term` on
> Enter, so whitespace-padding caused a redundant re-search instead of stepping — now trims on BOTH compare and
> commit (`onSearchChange(trimmed)`), with 2 regression tests. Unsigned arm64 desktop app rebuilt
> (`apps/desktop/dist/mac-arm64/Element.app` + `Element-1.12.22-arm64.dmg`), Phase 7 classes verified inside the
> packaged renderer. Build recipe note: must build the LOCAL `apps/web` (webpack) → stage into `apps/desktop/webapp`
> → `asar-webapp` → electron-builder; the recipe's `fetch develop` would NOT contain renderer changes
> (see `scratchpad/build-macos.sh`).
>
> Key design confirmations from the review (do not "fix"): (a) the kept-mounted RoomSearchView data engine is
> `visibility:hidden; inset:0` (NOT display:none) on purpose — layout/geometry preserved so its ScrollPanel
> auto-fills AND short result lists still paginate even when the dropdown can't scroll; (b) duplicate-pagination is
> deduped synchronously at the data layer by `searchResult.pendingRequest` (Searching.ts:1121 + SDK), so the
> dropdown's `hasMore && !inProgress` scroll gate is best-effort, not the correctness boundary; (c) `aborted` ref in
> RoomSearchView already discards stale cross-room results.

> Authored: 2026-06-26 (session 29). Trigger: user reports on the macOS build —
> (1) search runs automatically while typing (should wait for **Enter**);
> (2) results cover the whole app (no conversation visible) — want a **Telegram bounded dropdown** with the
>     live timeline visible behind it;
> (3) "54 results found" but only the first **10** are reachable — want **infinite scroll** to load all.
>
> User decisions (AskUserQuestion, session 29): **Enter-to-search** (Enter again on the same text steps to the
> next match) · **Telegram bounded dropdown, conversation visible** · **infinite scroll**.

## Confirmed root causes (code + adversarial verification, all 3 `confirmed:true`)

- **Bug1:** `RoomSearchHeader` input `onChange` calls `onSearchChange` every keystroke
  ([RoomSearchHeader.tsx:128-131](../apps/web/src/components/views/rooms/RoomSearchHeader.tsx#L128-L131)); RoomView
  wraps it in `debounce(onSearch, 300)` ([RoomView.tsx:2161-2163](../apps/web/src/components/structures/RoomView.tsx#L2161-L2163)),
  so a search fires ~300 ms after typing. Enter is bound to `Action.SearchMatchStep` (step match), not search.
- **Bug2:** `.mx_RoomSearchResults` is `position:absolute; inset:0` opaque overlay
  ([_RoomSearchResults.pcss:20-27](../apps/web/res/css/views/rooms/_RoomSearchResults.pcss#L20-L27)) AND the live
  timeline is `hidden` (`hideMessagePanel=true` → `display:none`, RoomView.tsx:2818 + 2849). Two mechanisms hide
  the conversation.
- **Bug3:** `SEARCH_LIMIT=10` first page. Pagination exists (`searchPagination` → `onSearchResultsFillRequest`,
  RoomSearchView.tsx:152-165) but is only driven by the hidden `RoomSearchView` ScrollPanel under the opaque
  dropdown; the visible `RoomSearchResults` has no scroll→load-more, so the user is stuck at 10. `onSearchUpdate`
  already recomputes previews/matches over the FULL accumulated `results.results`, so only the **trigger** is missing.

## Slice 7.1 — Bug1: search on Enter (not while typing)

- `RoomSearchHeader.tsx`: input `onChange` → only `setSearchValue` (no parent call). `onKeyDown` Enter (not IME
  composing): if `searchValue.trim()` non-empty AND `searchValue !== term` → `onSearchChange(searchValue)` (commit);
  else (term unchanged) → dispatch `Action.SearchMatchStep` (next / previous on Shift+Enter). Esc unchanged.
  Update `onSearchChange` JSDoc ("commit a search; parent runs it immediately").
- `RoomView.tsx`: `onSearchChange = (term) => this.onSearch(term)` (drop the 300 ms debounce; drop unused `debounce`
  import — keep `throttle`).
- Tests: typing doesn't call `onSearchChange`; Enter(changed term) commits; Enter(unchanged) steps next; Shift+Enter
  steps previous; empty Enter no-op; Esc cancels.

## Slice 7.2 — Bug2: bounded dropdown + conversation visible

- `_RoomSearchResults.pcss`: `.mx_RoomView_searchResultsWrapper` → `position:absolute; top/left/right:0; z-index:1`
  (anchors to `.mx_RoomView_timeline`, already `position:relative`). `.mx_RoomSearchResults` → drop `inset:0`; add
  `max-height: min(60vh, 480px); overflow-y:auto; box-shadow; border-radius:0 0 8px 8px; border-bottom`. Add
  `.mx_RoomView_searchDataEngine { display:none; }`.
- `RoomView.tsx`: remove `hideMessagePanel = true` (timeline stays visible). Wrap `<RoomSearchView>` in
  `<div className="mx_RoomView_searchDataEngine">` (hidden data engine). Repoint `handleScrollKey` away from the
  hidden `searchResultsPanel` to `messagePanel` (the visible timeline) — or keep but it's inert.
- Tests: messagePanel not hidden while dropdown shown; dropdown + live timeline both mounted.

## Slice 7.3 — Bug3: infinite scroll in the dropdown

- `RoomSearchView.tsx`: add prop `loadMoreRef?: MutableRefObject<(() => Promise<boolean>) | null>`; set
  `loadMoreRef.current = () => onSearchResultsFillRequest(true)` after it's defined (null in the `results===null`
  early return).
- `RoomView.tsx`: field `searchLoadMore = { current: null }`; pass `loadMoreRef={this.searchLoadMore}`. Handler
  `onSearchLoadMore = () => void this.searchLoadMore.current?.()`. In `onSearchUpdate`: compute
  `hasMore = searchResults ? !!searchResults.next_batch : prev?.hasMore`; **preserve** prior
  previews/matches/highlights/count during the in-progress interim (don't clear → no list flash); store `hasMore`.
  Pass `hasMore` + `onLoadMore` to `RoomSearchResults`.
- `RoomSearchResults.tsx`: props `hasMore`, `onLoadMore`. `onScroll` on the scroll container → near-bottom +
  `hasMore && !inProgress` → `onLoadMore()`. Bottom spinner row while `inProgress && previews.length>0`.
- `SearchSessionStore.ts`: `hasMore?` on results; `hasMore` on session; `start` false; `updateResults`
  `hasMore: results.hasMore ?? session.hasMore`. `Searching.ts`: `SearchInfo.hasMore?`. RoomView
  `searchInfoFromSession`: carry `hasMore`. (Optional field → no constructor breakage.)
- Tests: `RoomSearchResults` near-bottom scroll → `onLoadMore` (only when hasMore && !inProgress); RoomView threads
  hasMore + preserves previews during interim; `RoomSearchView` populates `loadMoreRef` → `searchPagination`.

## Verify / done
- `scripts: scratchpad/webjest.sh` for the touched suites; `pnpm lint` (tsc/eslint/stylelint/prettier/i18n).
- Then build the unsigned macOS desktop app for the user to test (see `element-desktop-build-recipe` memory).
