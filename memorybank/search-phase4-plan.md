# Search Phase 4 plan — typed, searchable shared-media tabs (CORRECTED SCOPE)

> Authored 2026-06-25 (session 26). Evidence base: 7-agent `phase4-media-understand` workflow + direct code
> verification of the pivotal lines. Phases 1–3 complete & pushed (`origin/main` = `7ba0e59`).

---

## 0. CRITICAL premise correction (verified by code, not assumption)

`search-improvement-plan.md` §5 Phase 4 claims: _"today `isValidEvent` excludes media-only events, so
filenames/captions aren't indexed → needs INDEX_VERSION bump + full local Seshat re-backfill."_

**This is FALSE.** Verified:

- `isValidEvent` ([EventIndex.ts:555-579](apps/web/src/indexing/EventIndex.ts#L555-L579)) has **no media exclusion**.
  Media are `m.room.message` events → pass `isUsefulType`; `m.image/m.file/m.video/m.audio` msgtypes pass the
  `validMsgType` check (only `m.key.verification` is excluded); the sole content gate is
  `if (!ev.getContent().body) hasContentValue = false` (line 571).
- Every media upload sets `body: fileName` ([ContentMessages.ts:564-566](apps/web/src/ContentMessages.ts#L564-L566))
  before specialising the msgtype → media events **always carry a truthy `body` = filename** → already pass
  `isValidEvent` → **already indexed and searchable in ⌘F today** (live path line 615, crawler path line 892).
- Native Seshat applies **no** type gating and tokenizes `content.body` generically (matrix-seshat 4.3.0); search
  results render media tiles fine (`haveRendererForEvent` true; `sanitizeSeshatResults` preserves content).
- Bumping `INDEX_VERSION` alone would do **nothing** anyway — there's no version-comparison code
  ([EventIndexPeg.ts:88-99](apps/web/src/indexing/EventIndexPeg.ts#L88-L99) only handles the `userVersion === 0`
  legacy case), so a forced re-backfill would itself need new migration code.
- The one genuine gap (media _received_ from clients using the filename/caption split, so `body`=caption and
  `filename`=realname → only the caption is indexed) can't be fixed cleanly: native Seshat indexes `body` only, so
  making the `filename` field searchable needs a **native Seshat (Rust/Hak) rebuild**, not a JS change.

**User decision (session 26, AskUserQuestion, user away → autonomous):** ship **"Typed + searchable FilePanel tabs
(no re-backfill)"**. No `isValidEvent` change, no `INDEX_VERSION` bump, no index wipe. Deliver the genuinely-missing
UI; the main ⌘F media-filename search already works and stays untouched.

---

## 1. Scope

Split the un-tabbed, un-searchable [FilePanel.tsx](apps/web/src/components/structures/FilePanel.tsx) into typed,
text-filterable tabs, reusing the existing TimelinePanel + EventIndex pagination/encryption machinery.

**Tabs (v1):** `All · Media · Files · Music · Voice`. Classification (client-side, pure):

- **Media** = `m.image` ∪ `m.video`
- **Files** = `m.file`
- **Music** = `m.audio` AND NOT `isVoiceMessage`
- **Voice** = `m.audio` AND `isVoiceMessage` (`org.matrix.msc3245.voice` / msc2516 — `EventUtils.isVoiceMessage`)
- **All** = any of the above (`getFileCategory(ev) !== null`) — ≈ current behaviour (the `contains_url` filter +
  encrypted `loadFileEvents` already yield media-only events).

**Links deferred (documented):** the FilePanel data source is the `contains_url` server filter / `loadFileEvents`,
which return events with a `content.url` **field** (= media), NOT messages with hyperlinks in body text. A real
"Links" tab needs a separate link-extraction data source (scan message bodies) — out of scope for v1.

**In-tab search:** case-insensitive substring over `presentableTextForFile(content)` (filename ‖ body); empty/
whitespace term = match all. Client-side over loaded events (v1; matches "in-tab text-searchable").

---

## 2. Architecture (MVVM v2, low-risk, additive)

Keep FilePanel (class) as the proven data/lifecycle owner (timelineSet creation, encrypted live-event listeners,
pagination override) — **untouched logic**. Extract the render of (header + timeline) into a new functional MVVM-v2
view, and add ONE additive prop to TimelinePanel.

1. **`apps/web/src/utils/FileCategory.ts`** (new, pure, fully tested): `enum FileCategory`,
   `getFileCategory(ev)`, `eventMatchesCategory(ev, cat)`, `eventMatchesFileSearch(ev, term)`,
   `buildFileEventFilter(cat, term) → (ev) => boolean`.
2. **`apps/web/src/viewmodels/right_panel/RoomFilesViewModel.ts`** (new, extends shared `BaseViewModel`):
   snapshot `{ activeCategory: FileCategory; searchTerm: string }`; actions `setCategory`, `setSearchTerm`
   (via `this.snapshot.merge`).
3. **`apps/web/src/components/views/right_panel/RoomFilesView.tsx`** (new, functional View): owns the VM via
   `useCreateAutoDisposedViewModel`; renders a Compound `ChatFilter` tab row (`role="listbox"`, mirrors
   `RoomListPrimaryFilters`) + a Compound `Search` input (mirrors `RoomSummaryCardView`) + `<TimelinePanel>` with
   `eventFilter={buildFileEventFilter(activeCategory, searchTerm)}`. Receives `timelineSet`, `onPaginationRequest`,
   `empty`, `narrow` from FilePanel.
4. **`TimelinePanel.tsx`** (modified, additive): add `eventFilter?: (ev: MatrixEvent) => boolean`; at render
   ([line 1852](apps/web/src/components/structures/TimelinePanel.tsx#L1852)) apply
   `const events = this.props.eventFilter ? this.state.events.filter(this.props.eventFilter) : this.state.events;`
   — the filtered array feeds only the MessagePanel `events` prop; pagination/scroll logic keeps using
   `this.state.events` (full set). Default undefined → every other caller byte-identical. MessagePanel untouched.
5. **`FilePanel.tsx`** (modified, minimal): replace the inline `<TimelinePanel>` block with `<RoomFilesView .../>`
   inside the existing `BaseCard` / `ScopedRoomContextProvider`.
6. **i18n** (`en_EN.json`): `file_panel|tab_all|tab_media|tab_files|tab_music|tab_voice`, `file_panel|search_placeholder`.
7. **CSS**: `res/css/views/right_panel/_RoomFilesView.pcss` (+ register in `res/css/_components.pcss`).

**Pagination-fill note (documented limitation):** a sparse tab (e.g. Voice in a room with none) renders few/no
tiles; ScrollPanel will keep requesting fills → TimelinePanel paginates the (already small, url-only) file timeline
toward its start. Acceptable for v1; same shape as scrolling to find older media.

---

## 3. TDD order (RED→GREEN each)

1. `FileCategory-test.ts` → `FileCategory.ts` (classification + search matching + predicate builder; edge cases:
   voice vs music, non-media → null, empty term, filename‖body precedence, case-insensitivity).
2. `RoomFilesViewModel-test.ts` → `RoomFilesViewModel.ts` (initial snapshot, setCategory, setSearchTerm, no-op merge).
3. `TimelinePanel-test.tsx` (+case) → add `eventFilter` prop (filtered events reach MessagePanel; absent ⇒ unchanged).
4. `RoomFilesView-test.tsx` → `RoomFilesView.tsx` (renders tabs + search; switching category & typing updates the
   predicate handed to a stubbed TimelinePanel; default tab = All).
5. `FilePanel-test.tsx` (+ snapshot regen) → wire `RoomFilesView` into FilePanel (empty-state + addEncryptedLiveEvent
   still pass).

## 4. Verification

`pnpm -C apps/web test:unit` on the affected suites; `tsc --noEmit` (only the 4 pre-existing vendored matrix-js-sdk
errors); eslint `--max-warnings 0`; prettier; `i18n:lint`. Then an adversarial-review workflow over the diff.

## 4a. OUTCOME — DONE (session 26)

Shipped end-to-end via TDD + a 5-lens adversarial-review workflow. **No indexing change, no INDEX_VERSION bump, no
re-backfill** (premise §0 disproven).

**Files:** new `utils/FileCategory.ts` (pure classification + `buildFileEventFilter`), `viewmodels/right_panel/
RoomFilesViewModel.ts` (MVVM v2, `{activeCategory, searchTerm}`), `components/views/right_panel/RoomFilesView.tsx`
(Compound `ChatFilter` tab row `role=listbox/option` + `Search` input + arrow/Home/End keyboard nav, drives
TimelinePanel via the derived predicate); modified `TimelinePanel.tsx` (additive optional `eventFilter` prop, applied
to the displayed list only — full window kept for pagination/scroll), `FilePanel.tsx` (renders `RoomFilesView`),
`_RoomFilesView.pcss` (+ `_components.pcss`), `en_EN.json` (`file_panel|tab_*`, `search_placeholder`, `tabs_label`).

**Tabs:** All / Media / Files / Music / Voice. **Links deferred** (data source can't supply hyperlink-in-text events).

**Review (5 lenses → 24 findings → adversarially verified):** 2 confirmed & fixed, 0 deferred, 20 refuted.

- **FIXED (high/critical, 2 lenses):** TimelinePanel empty-state guard keyed off the UNFILTERED `this.state.events.length`,
  so a tab/search matching nothing rendered a blank panel instead of the "No files" empty state. Moved the filter
  computation above the guard; guard now checks the filtered list (regression test added: `eventFilter=()=>false` →
  empty state shows; verified RED-without-fix).
- **FIXED (a11y):** the `role=listbox/option` tab bar had no keyboard navigation. Added arrow/Home/End focus stepping
  across chips (ChatFilter hardcodes tabIndex=0 so a true single-tab-stop roving index isn't possible; focus-stepping +
  native Enter/Space activation is the pragmatic remedy, consistent with the ChatFilter-in-listbox precedent
  `RoomListPrimaryFilters`). Test added.
- **Refuted (notable):** thread-detection / read-receipt "desync" from filtering (read markers+receipts are off in the
  File panel; filtered events never reach the receipt loop); `this:void` "type mismatch" (compiles clean; method-syntax
  bivariance is the real load-bearing mechanism); listbox aria-label "should reflect selection" (anti-pattern — selection
  is on per-option `aria-selected`); RTL padding (horizontal padding is symmetric); redacted-event crash in search match
  (`getContent()` never throws + short-circuit on category). Several "missing test" findings were already covered by
  composition.

**Verification:** 75 affected unit tests green (FileCategory 16, RoomFilesViewModel 4, TimelinePanel 23, RoomFilesView 5,
FilePanel 2, MessagePanel 25 unchanged downstream); `tsc --noEmit` clean (only the 4 pre-existing vendored matrix-js-sdk
errors); eslint `--max-warnings 0` clean; prettier clean; i18n:lint clean. **Not verifiable here:** real desktop Seshat
round-trip / live media rendering in the tabs (unit tests use mocked timelines).

## 5. Deferred / follow-ups

- **Links tab** (separate link-extraction data source).
- **Native filename-field indexing** for split-format received media (needs Rust/Hak Seshat rebuild + re-backfill).
- PostHog interaction metric for the media tabs (same upstream `@matrix-org/analytics-events` gap as stepper/jump/sender).
- In-tab search currently filters only _loaded_ events; a "search all media via Seshat" mode is a future enhancement.
