# `.fork/` — how this fork stays syncable

Everything fork-specific lives under `.fork/`. Upstream will never create that directory,
so it can never conflict. The short version of the rules is in the repo-root `CLAUDE.md`;
this file explains _why_.

## The problem this solves

`element-hq/element-web` lands dozens of commits a day. This fork used to keep its own
work on `develop` and merge upstream into it. That has three failure modes, and we hit all
three:

1. **`develop` could no longer fast-forward.** Once your own commits are on the trunk,
   every sync is a merge, and every merge is a conflict negotiation.
2. **Merged PRs got re-applied forever.** Upstream _squash_-merges. When one of our PRs
   landed, upstream got one new commit with a new SHA and a new patch-id. Our original
   commits stayed on `develop`, so `git` had no idea the work was already upstream and
   dutifully re-applied it — conflicting against the very code it had become. 49 branches
   were in this state.
3. **Review fixes landed on the trunk instead of the branch under review**, so the topic
   branches and the trunk drifted apart and neither was authoritative.

## The model

```
upstream/develop ──► develop            pristine mirror. ff-only. Nobody commits here.
                       ├── feat/fork-tooling    this directory. Merged first.
                       ├── feat/<a>             fork-local. REBASED each sync.
                       ├── pr/<x>               open upstream PR. MERGED, never rewritten.
                       └── pr/<y>
                             ↓
                       master = develop + every feat/* + every pr/*
```

`develop` is a mirror. It is advanced only with `git merge --ff-only upstream/develop`,
which by construction cannot conflict. If that command ever fails, someone committed to
the trunk and the script stops and tells you how to fix it.

`master` is what you build and deploy, and it is **disposable**: thrown away
and rebuilt from scratch on every sync. Nothing may live only there.

## Why two lists instead of one

`.fork/features.txt` and `.fork/contrib.txt` exist because the two kinds of branch must be
treated differently, and getting this wrong does real damage.

|                       | `feat/*` (`features.txt`)                        | `pr/*` (`contrib.txt`)                         |
| --------------------- | ------------------------------------------------ | ---------------------------------------------- |
| what it is            | fork-local; upstream declined it or never saw it | head of an **open upstream pull request**      |
| on sync               | **rebased** onto `develop`                       | **merged** into the integration branch         |
| rewritten?            | yes, freely                                      | **never** — no rebase, no amend, no force-push |
| pushed by the script? | yes, `--force-with-lease`                        | **never**                                      |
| commit trailer        | `Fork-Feature: <slug>`                           | none — these go upstream and must stay clean   |

Force-pushing a `pr/*` branch would rewrite commits that reviewers have already commented
on, detach every review thread, and re-fire CI on the PR. Upstream's `CONTRIBUTING.md`
forbids it. The script has no code path that pushes a branch from `contrib.txt`.

The cost of not rebasing them is that their conflicts surface later, in the integration
merge, where the context is larger. That is what `rerere` is for.

## Branches that are deliberately _not_ in either list

