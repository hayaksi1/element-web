# Search Phase 5 plan — reach / ranking / index-health

> Authored 2026-06-25 (session 27). Evidence base: a 5-agent Understand workflow (`phase5-relevance-understand`)
> over `Searching.ts` + the full search stack, plus direct code reads. Phases 1–4 are complete and pushed
> (`origin/main` = `d4c87fa`). User is away and pre-authorised: "choose the recommended or close-to-Telegram option
> for any question" — so the slice choice + all design decisions below were taken autonomously on that basis and
> delivered as one verified increment (matching the established per-slice pattern).

---

## 0. Phase 5 scope (master plan §5) and how it maps to reality

`search-improvement-plan.md` §5 lists three Phase-5 items:

1. **Portable offline encrypted search for web/mobile** (SQLite-WASM / tantivy-WASM) **or document why it stays
   Desktop-only.** → **Documented as Desktop-only (decision below).** It collides with the hard offline-only / no-CDN
   constraint and is a multi-week architecture spike, not a shippable increment.
2. **Optional relevance-vs-recency order toggle** (Seshat returns a relevance score; SDK has `SearchOrderBy.Rank`).
   → **This slice (slice 1).** The one concrete, user-facing, self-contained Phase-5 deliverable.
3. **Corrupt-index health check (#32056)** + backfill completeness (#32266/#32168/#32307). → **Mostly already built
   in this fork** (the #33501 crawler circuit-breaker, the given-up-rooms set, `getIndexingStatus()` →
   `{indexing, indexed, errored}`, `EventIndexPanel` already surfaces `EventIndexPeg.error` + a reset path). The
   narrow remaining gap = surfacing index _un-readiness_ at **search time** (vs only in settings). Queued as a future
   slice rather than half-built.

### Decision: offline web search stays Desktop-only (documented)

Element-web must run with **no public internet access and no remote scripts/assets** (CLAUDE.md §2). A portable
encrypted-search engine for the web build would mean packaging a full SQLite-WASM / tantivy-WASM index + crawler
locally, persisting an encrypted index in the browser (OPFS/IndexedDB), and re-implementing Seshat's crawl/backfill
off the main thread — a multi-week, high-risk bet with its own storage/perf/security surface. Encrypted search
therefore **remains Desktop/Seshat-only**; the web build keeps the existing homeserver-only path (and the
`message_search_unsupported_web` settings copy already tells the user to use Desktop). Revisit only if portable
encrypted search becomes a product requirement.

---

## 1. Slice 1 — relevance-vs-recency order toggle (design)

### What it is

A small **Recent / Relevant** order control in the in-room search header (a Compound `Menu` of two `RadioMenuItem`s
behind an `IconButton`), sitting beside the existing `from:`/sender filter and jump-to-date calendar. Default
**Most recent** (preserves today's behaviour, offline-safe). Picking **Most relevant** re-runs the active search
asking the backend to order by relevance.

### The correctness crux (verified by the Understand workflow)

Result-list order is decided differently per search path:

| Path                                                       | How order is set                          | Client re-sort?                                                                                                                                                                                                         | Honours Rank?                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **server-only** (no Seshat, or known-non-E2EE single room) | homeserver `order_by` in the request body | **No** — `processRoomEventsSearch` appends in array order                                                                                                                                                               | **YES** via `order_by: SearchOrderBy.Rank`                                                     |
| **Seshat-only single room** (encrypted — the common case)  | Seshat `ISearchArgs.order_by_recency`     | **No** — pass-through                                                                                                                                                                                                   | **YES** via `order_by_recency: false` (Seshat/tantivy then orders by its BM25 relevance score) |
| **combined** (All-rooms)                                   | both legs merged client-side              | **YES** — `combineEventSources` sorts by `compareEvents` (recency); the sliding-window cache (`combineEvents`/`compareOldestEvents`) pages the next leg by _oldest timestamp_ and is only valid for recency-sorted legs | **NO** — would silently corrupt cross-page order                                               |
| **chain** (upgraded-room predecessors)                     | k-way merge                               | **YES** — `mergeChainResults` re-sorts by `compareEvents`                                                                                                                                                               | **NO** — same invariant                                                                        |

So the minimal **correct** scope: honour Rank **only on the two single-source pass-through paths**, and keep the
merged paths (All-rooms + chain) on Recent. This is done **by construction**: `order` is threaded only into the
single-source legs; `combinedSearch`/`chainSearchProcess` simply never pass it, so their `serverSideSearch` /
`buildSeshatSearchArgs` calls keep the `SearchOrderBy.Recent` default. No comparator is touched. A naïve
"make `compareEvents` rank-aware" would corrupt cross-page order — explicitly **deferred** (needs a
merge-by-rank / page-by-lowest-rank-frontier redesign of `combineEvents` + `mergeChainResults`).

`extractSearchMatches` (the in-timeline **stepping** order, Phase 2) deliberately re-sorts newest-first regardless
of backend order, so **stepping stays chronological even under Rank** — by design; left unchanged.

### Backend threading (`Searching.ts`) — mirror of the `senders` param

Add `order: SearchOrderBy = SearchOrderBy.Recent` to, and forward it down, only the single-source legs:

- `eventSearch` (entry) → `serverSideSearchProcess` (no-index branch) **and** `eventIndexSearch`.
- `eventIndexSearch` → `serverSideSearchProcess` (seshat=0 branch) **and** `localSearchProcess` (single Seshat room).
  **NOT** into `chainSearchProcess` / `combinedSearch`.
- `serverSideSearchProcess` → `serverSideSearch`, which sets `order_by: order` (was hardcoded `Recent` at
  `Searching.ts:213`). The order rides inside the `body`/`_query`, so server pagination replays it for free.
- `localSearchProcess` → `localSearch` → `buildSeshatSearchArgs`, which sets
  `order_by_recency: order !== SearchOrderBy.Rank` (was hardcoded `true` at `:363`). The flag rides in the stored
  `seshatQuery`, so Seshat pagination keeps the order.
- Add explanatory comments at `combinedSearch` and `chainSearchProcess` stating Rank is intentionally not honoured
  on the merged paths pending a merge redesign.

### State threading (mirror of `senders`)

- `SearchInfo.order?: SearchOrderBy` (`Searching.ts`, the per-room-view render mirror).
- `SearchSessionParams.order?: SearchOrderBy` (`SearchSessionStore.ts`, session identity → survives remounts,
  preserved verbatim by `updateResults`).
- `searchInfoFromSession` (`RoomView.tsx`): add `order: session.order` — **the slice-2 rehydration gotcha**: any
  field omitted here is silently dropped on a cross-room stepping remount.

### Re-search seam + mount chain (mirror of `senders`)

- `RoomView.onSearch(term, scope, senders, order = this.state.search?.order ?? SearchOrderBy.Recent)` → thread into
  `eventSearch`, `SearchSessionStore.start`, and `setState`. `onSearchScopeChange`/`onSearchSendersChange`/
  `onSearchChange` call `onSearch` positionally and so preserve `order` from the session automatically.
- New `RoomView.onSearchOrderChange = (order) => this.onSearch(term, scope, senders, order)`.
- Pass `onSearchOrderChange` + `searchOrder` down `RoomView` → `RightPanel` (RoomProps) → `RoomSummaryCardView`
  (IProps) → the control, exactly as `onSearchSendersChange`/`searchSenders`.

### UI (MVVM v2, no VM needed — two static options)

New dumb View `apps/web/src/components/views/right_panel/RoomSearchOrderToggle.tsx`:

- Props `{ order: SearchOrderBy; onSearchOrderChange: (order) => void }` — fully controlled (order owned upstream).
- Compound `Menu` (title = `room|search|order_toggle_label`) + two `RadioMenuItem`s (Most recent / Most relevant),
  `IconButton` trigger (`chevron-up-down` icon, `size="28px"`, 20px icon) with an `indicator` dot when
  `order !== Recent` (mirrors the sender filter's active dot). Mounted in the `RoomSummaryCardView` header `Flex`
  beside `RoomSearchSenderFilter` / `RoomSearchJumpToDate`, gated on `onSearchOrderChange &&` (so it shows whenever
  the search header is shown). No `RoomSearchOrderToggleViewModel` — there is no per-room catalogue to compute
  (unlike the sender filter's member list).

### i18n (new `room|search|*` keys)

`order_toggle_button` ("Sort results"), `order_toggle_label` ("Sort search results"),
`order_recent` ("Most recent"), `order_relevant` ("Most relevant"). Run `pnpm -C apps/web run i18n:sort`. No
shared-components `dist` rebuild needed (apps/web-local keys; reads strings from `src`).

### Tests (TDD RED→GREEN)

- `Searching-test.ts` (new describe): server body `order_by` = `Rank` when requested / `Recent` by default;
  `order_by_recency` = `false` under Rank on the Seshat single-room path / `true` by default; **guard** — an
  all-rooms search keeps `Recent` + `order_by_recency: true` even when `Rank` is requested (merged-path deferral).
- `SearchSessionStore-test.ts`: `start({order: Rank})` then `updateResults` still yields `order === Rank` (identity).
- `RoomSearchOrderToggle-test.tsx` (new): selecting each option calls `onSearchOrderChange` with the right enum; the
  checked radio reflects `order`; indicator dot shows iff `order !== Recent`; aria-label present.
- `RoomView-test.tsx`: `onSearchOrderChange(Rank)` re-runs the search preserving `term`/`scope`/`senders` and adds
  `order: Rank`, mirrored onto render state.

### Verification

Jest via `scratchpad/webjest.sh`; `tsc --noEmit` (only the 4 pre-existing vendored matrix-js-sdk errors), eslint
`--max-warnings 0`, prettier, `i18n:lint`. **Not verifiable here:** a real homeserver `order_by: rank` round-trip
and a real Seshat `order_by_recency: false` relevance ordering on a live desktop build (unit tests assert the
request params, not the backend's actual ordering).

### Risks / deferred (called out for the reviewer)

- **All-rooms + chain stay recency** (documented limitation). Honouring Rank there needs a merge redesign — deferred.
- **`RoomSearchView` render loop** reverses the array positionally to lay out a chronological timeline and merges
  adjacent contexts; a rank order is not a contiguous timeline, so grouping may look slightly off under Rank on the
  paths that honour it. Accepted for slice 1; a presentation rethink is deferred.
- **Stepping vs list divergence**: under Rank the results list is rank-ordered while stepping stays chronological.
  By design (Phase-2 `extractSearchMatches`); documented.
- **Seshat relevance** depends on `order_by_recency: false` selecting tantivy's BM25 score order (the documented
  meaning of the flag). Verified by API semantics + Seshat = BM25 full-text backend; not unit-testable here.

## 2. Next (future slices)

- **5.2 — search-time index-health surfacing (#32056):** distinguish "index still building / disabled / corrupt"
  from "genuinely no matches" in the search results UI (today only settings shows `EventIndexPeg.error`).
- **5.3 — Rank on merged paths:** merge-by-rank / page-by-lowest-rank-frontier redesign of `combineEvents` +
  `mergeChainResults` so All-rooms / chain can honour relevance.
- PostHog interaction metric for the order toggle deferred (same upstream `@matrix-org/analytics-events` schema gap
  as the Phase-2 stepper / sender filter / jump-to-date).
