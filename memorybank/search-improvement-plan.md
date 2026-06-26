# Room Search Improvement Plan — "Make search work like Telegram"

> Status: **PROPOSAL — awaiting confirmation before implementation.**
> Authored: 2026-06-25. Evidence base: code reading of this fork + Telegram research + upstream element-web/matrix-react-sdk PR scan.
> Trigger: user reports "CMD+F to search in a room doesn't work" and "search isn't as good as Telegram".

---

## 1. The CMD+F bug — root cause (confirmed by code)

Pressing **⌘F / Ctrl+F in a room does nothing by default** because of a single setting gate, **not** a focus bug and **not** a desktop/Electron problem.

- The `SearchInRoom` key combo `{key: 'f', ctrlOrCmdKey: true}` is **only registered** when the
  `ctrlFForSearch` account setting is truthy — see `roomBindings()` in
  [apps/web/src/KeyBindingsDefaults.ts:116-130](apps/web/src/KeyBindingsDefaults.ts#L116-L130). The base ROOM
  category has **no default combo** for it.
- `ctrlFForSearch` **defaults to `false`** —
  [apps/web/src/settings/Settings.tsx:956-960](apps/web/src/settings/Settings.tsx#L956-L960).
- With the setting off, `getKeyBindingsManager().getRoomAction(ev)` returns `undefined`, so
  [LoggedInView.tsx:540-543](apps/web/src/components/structures/LoggedInView.tsx#L540-L543) never fires
  `Action.FocusMessageSearch`, and the keystroke falls through to the browser/OS.
- **No Electron interception**: [vectormenu.ts](apps/desktop/src/vectormenu.ts) has no Find item,
  [webcontents-handler.ts](apps/desktop/src/webcontents-handler.ts) has no `findInPage`, and the only
  `before-input-event` handler ([electron-main.ts:488-509](apps/desktop/src/electron-main.ts#L488-L509)) touches
  only the Quit shortcuts. **Web and desktop behave identically.**

**The "focus swallows the key" theory is false.** `onNativeKeyDown` only forwards when `ev.target === document.body`
([LoggedInView.tsx:518-525](apps/web/src/components/structures/LoggedInView.tsx#L518-L525)), but the React bubbling
path `onReactKeyDown` still fires for a focused composer, so when the setting is **on** the shortcut works regardless
of focus.

**The historic upstream "works once then dead" regression is already fixed here.** PR #28223 (merged 2024-10-17,
fixes #28221) handled a minimised RoomSummary card swallowing the shortcut — our
[RightPanelStore.ts:95-100](apps/web/src/stores/right-panel/RightPanelStore.ts#L95-L100) already re-opens the card on
`FocusMessageSearch`. So the **only** operative blocker today is the default-`false` gate.

---

## 2. Upstream PR / issue scan (answer to "is there a PR for the macOS search function?")

**There is no current/open upstream PR that fixes a macOS-specific search bug.** The relevant items:

| Ref                                                                       | State                 | What it is                                                                                                                       | Bearing on us                                                               |
| ------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| element-hq/element-web **#28223**                                         | merged 2024-10-17     | Fix Ctrl+F not working with minimised room summary card (fixes #28221)                                                           | **Already present in this fork** (RightPanelStore). No action needed.       |
| **#28221 / #27797 / #32081**                                              | closed                | "Ctrl+F works once then dead" regression family (v1.11.71-77)                                                                    | Already fixed; verify no re-regression with a test.                         |
| **#22888**                                                                | **open**              | "Ctrl+F is OFF by default, users think it's broken" — proposes surfacing the toggle                                              | Directly validates our Phase 1 (discoverability).                           |
| **#24359**                                                                | **open**              | "Differentiate Ctrl+F timeline search between desktop and web" (browser find should win on web)                                  | Informs the per-platform default decision.                                  |
| **#33360**                                                                | closed (cannot-repro) | Element captures Find so the browser's native findbar can't open                                                                 | Caution: don't hijack browser find on web.                                  |
| **#2764 / #13933 / #15816**                                               | closed                | Original macOS/Electron "Cmd-F doesn't exist / should toggle Search" requests                                                    | Historical origin of the feature; the macOS angle.                          |
| **#27876**                                                                | **open**              | Fold message search into the Cmd-K / top search box                                                                              | Phase 5 unified-search direction.                                           |
| **#21640**                                                                | **open**              | Design how fuzzy search results should be shown                                                                                  | Phase 5 fuzzy UI.                                                           |
| **#32127 / #32343 / #32168 / #32056 / #32258 / #32266 / #32307 / #32030** | **open**              | Search-quality / indexing defects (edits not found, `:` SyntaxError, tokenizer gaps, corrupt index, upgraded-room history, etc.) | Several already addressed by our Phase 4.x work; the rest feed Phase 5.     |
| matrix-org/matrix-react-sdk **#4156**                                     | closed (not merged)   | "SearchBar: search by author" (`from:` filter)                                                                                   | Telegram-style sender filter wanted upstream but never built → our Phase 3. |

**Bottom line for the user:** the macOS CMD+F "doesn't work" is the off-by-default setting, not a missing/broken
desktop PR. Upstream ships it opt-in deliberately.

---

## 3. How Telegram's in-room search works (research summary)

1. **In-place, not a list.** ⌘F swaps the chat header for an inline search field; the **live timeline stays**. You
   step through matches with **up/down chevrons**, each click re-scrolls the _same_ conversation to the next/previous
   hit (reusing the reply-jump animation), with a **"k of N" counter** and the matched term **highlighted in the real
   bubble**. You never leave the conversation. (tdesktop changelog 5.9.1: "Highlight some of search query on result.")
2. **Filters in the search bar.** A **sender filter** (`from:`/member picker), a **jump-to-date calendar**, and
   **typed shared-media tabs** (Media / Files / Links / Music / Voice / GIFs) that are themselves text-searchable.
   Filters combine: "from Alice, containing 'boat', in March".
3. **One global box.** The chat-list search blends Chats / Contacts / Messages / public Channels in sectioned results;
   server-side plaintext index makes it feel instant over years of history.
4. **Telegram's weaknesses we already beat or avoid:** whole-word/prefix only (no substring); **broken for CJK** for
   ~10 years; opaque popularity/Premium/geo ranking on public results. Our fork's configurable **n-gram tokenizer**
   (#32038) already makes Seshat CJK-capable — _ahead of Telegram_.

---

## 4. Capability gap table (Telegram vs Element today)

| Capability                             | Telegram                                       | Element today                                                                                                                              | Gap                             |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| **In-chat match stepper (up/down)**    | Chevrons walk the live timeline match-by-match | Separate `RoomSearchView` list of result tiles; click to jump out                                                                          | **LARGE** — biggest divergence  |
| **"k of N" active counter**            | Live current/total in the bar                  | Static "N results found" only ([RoomSearchAuxPanel.tsx:37-42](apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx#L37-L42))         | MEDIUM                          |
| **Inline highlight + jump-in-context** | Highlights in the real bubble, flashes message | Highlight only inside result tiles, fixed 1-msg context ([Searching.ts](apps/web/src/Searching.ts))                                        | **LARGE**                       |
| **`from:` / sender filter**            | Member picker, combinable                      | None; homeserver `IRoomEventFilter` supports `senders` but UI never sets it; Seshat `ISearchArgs` has no sender field                      | **LARGE** (UI), partial backend |
| **Jump-to-date / calendar**            | Calendar teleports timeline                    | None in search; MSC3030 `timestamp_to_event` unused                                                                                        | **LARGE**                       |
| **Media-type tabs (searchable)**       | Media/Files/Links/Music/Voice/GIF              | One combined [FilePanel.tsx](apps/web/src/components/structures/FilePanel.tsx), un-tabbed, un-searchable; index excludes media-only events | **LARGE**                       |
| **Global unified box**                 | One box: chats+people+messages+public          | Only Room/All scope + separate Spotlight (⌘K)                                                                                              | MEDIUM-LARGE                    |
| **Partial / prefix / CJK**             | Whole-word + prefix; **CJK broken**            | Homeserver substring; Seshat prefix + **n-gram CJK mode (#32038)**                                                                         | **SMALL / favorable**           |
| **⌘F discoverability**                 | Always on                                      | Hidden behind undescribed off-by-default toggle                                                                                            | MEDIUM                          |

---

## 5. Phased implementation plan

Constraints respected throughout: **MVVM v2** (ViewModels in `apps/web/src/viewmodels`, dumb Views in
`packages/shared-components`), **offline-only** (no CDNs / remote WASM), **Compound** design system, **strict
TypeScript**, **Seshat** for encrypted rooms, tests with every change (`pnpm test:unit`).

### Phase 1 — Fix the "⌘F does nothing" perception _(Small, ~1-2 days, LOW risk)_ — RECOMMENDED FIRST

Goal: make the in-room search shortcut actually usable/discoverable; closes the user's #1 complaint.

Two options (a product decision — see §6 Q1):

- **1A — Enable by default (Desktop, or everywhere).** Flip `ctrlFForSearch` default to `true` (or default-true on
  Electron only, per #24359). On Desktop the Seshat target is non-degraded and there is no browser findbar to hijack,
  so this is clean and matches Telegram's "just works" expectation.
- **1B — Discoverability only (upstream-aligned).** Keep opt-in but (i) add a description/caption under the toggle
  explaining it overrides browser "find on page" and that encrypted search needs Desktop+Seshat; (ii) show a **one-time
  non-modal toast** when ⌘F is pressed while the setting is off (intercept ONLY on the `document.body` native path so a
  focused composer never competes, and never `preventDefault` the browser find — avoids #33360), linking to the toggle.

Both add the **missing gating tests**: `roomBindings()` excludes `SearchInRoom` when `ctrlFForSearch=false`.

Files: [Settings.tsx](apps/web/src/settings/Settings.tsx) ·
[KeyBindingsDefaults.ts](apps/web/src/KeyBindingsDefaults.ts) ·
[PreferencesUserSettingsTab.tsx](apps/web/src/components/views/settings/tabs/user/PreferencesUserSettingsTab.tsx) ·
[LoggedInView.tsx](apps/web/src/components/structures/LoggedInView.tsx) (1B toast) ·
[en_EN.json](apps/web/src/i18n/strings/en_EN.json) · tests:
`test/unit-tests/KeyBindingsManager-test.ts`, `.../LoggedInView-test.tsx`, `.../PreferencesUserSettingsTab-test.tsx`.

### Phase 2 — In-timeline match navigation + live highlight + "k of N" _(Large, ~2-4 wks, HIGH risk)_

Goal: the defining Telegram behavior — step through matches **in the live conversation** with up/down arrows + counter

- in-bubble highlight, instead of a separate list.

* Extend `SearchInfo` with `currentMatchIndex` / `totalMatches` + an ordered match list
  ([Searching.ts](apps/web/src/Searching.ts)).
* New **ViewModel** (MVVM v2) owning the cursor + next/prev actions; dumb arrow+counter **View** in
  `packages/shared-components`; wire into [RoomSearchAuxPanel.tsx](apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx).
* Drive the live `MessagePanel` to jump/flash each hit (reuse reply/permalink jump); for hits outside the loaded
  window, contextually back-paginate. Apply `BaseHighlighter` to **live** event tiles in search mode
  ([HtmlUtils.tsx](apps/web/src/HtmlUtils.tsx), [\_EventTile.pcss](apps/web/res/css/views/rooms/_EventTile.pcss)).
* **Decision (§6 Q2):** replace the `RoomSearchView` list, or keep it as a secondary/all-rooms view.
* Risk: search currently _replaces_ the timeline (`timelineRenderingType=Search`); driving the live timeline to
  arbitrary historical matches needs contextual loading + Seshat-result→live-event mapping for encrypted rooms.

### Phase 3 — Structured filters: `from:` sender + jump-to-date _(Medium-Large, ~2-3 wks, MEDIUM risk)_

> **Correction (session 24, slice 1 DONE):** the §4/§5 claim that jump-to-date is "None in search / MSC3030 unused" is
> **wrong** — a full jump-to-date already exists (`DateSeparatorViewModel` + `timestampToEvent`, behind labs flag
> `feature_jump_to_date`). Slice 1 surfaced it in the search header + flipped the flag desktop-default-on. `from:`/sender
> is now slice 2. See `search-phase3-plan.md`.

- Filter UI: **Compound filter chips** in the search header (preferred over a `from:@user before:…` DSL, which collides
  with literal `:` text — already a Seshat hazard handled by `hardenSeshatSearchTerm`).
- Homeserver leg: set `senders` on `IRoomEventFilter` (already supported by Matrix `/search`).
- Seshat leg: either extend `ISearchArgs` + the native bridge
  ([BaseEventIndexManager.ts](apps/web/src/indexing/BaseEventIndexManager.ts), [seshat.ts](apps/desktop/src/seshat.ts))
  **or** post-filter client-side in v1 (no native change; needs over-fetch since `SEARCH_LIMIT=10` may yield 0 after
  filtering).
- Jump-to-date: wire MSC3030 `timestamp_to_event` into a Compound calendar in the header (pairs with Phase 2).

### Phase 4 — Typed, searchable shared-media tabs _(Large, ~2-4 wks, MEDIUM-HIGH risk)_

- Split [FilePanel.tsx](apps/web/src/components/structures/FilePanel.tsx) into Compound tabs:
  Media / Files / Links / Music / Voice, each a `types`/`contains_url`-filtered listing with in-tab text search.
- Make media discoverable: today `isValidEvent` excludes media-only events
  ([EventIndex.ts](apps/web/src/indexing/EventIndex.ts)), so filenames/captions aren't indexed. Indexing them needs an
  **INDEX_VERSION bump + full local re-backfill** (storage/compute cost — see §6 Q5).

### Phase 5 — Reach, ranking option, robustness _(Very Large / exploratory, HIGH risk)_

- Investigate portable **offline** encrypted search for web/mobile (SQLite-WASM / tantivy-WASM, packaged locally — no
  CDN) **or** document why it stays Desktop-only.
- Optional **relevance-vs-recency** order toggle (Seshat already returns `rank`; SDK has `SearchOrderBy.Rank`).
- Corrupt-index health check (#32056) so the UI never silently returns empty; continue backfill completeness
  (#32266/#32168/#32307).

---

## 6. Decisions needed before/while implementing

1. **⌘F default:** enable-by-default (Desktop only? or everywhere?) vs discoverability-only opt-in.
2. **Phase 2:** in-timeline stepping **replaces** the results list, or **complements** it (keep list for All-rooms)?
3. **Filter UX:** Compound chips/pickers (recommended) vs a typed `from:`/`before:` DSL.
4. **Seshat filters:** native binding change (schema/index bump) vs client-side post-filter in v1.
5. **Media indexing:** acceptable to force a full re-backfill (INDEX_VERSION bump) to make media searchable?
6. **Scope now:** implement only Phase 1 immediately, or commit to Phases 1-3?

---

## 7. Recommendation

Ship **Phase 1 first** (directly fixes the user's complaint; low risk). For a private Desktop-focused fork, **Option 1A
(default-true on Desktop)** is the most direct match to the "it should just work like Telegram" expectation, with the
caption/description added regardless. Then **Phase 2** delivers the single biggest Telegram-parity UX win, followed by
**Phase 3** filters. Phases 4-5 are larger bets to schedule after the core in-room experience matches Telegram.