A branch whose pull request was **merged** upstream must be excluded. Upstream squashed it,
so the content is already in `develop`; merging the branch again re-applies old code
against the code it became. Worse, if upstream later reworked that area, re-merging
silently reverts their work — `pr/desktop-titlebar-drag` (#33991) is exactly this case: it
was absorbed, then rewritten by #34419 and #34704, and merging it today would undo both.

Keep such branches around for history if you like. Just never list them.

## rerere — resolve once, replay forever

Because `pr/*` branches are frozen at whatever upstream they were cut from, merging ~100 of
them onto a moving `develop` produces the _same_ conflicts every single rebuild. Re-solving
them by hand each night is exactly the treadmill this restructure exists to end.

`rerere` ("reuse recorded resolution") records how you resolved a conflict hunk and
replays it automatically the next time the identical hunk appears. It is enabled with
`rerere.enabled` and `rerere.autoUpdate`.

Git only ever reads its cache from `$GIT_DIR/rr-cache`, which is local and dies with the
clone. So the script **copies** the cache in and out:

```
.fork/rr-cache/   (committed, shared, survives fresh clones)
      ↕ copied by sync-upstream.sh, at start and at end
.git/rr-cache/    (where git actually looks)
```

The two copies are **not** mirrors of each other. Import never overwrites a live
entry (it may be a resolution recorded since). Deleting an entry from the
committed cache therefore does not stop it replaying.

A failing entry is **quarantined, never cleared**: it moves to
`$GITDIR/rr-cache-quarantine/<id>/` with a `QUARANTINE_REASON.txt`, is listed in
`.fork/rr-cache-quarantined.tsv`, and is skipped on the next import. Clearing the
cache to deal with a handful of bad entries would re-ask every conflict already
answered once.

Export copies only `preimage`/`postimage`. `thisimage` is git's per-conflict
scratch and is what used to dirty the tree after every run. A failing entry is
refused, not warned-and-copied: exporting a wrong resolution is what makes it
permanent and shared.

A symlink was the obvious alternative and is wrong here: during a `feat/*` rebase, `HEAD`
is the feature branch, which does not contain `.fork/`, so the symlink would dangle and
rerere would silently record nothing. Copying is branch-independent.

**After any sync where you resolved a conflict, commit the cache:**

```bash
git add .fork/rr-cache .fork/rr-cache-quarantined.tsv
git commit -m "Record conflict resolutions from this sync"
```

Skip that and the next run — and every teammate, and CI — re-derives the same resolutions
from scratch.

## `integration-patches/`

Some fixes belong to no single branch: a test that only fails when feature A and feature B
are both present, a snapshot that only moves once every branch is merged. They cannot live
on a feature branch, and a commit made directly on `master` is destroyed by
the next rebuild.

So they are exported as patches:

```bash
# after committing the fix on master
git format-patch -1 -o .fork/integration-patches/
git checkout feat/fork-tooling
git add .fork/integration-patches && git commit -m "Carry <fix> across rebuilds"
```

The script applies every `.fork/integration-patches/*.patch` at the end of each rebuild,
with `git apply` and then `git apply --3way`. If one stops applying, upstream has rewritten
the code underneath it — regenerate or delete it.

## Files here

| Path                       | What                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------- |
| `sync-upstream.sh`         | the only supported way to sync. `--help` for flags.                                                     |
| `lib/rr-audit.sh`          | rerere quarantine, export gate, import-no-overwrite, unmanaged-branch report                            |
| `features.txt`             | ordered `feat/*` branches, rebased then merged. `feat/fork-tooling` first.                              |
| `contrib.txt`              | ordered `pr/*` branches, merged as-is. Order clusters conflicts together.                               |
| `unmanaged-branches.txt`   | on `gh`, in neither manifest, deliberately. Anything new is reported.                                   |
| `integration-patches/`     | cross-feature fixes, re-applied after every rebuild                                                     |
| `rr-cache/`                | shared rerere conflict-resolution cache                                                                 |
| `rr-cache-quarantined.tsv` | every resolution moved aside, and why                                                                   |
| `FORK_AUDIT.md`            | the 2026-08-27 audit this structure came from. Historical, but it records _why_ each decision was made. |

## Running a sync

```bash
.fork/sync-upstream.sh --dry-run     # always start here
.fork/sync-upstream.sh               # do it
```

On a conflict the script stops, prints the branch, the conflicting files and the exact
commands to resolve and resume. Fix it, then:

```bash
.fork/sync-upstream.sh --continue
```

It never auto-resolves with `-X ours`/`-X theirs`, and it pushes nothing unless
`pnpm install`, `pnpm lint` and `pnpm test:unit` all pass.

Other flags: `--no-push`, `--features=a,b` to work on a subset.

## Detect and publish

The sync runs as two jobs rather than one, because the two questions have very different
costs. _Does everything still merge?_ is cheap. _Does everything still build and pass?_
is not.

|        | Detect                      | Publish                                  |
| ------ | --------------------------- | ---------------------------------------- |
| Runs   | nightly                     | twice a week, or on demand               |
| Does   | the real accumulating merge | the same, plus patches, guards and gates |
| Pushes | `develop` only              | `develop`, `feat/*`, `master`            |
| Costs  | a few minutes of merging    | an install, a lint and two test suites   |

```bash
.fork/sync-upstream.sh --detect      # merge everything, report, touch nothing else
```

Detect merges in a throwaway worktree, so it never disturbs your checkout. It reads the
rerere cache and **never writes it**: a job running unattended must not record a
resolution nobody reviewed. On a conflict it records the branch, aborts that one merge and
carries on to the next, so one broken branch cannot hide every branch behind it — which
means its verdict for later branches is conditional on the ones it skipped, and the issue
says so.

It deliberately does **not** use `git merge-tree`. That would be a proxy for an operation
we already own, and it cannot replay rerere or the relocation resolver — so it reports
conflicts on branches that merge perfectly well. Measured: one search branch shows sixteen
conflicting paths against `develop` and merges clean in the real run.

Both jobs report into a **single** issue titled `Sync conflicts`, rewritten each run,
commented on only when the set of conflicts actually changes, closed when it empties and
reopened rather than duplicated. A conflict leaves detect's badge green: it is the job's
expected output, and a red badge every night is one nobody reads. Detect goes red only
when detect itself breaks.

`.fork/detect-report.tsv` is the machine-readable result — one `branch<TAB>path` line per
unresolved path, written even when the run is clean, so "nothing conflicted" and "the run
never got that far" cannot be confused. It is run output, not tooling: it is gitignored and
must never be committed.

`.fork/report-sync-conflicts.sh [report]` is what reflects that file in the issue; the
detect workflow runs it right after `--detect`. `FORK_ISSUE_DRY_RUN=1` prints every `gh`
write instead of doing it.

## Adding a branch

```bash
git checkout -b feat/<slug> develop     # or pr/<slug> for upstream work
# ... commits, with a "Fork-Feature: <slug>" trailer for feat/* only ...
echo 'feat/<slug>' >> .fork/features.txt    # or contrib.txt
.fork/sync-upstream.sh
```

## Keeping the conflict surface small

The audit measured where this fork actually fights upstream. In order:

1. `apps/web/src/i18n/strings/en_EN.json` — 53 fork commits against 30 upstream commits per
   quarter. **Avoidable.** Ship fork strings in a module's own `translations.json` and
   register them with `i18n.register()`. See `modules/banner` for the pattern.
2. `pnpm-lock.yaml` — the most-churned file upstream has. Never hand-edit; run `pnpm`.
3. `apps/web/src/settings/Settings.tsx` — unavoidable for _new_ settings (`SettingsApi` is
   read-only), but a change to a setting's _default_ needs no code at all: use
   `setting_defaults` in `config.json`.
4. `apps/web/src/components/structures/RoomView.tsx` — the deepest edit in the fork.
   Add lines; never restructure.

General rules: put new code in new files; in upstream files add rather than rearrange;
never rename an upstream file (we did once, to `DateSeparatorViewModel`, and it generated
conflicts until it was reverted); never reformat upstream code.
