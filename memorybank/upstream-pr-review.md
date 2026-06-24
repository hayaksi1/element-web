# Upstream PR Review — macOS Desktop Remediation

> Notes on which open element-hq/element-web PRs contain improvements worth adopting/adapting into our macOS-desktop remediation effort, and whether any overlap/conflict/supersede our committed work. Generated 2026-06-24 by reviewing open element-hq/element-web PRs for overlap with our effort. NOTHING here is implemented — all items are pending the user's confirmation.

Our committed baseline (do NOT re-recommend; only flagged if a PR conflicts/supersedes):

- **25cd00a** — Phase 0.1 pickle-key transient-decrypt data-loss guard (`apps/desktop/src/store.ts`, `ipc.ts`) for #32521/#32715/#32198; Phase 2.1 auto-launch rewrite onto native Electron loginItem API (`apps/desktop/src/auto-launch.ts`) for #32303.
- **3d5ce8b** — Phase 0.2 Seshat error-dialog **circuit-breaker** in `apps/web/src/indexing/EventIndex.ts` for #33501 (`indexingErrored` flag: `onSync` early-return once errored; `.catch` dedupes, stops crawler, shows the error dialog exactly once).

## TL;DR — adopt shortlist

| PR                                                             | Title                                                  | Maps to                            | Recommendation                   | Effort | Why                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------- | -------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [#33954](https://github.com/element-hq/element-web/pull/33954) | desktop: build seshat with ARMv8 hardware AES          | Phase 4.3 / #32119                 | **adopt** (validate seshat#185)  | low    | arm64 RUSTFLAGS `--cfg aes_armv8` kills ~10-20x software-AES CPU on Apple Silicon; applies clean                                             |
| [#33955](https://github.com/element-hq/element-web/pull/33955) | Make seshat backfill complete and resilient            | Phase 4.2 / #32266, #32011, #32253 | **adapt** (track until reviewed) | high   | Core backfill-completeness + resilience rework; auto-merges with our breaker except a trivial field block; has a build-break + test-path gap |
| [#33957](https://github.com/element-hq/element-web/pull/33957) | Ignore thread/filtered timeline resets when re-seeding | Phase 4.2 / #32119                 | **adapt**                        | low    | Stops dead rooms reanimating the crawl list every launch; bug present verbatim in our tree                                                   |
| [#33048](https://github.com/element-hq/element-web/pull/33048) | Add tokenizer mode support for message search          | Phase 4.3 / #32038                 | **adapt** (track, community)     | medium | N-gram tokenizer = CJK/mixed-language local search; auto-merges with our breaker; needs seshat 4.2.0 bump (#33168, merged)                   |
| [#33956](https://github.com/element-hq/element-web/pull/33956) | Report indexing progress as indexed/indexing/errored   | Phase 4.1 / #32253                 | **track** (adapt vocab)          | high   | Clean progress UI vocabulary; inseparable from #33955; red CI                                                                                |
| [#33958](https://github.com/element-hq/element-web/pull/33958) | Flush the seshat index when the search box is focused  | Phase 4 / #32119                   | **track**                        | medium | Good commit-on-focus pattern, but its commit-batching premise is absent from our tree                                                        |

Out of scope (track/skip): #33637, #32804, #33951, #33932, #33635, #33699 — see "Not relevant / skipped".

## Seshat cluster (#33954–#33958) vs our circuit-breaker (commit 3d5ce8b) — KEY FINDING

**Verdict: COMPLEMENTARY, not superseding. Recommended path: COMBINE.**

The whole cluster (all by maintainer ara4n, 2026-06-24) targets **#32119** (Seshat CPU spike) plus index completeness/quality — our **Phase 4**. None of the five PRs reference or target **#33501** (the Seshat error-_dialog_ flood) that our Phase 0.2 commit **3d5ce8b** fixes. Different problems at the issue level:

- Ours = "stop popping an error dialog on every /sync after an indexer throw."
- Theirs = "make backfill complete/resilient, report indexed/indexing/errored, save CPU."

**File/function overlap (only #33955 and #33957 touch `EventIndex.ts`):**

- Our change touches exactly two spots in `onSync`: (a) early-return `if (this.indexingErrored) return;`, and (b) the `onSyncInner().catch(...)` handler that sets the flag, calls `stopCrawler()`, and shows the dialog once.
- **#33955** is a ~420-line rework that does NOT touch the `.catch()` handler or `logErrorAndShowErrorDialog` at all. It adds a one-shot reconciliation block _inside_ `onSyncInner`, new fields, `reconcileMissedRooms()`, `isRoomIndexable()`, `hasQueuedCheckpoint()`, a `FULLY_CRAWLED` sentinel, and replaces `crawlingRooms()` with `getIndexingStatus()`. Its permanent-vs-transient error handling is a SEPARATE catch in the crawler loop, not the onSync catch.
- **#33957** changes `onTimelineReset` (a method we do not touch) → no conflict from us there.

**Empirical merge result (verified):** Our pre-commit base blob for `EventIndex.ts` is the exact base both #33955 and #33048 diff against (97913bf). A real 3-way merge with #33955 produced exit 1 with **ONE trivial conflict**: the private-field header block right after `needsInitialCheckpoints` (~line 82-90), where our commit inserts `indexingErrored` and the PR inserts `reconciliationDone`/`unindexableRooms`/`erroredRooms`/`fullyCrawledRooms` at the same anchor. Resolution: keep BOTH blocks (semantically independent). Critically, `onSync` itself auto-merged CLEANLY, preserving both our circuit-breaker AND #33955's reconciliation block. The #33048 merge produced **0 conflict markers**.

**Why they reinforce each other:** #33955 adds per-room resilience (errored set, give-up-on-permanent-4xx) so individual rooms fail gracefully, which REDUCES how often `onSyncInner` throws at all. Our circuit-breaker remains the last-resort guard for any UNEXPECTED throw that still escapes (now including a throw from #33955's new `reconcileMissedRooms()`). #33955 makes our flood less likely but does not replace the global dialog-dedupe guard.

**Structural rebase risk:** Upstream modifies the colocated test `apps/web/src/indexing/EventIndex.test.ts` (Vitest, `vi.*`), but our tree's test is at `apps/web/test/unit-tests/indexing/EventIndex-test.ts` (Jest, `jest.fn`). On adopt, our #33501 tests and the ported upstream tests must converge on one location, converting `vi.*` → `jest.*` and adding `getMyMembership`/`getCrypto`/`RoomEvent` mocks. The needed helpers already exist in our test-utils.

**Recommended combine steps:**

1. Keep our circuit-breaker (it fixes #33501, which the cluster does not).
2. Adopt #33955 (+ #33956 UI) as Phase 4 work for #32119/#32253; re-apply the `indexingErrored` guard + `.catch` dedupe on top of #33955's `onSync`.
3. Ensure our catch still calls `stopCrawler()` and the dialog-once path. Consider tightening it so a single-room permanent 4xx (already handled locally by #33955's errored set) does NOT trip the GLOBAL breaker — only genuinely unexpected throws should.
4. Reconcile the test-file location.

## Per-PR notes

### #33954 desktop: build seshat with ARMv8 hardware AES

- **What:** In `apps/desktop/hak/matrix-seshat/build.ts`, when target arch is arm64, appends `--cfg aes_armv8` to `env.RUSTFLAGS` via `[env.RUSTFLAGS, "--cfg aes_armv8"].filter(Boolean).join(" ")`. 10 additions, one file. x86_64 untouched (AES-NI auto-detected at runtime).
- **Root cause:** On Apple Silicon, Seshat's index encryption ran through pure-software constant-time AES, multiplying CPU cost of every index encrypt/decrypt.
- **Maps to:** #32119 / Phase 4.3.
- **Quality:** good (verified).
- **Conflict with our commits:** none. `build.ts` is clean in our tree (last touched by initial commit) and byte-matches the PR pre-image; applies cleanly. Complementary to 3d5ce8b (native AES build flag vs JS error handling).
- **Adopt:** the arch-gated RUSTFLAGS append idiom; `filter(Boolean).join` env-append pattern; gating native build flags on `getTargetArch()`/`isMac()`.
- **Recommendation:** **adopt (low effort)** — BUT not self-contained: requires matrix-org/seshat#185 and a Rust toolchain that accepts `--cfg aes_armv8`. Validate our seshat pin + toolchain build cleanly first; if the pin lacks #185, treat as adapt-with-validation. `makeGypEnv()` does not set RUSTFLAGS, so the `filter(Boolean)` undefined-handling is sound.

### #33955 Make seshat backfill complete and resilient

- **What:** Reworks `apps/web/src/indexing/EventIndex.ts`. Adds a once-per-launch `reconcileMissedRooms()` (crypto-ready-gated) seeding fullCrawl checkpoints for joined, crypto-enabled rooms with no indexed events and no queued checkpoint; switches gating to crypto-aware `isRoomIndexable()` (`isEncryptionEnabledInRoom`); tracks `erroredRooms` (permanent 4xx except 429/401 ⇒ give up + mark errored, self-healing on a new live event); records a `FULLY_CRAWLED` sentinel checkpoint in Seshat sqlite; de-duplicates queued checkpoints; replaces `crawlingRooms()` with `getIndexingStatus()` returning `{indexing, indexed, errored}`. +423/-41.
- **Root cause:** Seshat only ever backfilled encrypted rooms that existed with a back-pagination token at the single moment `addInitialCheckpoints` runs. Rooms joined later, missed when crypto wasn't ready, lacking a token, or hit by a transient failure never got a checkpoint and stayed unindexed forever; legacy state-only encryption checks wasted crawl CPU; gappy syncs stacked duplicate checkpoints.
- **Maps to:** #32266, #32011 (strong, generic completeness), #32253 (warn-when-incomplete), #32119 (CPU) / Phase 4.2. NOTE: #32258 (search in upgraded rooms / pre-upgrade history) is a WEAK mapping — that needs room-upgrade predecessor/tombstone traversal, which this PR does NOT do.
- **Quality:** good (verified). The "crypto-aware instead of legacy state-only" framing is slightly overstated — our `addInitialCheckpoints` (EventIndex.ts:156) already uses `isEncryptionEnabledInRoom`; the PR's real contribution is EXTENDING that to the live-event/`onRoomStateEvent`/`onTimelineReset` handlers (which still use `isRoomEncrypted`) plus reconciliation. PR body itself cites only #32119; the broader mappings are our inference.
- **Conflict with our commits:** CONFIRMED textual conflict (one trivial private-field block) but NOT superseding — `onSync` auto-merges, both features survive. Zero overlap with 25cd00a (web-only).
- **Adopt ideas:** `reconcileMissedRooms()`; crypto-aware `isRoomIndexable()` + `unindexableRooms`; permanent-vs-transient error classification; `erroredRooms` self-healing (clear-before-reseed bounds retries to crawl rate); `hasQueuedCheckpoint()` de-dup; `FULLY_CRAWLED` sentinel (couples to Seshat checkpoint semantics — adopt with care); yield via `if (++scanned % 20 === 0) await sleep(10)`; `getIndexingStatus()` cheap in-memory breakdown.
- **Recommendation:** **adapt (high effort, track until reviewed).** Blockers: (1) hand-merge with 3d5ce8b so both survive; (2) it renames `crawlingRooms()`→`getIndexingStatus()` and changes the return shape but does NOT update the sole consumer `ManageEventIndexDialog.tsx` (lines 85-86, 138, 159) — would break the build; (3) test hunk targets `src/indexing/EventIndex.test.ts` vs our `test/unit-tests/indexing/EventIndex-test.ts`; (4) still OPEN/BLOCKED/REVIEW_REQUIRED, self-described "heavily Claude-assisted for expedience."

### #33956 Report indexing progress as indexed / indexing / errored

- **What:** UI-only (+28/-27, 2 files): `ManageEventIndexDialog.tsx` + `en_EN.json`. Replaces confusing "N out of M rooms"/"awaiting indexing" with an indexed/indexing/errored breakdown from `getIndexingStatus()`. Errored count rendered only when non-zero (two i18n variants: `message_search_room_progress`, `message_search_room_progress_errored`).
- **Root cause:** Old progress UI was confusing/unstable — crawler counts fluctuated and never-indexable rooms showed as a permanent problem.
- **Maps to:** #32253 / Phase 4.1.
- **Quality:** good (verified). NOTE: the "exclude can't-speak-encryption rooms" behavior actually lives in prerequisite #33955 (`unindexableRooms` + membership skip inside `getIndexingStatus()`), not in #33956 itself; #33956 only consumes the numbers. CI is currently red (Check PR base branch, Oxfmt, Static Analysis, Tests, Vitest, Vitest packages/shared-components — "Preview Changelog" actually PASSES). It targets #33955's branch, not develop, so it cannot apply standalone.
- **Conflict with our commits:** none — different files; `getIndexingStatus()` doesn't exist in our tree (EventIndex.ts:1014 still has `crawlingRooms()`). Philosophical tension lives in #33955, not here.
- **Adopt ideas:** indexed/indexing/errored vocabulary; errored-only-when-nonzero conditional i18n key; exclude can't-speak rooms entirely; cheap synchronous in-memory status (no Seshat IPC) safe on every dialog refresh; pair our global "indexing broken" dialog with a per-room errored tally.
- **Recommendation:** **track.** Inseparable from the 423-line #33955 rework, so standalone adoption is high-effort. When we do Phase 4.1 for #32253, adapt the vocabulary/UX onto our own EventIndex reconciled with our circuit-breaker.

### #33957 Ignore thread/filtered timeline resets when re-seeding the index

- **What:** Guards `onTimelineReset` so it only seeds a backward gap-fill checkpoint when the `RoomEvent.TimelineReset` is for the room's own unfiltered live timeline set. Adds the emitted `timelineSet` param and `return`s early if `timelineSet && timelineSet !== room.getUnfilteredTimelineSet()`. Filters out ReEmitter resets from thread/filtered timeline sets (the startup flood from `Thread.updateThreadMetadata`). ~10 LOC source + ~57 LOC test.
- **Root cause:** `onTimelineReset` seeded a gap-fill on EVERY `TimelineReset`; the SDK re-emits it from thread/filtered timeline sets, so any room with one ancient thread got a spurious gap-fill every launch — long-dead rooms re-inflating the crawl list → CPU spike.
- **Maps to:** #32119 / Phase 4.2.
- **Quality:** good (verified). SDK 41.8.0 emits `RoomEvent.TimelineReset` with `(room, timelineSet, resetAllTimelines)`, so the guard is semantically correct.
- **Conflict with our commits:** none — different method from our `onSync` breaker; both apply cleanly. Bug present verbatim in our tree at `EventIndex.ts:312-319` (no `timelineSet` param, no unfiltered-timeline guard); `EventTimelineSet` already imported (line 19); `addRoomCheckpoint` (line 420) builds the same checkpoint shape.
- **Adopt:** the guard `if (timelineSet && timelineSet !== room.getUnfilteredTimelineSet()) return;` + `timelineSet?: EventTimelineSet` param; keep the explanatory comment (trim #33955-specific wording); port the regression test.
- **Recommendation:** **adapt (low effort).** Transplant the one-line guard into our simpler handler (our tree is partly modernized — `addInitialCheckpoints` already crypto-aware — but `onTimelineReset` is still on the old `isRoomEncrypted` gate). Port the test from upstream Vitest (`vi.*`) to our Jest harness (`jest.fn`, `setTimeout(...,0)` microtask flush); helpers already exist.

### #33958 Flush the seshat index when the search box is focused

- **What:** Adds `EventIndex.prepareForSearch()` (force-commits buffered live events via `indexManager.commitLiveEvents()`, try/catch warns on failure). Wires it to the room search box `onFocus` (`RoomSummaryCardViewModel.onSearchFocus` → `EventIndexPeg.get()?.prepareForSearch()`) and also calls it inside `search()` as a safety net.
- **Root cause:** Index staleness when Seshat batches Tantivy commits coarsely (a ~1-min power-saving window introduced by a companion change).
- **Maps to:** #32119 / Phase 4. (Curator's #32011/#32341 mapping is inaccurate — those are correctness bugs; this is freshness.)
- **Quality:** good (verified).
- **Conflict with our commits:** none — file-level only; edits `search()` (737-739, byte-identical to PR pre-image) + appends `prepareForSearch()`; our 3d5ce8b edits `onSync`. **Premise absent in our tree:** `apps/desktop/src/seshat.ts:192` commits eagerly (no throttle) and our `onSync` calls `commitLiveEvents()` every /sync, so the staleness this fixes is largely absent for us today.
- **Adopt ideas:** commit-on-focus so flush latency overlaps with typing; `prepareForSearch()` as single-source-of-truth no-op-when-empty helper; defensive try/catch that degrades gracefully; `EventIndexPeg.get()?.` no-op guard on non-desktop.
- **Recommendation:** **track.** Stacked on BLOCKED #33955; VM/View hunks target a newer base. Revisit only if/when we adopt power-saving commit batching for #32119; adopting in isolation adds overhead with little freshness benefit.

### #33048 Add tokenizer mode support for message search

- **What:** User-facing device setting "Search tokenizer mode" (language-based vs N-gram), threaded web → `EventIndexPeg` → `SeshatIndexManager` → IPC → desktop `seshat.ts` into the Seshat constructor config (`tokenizerMode` + `ngramMinSize:2`/`ngramMaxSize:4`). Adds `ConfirmTokenizerChangeDialog` (warns + deletes/rebuilds index on mode change), a `wasRecreated` signal so `EventIndex` re-adds initial checkpoints after recreation (`forceAddInitialCheckpoints` flag). Refactors desktop reindex/recovery out of the IPC handler into DI'd, testable `seshat-index.ts` (`initEventIndex`) + `seshat-config.ts` (`createSeshatConfig`). +843/-38 across 19 files. Community PR, CHANGES_REQUESTED.
- **Root cause:** Seshat's default tokenizer is language-based (word-boundary languages only), so local encrypted search returns nothing for CJK/word-boundary-free/mixed-language text; Element never passed any tokenizer config.
- **Maps to:** #32038 / Phase 4.3.
- **Quality:** good (verified).
- **Conflict with our commits:** NONE — verified by 3-way merge that the PR and 3d5ce8b **auto-merge cleanly (0 conflict markers)**, both features survive (our `indexingErrored` breaker + the PR's `forceAddInitialCheckpoints`/`setForceAddInitialCheckpoints`/`needsInitialCheckpoints || forceAddInitialCheckpoints` branch). Does not touch 25cd00a desktop files. (Correction vs original analysis, which predicted a manual conflict — there is none.)
- **Adopt ideas:** N-gram config wired into the Seshat constructor (the #32038 fix); extracting reindex/recovery + config into DI'd pure modules with real unit tests (reusable testability pattern); default-to-language for unknown tokenizer modes; threading a per-index option end-to-end via IPC `args[2]`; `wasRecreated`/`forceAddInitialCheckpoints` back-population; confirm-before-destructive-reindex UX.
- **Recommendation:** **adapt (medium effort, track).** Requires the matrix-seshat 4.2.0 bump (#33168, MERGED upstream 2026-04-16) be present in our local tree first under the no-public-internet/package-locally constraint. New dialogs are default-export class components (the existing eventindex-dialog convention, but vs our MVVM-v2/named-export preference for net-new UI). Still an unreviewed community PR at CHANGES_REQUESTED, so API/UX may shift.

## Not relevant / skipped

- [#33637](https://github.com/element-hq/element-web/pull/33637) Add multi-digit support for overlay badges — **track only.** Windows taskbar overlay (`favicon.ts` `BadgeOverlayRenderer`, gated `process.platform === "win32"`); never runs on macOS. Curator's #32288/Phase 5.3 mapping is doubly wrong: wrong platform AND wrong direction (#32288 = REMOVE the 99+ cap on macOS; this PR ADDS a 99+ clamp to Windows). Our macOS path already passes the count uncapped. Reusable patterns: `actualBoundingBoxAscent` vertical centering, font-scale-down on fixed canvases, node-canvas + jest-image-snapshot harness. Still DRAFT/DIRTY.
- [#32804](https://github.com/element-hq/element-web/pull/32804) Native proxy settings — **track.** New feature (#32407), not in our ~45 defects. Real blockers: live `resolveProxy()` calls to google.com/example.com/matrix.org (offline-mandate violation), `any` casts, `project.json` `"command":"echo skipped"` (breaks prebuild), dropped screen-share-picker IPC, AND broken shared-components import paths (won't compile). No line-level conflict with our store.ts hunks. Lift only the safeStorage secret pattern / capability gating / clearDataAndRelaunch preservation later in Phase 6.2.
- [#33951](https://github.com/element-hq/element-web/pull/33951) macOS translation menu — **track.** New feature (element-desktop#2740), maps to no phase. Relies on Apple's PRIVATE `TranslationUI.framework` (version-fragile, signing/App-Store risk); DRAFT/BLOCKED. Only positional adjacency in `ipc.ts` (no logic conflict). Good patterns: capability abstraction, non-blocking IPC probe, dispatch_once/@try-catch private-framework load.
- [#33932](https://github.com/element-hq/element-web/pull/33932) Fix Notifier import cycle — **track.** Clean maintainer refactor (moves `isPushNotifyDisabled` into `Notifier.ts`, drops the `require()` shim), but adds NO DND logic; only file-proximity to Phase 5.1 (#32383). No conflict. Build on the post-merge `Notifier.ts` when we start Phase 5.1.
- [#33635](https://github.com/element-hq/element-web/pull/33635) Fix broken app icon on debian dock — **skip.** Linux-only `electron-builder.ts` `StartupWMClass` tweak (closes #33472); no macOS relevance, likely superseded upstream by the electron-builder 26.15.x bump.
- [#33699](https://github.com/element-hq/element-web/pull/33699) Exporter naming via eventId + MIME extensions — **skip.** Web chat-export ZIP naming (#33356, A-Export-Chat), NOT the desktop download/save bugs (#32355/#32362) the curator hint claimed — those live in `webcontents-handler.ts`, untouched here. MIME-table idea mildly reusable for Phase 6.1. Minor nit if adopted: PR uses `console.warn`; rest of Exporter.ts uses `logger`.

- [#33724](https://github.com/element-hq/element-web/pull/33724) Align macOS user-menu avatar with room list/header row — **skip.** Cosmetic CSS alignment of the user-menu avatar (Z-Community-PR, CLA unsigned, BLOCKED; maintainer questioned correctness). Maps to no tracked defect (NOT #32018 title-bar drag). No conflict with our commits.

## Recommended next actions (ordered) — pending user confirmation

1. **Validate then adopt #33954** (Phase 4.3, #32119): confirm our pinned seshat includes matrix-org/seshat#185 and our Rust toolchain accepts `--cfg aes_armv8`; if so, transplant the arch-gated RUSTFLAGS append into `apps/desktop/hak/matrix-seshat/build.ts`. Low risk, high payoff on Apple Silicon.
2. **Adapt #33957** (Phase 4.2, #32119): add the `timelineSet` param + unfiltered-timeline guard to `onTimelineReset` (EventIndex.ts:312-319); port the regression test from Vitest to our Jest harness. Low effort, standalone, no dependency on the rest of the cluster.
3. **Combine the Seshat cluster into Phase 4** (#32119/#32253/#32266/#32011): pull #33955's `reconcileMissedRooms`, crypto-aware `isRoomIndexable`, permanent-vs-transient classification, checkpoint de-dup, `getIndexingStatus`, re-applied on top of our 3d5ce8b circuit-breaker (keep both field blocks; keep `stopCrawler()`/dialog-once; tighten the global breaker so single-room 4xx handled by #33955 does not trip it). Update the `ManageEventIndexDialog` consumer. Then layer #33956's indexed/indexing/errored UI vocabulary for #32253. Port tests into our test layout. Track upstream until reviewed before locking the API.
4. **Adapt #33048 for #32038/Phase 4.3** (after the matrix-seshat 4.2.0 bump #33168 is in our tree under the offline constraint): take the N-gram tokenizer config + the `seshat-index.ts`/`seshat-config.ts` DI refactor + `wasRecreated`/`forceAddInitialCheckpoints`; conform new dialogs to CLAUDE.md (named exports / MVVM-v2 for net-new UI). Auto-merges cleanly with our circuit-breaker.
5. **Track-only**, revisit during their phases: #33958 (only if we adopt commit-batching for #32119), #33932 (build on post-merge `Notifier.ts` in Phase 5.1), #33637 (reuse its canvas/test patterns if #32288 needs a custom rendered macOS badge), #32804 (lift safe pieces in Phase 6.2), #33951.
6. **No action:** #33635, #33699 (out of scope; the curator hints mapping #33699→#32355/#32362 and #33637→#32288 are incorrect).
