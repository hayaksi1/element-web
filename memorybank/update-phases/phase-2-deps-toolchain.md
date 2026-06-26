# Phase 2 — Dependencies, lockfile & toolchain decisions

> **Risk: MEDIUM. Goal:** lock in the dependency + toolchain story _before_ the bulk merge, so the merged tree compiles
> and the fork's tests/format/lint still pass. ~80% of the 70 upstream commits are absorbed here. No feature code is
> touched; this phase is about `package.json`, the lockfile, formatter, test runner, and the matrix-js-sdk pin.

## 2.0 — What the 70 commits actually are (so nothing is "lost")

The categorize agent bucketed all 69 non-merge commits (the 70th is the master→develop merge). Buckets and how each is
absorbed:

| Bucket                                                                                                                                                                                   | Count | Absorbed by                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------ |
| Pure dep bumps (nx major, storybook, electron 42.4.1, vite, webpack, babel, ts 4.12, testcontainers, zxcvbn v4, temporal-polyfill v1, electron-builder 26.15.3, pacote, dnd-kit ^0.5.0…) | 27    | **adopting upstream lockfile + package.json** (this phase)   |
| compound-web 9.6.0 → 9.7.0                                                                                                                                                               | 2     | lockfile + **snapshot regen** (Phase 6)                      |
| CI / Docker / publish / Node infra                                                                                                                                                       | 17    | take upstream wholesale (Phase 3 bulk)                       |
| Test-infra / flake fixes                                                                                                                                                                 | 6     | take upstream wholesale (Phase 3)                            |
| i18n auto-translations                                                                                                                                                                   | 3     | key-wise JSON merge (Phase 5)                                |
| Real upstream features (room-list DnD #33606/#33800, UserMenu names #33900, double-tooltip #33923, separator #33869)                                                                     | 5     | take upstream wholesale (Phase 3) — **no fork-file overlap** |
| Cross-cutting toolchain migrations (oxfmt #33844, jest→vitest #33898, knip --strict #33893, languageHandler split #33948, raw-loader→?raw #33854, framer-motion→motion #33887)           | 6     | **this phase + Phases 5/6**                                  |
| Desktop refactors (#33468 config-de-global, #33827 deeplinks)                                                                                                                            | 2     | **Phase 4**                                                  |
| #33946 JSX tidy (touches RoomView etc.)                                                                                                                                                  | 1     | Phase 5 (auto-merges)                                        |

## 2.1 — Dependency / lockfile strategy (do NOT hand-merge the lockfile)

`pnpm-lock.yaml` is +2180/−1742 upstream (pure regen) and the fork's only change is **removals** (it dropped
`auto-launch`, `electron-window-state`, `@types/auto-launch`). Strategy (from the build-meta agent):

1. Take **upstream** `pnpm-workspace.yaml` and `pnpm-lock.yaml` wholesale (do this during/after the Phase 3 merge:
   `git checkout upstream/develop -- pnpm-lock.yaml pnpm-workspace.yaml`).
2. Re-apply the **fork's removals**: delete the `@types/auto-launch: patches/@types__auto-launch.patch`
   `patchedDependencies` entry (+ its `# Workaround…` comment) from `pnpm-workspace.yaml`, and delete the file
   `patches/@types__auto-launch.patch`. (Upstream independently removed `@dnd-kit/abstract`'s patch via dnd-kit ^0.5.0 —
   keep that removal too. **Merged `patchedDependencies` has neither entry.**)
3. Apply the fork's `apps/desktop/package.json` (which removes the 3 deps) — see Phase 4.
4. `pnpm install` (matching upstream's pinned `packageManager`/corepack) to **regenerate** the lock deterministically.
5. Verify: `git grep -i 'auto-launch\|electron-window-state' pnpm-lock.yaml` → empty.

> ⚠️ Upstream added `minimumReleaseAgeStrict: true` / `minimumReleaseAge` to `pnpm-workspace.yaml`. Confirm a regen
> `pnpm install` works in this (possibly offline/corepack-shim) environment without the age gate blocking resolution —
> may need a `--config.minimumReleaseAge=0` override. (memory: pnpm via corepack + postinstall shim.)

## 2.2 — matrix-js-sdk pin (DECISION — recommended: keep 41.8.0)

- Base + fork both pin `apps/web/package.json` → `matrix-js-sdk: "41.8.0"`. Upstream commit `d1dfd3a7ca` floats develop to
  `github:matrix-org/matrix-js-sdk#develop`.
- Upstream changed **zero** of the fork's indexing/search files (`BaseEventIndexManager.ts`, `EventIndex.ts`,
  `EventIndexPeg.ts`, `SeshatIndexManager.ts`, `Searching.ts`) — verified `git log` count 0 each. So there is **no merge
  pressure** to bump; this is a pure `package.json` line choice → **take OURS (`41.8.0`)** for that line.
- ⚠️ **Clear this open risk first:** scan the 366 U-only upstream files for SDK symbols only present on develop:
    ```bash
    # spot-check: do any upstream-NEW/changed files import SDK paths the 41.8.0 .d.ts lacks?
    git diff --name-only v1.12.22 upstream/develop | grep -E '\.tsx?$' \
      | xargs -I{} sh -c 'git show upstream/develop:{} 2>/dev/null | grep -l "matrix-js-sdk" >/dev/null && echo {}' 2>/dev/null
    ```
    If upstream code needs a develop-only API → do a **controlled bump to a TAGGED 42.x release** (never the floating pin)
    and re-run the seshat encrypt/commit/reopen/search QA. Otherwise keep 41.8.0; revisit as a separate follow-up.
- The fork's known **4 pre-existing tsc errors** (41.8.0 vendored `.d.ts`) are expected and tolerated by `tsc` gates.

## 2.3 — Formatter: prettier → oxfmt (DECISION — recommended: adopt oxfmt)

- Upstream `#33844` **deletes prettier entirely**: drops the `prettier` devDep, deletes `.prettierrc.cjs` /
  `.prettierignore` (root + `apps/desktop` + `packages/shared-components`), removes `lint:prettier*` scripts, adds
  `oxfmt ^0.54.0` with `lint:fmt` (`oxfmt --check`) / `lint:fmt-fix` (`oxfmt`) and a new `.oxfmtrc.jsonc`.
- `.oxfmtrc.jsonc` style is **byte-identical** to the fork's prettier settings (printWidth 120, tabWidth 4, quoteProps
  consistent, trailingComma all) → **near-zero reformat churn** (upstream's own switch reformatted ~11 files total).
- The fork touched **none** of the formatter/lint config files → resolve them all by **taking THEIRS** in the merge.
- **Action:** adopt oxfmt; run one normalize pass in **Phase 6**; update **CLAUDE.md** `pnpm lint:prettier-fix` →
  `pnpm lint:fmt-fix`. Do **not** pre-format the fork before the merge (the tree is already prettier-clean; pre-format
  only pollutes the conflict diffs).

## 2.4 — Test runner: jest survives (no action; reassurance)

- **jest is NOT removed** on develop — `apps/web/project.json` still has `test:unit → jest` and `test:vitest → vitest`;
  the `vitest` project `include` is only `src/**/*.test.{ts,tsx}`. `#33898` is **additive** (migrates a few tests +
  adds a `jest-mock-vitest-adapter` shim so vitest-style tests still run under jest).
- The fork's ~60 jest tests under `apps/web/test/unit-tests/` (531 `jest.*` calls, `jest-matrix-react` alias) keep
  running unchanged. **Take upstream wholesale** for `jest.config.ts`, `vitest.config.ts`, `test/setupTests.ts`, and the
  new `__mocks__/workerFactoryMock-jest.js` + `test/setup/adapter.ts` (fork never touched them → clean adopt).
- Keep the fork's matrix-js-sdk ESM `transformIgnorePatterns` **CLI flag** (upstream didn't change
  `transformIgnorePatterns`, so it still works). See `memorybank/` jest-env workaround note.
- Only **one** fork-modified test was relocated by the migration (`indexing/EventIndex-test.ts`) → handled in Phase 5.

## 2.5 — knip --strict (flag for Phase 6; the real lint risk)

`#33893` hardens `lint:knip` to `--strict` (flags unused exports/files). The fork adds ~25 new web exports
(`SearchSessionStore`, `FileCategory`, `scrollBehavior`, `jumpToDate`, `viewmodels/search/*`, `RoomSearch*`,
`SearchMatchStepPayload`, `InRoomSearchNudgeToast`) + the shared-components `SearchMatchNavigation` barrel, and 13 new
`apps/desktop/src/*` helpers. Any export reachable only from its own `*-test` file, or a barrel not re-exported from a
knip entry root, will FAIL strict. **Fix in Phase 6** (ensure `packages/shared-components/src/index.ts` re-exports
SearchMatchNavigation; ensure each new module is imported from a real entry-reachable site). Don't guess — run
`pnpm lint:knip` after the merge to enumerate real failures.

## Verification gate (Phase 2 done when)

- Decisions recorded: matrix-js-sdk = 41.8.0 (or tagged-42.x if the U-only scan forces it); oxfmt adopted; jest kept.
- The dependency/lockfile _procedure_ is staged for Phase 3 (this phase decides; Phase 3 executes the merge that pulls
  the package.jsons, then regen).
- No code merged yet.
