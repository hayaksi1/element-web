# update-phases/ — Upstream Sync (v1.12.22 → develop)

Bring the fork up to date with `element-hq/element-web` `develop` **without breaking any built feature** (search +
macOS desktop), so a clean PR can be sent upstream. Read in order; each phase file is self-contained for a fresh session.

| #   | File                                                               | What                                                                         | Risk |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ---- |
| —   | [00-upstream-sync-master-plan.md](00-upstream-sync-master-plan.md) | situation, numbers, mechanic, decisions, phase index                         | —    |
| 1   | [phase-1-setup-graft.md](phase-1-setup-graft.md)                   | upstream remote, graft v1.12.22 as merge-base, integration branch, dry-run   | LOW  |
| 2   | [phase-2-deps-toolchain.md](phase-2-deps-toolchain.md)             | deps + lockfile regen, oxfmt, jest/vitest, knip, **matrix-js-sdk pin**       | MED  |
| 3   | [phase-3-bulk-merge.md](phase-3-bulk-merge.md)                     | run the grafted merge; adopt 366 U-only + review 19 auto-merges              | MED  |
| 4   | [phase-4-desktop-conflicts.md](phase-4-desktop-conflicts.md)       | **the only hard cluster** — #33468 config-de-global + #33827 deeplinks       | HIGH |
| 5   | [phase-5-web-conflicts.md](phase-5-web-conflicts.md)               | DateSeparator import + EventIndex test relocation; verify search auto-merges | LOW  |
| 6   | [phase-6-api-drift-cleanup.md](phase-6-api-drift-cleanup.md)       | getBrand ripple, snapshots, knip, oxfmt normalize, CLAUDE.md                 | MED  |
| 7   | [phase-7-verify-pr.md](phase-7-verify-pr.md)                       | full lint/test/build, macOS QA, PR prep                                      | MED  |

## Headline facts (empirical, session 36 / 2026-06-26)

- Upstream delta = **70 commits / 395 files**, ~80% dependency+CI maintenance. Target = **`develop`** (== PR base).
- Fork base is **byte-identical to `v1.12.22`** → perfect graft merge-base; a normal 3-way `git merge` works.
- Real git conflicts = **10 files**; 8 of them are the desktop config-de-globalling (#33468). All web conflicts trivial.
- jest survives on develop (fork tests safe); prettier→oxfmt (low churn); matrix-js-sdk recommend keep **41.8.0**.
- Analysis provenance: 12-agent Workflow (`tasks/w4nxrcs4x.output`) + Codex sidecar on config.ts; ground truth in
  `scratchpad/empirical_facts.md`, `scratchpad/codex_config_merge.md`.
