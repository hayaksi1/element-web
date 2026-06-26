# Upstream Sync — Master Plan (port element-web `v1.12.22` → `develop` into the fork)

> **STATUS: PROPOSAL — plan only, NOTHING implemented.** Authored 2026-06-26 (session 36).
> Evidence base: full upstream clone + `git merge-tree` dry-run + a 12-agent analysis Workflow + a Codex
> sidecar cross-check of the hardest file. All numbers below are empirical, not estimates.
>
> **Trigger / goal (user):** the fork was created from the **v1.12.22 source tarball** and has ~48 custom commits
> (Telegram-style in-room **search** + **macOS desktop** fixes). Upstream has moved on; the user wants the fork brought
> **up to date with `element-hq/element-web`** so a clean PR can eventually be sent upstream — **without breaking ANY
> feature already built**. This master + the `phase-*.md` files are written so each phase can be executed in a fresh
> session (context-safe).

---

## 1. The situation (why this is a *vendor update*, not a `git pull`)

The fork is **NOT a clone** of upstream — it is a source drop. The first commit
(`3294bcc` "Initial commit with CLAUDE.md project rules") is the **v1.12.22 source tree + CLAUDE.md**, then 48 custom
commits on top. **There is zero shared git ancestry with upstream**, so a plain `git merge`/`git rebase` has no common
ancestor and would treat every file as a conflict.

**Proven fact that unlocks everything:** the fork's base tree is **byte-identical** to upstream tag `v1.12.22`
— `git diff v1.12.22 3294bcc` shows only `CLAUDE.md` + `.claude/settings.json` added, **0 code differences**. Therefore
**`v1.12.22` is a perfect synthetic 3-way merge base.** We graft it in and let git do the heavy lifting.

```
upstream/develop (ed768f69e1, 2026-06-26)  ← THEIRS (target; also the element-hq PR base)
        ▲ 70 commits
        │
   v1.12.22 (6bfc4ddfef)  ← BASE (merge base; == fork's source drop, also the LATEST release tag)
        │
   3294bcc (source drop + CLAUDE.md)
        │ 48 custom commits
        ▼
   HEAD / main (862383cd)  ← OURS (fork: search + macOS desktop)
```

## 2. Hard numbers

| Metric | Value |
|---|---|
| Upstream delta `v1.12.22..develop` | **70 commits** (69 non-merge + 1 merge), **395 files**, +7,963 / −6,680 |
| Nature of the delta | **~80% dependency / CI / tooling maintenance** (Renovate), ~20% real change |
| Fork custom footprint | 48 commits, **179 files**, +19,325 / −793 |
| Files upstream changed **and** fork changed (overlap) | **29** |
| **Actual git 3-way conflicts** (`merge-tree`, base `v1.12.22`) | **10** (the other 19 overlaps auto-merge) |
| Target branch | **`develop`** — it is the only forward branch (master==staging is 70 behind) **and** the PR base |

## 3. The three file sets (the core of the strategy)

`git merge` with the graft partitions all 395 upstream-changed files into three buckets:

- **U-only = 366 files** — upstream changed, fork never touched → **git auto-takes upstream's version** (correct, because
  fork == base here). No work beyond a typecheck.
- **C-only = 150 files** — fork changed, upstream never touched → **git keeps the fork's version**. Risk is only *API
  drift* (a fork file calling an upstream-removed symbol — see Phase 6).
- **Overlap = 29 files** — both changed. Of these, **git auto-merges 19** (still review the risky ones) and **10 truly
  conflict** and need hand-resolution.

