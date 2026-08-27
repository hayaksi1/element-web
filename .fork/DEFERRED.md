# Deferred work from the first `combined` rebuild

Things deliberately not done during the 2026-08-27 restructure, recorded here so they are
not lost. Each is a real gap, not a rounding error.

## Fork test cases dropped in the jest -> vitest relocation

Upstream moved its unit tests from `apps/web/test/unit-tests/**` to co-located
`src/**/*.test.tsx` and rewrote them for vitest. Several contribution branches still carry
the *old* file at the *old* path with jest idioms, so merging them produces a conflict
between two files that are the same test suite in different worlds.

For these five, the merge took **upstream's relocated version**. Upstream's own cases are
therefore intact, but any case the fork branch had added to that file is currently absent
from `combined`:

| File (upstream path) | Branch version | Cases in the branch copy |
|---|---|---|
| `apps/web/src/Searching.test.ts` | `pr/search-top-bar` | 22 |
| `apps/web/src/components/structures/RoomSearchView.test.tsx` | `pr/search-top-bar` | 10 |
| `apps/web/src/components/structures/RoomView.test.tsx` | `pr/search-top-bar` | 74 |
| `apps/web/src/components/views/right_panel/RoomSummaryCardView.test.tsx` | `pr/search-top-bar` | 25 |
| `apps/web/src/components/views/rooms/RoomHeader/RoomHeader.test.tsx` | `pr/search-top-bar` | 46 |

Those counts are the whole file, most of which is upstream's own tests that already exist
in the relocated copy. The fork-specific additions are the subset worth porting.

**To port one:** diff the branch's copy against the version upstream had *before* it was
relocated, which isolates the fork's additions, then re-target them at the co-located file.

```bash
git show pr/search-top-bar:apps/web/test/unit-tests/components/structures/RoomView-test.tsx > /tmp/fork.tsx
git show $(git merge-base develop pr/search-top-bar):apps/web/test/unit-tests/components/structures/RoomView-test.tsx > /tmp/base.tsx
diff -u /tmp/base.tsx /tmp/fork.tsx        # exactly the fork's additions
```

Port them onto the feature branch that owns the behaviour, never onto `combined` - the
next rebuild discards anything committed only there.

## Not yet run

- The verification gates (`pnpm install`, `pnpm lint`, `pnpm test:unit`) have not been run
  against a complete `combined`. The rebuild is not finished.
- No Playwright/e2e run.
- No desktop packaged build.

## The rebuild is incomplete

`.fork/contrib.txt` lists 92 branches. Only the first handful are merged so far. Resume
with `.fork/sync-upstream.sh --no-push`; every conflict already resolved replays from
`.fork/rr-cache` automatically, so restarting is cheap.
