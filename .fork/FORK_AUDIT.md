# Fork Audit — hayaksi1/element-web

Read-only investigation, Phase 1. Nothing in the repository was modified to produce this
document except the creation of this file and `git fetch`.

- **Date:** 2026-08-27
- **`develop` tip:** `3ccacb9d10` (2026-08-26)
- **`upstream/develop` tip:** `b52f8d71c3` (2026-08-27)
- **Merge base:** `716edc0d3e` — _Fix documentation references to Settings.tsx (#34766)_, 2026-08-21
- **Drift:** `develop` is **38 behind / 352 ahead** of `upstream/develop`

---

## 0. State of the fork — read this first

**Your description of the problem does not match the repository.** Four findings change
the shape of the work:

### 0.1 The feature split has already happened

`develop` carries 352 commits: **117 merge commits and 235 non-merge commits**. Of those
235 non-merge commits:

|                                                                  |  count | meaning           |
| ---------------------------------------------------------------- | -----: | ----------------- |
| present verbatim on a `pr/*` branch                              |    130 | already split out |
| present as an equivalent patch (rebased copy) on a `pr/*` branch |     27 | already split out |
| **exist only on `develop`**                                      | **78** | the actual work   |

`develop` is not a polluted trunk. It is **already an integration branch**, assembled by
merging ~150 `pr/*` topic branches. The restructure is a _formalisation and renaming_
job, not a rescue. The 78 true orphans are the only commits that need new homes.

### 0.2 There are 86 open upstream pull requests — the plan in §4 would damage them

147 PRs have been opened against `element-hq/element-web` from this fork: **86 open, 49
merged, 12 closed**. 145 of the 154 local topic branches back a real PR.

The task brief instructs me to, for every feature branch: rewrite each commit to add a
`Fork-Feature:` trailer, rebase it onto `develop` on every sync, and push with
`--force-with-lease`.

**Applied to a `pr/*` branch, that force-pushes the head of a live upstream PR.** It
would rewrite commits under review, detach existing review threads, re-trigger CI on 86
PRs, and violate both `CONTRIBUTING.md` and your own standing rule never to force-push an
open PR. I will not do that, and the plan in Phase 2 splits the namespace instead:

- **`pr/*` — contribution branches.** Aimed at upstream. Never rebased, never rewritten,
  no trailer. Already minimal (1–11 commits off upstream). Out of scope for the sync
  script's rebase loop.
- **`feat/*` — fork-local features.** Things upstream has rejected or will never take.
  These get the trailer, the rebase, and the integration merge.

### 0.3 `develop` has a second root commit

`git rev-list --max-parents=0 develop` returns **7 roots**; `upstream/develop` returns 6.
The extra one is `eccb9d3f5c` _"Initial commit"_ (2026-06-24, `admin@myhome.internal`,
**4,925 files**).

The fork was not created by cloning upstream. It was bootstrapped as a fresh repository
from a v1.12.22 snapshot, and upstream was grafted on later at `db411f2f15` (2026-06-26,
_"Merge upstream/develop into the fork"_).

Consequence: the 39 commits authored by `admin@myhome.internal` between 2026-06-24 and
2026-06-26 were written against a _parallel, unrelated history_. They are not cleanly
cherry-pickable onto today's `upstream/develop` — expect real conflicts when re-homing
them, not mechanical ones. Every later commit (196, by `hayaksi1`) sits on the grafted
history and is well-behaved.

### 0.4 Merged PRs are re-applied on `develop` forever — this is the real merge pain

Upstream **squash-merges**. When PR #34641 (`pr/spotlight-no-results`) was merged it
landed on upstream as a single new commit `de231a6922`. The fork's three original
commits still sit on `develop` with different SHAs and different patch-ids.

`git cherry upstream/develop pr/spotlight-no-results` → `0` already-upstream, `3`
still-unique. Verified the same way for `pr/home-space-badge-parity`,
`pr/invite-forbidden-reason`, `pr/thread-notification-decryption-race`.

So `develop` keeps re-applying changes upstream already has. **49 merged-PR branches are
in this state.** That is the single largest generator of the conflicts you have been
paying an agent to resolve, and the pristine-mirror model deletes it outright: once
`develop == upstream/develop`, merged work arrives free from upstream and its branch is
simply deleted.

---

## 1. Branch inventory

174 local branches, 172 on `gh`. Two worktrees:
`/home/jack/Desktop/Projects/element` (`develop`) and
`/home/jack/Desktop/Projects/element-e2e-threads` (`e2e/full-size-threads`).

> **The fork remote is named `gh`, not `origin`.** Every command in the task brief says
> `origin`. All commands in the plan use `gh`.

### 1.1 By class

| Class                                      | Count | Disposition                                                   |
| ------------------------------------------ | ----: | ------------------------------------------------------------- |
| `pr/*` backing an **open** upstream PR     |    86 | **Keep as-is. Never rebase, never rewrite.**                  |
| `pr/*` whose PR is **merged**              |    49 | Delete after verifying content is in upstream                 |
| `pr/*` whose PR is **closed** (rejected)   |    12 | Promote to `feat/*` — these are the fork's permanent identity |
| `pr/*`/`feature/*` with **no PR**          |     9 | Triage: promote or drop                                       |
| `backup/*`, `backup-develop-s61`           |     7 | Superseded by the new backup tag; delete after                |
| `shots/*`                                  |     7 | Screenshot scratch; delete                                    |
| `ss/*`, `sync/*`, `upstream-sync`          |     4 | Dead scaffolding; delete                                      |
| `main`                                     |     1 | 70,395 behind — dead parallel history, unrelated to upstream  |
| `demo/media-tabs`, `e2e/full-size-threads` |     2 | Scratch                                                       |

### 1.2 Staleness

Nothing is older than three months — the fork began 2026-06-24. But 41 branches have not
been touched since July, and `main` (2026-06-26) is a dead parallel history that shares
almost nothing with `upstream/develop`.

### 1.3 Closed PRs — the fork's permanent divergence

These twelve are the features upstream declined. They define what the fork _is_:

| Branch                              | PR            | Title                                                              |
| ----------------------------------- | ------------- | ------------------------------------------------------------------ |
| `pr/chat-background`                | #34297        | Add a customisable chat background behind the message timeline     |
| `pr/full-size-threads`              | #34791        | Add a preference to open threads in the main chat area             |
| `pr/message-hover-actions`          | #34315        | Add a setting to collapse message actions and the hover highlight  |
| `pr/message-hover-actions-upstream` | #34314        | Add a setting to collapse the message action bar                   |
| `pr/search-top-bar`                 | #34014        | Move in-room search into a top-of-chat bar with a results dropdown |
| `pr/search-jump-to-date`            | #34012        | Add a jump-to-date calendar to the in-room search header           |
| `pr/search-order-toggle`            | #34011        | Sort in-room search by relevance or recency                        |
| `pr/search-from-filter`             | #34010        | Filter in-room message search by sender                            |
| `pr/seshat-circuit-breaker`         | #33984/#33985 | Stop the search error dialog after every sync                      |
| `pr/export-utf8-bom`                | #34640        | Mark a plain text export as UTF-8                                  |
| `pr/video-download-error-label`     | #34517        | Distinguish a failed video download from a failed decryption       |

---

## 2. Change surface

### 2.1 Net divergence

`git diff upstream/develop...develop` → **400 files, +25,934 / −1,935**

| Area                             | files |
| -------------------------------- | ----: |
| `apps/web/src`                   |   197 |
| `apps/web/test`                  |    68 |
| `apps/web/playwright`            |    39 |
| `apps/desktop/src`               |    38 |
| `apps/web/res`                   |    24 |
| `packages/shared-components/src` |    13 |
| everything else                  |    21 |

95 files added, 299 upstream files modified, 6 removed.

### 2.2 Conflict hot-spot ranking

Fork touches counted across all 282 fork commits; upstream churn is commits in the last
90 days on `upstream/develop`. **Collision risk is the product**, not either column alone.

| Rank | File                                                  | fork | upstream/90d | note                                                           |
| ---: | ----------------------------------------------------- | ---: | -----------: | -------------------------------------------------------------- |
|    1 | `apps/web/src/i18n/strings/en_EN.json`                |   53 |           30 | **worst file in the repo.** Fully avoidable — see §3           |
|    2 | `pnpm-lock.yaml`                                      |    6 |      **213** | most-churned upstream file; fork holds a structural −52 delta  |
|    3 | `apps/web/src/settings/Settings.tsx`                  |   21 |           23 | 8 fork-added settings, additive (+84/−3, 15 hunks)             |
|    4 | `apps/web/src/components/structures/RoomView.tsx`     |   31 |            9 | **+566/−65 over 29 hunks** — deepest invasive edit in the fork |
|    5 | `apps/web/src/components/structures/MatrixChat.tsx`   |   11 |           17 |                                                                |
|    6 | `apps/desktop/src/electron-main.ts`                   |   20 |            7 | no module API exists for this file                             |
|    7 | `apps/web/src/components/views/rooms/EventTile.tsx`   |    7 |           12 |                                                                |
|    8 | `apps/web/src/components/structures/LoggedInView.tsx` |    8 |           12 |                                                                |
|    9 | `apps/desktop/src/store.ts`                           |   17 |            3 |                                                                |
|   10 | `apps/web/src/Searching.ts`                           |   18 |            1 | high fork churn, near-zero upstream churn — cheap              |
|   11 | `apps/web/res/css/_components.pcss`                   |   13 |            7 | append-only index file; conflicts are trivial                  |
|   12 | `apps/web/src/Notifier.ts`                            |   10 |            6 |                                                                |

Files that are **not** a problem, contrary to the brief's assumption:
`oxlint.config.ts`, `.oxfmtrc.jsonc`, `knip.ts`, root `package.json`, `nx.json`,
`vitest.config.ts` are all **byte-identical to upstream**. The fork has never reformatted
upstream code or touched lint config. CI divergence is two lines
(`.github/CODEOWNERS` +5/−3, `.github/workflows/localazy_upload.yaml` +1), both from the
InfoPlist i18n work.

### 2.3 Permanent conflict generators

1. **`en_EN.json` (+90/−22).** 53 fork commits vs 30 upstream commits per 90 days. Most
   of the 22 "deletions" are reword pairs, not removals of upstream strings. **This is
   the highest-value thing to fix and it is fully solvable** — see §3.1.
2. **`pnpm-lock.yaml` (0/−52).** The fork _removes_ the `auto-launch`,
   `@types/auto-launch` and `electron-window-state` dependencies, having replaced them
   with a native Electron `loginItem` implementation (`apps/desktop/src/auto-launch.ts`,
   commit `1bf22f45b9`, PR #33999). This is deliberate, not accidental. It also means:
3. **`patches/@types__auto-launch.patch` is deleted by the fork** (commit `8053426880`)
   and its `patchedDependencies` entry removed from `pnpm-workspace.yaml`. Upstream still
   ships both. Your safety rule 6 says not to touch `patches/` — this predates the rule
   and is a _consequence_ of a shipped feature, so I have flagged it rather than reverting
   it. **This needs your decision** (see §5, open question 2).
4. **`apps/web/src/viewmodels/room/timeline/DateSeparatorViewModel.tsx` → `.ts`.** The
   fork _renamed_ an upstream file (commit `2510deb1a9`). Upstream still has the `.tsx`
   and six upstream files import it. Every upstream commit touching it will produce a
   rename/modify conflict or a silent duplicate. Cheap to revert; high recurring cost to
   keep.
5. **`apps/web/src/components/views/rooms/RoomSearchAuxPanel.tsx` deleted** (commit
   `26c7c763ad`) along with its CSS, test and Playwright snapshot — the fork replaced the
   search UI. Deliberate, and unavoidable while the search feature exists.

### 2.4 Pure noise — drop these

| Commit / artifact                                                          | Why                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/web/blob-report/report-Chrome-c7ab7a0.zip`                           | 528 KB committed Playwright blob report. Accidental.                            |
| `6e1c5fc05c` _chore: ignore graphify-out/_                                 | one-line `.gitignore` tweak; belongs in `feat/fork-tooling`                     |
| `eccb9d3f5c` _Initial commit_                                              | the 4,925-file parallel root. Disappears automatically when `develop` is reset. |
| `05df42227d` _Drop the note above the InfoPlist test's directory constant_ | comment-only                                                                    |
| `4d7523a4cf`, `4190f3124e`, `c8682f1b47`                                   | snapshot/mock/lint-gate repairs — integration-only, not feature work            |

**Commits with unusable messages.** Twelve commits are named only by issue number —
`77d68752bb` _"34639 34659 34576 34476 34478"_, `ce500d4dc6` _"34007 34478 34486 33994"_,
`cdb2233636` _"34007"_, `f9011de1f8` _"34001"_, `31aa20ca52` _"33990"_, `94926a75fb`
_"33995"_, `c9e35d4d7a` _"33994"_, `f587f1b28d` _"33986"_, `85356027d9` _"34004"_,
`f790137282` _"34478"_, `943369e6da` _"34512"_, `72d54d5b49` _"34606 34610 34604"_.

These are **PR review fixes applied to `develop` instead of to the branch under review**.
They are the mechanism by which `develop` drifted from its own topic branches. Each one
needs to be split back onto the `pr/*` branch it belongs to — that is the most delicate
part of the whole migration, and it is where I will need you (see §5).

---

## 3. Element extension points — modularization classification

Sources read: `docs/customisations.md`, `docs/skinning.md`, `docs/config.md`,
`modules/README.md`, `packages/module-api/element-web-module-api.api.md` (the
api-extractor public surface), `modules/banner`, `modules/widget-toggles`.

### 3.0 What is actually available

- **Customisations are deprecated.** `docs/customisations.md` opens with
  _"🦖 DEPRECATED … in favour of the Module API"_. The `customisations.json` mechanism is
  not a target to migrate to.
- **The Module API is the supported extension point.** `packages/module-api` exposes
  `i18n`, `customComponents`, `extras`, `navigation`, `composer`, `dialog`, `settings`,
  `config`, `stores`, `widget`, `widgetLifecycle`, `storageHelper`, `builtins`,
  `customisations`.
- **Modules live in `modules/<name>/`** — their own package, own `vite.config.ts`, own
  `style.css`, own `translations.json`. **A fork module directory is a path upstream will
  never create, so its conflict surface is exactly zero** — the same property that makes
  `.fork/` safe.
- **Modules are loaded at runtime** via `config.json` `"modules": [...]`, or at build time
  via `build_config.yaml`.
- **`setting_defaults` in `config.json`** overrides the default of any setting that
  supports the `config` level — **zero code**.

### 3.1 The one big win: `i18n.register()`

`I18nApi.register(translations)` lets a module ship its own strings in its own
`translations.json`. Verified in `modules/banner/src/translations.json`.

**Every fork-specific string can leave `apps/web/src/i18n/strings/en_EN.json`.** That
single change removes the worst file in the hot-spot table (53 fork touches × 30 upstream
commits/90d) and also removes the risk your own notes flag — that a substitution-shape
change silently renders `<Tag/>` as literal text across ~40 stale translations.

### 3.2 The hard limits

- **`SettingsApi` is `getValue()` only.** There is no `registerSetting`. A fork that
  _adds_ a setting must edit `Settings.tsx` and `en_EN.json`. Nothing can be done about
  this today; it caps eight fork features at `PARTIAL`.
- **There is no module API for the Electron main process.** The Module API is a web
  renderer API. All 38 `apps/desktop/src/*` files are `INVASIVE` by construction.
- **No extension point for timeline internals.** `customComponents.registerMessageRenderer`
  replaces rendering for a whole event _type_; it cannot alter `MessagePanel` grouping,
  `RoomView` layout, or scroll behaviour. `builtins.renderRoomView` embeds an entire room
  view and is not a patching mechanism.
- **No extension point for search.** `Searching.ts`, `SearchSessionStore`, `EventIndex`
  have no module surface at all.

### 3.3 Classification

| Feature                                                                                  | Class           | Extension point / why not                                                                                                                                                  |
| ---------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fork i18n strings** (all of them)                                                      | `MODULARIZABLE` | `I18nApi.register()` + module `translations.json`. Removes hot-spot #1 entirely.                                                                                           |
| **Setting _default_ changes only** (jump-to-date on, warn-before-quit off, ⌘F search on) | `MODULARIZABLE` | `setting_defaults` in `config.json`. Zero code.                                                                                                                            |
| **Chat background** (`feat/chat-background`)                                             | `PARTIAL`       | Artwork + CSS ship as a module (`modules/*/style.css`). The two settings (`RoomView.backgroundImage`, `RoomView.backgroundOpacity`) still need `Settings.tsx`.             |
| **Message action bar / hover** (`feat/message-action-bar`)                               | `PARTIAL`       | CSS to a module. `compactMessageActions` setting + `EventTile`/`EventTileDerivedState` hooks stay in-tree.                                                                 |
| **Bot command autocomplete (MSC4332)**                                                   | `PARTIAL`       | `composer` API covers upload options, not autocomplete providers. Provider registration stays in-tree.                                                                     |
| **Full-size thread view** (`feat/full-size-threads`)                                     | `INVASIVE`      | Rewires `RightPanelStore`, `RoomView`, `MatrixChat`. 31 files. No extension point.                                                                                         |
| **Telegram-parity search UI** (`feat/search-*`)                                          | `INVASIVE`      | `RoomView.tsx` +566/−65 across 29 hunks, `MessagePanel`, `EventTile`, `Searching.ts`, plus a deleted upstream component. The fork's largest and most expensive divergence. |
| **Seshat indexing / resilience**                                                         | `INVASIVE`      | `apps/web/src/indexing/EventIndex.ts` — no module surface.                                                                                                                 |
| **All macOS/desktop work** (21 orphans + ~20 `pr/desktop-*`)                             | `INVASIVE`      | No Electron-main module API exists. Permanent.                                                                                                                             |
| **Notification behaviour** (`Notifier.ts`, invite notifications, sound)                  | `INVASIVE`      | No extension point.                                                                                                                                                        |

Honest summary: **two things are genuinely modularizable and both are cheap; the rest is
not.** The fork's identity is deep timeline, search and Electron work, and the Module API
does not reach any of it. What modularization buys you is removing hot-spot #1 and a
handful of default flips — not a conflict-free fork. The branch model in Phase 2 is what
does the heavy lifting.

---

## 4. Feature grouping

The 78 true orphans, grouped. `pr/*` names in the _existing branch_ column mean the
feature already has a branch and the orphan is a divergent or later revision of it.

| Proposed branch                             | Existing branch(es)                                                                                                                                               |                                                                                                                                                                                                                                                                        Orphan commits | Primary files                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | ------------------------------------------------------------------------------------------------------------- |
| `feat/search-ui`                            | `pr/search-top-bar`, `pr/search-stepping`, `pr/search-all-rooms`, `pr/search-order-toggle`, `pr/search-from-filter`, `pr/search-jump-to-date`, `pr/search-cmdf-*` | 21 — `30c1b18716` `726deffc5c` `32eb2271a0` `c121292038` `ee4981dfae` `2d656c059a` `3e3c25cd34` `bf0df9c789` `d7d6bc03f5` `3bd5b578e2` `511034fde7` `b36be65d68` `ef26e174c2` `c0e1b9418a` `42436b296f` `3cb364ca44` `99b66aee73` `de8d4c56bf` `49c4354511` `6fe7a3ef28` `26c7c763ad` | `RoomView.tsx`, `MessagePanel.tsx`, `SearchSessionStore.ts`, `RoomSearchHeader.tsx`, shared-components search |
| `feat/search-indexing`                      | `pr/seshat-circuit-breaker`, `pr/search-resilience`, `pr/search-incomplete-warning`                                                                               |                                                                                                                                                                                        7 — `b2705016bd` `356b2d215b` `c43918a64e` `9ff6da5432` `f824c65906` `f9011de1f8` `85356027d9` | `apps/web/src/indexing/EventIndex.ts`, `Searching.ts`                                                         |
| `feat/search-tz-fix`                        | `pr/jump-to-date-local-timezone` (#34476, open)                                                                                                                   |                                                                                                                                                                                                                                                                      1 — `2510deb1a9` | `DateSeparatorViewModel` — **carries the `.tsx`→`.ts` rename**                                                |
| `feat/chat-background`                      | `pr/chat-background` (#34297 closed)                                                                                                                              |                                                                                                                                                                                                                                            3 — `981bb6cead` `cb32e0cfb1` `6ea076b1f0` | `Settings.tsx`, `LoggedInView.tsx`, Appearance tab                                                            |
| `feat/message-action-bar`                   | `pr/message-hover-actions` (#34315 closed), `feature/remove-message-hover-highlight`                                                                              |                                                                                                                                                                                                                                            3 — `1eaf6a95bc` `ea00f52cfc` `2e7a4c1883` | `_EventTile.pcss`, `_EventBubbleTile.pcss`, `EventTileDerivedState.ts`                                        |
| `feat/full-size-threads`                    | `pr/full-size-threads` (#34791 closed), `e2e/full-size-threads`                                                                                                   |                                                                                                                                                                                                                                                         2 — `5d381d74ca` `898f6ebcb5` | `RightPanelStore`, `RoomView.tsx`, ThreadHeader                                                               |
| `feat/macos-desktop`                        | ~20 open `pr/desktop-*` PRs                                                                                                                                       |                                                                                            14 — `8053426880` `030bce32e3` `6547496b4f` `984e7ca6ab` `373b91a4fc` `b485bd88b8` `c2b5a1867c` `230c7c6fe0` `80b8385bfd` `3ed204897b` `0788b1c2a3` `1bf22f45b9` `0f4e9351df` `4190f3124e` | `electron-main.ts`, `store.ts`, `ipc.ts`, `webcontents-handler.ts`                                            |
| `feat/macos-notification-sound`             | `pr/macos-notification-sound` (no PR)                                                                                                                             |                                                                                                                                                                                                                                                                      1 — `7265b77ee6` | `apps/desktop/src`, `vector/platform`                                                                         |
| `feat/fork-misc`                            | —                                                                                                                                                                 |                                                                                                                                                                                                                  5 — `677662dfbf` `e4da7a4e9a` `6ea3ca82bb` `c23138bc54` `772e796d3a` | keyboard case-insensitivity, audio overlap, invite notify, leave dialog size, uploaded-media cache            |
| **`.fork/integration-patches/`**            | —                                                                                                                                                                 |                                                                                                                                                                           8 — `18def0a80c` `2e009e6790` `27c33c577c` `973eee36b3` `c8682f1b47` `4d7523a4cf` `b79d5e7528` `943369e6da` | e2e/snapshot/lint repairs that belong to no single feature                                                    |
| **needs your call — misfiled review fixes** | various `pr/*`                                                                                                                                                    |                                                                                                                                                                                                                                              12 — the numeric-subject commits in §2.4 | must be split back onto the named `pr/*` branch                                                               |
| **drop**                                    | —                                                                                                                                                                 |                                                                                                                                                                                                                                                         2 — `eccb9d3f5c` `6e1c5fc05c` | parallel root; `.gitignore` chore                                                                             |

---

## 5. Open questions I need answered before Phase 2 is final

I will not guess at the intent of your code. Four decisions are yours:

1. **The 12 numeric-subject review-fix commits.** Each bundles fixes for several PRs
   (`77d68752bb` alone names five: 34639, 34659, 34576, 34476, 34478). Splitting them
   correctly means deciding, hunk by hunk, which PR each fix belongs to. Do you want me
   to (a) split them per-PR onto the right `pr/*` branches, (b) park them wholesale in
   `.fork/integration-patches/`, or (c) leave them and accept they re-conflict?

2. **`patches/@types__auto-launch.patch` and the `auto-launch` dependency removal.** The
   fork deleted an upstream patch and two upstream dependencies. PR #33999 proposes this
   upstream and is still open. Keep the fork's removal (permanent lockfile divergence),
   or restore upstream's state on the mirror and carry the removal only on
   `feat/macos-desktop`?

3. **`DateSeparatorViewModel.tsx` → `.ts` rename.** Revert to upstream's `.tsx` (one-time
   cost, removes a recurring conflict) or keep it?

4. **The 49 merged-PR branches.** Their content is in upstream under squashed SHAs.
   Confirm I may delete the local and `gh` branches after verifying each against
   `upstream/develop`.

---

## 6. What this means for the target model

The model you proposed is right, with three amendments:

1. **Two namespaces, not one.** `pr/*` (upstream contribution, never rewritten) and
   `feat/*` (fork-local, rebased every sync). `.fork/features.txt` lists only `feat/*`.
2. **`master` must merge both** — your build needs the open-PR work too, so
   the script merges `feat/*` from `features.txt` and then the `pr/*` branches listed in
   a second file, `.fork/contrib.txt`, without ever rewriting them.
3. **Deleting the 49 merged-PR branches is a prerequisite**, not cleanup. While they exist
   and get merged into the integration branch, every sync re-applies changes upstream
   already has — §0.4. This is the change that actually makes syncing boring.

Expected result: `develop` fast-forwards with zero conflicts by construction. Conflict
work drops to rebasing ~9 `feat/*` branches, concentrated in `RoomView.tsx` (9 upstream
commits/90d) and `Settings.tsx` (23/90d) — and `en_EN.json` disappears from the list
entirely once §3.1 is done.