### The 10 real conflicts (from `git merge-tree`)
| File | Type | Cluster | Phase |
|---|---|---|---|
| `apps/desktop/src/config.ts` | structural (#33468) | desktop | **4** |
| `apps/desktop/src/config.test.ts` | add/add (#33468) | desktop | **4** |
| `apps/desktop/src/electron-main.ts` | structural (#33468 + #33827) | desktop | **4** |
| `apps/desktop/src/ipc.ts` | content (#33468) | desktop | **4** |
| `apps/desktop/src/ipc.test.ts` | add/add (#33468) | desktop | **4** |
| `apps/desktop/src/auto-launch.ts` | content (#33468; fork rewrote whole file → keep fork) | desktop | **4** |
| `apps/desktop/src/webcontents-handler.ts` | content (#33468 one-liner) | desktop | **4** |
| `apps/web/src/viewmodels/room/timeline/DateSeparatorViewModel.tsx` | mechanical import (#33948) | web | **5** |
| `apps/web/src/indexing/EventIndex.test.ts` | jest→vitest **relocation** (#33898) | web/test | **5** |
| `apps/web/test/unit-tests/indexing/EventIndexPeg-test.ts` | dir-rename **false-positive** → keep fork path | web/test | **5** |

**Takeaway:** 8 of 10 conflicts are the **desktop config-de-globalling** (#33468). Everything web-side is trivial.

## 4. The merge mechanic (recommended)

1. Add `upstream` remote, fetch `develop` + tag `v1.12.22` (already done this session).
2. **Graft** the fork's root commit onto `v1.12.22` so git sees a real merge base:
   `git replace --graft 3294bcc v1.12.22` (reversible; `git replace -d` to undo).
3. Work on an **integration branch** (`upstream-sync`), never on `main`.
4. `git merge --no-commit --no-ff upstream/develop` → git stages the 366 U-only + 19 auto-merges, keeps the 150
   C-only, and marks the **10 conflicts**. Resolve them per Phases 4–5.
5. **Override the lockfile** (never trust a text-merged `pnpm-lock.yaml`): `git checkout upstream/develop -- pnpm-lock.yaml`
   then `pnpm install` to regenerate (Phase 2).
6. **Normalize formatting last** with one `oxfmt` pass (Phase 6), then green-gate (Phase 7), then commit the merge.

> The in-progress merge state persists on disk between sessions, so this **is** resumable: resolve the desktop cluster
> in one session (`git add` those files), the web cluster in the next, commit when Phase 7 is green. A discrete-commit
> fallback (`git checkout`/`git merge-file` per file group) is described in `phase-3-bulk-merge.md`.

## 5. Phase index (execution order respects dependencies)

| Phase | File | What | Risk | Why this order |
|---|---|---|---|---|
| 1 | `phase-1-setup-graft.md` | upstream remote, graft, integration branch, dry-run verify | LOW | foundation |
| 2 | `phase-2-deps-toolchain.md` | adopt upstream deps + lockfile regen + toolchain decisions (oxfmt, jest/vitest, knip, **matrix-js-sdk pin**) | MED | deps must exist before code compiles |
| 3 | `phase-3-bulk-merge.md` | run the grafted merge; adopt 366 U-only + review the 19 auto-merges | MED | brings in the bulk safely |
| 4 | `phase-4-desktop-conflicts.md` | resolve the **8 desktop conflicts** (#33468 config-de-global + #33827 deeplinks) | **HIGH** | the only hard cluster |
| 5 | `phase-5-web-conflicts.md` | resolve DateSeparator import + EventIndex test relocation; review RoomView/RoomHeader/Settings/i18n auto-merges | LOW | trivial but must verify features |
| 6 | `phase-6-api-drift-cleanup.md` | `getBrand()` ripple, snapshot regen, knip --strict, oxfmt normalize, CLAUDE.md update | MED | post-merge consistency |
| 7 | `phase-7-verify-pr.md` | full lint/tsc/test/build, manual macOS QA, PR prep | MED | green-gate + ship |

## 6. Feature-preservation guarantees (the non-negotiable)

Every fork feature is protected by design — the merge only *adds* upstream and only the 10 conflict files are
hand-touched. Specific guard rails baked into the phases:

- **Search overhaul** lives in `RoomView.tsx` (+533/−63), `SearchSessionStore.ts`, `RoomSearch*`, `Searching.ts`,
  `viewmodels/search/*`, `shared-components/.../SearchMatchNavigation`, indexing — upstream touched **none** of these
  except a 6-line dead-prop deletion in RoomView/EventTile/LoggedInView (Phase 5, auto-merges). **0 search logic at risk.**
- **macOS desktop** lives in `apps/desktop/src/*` — the conflict is real but every fork behavior (config-path baking,
  deepMerge, window-state, quit UX, media perms, renderer recovery, save-image, native loginItem, pickle-key guard,
  seshat resilience) is preserved by *re-implanting fork logic onto upstream's de-globalled skeleton* (Phase 4, with
  Codex-verified per-file recipes).
- **Tests stay green:** jest survives on `develop` (vitest is additive), so the fork's ~60 jest tests keep running
  unchanged (Phase 2 finding). Each phase ends by running the relevant fork test suite.
- The fork's manual macOS QA checklist (`memorybank/manual-qa-checklist.md`) is the Phase 7 acceptance gate.

## 7. Decisions needed (recommended defaults set; confirm during execution)

1. **matrix-js-sdk pin.** `develop` floats to `github:matrix-org/matrix-js-sdk#develop`; the fork is validated on
   **`41.8.0`**. **Recommended: keep `41.8.0`** (upstream changed none of the indexing/search files), and later do a
   *controlled* bump to a **tagged** 42.x — never the floating develop pin. ⚠️ Open risk to clear in Phase 2: scan the
   366 U-only files for SDK APIs that only exist on develop (could force a tagged bump).
2. **oxfmt vs prettier.** Upstream **deletes prettier entirely** (#33844). **Recommended: adopt oxfmt** (config is
   byte-identical to the fork's prettier settings → near-zero churn; keeping prettier would diverge from upstream and
   complicate the PR). **CLAUDE.md must be updated**: `pnpm lint:prettier-fix` → `pnpm lint:fmt-fix` (Phase 6).
3. **PR shape.** Integration is a **merge** (good for "update my fork"). For the element-hq PR, derive a clean branch via
   `git rebase --onto upstream/develop v1.12.22 <fork-commits>` at Phase 7 — both yield the same tree. **Recommended:
   merge now, decide PR shape at Phase 7.**
4. **SPDX header.** The fork dropped `GPL-3.0-only OR` from `config.ts`/`config.test.ts` headers. Decide if intentional
   (private fork) or revert to upstream's tri-license before a public PR (Phase 4).

## 8. Provenance

- Empirical conflict set: `git merge-tree --write-tree --merge-base=v1.12.22 HEAD upstream/develop`.
- Categorization + per-cluster + cross-cutting analysis: 12-agent Workflow `element-upstream-sync-analysis`
  (443K tokens, 142 tool calls) — full report archived at the session task output
  `tasks/w4nxrcs4x.output`; distilled into Phases 2–6.
- Hardest file (config.ts #33468) independently cross-checked with the **Codex sidecar** (1 call) — see Phase 4.
- Scratchpad ground-truth: `scratchpad/empirical_facts.md`, `scratchpad/codex_config_merge.md`,
  `scratchpad/{U_only,C_only,I_conflict_surface,changelog_70}.txt`.
