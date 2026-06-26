# Phase 1 — Setup, graft & integration branch

> **Risk: LOW. Goal:** make `v1.12.22` a real git merge-base for the fork so a normal 3-way `git merge` works, on an
> isolated branch, and confirm the dry-run conflict set matches the plan (10 files). No fork code changes.
> Read `00-upstream-sync-master-plan.md` first.

## Refs (constants used by every phase)

- BASE (merge base, == fork source drop, pristine) = tag **`v1.12.22`** = `6bfc4ddfef`
- OURS (fork tip) = **`HEAD`** / `main` = `862383cd`; ROOT (source-drop commit) = `3294bcc088d53f1462197baff77fef25ad51bcb5`
- THEIRS (target) = **`upstream/develop`** = `ed768f69e1` (also the element-hq PR base)

## Steps

### 1.1 — Upstream remote + fetch (idempotent; already done in session 36)

```bash
git -C /Users/hayyaksi/Code/element remote add upstream https://github.com/element-hq/element-web.git 2>/dev/null || true
git fetch upstream 'refs/heads/develop:refs/remotes/upstream/develop' 'refs/tags/v1.12.22:refs/tags/v1.12.22'
git rev-parse v1.12.22 upstream/develop   # expect 6bfc4ddfef… and ed768f69e1…
```

> Session 36 used a local mirror clone at `/tmp/element-web-upstream` as the remote. For real execution, point
> `upstream` at the GitHub URL (offline-mandate note: cloning upstream is a one-time dev action, not a runtime asset).

### 1.2 — Verify the base is pristine v1.12.22 (must pass before grafting)

```bash
git diff --stat v1.12.22 3294bcc      # MUST show ONLY CLAUDE.md + .claude/settings.json
git diff --name-only v1.12.22 3294bcc | grep -E '^(apps|packages|modules)/' | grep -v CLAUDE | wc -l   # MUST be 0
```

If this shows code differences, STOP — the graft base is wrong and every downstream merge is suspect.

### 1.3 — Graft v1.12.22 as the fork root's parent

```bash
git replace --graft 3294bcc088d53f1462197baff77fef25ad51bcb5 v1.12.22
git merge-base HEAD upstream/develop    # should now resolve to v1.12.22 (6bfc4ddfef…), not empty
```

- This rewrites _nothing_ — `git replace` adds a replacement ref; undo anytime with
  `git replace -d 3294bcc088d53f1462197baff77fef25ad51bcb5`.
- ⚠️ `git replace` refs are **not pushed** and not seen by all tools; that's fine — the graft is a local merge aid. The
  final PR is derived from the resulting tree/diff, not from this synthetic ancestry.

### 1.4 — Integration branch

```bash
git switch -c upstream-sync           # branch off fork HEAD; main stays untouched
```

### 1.5 — Dry-run: confirm the conflict set (no working-tree changes)

```bash
git merge-tree --write-tree --merge-base=v1.12.22 HEAD upstream/develop > /dev/null; echo "exit=$?"   # exit=1 (conflicts)
git merge-tree --write-tree --merge-base=v1.12.22 HEAD upstream/develop \
  | grep -iE 'CONFLICT'
```

**Expected (the 10 from the master plan):** `auto-launch.ts`, `config.ts`, `config.test.ts`, `electron-main.ts`,
`ipc.ts`, `ipc.test.ts`, `webcontents-handler.ts`, `DateSeparatorViewModel.tsx`, `src/indexing/EventIndex.test.ts`
(relocation), `test/unit-tests/indexing/EventIndexPeg-test.ts` (dir-rename false positive).

> If the set differs materially (upstream advanced since 2026-06-26), re-run the analysis Workflow before proceeding.

## Verification gate (Phase 1 done when)

- `git merge-base HEAD upstream/develop` == `v1.12.22`.
- On branch `upstream-sync`, working tree clean, `main` unchanged.
- Dry-run conflict list == the 10 expected files (or the delta is understood and re-analyzed).

## Notes for the executor

- **Do not** run `git merge` yet — that's Phase 3, after Phase 2 establishes deps/toolchain decisions.
- Keep `/tmp/element-web-upstream` (or the upstream remote) available for `git show upstream/develop:<path>` lookups
  used heavily in Phases 4–5.
- Rollback for the whole effort: `git switch main && git branch -D upstream-sync && git replace -d 3294bcc…`.
