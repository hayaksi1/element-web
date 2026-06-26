# Phase 7 — Full verification, macOS QA & PR preparation

> **Risk: MEDIUM. Goal:** prove the merged tree is green and every fork feature works, commit the merge, then shape the
> contribution for element-hq. This is the acceptance gate for the whole sync.

## 7.1 — Green-gate (run from repo root, all must pass)
```bash
pnpm install                       # clean, deterministic, lock unchanged
pnpm lint                          # lint:types (tsc) + lint:fmt (oxfmt) + lint:js (eslint) + lint:style + lint:knip
pnpm test:unit                     # jest — the fork's ~60 web tests + upstream's
pnpm -C apps/desktop test          # vitest — fork desktop suite + upstream's args/tray/vectormenu
pnpm -C apps/web test:vitest       # the upstream-migrated colocated tests (don't let this coverage be silently skipped)
pnpm -C packages/shared-components test
pnpm build                         # or per-workspace build; confirm webpack/CSS imports resolve
```
- **Expected residue:** the 4 known matrix-js-sdk 41.8.0 `.d.ts` tsc errors (pre-existing, tolerated). Anything new is a
  regression to fix before committing.
- If `test:vitest` and `test:unit` overlap-skip migrated tests, ensure both runners are invoked (Phase 2.4 finding).

## 7.2 — Commit the merge
Only after 7.1 is green (and the Phase-6 oxfmt commit exists):
```bash
git commit    # completes the `git merge` from Phase 3 — one merge commit "Merge upstream/develop (v1.12.22→develop)"
```
> If the discrete-commit fallback (Phase 3.4) was used instead, there's no merge commit to finalize — just ensure the
> per-phase commits are all in.

## 7.3 — Manual macOS QA (the feature-preservation acceptance test)
Run the fork's checklist `memorybank/manual-qa-checklist.md` on a packaged build. **Must-verify**, grouped:

**Search (Telegram-parity):**
- ⌘F opens in-room search (desktop default-on); header search button works.
- Match stepping ↑/↓ with k-of-N counter; in-bubble highlight; result-click flashes + centers (Phase 8e behavior).
- Sender (`from:`) filter, jump-to-date, typed media tabs, relevance/recency toggle.
- Encrypted-room search via Seshat; n-gram tokenizer; results-list timeline anchor (no jump-to-latest).

**macOS desktop:**
- Config: baked `config.json` loads, default server present, machine-wide/MDM config deep-merges (#32351, #32337).
- Quit UX: warn-before-quit via menu / tray / ⌘Q (#32287); close-to-hide on macOS (#32267).
- Window geometry restore, no auto-fullscreen (#32228/#32360); no white launch flash (#32260).
- Renderer crash auto-recovery (#32222); media (mic/cam/screen-share) permissions (#32373/#32398);
  Save-image-as via session (#32362); download-open error dialog (#32273).
- Seshat: no error-dialog flood (#33501), backfill resilience, AES arm64.

**Newly adopted upstream (never exercised by the fork — extra scrutiny):**
- **Deeplink handling (#33827)** — `vector://` / element deeplinks navigate correctly (the `hasDeeplink` gate).
- Room-list **section drag-and-drop** reorder (#33606) + "Introducing Sections" announcement (#33800).
- UserMenu long display/user names (#33900); Quick-Settings tooltip (#33923).

If anything fails, fix on `upstream-sync` and re-run 7.1.

## 7.4 — PR preparation for element-hq (DECISION — see §00.7.3)
The element-hq PR targets **`develop`**. The fork's custom work must be expressed as clean commits *on top of* develop —
**not** the macOS-private bits the project won't accept. Recommended path:

1. **Decide scope.** element-hq is unlikely to take the whole private fork. Likely PR-able, *separable* pieces:
   - the **search** UX (in-room stepping, k-of-N, filters) — aligns with open issues (#22888, #24359, #27876, #21640);
   - specific **desktop fixes** that map to upstream issues (see `memorybank/upstream-pr-review.md` for the per-PR
     mapping already done — #33954 AES, #33957 timeline-reset, the seshat cluster, etc.).
   Private-only bits (white-label config baking, MDM precedence) likely stay in the fork.
2. **Derive a clean branch** from the synced tree:
   ```bash
   # option A: replay only the fork's feature commits onto current develop (clean PR history)
   git rebase --onto upstream/develop v1.12.22 <range-of-fork-feature-commits>
   # option B: a fresh feature branch off upstream/develop, cherry-pick the relevant resolved files
   ```
   Both produce a diff against develop with no vendor noise. Split into reviewable PRs by feature.
3. **Per-PR hygiene:** conform to upstream conventions (oxfmt, vitest colocated tests for *new* files, MVVM-v2, named
   exports, i18n keys sorted, `pnpm lint` green, sign-off/DCO). Reuse the analysis in `memorybank/upstream-pr-review.md`.
4. Keep the fork's `main` as the private superset; land the synced `upstream-sync` into `main` first
   (`git switch main && git merge --ff-only upstream-sync` or fast-forward), then cut PR branches from there.

## 7.5 — Cleanup
- `git replace -d 3294bcc088d53f1462197baff77fef25ad51bcb5` (remove the graft once the merge commit exists — the merge
  commit now records the real ancestry; the graft is no longer needed).
- Update `memorybank/activity-log.md` + the `search-improvement-initiative` / `macos-desktop-remediation` memories with
  the sync outcome and the new upstream baseline (develop @ ed768f69e1, 2026-06-26).

## Verification gate (whole sync done when)
- 7.1 fully green (modulo the 4 known SDK tsc errors).
- 7.3 macOS QA passes — **every** fork feature works AND the 3 newly-adopted upstream features work.
- Merge committed; graft removed; memorybank updated.
- (Optional) PR branch(es) derived against `develop` and passing upstream CI.
