# Fork rules — hayaksi1/element-web

Downstream fork of `element-hq/element-web`. Element coding rules live in
`project/CLAUDE.md`. Full rationale in `.fork/README.md`. **This file is about branches.**

## First 60 seconds

```bash
git fetch upstream --prune && git fetch gh --prune
cat .fork/features.txt .fork/contrib.txt        # what gets rebased vs merged
git rev-list --left-right --count upstream/develop...develop   # MUST be N	0
git log --oneline upstream/develop..develop     # MUST be empty
.fork/sync-upstream.sh --dry-run                # what a sync would do
```

## Branch model

```
upstream/develop ──► develop            pristine mirror. ff-only. NEVER commit here.
                       ├── feat/fork-tooling    .fork/ + workflow. Merged first.
                       ├── feat/<a>             fork-local. Rebased each sync.
                       ├── feat/<b>
                       ├── pr/<x>               open upstream PR. NEVER rewritten.
                       └── pr/<y>
                             ↓
                       master = develop + every feat/* + every pr/*
                                            rebuilt from scratch by script
```

- The fork remote is **`gh`**, not `origin`.
- `master` is the **default branch** and the one you build and deploy. It is
  **disposable** — regenerated every sync. Never the source of truth for any code.

## Never

- **Never commit to `develop`.** It is a mirror of upstream. If someone asks you to "just
  commit this to develop", that is a mistake — say so and put it on a feature branch.
- **Never rebase, amend, squash or force-push a `pr/*` branch.** Each is the head of an
  open upstream pull request; rewriting it detaches review threads and re-fires CI.
  Fix-ups go on top as new commits.
- **Never `git merge upstream/develop` by hand.** Syncing is `.fork/sync-upstream.sh` and
  nothing else.
- **Never hand-merge into `master`.** It is always the product of the script.
- **Never resolve a conflict with `-X ours` / `-X theirs`.**
- **Never hand-edit `pnpm-lock.yaml`** — run `pnpm` and let it write the file.
- **Never edit anything in `patches/`** unless the change *is* the dependency patch.
- **Never reformat upstream code** and never touch `oxlint.config.ts` or `.oxfmtrc.jsonc`.
  They are byte-identical to upstream today; keep it that way.
- `git push --force-with-lease` only. Never bare `--force`. Only ever for `develop`,
  `master`, and rebased `feat/*`.

## Where a change goes

| What | Where |
|---|---|
| New fork-only feature | new `feat/<slug>` cut from `develop`, added to `.fork/features.txt` |
| Something to send upstream | new `pr/<slug>` cut from `develop`, added to `.fork/contrib.txt` |
| Bug in an existing feature | **that feature's branch**, then rebuild. Never on the integration branch. |
| Bug in an open PR | a **new commit** on that `pr/*` branch. Never amend. |
| Cross-feature / integration-only fix | commit on `master`, then **immediately** export it: `git format-patch -1 -o .fork/integration-patches/` and commit that to `feat/fork-tooling`. Otherwise the next rebuild deletes it. |
| Change to the sync tooling | `feat/fork-tooling` |

**After changing any branch, rebuild:** `.fork/sync-upstream.sh`. Every fix must end up
committed on the integration branch, and only the script puts it there.

## Conflict policy

Resolve inside the **feature branch's rebase** — small, focused context — not inside a
giant integration merge. Keep upstream's version of upstream logic and re-apply our intent
on top.

`pr/*` branches cannot be rebased, so their conflicts surface in the integration merge.
That is expected. `rerere` is enabled and its cache is committed at `.fork/rr-cache/`, so
each resolution is recorded once and replayed on every later rebuild. **Commit the cache
after a sync that resolved anything** — otherwise the next run re-derives it.

## Writing code so it does not conflict

- Prefer the **Module API** over editing upstream source. Check `packages/module-api` and
  the examples in `modules/` first. A `modules/fork-*/` directory has a zero conflict
  surface because upstream will never create that path.
- **Fork-specific i18n strings belong in a module's own `translations.json`**, registered
  with `i18n.register()` — not in `apps/web/src/i18n/strings/en_EN.json`. That file is the
  fork's single worst conflict source.
- Changing only a setting's *default*? Use `setting_defaults` in `config.json`. Zero code.
- In upstream files, **add lines; do not restructure them**. Never rename an upstream file.
- Keep commits small and single-purpose.

## Commit convention

Every fork commit on a `feat/*` branch carries a trailer so it stays greppable:

```
Fork-Feature: <slug>
```

Find them all with `git log --grep="Fork-Feature:"`. `pr/*` commits do **not** carry it —
they are destined for upstream and must stay clean.

Commit messages: imperative subject, body explains the trade-off in prose. No file lists,
no AI attribution trailers.

## Before you push

`pnpm install`, `pnpm lint`, `pnpm test:unit` must all pass. The sync script enforces this
and refuses to push if any gate fails. Note the real script names: it is `pnpm test:unit`
(there is no `pnpm test`) and `pnpm lint:fmt:fix` to format.
