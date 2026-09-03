#!/usr/bin/env bash
#
# Rebuild this fork against upstream.
#
#   develop              pristine mirror of upstream/develop, advanced only with --ff-only
#   feat/*               fork-local features, REBASED onto develop  (.fork/features.txt)
#   pr/*                 upstream contribution branches, MERGED as-is, never rewritten
#                                                          (.fork/contrib.txt)
#   master               develop + every feat/* + every pr/*, rebuilt from scratch
#
# See .fork/README.md for the why. Run --help for flags.

set -euo pipefail

# Re-exec from a temp copy: this script switches branches while running, and bash reads
# scripts incrementally, so editing the checkout underneath a running shell corrupts it.
if [[ "${FORK_SYNC_SELF_COPY:-}" != "1" ]]; then
    _tmp="$(mktemp)"
    cp "$0" "$_tmp"
    chmod +x "$_tmp"
    FORK_SYNC_SELF_COPY=1 FORK_SYNC_TMP="$_tmp" exec "$_tmp" "$@"
fi
trap '[[ -n "${FORK_SYNC_TMP:-}" ]] && rm -f "$FORK_SYNC_TMP"' EXIT

REMOTE="${FORK_REMOTE:-gh}"
UPSTREAM="${FORK_UPSTREAM:-upstream}"
MIRROR="${FORK_MIRROR_BRANCH:-develop}"
INTEGRATION="${FORK_INTEGRATION_BRANCH:-master}"

DRY_RUN=0
NO_PUSH=0
LOCKFILE_NEEDS_REGEN=0
SNAPSHOTS_STALE=0
CONTINUE=0
DETECT=0
FEATURE_SUBSET=""

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
if [[ ! -t 1 ]]; then RED=""; GRN=""; YLW=""; BLD=""; RST=""; fi

log()  { printf '%s[fork-sync]%s %s\n' "$BLD" "$RST" "$*"; }
ok()   { printf '%s[fork-sync]%s %s%s%s\n' "$BLD" "$RST" "$GRN" "$*" "$RST"; }
warn() { printf '%s[fork-sync]%s %s%s%s\n' "$BLD" "$RST" "$YLW" "$*" "$RST" >&2; }
die()  { printf '%s[fork-sync]%s %sERROR:%s %s\n' "$BLD" "$RST" "$RED" "$RST" "$*" >&2; exit 1; }
run()  { if (( DRY_RUN )); then printf '  would run: %s\n' "$*"; else "$@"; fi; }

usage() {
    cat <<'EOF'
Rebuild this fork against upstream.

  develop              pristine mirror of upstream/develop, advanced only with --ff-only
  feat/*               fork-local features, REBASED onto develop  (.fork/features.txt)
  pr/*                 upstream contribution branches, MERGED as-is, never rewritten
                                                         (.fork/contrib.txt)
  master               develop + every feat/* + every pr/*, rebuilt from scratch

Usage: .fork/sync-upstream.sh [flags]

  --dry-run           Report what would change. Touches nothing, pushes nothing.
  --no-push           Do all the work locally; never push.
  --continue          Resume after you resolved a conflict by hand.
  --detect            Rebuild in a throwaway worktree from the remote-tracking refs
                      and report every branch the publish run would stop on, then
                      throw the worktree away. Pushes nothing, runs no gate, reads
                      the rerere cache but never writes it back. Writes
                      .fork/detect-report.tsv (branch<TAB>path per unresolved
                      path, empty when clean) and exits with the code the publish
                      run would have stopped with.
  --features=a,b      Only process these feature branches (comma separated,
                      with or without the feat/ prefix).
  -h, --help          This text.

Environment: FORK_REMOTE (default gh), FORK_UPSTREAM (default upstream),
             FORK_MIRROR_BRANCH (default develop),
             FORK_INTEGRATION_BRANCH (default master).

Exit codes: 0 ok - 1 error - 2 feature rebase conflict - 3 integration merge
            conflict - 4 patch failed - 5 verification gate failed - 6 a
            contribution branch had drifted from the remote and was left out.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --dry-run)     DRY_RUN=1 ;;
        --no-push)     NO_PUSH=1 ;;
        --continue)    CONTINUE=1 ;;
        --detect)      DETECT=1 ;;
        --features=*)  FEATURE_SUBSET="${arg#*=}" ;;
        -h|--help)     usage; exit 0 ;;
        *)             die "unknown flag: $arg (try --help)" ;;
    esac
done
if (( DETECT )) && { (( DRY_RUN + NO_PUSH + CONTINUE )) || [[ -n "$FEATURE_SUBSET" ]]; }; then
    die "--detect cannot be combined with --dry-run, --no-push, --continue or --features"
fi

REPO_ROOT="$(git rev-parse --show-toplevel)" || die "not inside a git repository"
cd "$REPO_ROOT"
GIT_COMMON="$(git rev-parse --git-common-dir)"
case "$GIT_COMMON" in /*) ;; *) GIT_COMMON="$REPO_ROOT/$GIT_COMMON" ;; esac
STATE_FILE="$GIT_COMMON/fork-sync-state"
RR_LIVE="$GIT_COMMON/rr-cache"
RR_REPO="$REPO_ROOT/.fork/rr-cache"
FEATURES_FILE="$REPO_ROOT/.fork/features.txt"
CONTRIB_FILE="$REPO_ROOT/.fork/contrib.txt"
PATCH_DIR="$REPO_ROOT/.fork/integration-patches"
DELETIONS_FILE="$REPO_ROOT/.fork/accept-upstream-deletions.txt"
RELOCATIONS_FILE="$REPO_ROOT/.fork/relocations.txt"
DROPS_FILE="$GIT_COMMON/fork-sync-drops"
# A manifest entry with no local branch used to warn and carry on, which builds the
# integration branch from a subset and can still pass every gate and push. Silence is
# the wrong response to "one of the ninety-three is not here".
MISSING_REFS="$GIT_COMMON/fork-sync-missing-refs"
rm -f "$MISSING_REFS"
STILL_DROPPED="$GIT_COMMON/fork-sync-drops-final"
# Which allowlist entries actually silenced something this run. An exemption nobody
# exercises is the dangerous kind: it stays authoritative long after the reason for it
# has gone, and blinds the guard to a real drop on that path forever.
ACCEPTED_USED="$GIT_COMMON/fork-sync-accepted-used"
# Contribution branches whose local ref no longer matches the remote. They are left out
# of the rebuild rather than merged stale, and the run refuses to push at the end.
SKIPPED_CONTRIBS="$GIT_COMMON/fork-sync-skipped-contribs"
# assert_branch_landed runs twice: once per merge, where it can only see that merge's
# result, and once at the end against the finished tree. RECHECK selects the pass.
RECHECK=0
DROPS_SINK="$DROPS_FILE"
REF_PREFIX="refs/heads"
if (( DETECT )); then
    SCRATCH="$(mktemp -d)"
    STATE_FILE="$SCRATCH/state"
    DROPS_FILE="$SCRATCH/drops"
    MISSING_REFS="$SCRATCH/missing-refs"
    STILL_DROPPED="$SCRATCH/drops-final"
    ACCEPTED_USED="$SCRATCH/accepted-used"
    DROPS_SINK="$DROPS_FILE"
    REF_PREFIX="refs/remotes/$REMOTE"
    DETECT_REPORT="${FORK_DETECT_REPORT:-$REPO_ROOT/.fork/detect-report.tsv}"
    rm -f "$DETECT_REPORT"
fi

# ---------------------------------------------------------------- helpers

read_list() {
    # Strip comments and blanks, keep order, drop refs that do not exist.
    local file="$1" line ref
    [[ -f "$file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"
        ref="${line#"${line%%[![:space:]]*}"}"
        ref="${ref%"${ref##*[![:space:]]}"}"
        [[ -z "$ref" ]] && continue
        if git show-ref --verify --quiet "$REF_PREFIX/$ref"; then
            printf '%s\n' "$ref"
        else
            printf '%s\n' "$ref" >> "$MISSING_REFS"
            warn "listed in ${file##*/} but $REF_PREFIX/$ref does not exist, skipping"
        fi
    done < "$file"
}

in_subset() {
    local branch="$1" want
    local -a wants
    [[ -z "$FEATURE_SUBSET" ]] && return 0
    IFS=',' read -ra wants <<< "$FEATURE_SUBSET"
    for want in "${wants[@]}"; do
        [[ "$want" == "$branch" || "feat/$want" == "$branch" ]] && return 0
    done
    return 1
}

# State is written as strict KEY=VALUE and read back with a parser, never `source`:
# a branch name may legally contain ';' or '$', which sourcing would execute.
# The originating flags are persisted too, so a bare --continue cannot silently turn a
# --no-push or --features run into a full push of every branch.
save_state() {
    { printf 'PHASE=%s\n' "$1"
      printf 'INDEX=%s\n' "$2"
      printf 'BRANCH=%s\n' "${3:-}"
      printf 'NO_PUSH=%s\n' "$NO_PUSH"
      printf 'SUBSET=%s\n' "$FEATURE_SUBSET"
      printf 'MIRROR_SHA=%s\n' "$(git rev-parse "$MIRROR" 2>/dev/null || echo unknown)"
    } > "$STATE_FILE"
}
clear_state() { rm -f "$STATE_FILE"; }

load_state() {
    local line key value
    while IFS= read -r line || [[ -n "$line" ]]; do
        key="${line%%=*}"; value="${line#*=}"
        case "$key" in
            PHASE)      ST_PHASE="$value" ;;
            INDEX)      ST_INDEX="$value" ;;
            BRANCH)     ST_BRANCH="$value" ;;
            NO_PUSH)    ST_NO_PUSH="$value" ;;
            SUBSET)     ST_SUBSET="$value" ;;
            MIRROR_SHA) ST_MIRROR_SHA="$value" ;;
            *) warn "ignoring unrecognised state key: $key" ;;
        esac
    done < "$STATE_FILE"
    [[ "${ST_INDEX:-0}" =~ ^[0-9]+$ ]] || die "corrupt state: INDEX is not a number"
    [[ "${ST_NO_PUSH:-0}" =~ ^[01]$ ]] || die "corrupt state: NO_PUSH is not 0 or 1"
}

require_clean_tree() {
    # Untracked files are fine (they survive checkouts); staged/unstaged changes are not.
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        git status --short --untracked-files=no >&2
        die "working tree has uncommitted changes. Commit or stash them, then re-run."
    fi
    local op
    for op in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
        # Written as if/fi, not `[[ ]] && die`: the latter makes the loop return 1 on its
        # last iteration, which under `set -e` can abort before the rebase check below.
        if [[ -e "$(op_path "$op")" ]]; then
            die "a $op operation is in progress. Finish or abort it first."
        fi
    done
    if in_progress_rebase; then
        die "a rebase is in progress. Finish it and re-run with --continue, or 'git rebase --abort'."
    fi
}

# MERGE_HEAD and the rebase directories are PER-WORKTREE state. Resolving them against
# --git-common-dir misses them entirely in a linked worktree, so ask git for the path.
op_path() { git rev-parse --git-path "$1"; }
in_progress_rebase() {
    [[ -d "$(op_path rebase-merge)" || -d "$(op_path rebase-apply)" ]]
}

conflicting_files() { git diff --name-only --diff-filter=U || true; }

# pnpm-lock.yaml is generated, never hand-merged, and upstream churns it harder than any
# other file in this repo. Resolve it to our side and let the `pnpm install` gate rewrite
# it from the merged package.json files - that is the only authoritative resolution, and
# it is why the install gate runs before anything is pushed.
# The rerere cache is committed under .fork/rr-cache so resolutions survive a fresh clone,
# which also puts it inside every integration merge. Git's rename detection then pairs a
# deleted file with a preimage - preimages are near-copies of the very files that conflict -
# and the merge stops on a cache artifact. Our side is authoritative and export_rr_cache
# rewrites the whole directory at the end of the run, so there is nothing to weigh up.
resolve_rr_cache_conflicts() {
    local path resolved=0
    while read -r path; do
        [[ -n "$path" ]] || continue
        case "$path" in
            .fork/rr-cache/*) ;;
            *) continue ;;
        esac
        if git show ":2:$path" > "$path" 2>/dev/null; then
            git add -- "$path"
        else
            git rm -q --force --ignore-unmatch -- "$path"
        fi
        log "    kept our side of the rerere cache artifact $path"
        resolved=1
    done <<< "$(git diff --name-only --diff-filter=U || true)"
    return $(( ! resolved ))
}

resolve_lockfile() {
    local lock="pnpm-lock.yaml"
    git diff --name-only --diff-filter=U | grep -qxF "$lock" || return 1
    git show ":2:$lock" > "$lock"
    git add -- "$lock"
    log "    took our pnpm-lock.yaml; the install gate will regenerate it"
    LOCKFILE_NEEDS_REGEN=1
    return 0
}

# UA / AU mean exactly one side has the file at all: the other side never had it, so
# there is no competing content and nothing for a human to arbitrate. Take the version
# that exists. AA (both added, different content) is a real conflict and is left alone.
resolve_one_sided_adds() {
    local path code resolved=0
    while read -r code path; do
        local stage=""
        case "$code" in
            UA) stage=3 ;;
            AU) stage=2 ;;
            *)  continue ;;
        esac
        if ! git show ":${stage}:$path" > "$path" 2>/dev/null; then
            warn "    could not read stage $stage of $path; leaving it conflicted"
            continue
        fi
        git add -- "$path"
        log "    took the only side that has $path ($code)"
        resolved=1
    done <<< "$(unmerged_kinds | awk '$1=="UA"||$1=="AU"{print $1, $2}')"
    return $(( ! resolved ))
}

# Jest/vitest .snap files are DERIVED from the components they render, so a hand-merged
# snapshot is meaningless - the component is the truth. Resolve to our side and let the
# test gate be the arbiter: if the merged UI really renders differently, the suite fails
# and says so, which is the signal we actually want.
resolve_snapshots() {
    local f resolved=0
    while read -r f; do
        case "$f" in
            *__snapshots__/*.snap|*.snap)
                git show ":2:$f" > "$f" 2>/dev/null || continue
                git add -- "$f" || die "could not stage $f; another git process holds the index lock"
                log "    took our $f; regenerate with the test runner if the suite disagrees"
                SNAPSHOTS_STALE=1
                resolved=1
                ;;
            */playwright/snapshots/*.png)
                # A screenshot baseline cannot be merged, and on the integration branch NEITHER
                # side is right: the integrated UI carries every branch's visual change, so any
                # baseline recorded against one of them alone is stale by construction. Take the
                # branch's - it is at least the newer of the two - and flag the whole set for
                # regeneration rather than pretend the pixels are settled.
                git show ":3:$f" > "$f" 2>/dev/null || continue
                git add -- "$f" || die "could not stage $f; another git process holds the index lock"
                log "    took the branch's $f; every playwright baseline needs regenerating"
                SNAPSHOTS_STALE=1
                resolved=1
                ;;
        esac
    done <<< "$(git diff --name-only --diff-filter=U)"
    return $(( ! resolved ))
}

# The kind of each unmerged path, read from the index stages rather than parsed out of
# `git status` text: stage 1 is the base, 2 ours, 3 theirs. Printed as the two-letter
# status code callers already match on (DU: deleted by us, UD: deleted by them, UA/AU:
# added on one side, AA: added on both, UU: modified on both).
unmerged_kinds() {
    local path stages
    while IFS= read -r -d '' path; do
        stages="$(git ls-files -u -z -- "$path" | tr '\0' '\n' | awk '{ print $3 }' | sort -u | tr -d '\n')"
        case "$stages" in
            13)  printf 'DU %s\n' "$path" ;;
            12)  printf 'UD %s\n' "$path" ;;
            3)   printf 'UA %s\n' "$path" ;;
            2)   printf 'AU %s\n' "$path" ;;
            23)  printf 'AA %s\n' "$path" ;;
            123) printf 'UU %s\n' "$path" ;;
        esac
    done < <(git diff --name-only -z --diff-filter=U)
}

# rerere only ever caches CONTENT conflicts. A modify/delete is a tree conflict, so it is
# never replayed and would halt every rebuild forever. For paths explicitly listed as
# "upstream deleted this for good", take the deletion and move on. Everything else still
# stops the run and asks a human.
resolve_listed_deletions() {
    local path resolved=0 allowed
    [[ -f "$DELETIONS_FILE" ]] || return 0
    allowed="$(grep -v '^[[:space:]]*#' "$DELETIONS_FILE" | grep -v '^[[:space:]]*$' || true)"
    [[ -z "$allowed" ]] && return 1
    # NB: plain `read -r path`, not `IFS= read` - the latter disables field splitting, so
    # the whole line lands in $path and nothing ever matches.
    while read -r path; do
        [[ -n "$path" ]] || continue
        if printf '%s\n' "$allowed" | grep -qxF -- "$path"; then
            git rm -q --force --ignore-unmatch -- "$path"
            log "    accepted upstream's deletion of $path (listed in accept-upstream-deletions.txt)"
            resolved=1
        fi
    done <<< "$(unmerged_kinds | awk '$1=="DU"||$1=="UD"{print $2}')"
    return $(( ! resolved ))
}

# ---------------------------------------------------------------- relocations
# Upstream co-located its test suite: apps/web/test/unit-tests/X/Y-test.tsx became
# apps/web/src/X/Y.test.tsx, and the original was deleted. A contribution branch that
# touches the old path therefore hits a modify/delete: our side (upstream) deleted it,
# their side (the branch) modified it. Taking the deletion -- which is what
# resolve_listed_deletions does -- lands the branch's SOURCE change and silently drops
# its TESTS. That has already happened three times (pr/search-top-bar's Searching and
# RoomView suites, pr/message-hover-actions' EventTileActionBarViewModel suite).
#
# So: find where the file went, three-way merge the branch's version into it, and if
# that does not apply cleanly leave it CONFLICTED for a human. Never drop silently.

RELOC_MAP=""            # cached "old<TAB>new" pairs for the merge in progress
RELOC_MAP_BASE=""       # the merge base $RELOC_MAP was built against

build_reloc_map() {
    local base="$1"
    [[ "$base" == "$RELOC_MAP_BASE" && -n "$RELOC_MAP_BASE" ]] && return 0
    RELOC_MAP_BASE="$base"
    # .fork is excluded deliberately. The committed rerere cache stores preimages, which
    # are near-copies of the very files that conflict; git's rename detection cheerfully
    # pairs a deleted test file with an rr-cache preimage, and following that would merge
    # the branch's tests into the conflict cache instead of into the test suite.
    RELOC_MAP="$(git diff -M50% -l0 --name-status --diff-filter=R "$base" HEAD \
                     -- . ':(exclude).fork/*' 2>/dev/null | cut -f2,3 || true)"
}

# Resolve an old path to its current home. Three sources, most authoritative first.
reloc_target() {
    local old="$1" new=""
    # 1. an explicit override, for moves no algorithm can derive.
    if [[ -f "$RELOCATIONS_FILE" ]]; then
        new="$(sed 's/#.*//' "$RELOCATIONS_FILE" | awk -F'->' -v k="$old" '
            { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
              gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2) }
            $1 == k && $2 != "" { print $2; exit }')"
        [[ -n "$new" ]] && { printf '%s\n' "$new"; return 0; }
    fi
    # 2. what git says upstream actually did. This is the only source that copes with a
    #    file that moved directory as well as filename (131 of the 554 real relocations
    #    did, e.g. test/viewmodels/message-body/TextualBodyViewModel-test.tsx ->
    #    src/viewmodels/room/timeline/event-tile/body/TextualBodyViewModel.test.ts).
    new="$(printf '%s\n' "$RELOC_MAP" | awk -F'\t' -v k="$old" '$1 == k { print $2; exit }')"
    [[ -n "$new" ]] && { printf '%s\n' "$new"; return 0; }
    # 3. the deterministic co-location transform, for when similarity detection misses
    #    (it matched 423 of the 554 real relocations on its own).
    new="$(printf '%s\n' "$old" | sed -E '
        s|^apps/web/test/unit-tests/|apps/web/src/|
        s|^apps/web/test/|apps/web/src/|
        s|-test\.(tsx?)(\.snap)?$|.test.\1\2|')"
    [[ "$new" != "$old" && -n "$new" ]] && { printf '%s\n' "$new"; return 0; }
    return 1
}

resolve_relocations() {
    local old new base resolved=0 conflicted=0
    local base_sha ours_sha theirs_sha mode rc tmp
    base="$(git merge-base HEAD MERGE_HEAD 2>/dev/null)" || return 1
    build_reloc_map "$base"

    while read -r old; do
        [[ -n "$old" ]] || continue
        new="$(reloc_target "$old")" || continue
        [[ "$new" == "$old" ]] && continue
        # Two runners collect tests, and between them they leave a dead zone: jest takes
        # apps/web/test/**/*-test.*, vitest takes apps/web/src/**/*.test.*, so a file that
        # is in src with a -test name, or in test with a .test name, is collected by
        # neither. Landing fork work there loses it silently - it neither fails nor runs.
        # The co-location transform cannot produce those shapes, but relocations.txt is
        # free text and git's rename detection returns whatever it finds.
        case "$new" in
            apps/web/src/*-test.ts|apps/web/src/*-test.tsx|apps/web/test/*.test.ts|apps/web/test/*.test.tsx)
                die "relocation would land $old at $new, which no test runner collects.
jest takes apps/web/test/**/*-test.*; vitest takes apps/web/src/**/*.test.*. A file in
between is silently never run. Fix the mapping in .fork/relocations.txt." ;;
        esac
        # A rename pair whose extension changes is git guessing across file types: the
        # same detection window paired a .pcss stylesheet with a .ts helper at -M50%.
        if [[ "${old##*.}" != "${new##*.}" ]]; then
            warn "    ignoring rename $old -> $new: different file types, almost certainly a false pair"
            continue
        fi
        # The target has to be present in the merge result, else there is nothing to
        # merge into and the deletion allowlist should get its turn.
        git cat-file -e ":0:$new" 2>/dev/null || continue
        base_sha="$(git rev-parse --verify --quiet ":1:$old")"   || continue
        theirs_sha="$(git rev-parse --verify --quiet ":3:$old")" || continue
        ours_sha="$(git rev-parse --verify --quiet ":0:$new")"   || continue
        mode="$(git ls-files --stage -- "$new" | awk '{ print $1; exit }')"
        [[ -n "$mode" ]] || mode=100644

        tmp="$(mktemp -d)" || continue
        git cat-file blob "$base_sha"   > "$tmp/base"   || { rm -rf "$tmp"; continue; }
        git cat-file blob "$theirs_sha" > "$tmp/theirs" || { rm -rf "$tmp"; continue; }
        git cat-file blob "$ours_sha"   > "$tmp/merged" || { rm -rf "$tmp"; continue; }

        git merge-file \
            -L "${INTEGRATION##*/}:$new" -L "merge base:$old" -L "branch:$old" \
            "$tmp/merged" "$tmp/base" "$tmp/theirs" >/dev/null 2>&1
        rc=$?
        if (( rc < 0 )); then
            warn "    could not three-way merge $old into $new; leaving it conflicted"
            rm -rf "$tmp"; continue
        fi

        mkdir -p "$(dirname -- "$new")"
        cat "$tmp/merged" > "$new"
        git rm -q --force --ignore-unmatch -- "$old"

        if (( rc == 0 )); then
            git add -- "$new"
            log "    relocated $old -> $new (clean three-way merge)"
            resolved=1
        else
            # Stage a genuine unmerged entry so `git diff --diff-filter=U` sees it and
            # merge_one halts. Writing markers and `git add`-ing them would commit them,
            # which is precisely the failure the conflict-marker guard exists to catch.
            git rm -q --cached --force --ignore-unmatch -- "$new"
            printf '%s %s %s\t%s\n' "$mode" "$base_sha"   1 "$new" >  "$tmp/idx"
            printf '%s %s %s\t%s\n' "$mode" "$ours_sha"   2 "$new" >> "$tmp/idx"
            printf '%s %s %s\t%s\n' "$mode" "$theirs_sha" 3 "$new" >> "$tmp/idx"
            git update-index --index-info < "$tmp/idx"
            warn "    relocated $old -> $new but it CONFLICTS; resolve $new by hand"
            conflicted=1
        fi
        rm -rf "$tmp"
    done <<< "$(unmerged_kinds | awk '$1 == "DU" { print $2 }')"

    # A modify/delete is a tree conflict and rerere never caches one, which is why this
    # class of conflict used to halt every rebuild forever. Having turned it into a
    # content conflict, ask rerere to record it -- and to replay it if this same
    # conflict was resolved on a previous run.
    if (( conflicted )); then
        git rerere 2>/dev/null || true
        local f
        while read -r f; do
            [[ -n "$f" ]] || continue
            if [[ -f "$f" ]] && ! grep -q '^<<<<<<< ' "$f"; then
                git add -- "$f"
                log "    rerere replayed a previous resolution for $f"
                resolved=1
            fi
        done <<< "$(git diff --name-only --diff-filter=U || true)"
    fi
    return $(( ! resolved ))
}

# ------------------------------------------------------------- landing guard
# The relocation conflicts are raised LOUDLY by git and resolved by a human. That is
# where the three known drops actually came from: the conflict was resolved by taking
# upstream's side, and once the merge is committed the loss is invisible -
# `git merge-base --is-ancestor` still says the branch is in, because it is; only its
# content is gone.
#
# So assert it after the fact. For every file the branch changed, compare the blob in
# the merge result against the blob our side had going in. If they are identical while
# the branch's own version differed, the merge took nothing from the branch for that
# file and the run stops. This is pure SHA comparison -- no content scanning.
assert_branch_landed() {
    local branch="$1" base="$2" pre="$3"   # pre = first parent, i.e. our side going in
    local f target lost=0 f_reloc
    # On the re-check pass HEAD is the finished tree, so say so rather than repeating
    # the merge-time warnings for content the integration patches have since restored.
    local warn=warn log=log
    if (( RECHECK )); then warn=:; log=:; fi
    local before after theirs accepted=""

    # A path listed here is one upstream deleted and we agreed to let go, so a branch
    # contributing nothing to it is the expected outcome, not a dropped merge.
    if [[ -f "$DELETIONS_FILE" ]]; then
        accepted="$(grep -v '^[[:space:]]*#' "$DELETIONS_FILE" | grep -v '^[[:space:]]*$' || true)"
    fi

    while read -r f; do
        [[ -n "$f" ]] || continue
        case "$f" in
            pnpm-lock.yaml) continue ;;    # regenerated by the install gate
        esac
        # Match the allowlist against the branch's own path AND where the file now lives.
        # Upstream's co-location moved most of these, so an entry written either way works;
        # requiring the pre-move spelling made correct entries silently miss.
        f_reloc="$(reloc_target "$f" 2>/dev/null || true)"
        if [[ -n "$accepted" ]] && printf '%s\n' "$accepted" | grep -qxF -e "$f" -e "${f_reloc:-$f}"; then
            $log "    $f: upstream deleted it and the allowlist accepts that; not a drop"
            (( RECHECK )) || printf '%s\n%s\n' "$f" "${f_reloc:-$f}" >> "$ACCEPTED_USED"
            continue
        fi
        theirs="$(git rev-parse --verify --quiet "$branch:$f")" || continue
        # Unchanged on the branch relative to the base? Then there is nothing to land.
        [[ "$theirs" == "$(git rev-parse --verify --quiet "$base:$f")" ]] && continue

        target="$f"
        if ! git rev-parse --verify --quiet "HEAD:$target" >/dev/null 2>&1; then
            target="$(reloc_target "$f")" || target="$f"
        fi

        after="$(git rev-parse --verify --quiet "HEAD:$target" || true)"
        before="$(git rev-parse --verify --quiet "$pre:$target" || true)"
        if [[ -z "$after" ]]; then
            $warn "    LOST: $f is not in the merge result (nor at $target)"
            lost=1
        elif [[ "$after" == "$before" ]]; then
            $warn "    LOST: $target is byte-identical to our pre-merge version;"
            $warn "          $branch changed $f and the merge kept none of it"
            lost=1
        fi
    done <<< "$(git diff --name-only "$base" "$branch")"

    (( lost == 0 )) && return 0

    # Recorded, not raised. A nightly run that stops on the fifth of ninety-odd branches
    # tells you almost nothing; one that finishes and hands back every branch that
    # dropped content tells you where to spend the morning. A conflict still halts -
    # nothing can be committed until a human resolves it - but a drop is only visible
    # after the merge commit exists, and costs nothing to carry to the end of the run.
    printf '%s\t%s\t%s\n' "$branch" "$base" "$pre" >> "$DROPS_SINK"
    return 0
}

# Indent a multi-line string by four spaces, without shelling out.
indent() { local s="${1//$'\n'/$'\n'    }"; printf '    %s\n' "$s"; }

try_merge() {
    local branch="$1"
    git merge --no-ff --no-edit -m "Merge $branch into ${INTEGRATION##*/}" "$branch" && return 0
    # MUST run before resolve_listed_deletions: the allowlist would take the
    # deletion and the branch's tests would vanish with it.
    resolve_relocations || true
    resolve_rr_cache_conflicts || true
    resolve_listed_deletions || true
    resolve_lockfile || true
    resolve_snapshots || true
    resolve_one_sided_adds || true
    [[ -z "$(conflicting_files)" ]] || return 1
    # rerere and/or the deletion list resolved everything; conclude the merge.
    git commit --no-edit
}

# rerere must not run inside the apply. git apply --3way holds the index for the whole
# operation, and rerere.autoUpdate makes rerere try to stage its replay from within it -
# so the two deadlock, git dies on index.lock instead of on the conflict, and the apply
# rolls the index back leaving nothing to salvage. Disabling rerere for the apply turns
# that crash into an ordinary conflict, which this then resolves afterwards the way
# try_merge does - but only when EVERY unmerged path came out clean. A patch that
# "applies" with markers still in it is the worst outcome available: the marker guard
# runs later in the run, and the file would already be staged.
accept_rerere_resolution() {
    local p="$1" f conflicted accepted=0
    # Collected BEFORE git rerere runs. autoUpdate means rerere stages what it replays, so
    # asking for unmerged paths afterwards returns nothing whether it resolved everything
    # or was never able to resolve anything - the two are indistinguishable at that point.
    conflicted="$(git diff --name-only --diff-filter=U)"
    [[ -n "$conflicted" ]] || return 1
    git rerere 2>/dev/null || true
    while read -r f; do
        [[ -n "$f" ]] || continue
        if [[ -f "$f" ]] && ! grep -q '^<<<<<<< ' "$f"; then
            git add -- "$f"
            log "    rerere replayed a previous resolution for $f"
            accepted=1
        else
            warn "    $f is STILL conflicted after $(basename "$p")"
            return 1
        fi
    done <<< "$conflicted"
    (( accepted )) || return 1
    git diff --name-only --diff-filter=U | grep -q . && return 1
    warn "  $(basename "$p") did not apply cleanly; rerere resolved it. Review the result."
    return 0
}

apply_patch() {
    local p="$1"
    log "  $(basename "$p")"
    if grep -qE '^\+\+\+ b/\.fork/' "$p"; then
        die "integration patch $(basename "$p") changes .fork/ tooling.
Tooling lives on feat/fork-tooling and is merged, not patched. A patch that carries a
tooling change conflicts with the branch the moment the tooling moves on.
Regenerate it without that path:
    git format-patch -1 <sha> -o $PATCH_DIR -- ':(exclude).fork/*'"
    fi
    if git apply --reverse --check "$p" 2>/dev/null; then
        log "  already in the tree - nothing to commit"
        return 0
    fi
    if git apply --index --check "$p" 2>/dev/null; then
        git apply --index "$p" || return 1
    elif git -c rerere.enabled=false apply --3way --check "$p" 2>/dev/null; then
        git -c rerere.enabled=false apply --3way "$p" || accept_rerere_resolution "$p" || return 1
    else
        return 1
    fi
    if git diff --cached --quiet; then
        log "  already in the tree - nothing to commit"
        return 0
    fi
    git commit --quiet -m "Apply integration patch $(basename "$p")" \
                        -m "Cross-feature fix that belongs to no single branch. Source: .fork/integration-patches/$(basename "$p")"
}

# rerere rewrites .fork/rr-cache while the run is in progress, and that directory is
# tracked - so by the time the script wants to switch branches or start a rebase, git
# refuses because the working tree is dirty exactly where the script itself dirtied it.
# The live cache under .git/rr-cache is the source of truth and is never touched here;
# the tracked copy is a mirror that export_rr_cache rewrites at the end of the run. So
# discarding working-tree edits to the mirror before an operation that needs a clean
# tree loses nothing. Untracked files are left alone - they are new resolutions, they do
# not block anything, and export_rr_cache will write them out again.
restore_rr_worktree() {
    git ls-files --modified -- "$RR_REPO" 2>/dev/null | grep -q . || return 0
    git checkout --quiet -- "$RR_REPO" 2>/dev/null || true
}

# ------------------------------------------- 5b2. cached-resolution audit

# A postimage IS the merge result for its conflict, replayed verbatim on every rebuild
# forever. A defective one is therefore worse than no cache at all: it reproduces the
# same broken file silently, and the branch still merges cleanly, so nothing upstream of
# the test run notices. Two of these shipped before this check existed - one left a file
# unparseable, one left jest idioms in a vitest suite that only failed on the runner.
audit_rr_cache() {
    local f bad=""
    for f in "$RR_REPO"/*/postimage*; do
        [[ -e "$f" ]] || continue
        # A resolution that still holds conflict markers was never finished.
        if grep -qE '^(<{7}|>{7})$' "$f"; then
            bad+="$f (unresolved conflict markers)"$'\n'; continue
        fi
        # jest in a file that imports vitest is a half-done migration. Files that do not
        # import vitest are the legacy suites, where jest is correct - leave them be.
        # Match a bare `jest` too: the real code writes `jest` and `.spyOn(...)` on
        # separate lines often enough that a `jest\.` pattern misses it entirely.
        if grep -q 'from "vitest"' "$f" && grep -qE '(^|[^-[:alnum:]])jest([^-[:alnum:]]|$)' "$f"; then
            bad+="$f (jest idioms in a vitest resolution)"$'\n'
        fi
        # vitest has no `vi.SpyInstance`; the type is `MockInstance`, imported by name.
        # A blanket jest.->vi. rewrite produces this and it compiles nowhere.
        if grep -qE '\bvi\.(SpyInstance|Mocked|Mock)\b' "$f"; then
            bad+="$f (vi.* used as a type; vitest exports these as named types)"$'\n'
        fi
    done
    [[ -z "$bad" ]] && { log "rr-cache: ${RR_COUNT:-?} cached resolutions, none defective"; return 0; }
    warn "DEFECTIVE CACHED RESOLUTIONS:"
    warn "$(indent "${bad%$'\n'}")"
    die "A postimage is replayed verbatim on every rebuild, so each of these reproduces a
broken file every run while the merge still reports clean. Fix the postimage itself -
editing the merged file afterwards fixes this run and no other."
}

import_rr_cache() {
    mkdir -p "$RR_LIVE"
    if [[ -d "$RR_REPO" ]]; then
        # -T copies the CONTENTS, so we never nest rr-cache/rr-cache.
        if ! cp -rT "$RR_REPO" "$RR_LIVE"; then
            warn "could not import the shared rerere cache; conflicts you already solved"
            warn "will have to be solved again this run."
        fi
        local n; n="$(find "$RR_LIVE" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
        log "rerere: imported shared cache ($n recorded resolutions)"
    fi
}

export_rr_cache() {
    [[ -d "$RR_LIVE" ]] || return 0
    mkdir -p "$RR_REPO"
    if ! cp -rT "$RR_LIVE" "$RR_REPO"; then
        warn "FAILED to export the rerere cache to .fork/rr-cache. Resolutions recorded"
        warn "this run are NOT saved and will have to be redone next time."
        return 1
    fi
    touch "$RR_REPO/.gitkeep"
    local n; n="$(find "$RR_REPO" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    log "rerere: exported cache back to .fork/rr-cache ($n resolutions)"
    if [[ -n "$(git status --porcelain -- .fork/rr-cache 2>/dev/null)" ]]; then
        warn "the rerere cache changed. Commit it to feat/fork-tooling so the next sync"
        warn "and every fresh clone replay these resolutions instead of re-deriving them:"
        warn "    git add .fork/rr-cache && git commit -m 'Record conflict resolutions from this sync'"
    fi
}

# ---------------------------------------------------------------- preflight

log "repository : $REPO_ROOT"
log "remote     : $REMOTE   upstream: $UPSTREAM"
log "mirror     : $MIRROR   integration: $INTEGRATION"
if (( DRY_RUN )); then warn "DRY RUN - nothing will be modified or pushed"; fi

PHASE=""; INDEX=0; BRANCH=""
(( CONTINUE )) || rm -f "$DROPS_FILE" "$STILL_DROPPED" "$ACCEPTED_USED"
# Whether we are still before the feature-rebase resume point. Kept separate from
# CONTINUE: clearing CONTINUE here would also disable the integration-merge resume
# below, silently turning every --continue into a full rebuild.
RESUME_REBASE=0
if (( CONTINUE )); then
    [[ -f "$STATE_FILE" ]] || die "--continue given but no sync is in progress ($STATE_FILE missing)"
    load_state
    PHASE="${ST_PHASE:-}"; INDEX="${ST_INDEX:-0}"; BRANCH="${ST_BRANCH:-}"
    # Restore the flags the interrupted run started with. Without this a bare --continue
    # would push a run that began as --no-push, or widen a --features subset.
    if [[ "${ST_NO_PUSH:-0}" == "1" ]] && (( ! NO_PUSH )); then
        NO_PUSH=1
        log "restoring --no-push from the interrupted run"
    fi
    if [[ -n "${ST_SUBSET:-}" && -z "$FEATURE_SUBSET" ]]; then
        FEATURE_SUBSET="${ST_SUBSET}"
        log "restoring --features=$FEATURE_SUBSET from the interrupted run"
    fi
    # If upstream moved since the run we are resuming, the branches we would skip were
    # rebased onto a mirror that no longer exists. Redo them rather than shipping a
    # half-stale rebuild.
    if [[ -n "${ST_MIRROR_SHA:-}" && "$ST_MIRROR_SHA" != "unknown" ]]; then
        current_mirror="$(git rev-parse "$MIRROR" 2>/dev/null || echo unknown)"
        if [[ "$current_mirror" != "$ST_MIRROR_SHA" ]]; then
            warn "$MIRROR moved since the interrupted run (${ST_MIRROR_SHA:0:10} -> ${current_mirror:0:10})."
            warn "Discarding the resume point and redoing every branch, so nothing is left"
            warn "rebased onto the old mirror."
            PHASE=""; INDEX=0
        fi
    fi
    RESUME_REBASE=1
    log "resuming from phase=${PHASE:-?} branch=${BRANCH:-?}"
    if in_progress_rebase; then
        die "the rebase is still in progress. Finish it first:
    git add <resolved files> && git rebase --continue
then re-run: .fork/sync-upstream.sh --continue"
    fi
    if [[ -e "$(op_path MERGE_HEAD)" ]]; then
        die "the merge is still in progress. Finish it first:
    git add <resolved files> && git commit --no-edit
then re-run: .fork/sync-upstream.sh --continue"
    fi
elif (( DETECT )); then
    log "detect: this working tree is never touched, so it need not be clean"
elif (( ! DRY_RUN )); then
    require_clean_tree
    clear_state
else
    # --dry-run promises to touch nothing. In particular it must NOT clear the state of a
    # sync that is paused waiting for --continue.
    if [[ -f "$STATE_FILE" ]]; then
        warn "a sync is paused awaiting --continue; this dry run leaves it alone"
    fi
fi

ORIGINAL_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$ORIGINAL_BRANCH" == "HEAD" ]] && die "detached HEAD. Check out a branch first."

if (( ! DRY_RUN )); then
    git config rerere.enabled true
    git config rerere.autoUpdate true
    import_rr_cache
    # Audit the cache before spending 93 merges on it. A defective postimage is replayed
    # verbatim into the tree, so finding out afterwards means every merge downstream of it
    # is built on a file we already know is wrong - and an earlier guard can exit first and
    # hide the reason entirely.
    RR_COUNT="$(find "$RR_REPO" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)"
    audit_rr_cache
fi

if (( DETECT )); then
    log "fetching $REMOTE first, so the manifests are checked against what it holds now"
    git fetch "$REMOTE" --prune
fi
mapfile -t FEATURES < <(read_list "$FEATURES_FILE")
mapfile -t CONTRIBS < <(read_list "$CONTRIB_FILE")

# Refuse to rebuild from a subset. A branch listed in a manifest but absent locally used
# to warn and carry on, which produces an integration branch missing that branch's work
# entirely - and it can still pass every gate and be pushed, because nothing downstream
# knows the branch was meant to be there. On a runner this is one failed fetch away.
if [[ -s "$MISSING_REFS" ]]; then
    warn "MANIFEST REFS WITH NO LOCAL BRANCH:"
    warn "$(indent "$(sort -u "$MISSING_REFS")")"
    die "refusing to rebuild $INTEGRATION without them. Building from a subset silently
drops that branch's work and still passes the gates. Fetch the missing refs (a runner
needs them materialised as local branches), or take the branch out of its manifest if it
is genuinely gone."
fi
log "manifests: ${#FEATURES[@]} feature + ${#CONTRIBS[@]} contrib branch(es), all present"
# Validate the manifests before acting on them. A pr/* branch that ends up in features.txt
# would be rebased and force-pushed, which destroys an open pull request -- so that is a
# hard error, not a warning.
validate_manifests() {
    local b other seen_dupe=0
    local -A seen=()
    for b in "${FEATURES[@]}"; do
        case "$b" in
            pr/*) die "'$b' is in .fork/features.txt, but pr/* branches back open upstream
pull requests and must never be rebased or force-pushed. Move it to .fork/contrib.txt." ;;
        esac
        [[ "$b" == "$MIRROR" ]] && die "'$b' is the mirror branch; it cannot also be a feature."
        [[ "$b" == "$INTEGRATION" ]] && die "'$b' is the integration branch; it cannot also be a feature."
        [[ -n "${seen[$b]:-}" ]] && { warn "duplicate in features.txt: $b"; seen_dupe=1; }
        seen[$b]=1
    done
    for b in "${CONTRIBS[@]}"; do
        [[ "$b" == "$MIRROR" ]] && die "'$b' is the mirror branch; it cannot also be a contribution branch."
        [[ "$b" == "$INTEGRATION" ]] && die "'$b' is the integration branch; it cannot also be a contribution branch."
        for other in "${FEATURES[@]}"; do
            [[ "$b" == "$other" ]] && die "'$b' is listed in BOTH features.txt and contrib.txt.
It would be rebased and force-pushed as a feature. Pick one list."
        done
    done
    (( seen_dupe )) && warn "duplicates are merged twice; the second merge is a no-op but wastes time"
    return 0
}
validate_manifests

log "features (rebased): ${#FEATURES[@]}   contrib (merged as-is): ${#CONTRIBS[@]}"
if (( ${#FEATURES[@]} + ${#CONTRIBS[@]} == 0 )); then
    die "nothing to do: both .fork/features.txt and .fork/contrib.txt are empty"
fi

# ---------------------------------------------------------------- 1. fetch

log "fetching $UPSTREAM and $REMOTE"
run git fetch "$UPSTREAM" --prune --tags
run git fetch "$REMOTE" --prune

if (( DRY_RUN )); then
    behind="$(git rev-list --count "$MIRROR..$UPSTREAM/develop" 2>/dev/null || echo '?')"
    ahead="$(git rev-list --count "$UPSTREAM/develop..$MIRROR" 2>/dev/null || echo '?')"
    log "$MIRROR is $behind behind / $ahead ahead of $UPSTREAM/develop"
    if [[ "$ahead" != "0" ]]; then
        warn "$MIRROR carries $ahead commit(s) upstream does not have - it is NOT a pristine mirror."
        warn "A real run would abort. Offending commits:"
        git log --oneline --no-merges "$UPSTREAM/develop..$MIRROR" | sed 's/^/    /' >&2
    fi
    for b in "${FEATURES[@]}"; do
        in_subset "$b" || continue
        n="$(git rev-list --count "$UPSTREAM/develop..$b" 2>/dev/null || echo '?')"
        log "  would rebase $b ($n commit(s)) onto $MIRROR"
    done
    for b in "${CONTRIBS[@]}"; do
        n="$(git rev-list --count "$UPSTREAM/develop..$b" 2>/dev/null || echo '?')"
        log "  would merge  $b ($n commit(s)) into $INTEGRATION"
    done
    shopt -s nullglob
    patches=("$PATCH_DIR"/*.patch)
    shopt -u nullglob
    log "  would apply ${#patches[@]} integration patch(es)"
    ok "dry run complete - nothing was changed"
    exit 0
fi

if (( DETECT )); then
    DETECT_BASE="$(git rev-parse "$UPSTREAM/develop")"
    DETECT_WT="${REPO_ROOT}-detect"
    RR_BEFORE="$(find "$RR_LIVE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)"
    detect_cleanup() {
        local d
        cd "$REPO_ROOT" || return 0
        if git worktree list --porcelain | grep -qxF "worktree $DETECT_WT"; then
            git worktree remove --force "$DETECT_WT" || warn "could not remove $DETECT_WT; remove it by hand"
        fi
        git worktree prune
        while IFS= read -r d; do
            [[ -n "$d" ]] || continue
            printf '%s\n' "$RR_BEFORE" | grep -qxF -- "$d" || rm -rf -- "$d"
        done <<< "$(find "$RR_LIVE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort)"
        rm -rf -- "$SCRATCH"
    }
    trap 'detect_cleanup; [[ -n "${FORK_SYNC_TMP:-}" ]] && rm -f "$FORK_SYNC_TMP"' EXIT

    if [[ -e "$DETECT_WT" ]]; then
        git worktree remove --force "$DETECT_WT" 2>/dev/null \
            || die "$DETECT_WT exists and is not a worktree of this repository. Remove it, then re-run."
    fi
    git worktree prune
    log "detect: base $UPSTREAM/develop = ${DETECT_BASE:0:10}"
    log "detect: building in a throwaway worktree at $DETECT_WT"
    git worktree add --quiet --detach "$DETECT_WT" "$DETECT_BASE"
    cd "$DETECT_WT"

    FOUND=()
    FIRST_STOP=0
    record() {
        local name="$1" code="$2" files="${3:-}" f
        if (( FIRST_STOP == 0 )); then FIRST_STOP="$code"; fi
        if [[ -z "$files" ]]; then
            FOUND+=("$name"$'\t')
            return 0
        fi
        while IFS= read -r f; do
            [[ -n "$f" ]] && FOUND+=("$name"$'\t'"$f")
        done <<< "$files"
        return 0
    }

    REBASED_TIPS=()
    for branch in "${FEATURES[@]}"; do
        ref="$REMOTE/$branch"
        n="$(git rev-list --count "$DETECT_BASE..$ref")"
        if [[ "$n" == "0" ]]; then
            log "  $branch - already contained in $UPSTREAM/develop, nothing to rebase"
            continue
        fi
        log "  rebasing feature $branch ($n commit(s)) onto $UPSTREAM/develop"
        git checkout --quiet --detach "$ref"
        if git rebase --quiet "$DETECT_BASE"; then
            REBASED_TIPS+=("$branch"$'\t'"$(git rev-parse HEAD)")
        else
            files="$(conflicting_files)"
            warn "  REBASE CONFLICT in $branch"
            [[ -n "$files" ]] && warn "$(indent "$files")"
            record "$branch" 2 "$files"
            git rebase --abort
        fi
    done

    git checkout --quiet --detach "$DETECT_BASE"
    detect_merge() {
        local branch="$1" ref="$2" n files
        n="$(git rev-list --count "HEAD..$ref")"
        if [[ "$n" == "0" ]]; then
            log "  $branch - already contained, nothing to merge"
            return 0
        fi
        log "  merging $branch ($n commit(s))"
        if try_merge "$ref"; then return 0; fi
        files="$(conflicting_files)"
        warn "  MERGE CONFLICT in $branch"
        [[ -n "$files" ]] && warn "$(indent "$files")"
        record "$branch" 3 "$files"
        git merge --abort || git reset --quiet --hard
        [[ -z "$(git status --porcelain)" ]] \
            || die "the throwaway worktree is dirty after aborting the merge of $branch; every verdict after it would be built on that"
    }
    for entry in "${REBASED_TIPS[@]}"; do
        detect_merge "${entry%%$'\t'*}" "${entry#*$'\t'}"
    done
    for branch in "${CONTRIBS[@]}"; do
        detect_merge "$branch" "$REMOTE/$branch"
    done

    shopt -s nullglob
    PATCHES=("$PATCH_DIR"/*.patch)
    shopt -u nullglob
    for p in "${PATCHES[@]}"; do
        if apply_patch "$p"; then continue; fi
        files="$(git apply --check "$p" 2>&1 | sed -n -e 's/^error: patch failed: \(.*\):[0-9][0-9]*$/\1/p' \
                                                      -e 's/^error: \(.*\): patch does not apply$/\1/p' | LC_ALL=C sort -u || true)"
        warn "  PATCH WOULD NOT APPLY: $(basename "$p")"
        [[ -n "$files" ]] && warn "$(indent "$files")"
        record "integration-patches/$(basename "$p")" 4 "$files"
        git reset --quiet --hard
    done

    cd "$REPO_ROOT"
    if (( ${#FOUND[@]} )); then
        printf '%s\n' "${FOUND[@]}" | LC_ALL=C sort -u > "$DETECT_REPORT"
    else
        : > "$DETECT_REPORT"
    fi
    log "detect: report written to $DETECT_REPORT"
    if (( FIRST_STOP == 0 )); then
        ok "detect: clean - every branch and every patch would apply"
        exit 0
    fi
    warn "detect: $(cut -f1 "$DETECT_REPORT" | LC_ALL=C sort -u | wc -l | tr -d ' ') branch(es)/patch(es) would stop the publish run (exit $FIRST_STOP)"
    exit "$FIRST_STOP"
fi

# ------------------------------------------------- 2. fast-forward the mirror

log "fast-forwarding $MIRROR to $UPSTREAM/develop"

# `git merge --ff-only` exits 0 with "Already up to date" when the mirror is AHEAD of
# upstream, so it alone cannot detect a polluted mirror. Check the ahead-count directly.
assert_pristine() {
    local when="$1" ahead
    ahead="$(git rev-list --count "$UPSTREAM/develop..$MIRROR")"
    [[ "$ahead" == "0" ]] && return 0
    echo >&2
    die "$MIRROR carries $ahead commit(s) that $UPSTREAM/develop does not have ($when).

It is a PRISTINE MIRROR and must never carry fork commits. Offending commits:

$(git log --oneline --no-merges "$UPSTREAM/develop..$MIRROR" | head -40 | sed 's/^/    /')

Move each of them to a feat/* branch, then reset the mirror:

    git branch feat/<slug> $MIRROR          # if they belong to a new feature
    git branch -f $MIRROR $UPSTREAM/develop
    git push --force-with-lease $REMOTE $MIRROR

Never 'git merge $UPSTREAM/develop' by hand - that is what caused this."
}
assert_pristine "before fast-forwarding"

# Deliberately done without checking the mirror out. The rerere cache is committed under
# .fork/rr-cache and rerere rewrites it live during the run, so the working tree is
# routinely dirty there by design - and `git checkout <branch>` refuses to switch when it
# is. Advancing the ref directly keeps the run working from any starting branch.
ff_mirror() {
    git merge-base --is-ancestor "$MIRROR" "$UPSTREAM/develop" || return 1
    if [[ "$(git symbolic-ref --quiet --short HEAD || true)" == "$MIRROR" ]]; then
        git merge --ff-only "$UPSTREAM/develop"
        return
    fi
    git update-ref "refs/heads/$MIRROR" "$(git rev-parse "$UPSTREAM/develop")"
}

if ! ff_mirror; then
    echo >&2
    die "$MIRROR could not fast-forward to $UPSTREAM/develop.

That means someone committed to $MIRROR. It is a PRISTINE MIRROR and must never
carry fork commits. The offending commits are:

$(git log --oneline --no-merges "$UPSTREAM/develop..$MIRROR" | sed 's/^/    /')

Move each of them to a feat/* branch, then reset the mirror:

    git branch feat/<slug> $MIRROR          # if they belong to a new feature
    git checkout $MIRROR
    git reset --hard $UPSTREAM/develop
    git push --force-with-lease $REMOTE $MIRROR

Never 'git merge $UPSTREAM/develop' by hand - that is what caused this."
fi
assert_pristine "after fast-forwarding"
ok "$MIRROR = $(git rev-parse --short "$MIRROR") ($UPSTREAM/develop)"

# ------------------------------------------------- 3. rebase feature branches

REBASED=()
for i in "${!FEATURES[@]}"; do
    branch="${FEATURES[$i]}"
    in_subset "$branch" || { log "skipping $branch (not in --features)"; continue; }
    if (( RESUME_REBASE )) && [[ "${PHASE:-}" == "rebase" ]] && (( i < ${INDEX:-0} )); then
        REBASED+=("$branch"); continue
    fi
    n="$(git rev-list --count "$MIRROR..$branch")"
    if [[ "$n" == "0" ]]; then
        warn "$branch has no commits of its own - already contained in $MIRROR. Skipping."
        continue
    fi
    restore_rr_worktree
    log "rebasing $branch ($n commit(s)) onto $MIRROR"
    save_state rebase "$i" "$branch"
    if ! git rebase "$MIRROR" "$branch"; then
        files="$(conflicting_files)"
        export_rr_cache
        echo >&2
        printf '%s================ REBASE CONFLICT ================%s\n' "$RED" "$RST" >&2
        printf 'branch : %s\n' "$branch" >&2
        printf 'onto   : %s (%s)\n' "$MIRROR" "$(git rev-parse --short "$MIRROR")" >&2
        printf 'files  :\n%s\n' "$(indent "$files")" >&2
        cat >&2 <<EOF

Resolve it INSIDE this rebase - the context is small and focused. Keep upstream's
version of upstream logic and re-apply the fork's intent on top. Never resolve with
-X ours or -X theirs.

    \$EDITOR $(echo "$files" | tr '\n' ' ')
    git add $(echo "$files" | tr '\n' ' ')
    git rebase --continue
    .fork/sync-upstream.sh --continue

To give up on this run entirely:

    git rebase --abort && rm -f $STATE_FILE
EOF
        exit 2
    fi
    REBASED+=("$branch")
    RESUME_REBASE=0
done
ok "rebased ${#REBASED[@]} feature branch(es)"

# ------------------------------------------- 4. rebuild the integration branch

restore_rr_worktree
# What the remote holds right now, read before the rebuild overwrites the local ref.
# Section 6b grafts the rebuild onto this so the push fast-forwards instead of forcing.
# The remote-tracking ref is the one that matters - it is what the push has to descend
# from - and it is current: section 1 fetched "$REMOTE" --prune before any branch was
# touched, which is why nothing here fetches again.
PREV_INTEGRATION="$(git rev-parse --verify --quiet "refs/remotes/$REMOTE/$INTEGRATION" \
                    || git rev-parse --verify --quiet "refs/heads/$INTEGRATION" || true)"
RESUME_MERGE_KIND=""
RESUME_MERGE_INDEX=0
if (( CONTINUE )) && [[ "${PHASE:-}" == merge-* ]]; then
    # The user resolved an integration merge by hand and committed it. Recreating the
    # branch here would discard that work, so pick up where we stopped instead.
    RESUME_MERGE_KIND="${PHASE#merge-}"
    RESUME_MERGE_INDEX="${INDEX:-0}"
    git checkout --quiet "$INTEGRATION"
    log "resuming $INTEGRATION at $RESUME_MERGE_KIND #$RESUME_MERGE_INDEX (not rebuilding)"
else
    log "rebuilding $INTEGRATION from $MIRROR"
    git checkout --quiet -B "$INTEGRATION" "$MIRROR"
fi

merge_one() {
    local branch="$1" kind="$2" idx="$3"
    local n; n="$(git rev-list --count "HEAD..$branch" 2>/dev/null || echo 0)"
    if [[ "$n" == "0" ]]; then
        log "  $branch - already contained, nothing to merge"
        return 0
    fi
    log "  merging $kind $branch ($n commit(s))"
    save_state "merge-$kind" "$idx" "$branch"
    local mbase mpre
    mpre="$(git rev-parse HEAD)"
    mbase="$(git merge-base HEAD "$branch")"
    if ! try_merge "$branch"; then
        local files; files="$(conflicting_files)"
        export_rr_cache
        echo >&2
        printf '%s============== INTEGRATION MERGE CONFLICT ==============%s\n' "$RED" "$RST" >&2
        printf 'branch : %s  (%s)\n' "$branch" "$kind" >&2
        printf 'files  :\n%s\n' "$(indent "$files")" >&2
        if [[ "$kind" == contrib ]]; then
            cat >&2 <<'NOTE'

This is an upstream contribution branch. DO NOT rebase or amend it - it is the head
of an open pull request. Resolve here, in the integration merge only.
NOTE
        fi
        cat >&2 <<EOF

    \$EDITOR $(echo "$files" | tr '\n' ' ')
    git add $(echo "$files" | tr '\n' ' ')
    git commit --no-edit
    .fork/sync-upstream.sh --continue

rerere will record this resolution, so the next rebuild replays it automatically.
To give up on this run entirely:

    git merge --abort && rm -f $STATE_FILE
EOF
        exit 3
    fi
    assert_branch_landed "$branch" "$mbase" "$mpre"
    return 0
}

# When resuming, everything before the interrupted merge is already committed on the
# integration branch. merge_one is a no-op for those anyway (0 commits to merge), but
# skipping is explicit and avoids re-walking ~100 branches.
skip_done() {
    local kind="$1" idx="$2"
    [[ -z "$RESUME_MERGE_KIND" ]] && return 1
    if [[ "$kind" == "$RESUME_MERGE_KIND" ]]; then (( idx < RESUME_MERGE_INDEX )); return; fi
    # contrib runs after feature: if we died in contrib, every feature merge is done.
    [[ "$kind" == feature && "$RESUME_MERGE_KIND" == contrib ]]
}

for i in "${!REBASED[@]}"; do
    skip_done feature "$i" && continue
    merge_one "${REBASED[$i]}" feature "$i"
done
# ------------------------------------ contribution branches must match their remote
# Element's own maintainers push directly to these branches, because each one is the head
# of an open pull request against element-hq. Merging a local ref that has fallen behind
# its remote bakes the wrong revision of somebody else's review into the rebuild, and the
# fork holds no copy of what it missed - it is the one loss here that is unrecoverable
# from our side. So compare before merging, and leave a drifted branch out rather than
# merge it stale.
#
# No fetch here on purpose: section 1 already ran `git fetch "$REMOTE" --prune`, before
# the mirror moved and before any branch was rebased, so these remote-tracking refs are
# the freshest this run will ever have.
#
# Direction is the whole point. BEHIND means a maintainer pushed work we do not have and
# the fix is to take theirs; AHEAD means local commits nobody has published and the fix is
# to publish or discard them. "They differ" alone tells a human nothing.
check_contrib_current() {
    # Two statements, not one: `local a=$1 b=$a` expands every argument before any of the
    # assignments happen, so b would be built from whatever $a meant in the CALLER. Here
    # that was the global `branch` the section 3 rebase loop leaves behind, which made
    # every contribution branch get compared against the last feature branch instead.
    local branch="$1"
    local rref="refs/remotes/$REMOTE/$branch" counts ahead behind
    if ! git show-ref --verify --quiet "$rref"; then
        warn "  $branch: no $REMOTE counterpart to compare against; merging the local ref"
        return 0
    fi
    [[ "$(git rev-parse "$branch")" == "$(git rev-parse "$rref")" ]] && return 0
    counts="$(git rev-list --left-right --count "$branch...$rref")"
    ahead="${counts%%[[:space:]]*}"
    behind="${counts##*[[:space:]]}"
    warn "  SKIPPING $branch: it has diverged from $REMOTE/$branch"
    warn "      $ahead commit(s) only here, $behind commit(s) only on $REMOTE"
    if (( behind > 0 && ahead == 0 )); then
        warn "      Someone pushed to the pull request. Take their work:"
        warn "          git fetch $REMOTE --prune && git branch -f $branch $REMOTE/$branch"
    elif (( ahead > 0 && behind == 0 )); then
        warn "      Local commits that were never published. This script never pushes a"
        warn "      pr/* branch, so publish them yourself or drop them:"
        warn "          git push $REMOTE $branch                 # if they belong on the PR"
        warn "          git branch -f $branch $REMOTE/$branch    # if they are local cruft"
    else
        warn "      Both sides moved. Reconcile by hand, with a new commit on top -"
        warn "      never rebase or amend a pr/* head; it is an open PR."
    fi
    printf '%s\t%s\t%s\n' "$branch" "$ahead" "$behind" >> "$SKIPPED_CONTRIBS"
    return 1
}

: > "$SKIPPED_CONTRIBS"
log "checking ${#CONTRIBS[@]} contribution branch(es) against $REMOTE"
for b in "${CONTRIBS[@]}"; do
    check_contrib_current "$b" || true
done
if [[ -s "$SKIPPED_CONTRIBS" ]]; then
    warn "$(wc -l < "$SKIPPED_CONTRIBS" | tr -d ' ') contribution branch(es) will be left out of this rebuild"
    warn "The rebuild continues without them so the rest of the run still reports, but"
    warn "nothing will be pushed - see the end of the run."
else
    log "contribution branches: all ${#CONTRIBS[@]} match $REMOTE"
fi

for i in "${!CONTRIBS[@]}"; do
    skip_done contrib "$i" && continue
    cut -f1 "$SKIPPED_CONTRIBS" | grep -qxF -- "${CONTRIBS[$i]}" && continue
    merge_one "${CONTRIBS[$i]}" contrib "$i"
done
ok "$INTEGRATION rebuilt: $(git rev-parse --short HEAD)"

# ------------------------------------------------- 5. integration patches

shopt -s nullglob
PATCHES=("$PATCH_DIR"/*.patch)
shopt -u nullglob
if (( ${#PATCHES[@]} )); then
    log "applying ${#PATCHES[@]} integration patch(es)"
    for p in "${PATCHES[@]}"; do
        if ! apply_patch "$p"; then
            export_rr_cache
            printf '%s[fork-sync]%s %sERROR:%s %s\n' "$BLD" "$RST" "$RED" "$RST" \
                "integration patch failed to apply: $p" >&2
            cat >&2 <<EOF

It no longer matches the tree - upstream probably rewrote the code it patches.
Regenerate it from the current tree, or delete it if it is obsolete:

    git apply --3way --reject $p     # inspect the .rej files
    # fix up, then:
    git diff > $p
EOF
            exit 4
        fi
    done
    ok "integration patches applied"
else
    log "no integration patches to apply"
fi

export_rr_cache

# ------------------------------------------- 5a. conflict-marker guard

# `git add` will happily stage a file that still contains conflict markers, and `git
# commit` will happily record it. A half-resolved file then rides into the build looking
# like a normal commit. Refuse to go any further if one is present.
assert_no_conflict_markers() {
    local hits
    # Only <<<<<<< and >>>>>>> are reliable: a bare ======= line is also how people
    # underline a heading in a doc comment (upstream's ScalarMessaging.ts does exactly
    # that), so matching it alone produces false positives.
    hits="$(git grep -l -E '^(<{7}|>{7}) ' -- ':(exclude).fork/rr-cache' 2>/dev/null || true)"
    [[ -z "$hits" ]] && { log "conflict markers: none"; return 0; }
    warn "CONFLICT MARKERS are committed in:"
    warn "$(indent "$hits")"
    die "refusing to continue. A merge was concluded while a file was still unresolved.
Fix each file, then:
    git add <files> && git commit --amend --no-edit
and re-run. Nothing has been pushed."
}
assert_no_conflict_markers

# ------------------------------------------- 5c. dead-test-name guard

# A branch that adds a test at the old apps/web/test layout gets pulled into apps/web/src by
# git's directory-rename detection, which moves the file but keeps its name. The vitest
# project collects src/**/*.test.{ts,tsx}, so an X-test.ts lands in the right directory under
# a name nothing runs: present in the tree, counted by every ancestry check, never executed.
DEAD_TESTS="$(git ls-files -- 'apps/web/src/**-test.ts' 'apps/web/src/**-test.tsx' 2>/dev/null || true)"
if [[ -n "$DEAD_TESTS" ]]; then
    echo >&2
    printf '%s============== TEST FILES NOTHING WILL RUN ==============%s\n' "$RED" "$RST" >&2
    printf '%s' "$(indent "$DEAD_TESTS")" >&2
    cat >&2 <<'EOF'

These sit under apps/web/src but keep the old -test suffix, and
apps/web/vitest.config.ts only collects src/**/*.test.{ts,tsx}. Rename each to
X.test.ts and fix up the relative imports it carried over from the old layout,
then add the result to .fork/integration-patches/ so the next rebuild keeps it.
EOF
    exit 4
fi

# ------------------------------------------- 5b. dropped-content report

if [[ -s "$DROPS_FILE" ]]; then
    # Re-check against the finished tree. A drop the integration patches have since
    # repaired is not a drop in what we ship, and failing on it would mean the only way
    # to get a green run is to stop repairing things.
    log "re-checking $(sort -u "$DROPS_FILE" | wc -l) dropped-content branch(es) against the final tree"
    RECHECK=1
    DROPS_SINK="$STILL_DROPPED"
    rm -f "$STILL_DROPPED"
    while IFS=$'\t' read -r b base pre; do
        [[ -n "$b" ]] || continue
        assert_branch_landed "$b" "$base" "$pre"
    done <<< "$(sort -u "$DROPS_FILE")"
    RECHECK=0
    DROPS_SINK="$DROPS_FILE"
    if [[ ! -s "$STILL_DROPPED" ]]; then
        ok "every dropped-content branch was restored by the integration patches"
    fi
fi

if [[ -s "$STILL_DROPPED" ]]; then
    export_rr_cache
    echo >&2
    printf '%s============== MERGES THAT DROPPED BRANCH CONTENT ==============%s\n' "$RED" "$RST" >&2
    # Name the files that are still missing from the finished tree, rather than the
    # merge-time list, which includes everything the patches have already put back.
    DROPS_SINK=/dev/null
    while IFS=$'\t' read -r b base pre; do
        [[ -n "$b" ]] || continue
        printf '  %s\n' "$b" >&2
        assert_branch_landed "$b" "$base" "$pre"
    done <<< "$(sort -u "$STILL_DROPPED")"
    cat >&2 <<'EOF'

Each branch above merged cleanly, but for at least one file the result is exactly
what our side already had - so the branch contributed nothing there. The per-branch
LOST lines earlier in this log name the files.

This is almost always a conflict resolved to upstream's side by mistake, and it is
invisible to every ancestry check: the branch IS merged, only its content is gone.

Redo the affected merge keeping both sides. If a drop is deliberate because upstream
superseded the branch's approach, list the path in .fork/accept-upstream-deletions.txt
or drop the branch from its manifest, and re-run.
EOF
    exit 4
fi

# ------------------------------------------- 5b. snapshot sanity

# A merged .snap can end up defining the same exports[...] key twice. Jest evaluates the
# file as a JS module, so the last assignment silently wins: a stale block shadows the
# correct one, and neither git status nor a green test count shows it.
check_duplicate_snapshot_keys() {
    local f dupes found=0
    while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        dupes="$(grep -o '^exports\[[^]]*\]' "$f" | sort | uniq -d)"
        if [[ -n "$dupes" ]]; then
            found=1
            warn "duplicate snapshot keys in $f:"
            warn "$(indent "$dupes")"
        fi
    done < <(git ls-files '*.snap')
    if (( found )); then
        warn "Regenerate those files rather than hand-editing them; the last duplicate wins"
        warn "silently, so a passing suite does not mean the snapshot is right."
        return 1
    fi
    return 0
}
if check_duplicate_snapshot_keys; then
    log "snapshot keys: no duplicates"
fi

# ------------------------------------------- 5a2. jest-idiom sweep

# Upstream moved these suites to vitest by relocating them, so any branch that predates
# the move still writes jest. Wherever such a branch merges, the jest call arrives with
# it and the file only fails on the runner. This used to be two hand-written patches,
# which had to be regenerated every time a merge produced slightly different context and
# conflicted the moment a cached resolution improved. A sweep does not care about context.
#
# Scope is deliberately narrow: files the runner actually collects, that already import
# vitest. A suite that has not migrated keeps jest, which is correct there.
# Add one named export to the file's vitest import unless it is already there. The
# import block may span lines with a trailing comma, so the check and the insertion are
# both done on the whole file, and a trailing comma gets its own line rather than ",, x".
add_vitest_import() {
    local f="$1" name="$2"
    NAME="$name" perl -0777 -i -pe '
        my $n = $ENV{NAME};
        next if /import \{[^}]*\b\Q$n\E\b[^}]*\} from "vitest";/;
        s/(import \{[^}]*?)(,?)(\s*\} from "vitest";)/ $2 ? "$1,\n    $n,$3" : "$1, $n$3" /e;
    ' "$f"
}

sweep_jest_idioms() {
    local f swept=0 files
    # ** requires an intervening directory, so the bare apps/web/src/*.test.ts files
    # need their own pattern; without it 37 collected suites were invisible here.
    files="$(git ls-files -- ':(glob)apps/web/src/**/*.test.ts' ':(glob)apps/web/src/**/*.test.tsx' \
                            'apps/web/src/*.test.ts' 'apps/web/src/*.test.tsx' || true)"
    [[ -n "$files" ]] || return 0
    while IFS= read -r f; do
        [[ -n "$f" && -f "$f" ]] || continue
        grep -q 'from "vitest"' "$f" || continue
        if grep -qE '(^|[^-[:alnum:]])jest([^-[:alnum:]]|$)' "$f"; then
            perl -0777 -i -pe '
                # the type first, so the call rewrite below cannot turn it into vi.SpyInstance,
                # which vitest does not export.
                s/\bjest\.SpyInstance\b/MockInstance/g;
                # `jest` and `.spyOn(...)` are written on separate lines often enough that a
                # jest\. pattern misses them entirely.
                s/\bjest\b(?=\s*\n\s*\.)/vi/g;
                s/\bjest\./vi./g;
            ' "$f"
        fi
        if grep -q '\bMockInstance\b' "$f"; then
            add_vitest_import "$f" "type MockInstance"
        fi
        # The rewrite above turns `jest.spyOn` into `vi.spyOn`, but `vi` is a named export
        # the file never needed before. Without this the suite runs and tsc fails on
        # `Cannot find name 'vi'` - the one gate that reads the file as code.
        if grep -qE '\bvi\b' "$f"; then
            add_vitest_import "$f" "vi"
        fi
        # grep matching is not the same as the rewrite changing anything: a bare
        # "@types/jest" in an import matches the word and has nothing to convert. Count
        # and stage only what actually moved, or the commit below runs on an empty index.
        if git diff --quiet -- "$f"; then continue; fi
        git add -- "$f" || die "could not stage $f"
        swept=$((swept + 1))
    done <<< "$files"
    if (( swept == 0 )) || git diff --cached --quiet; then
        log "jest sweep: nothing left to convert"
        return 0
    fi
    log "jest sweep: converted $swept file(s) the merges brought in with jest idioms"
    git commit --quiet -m "Convert the merged-in jest idioms to vitest" \
        -m "Branches predating upstream's move to vitest still write jest, and the call
arrives wherever they merge. Converted for the suites the runner collects; the
unmigrated ones keep jest, which is correct there."
}
sweep_jest_idioms


# ------------------------------------------- 5c. stale-exemption report

# An allowlist is a category people agree to stop looking at, which is exactly where a
# real problem survives longest. Three separate defects this fork hit were hiding in one:
# an uncollected test directory, files dropped by a dead worker, and a stylesheet sitting
# among documentation everyone had agreed was noise. So the exemptions justify themselves
# every run rather than accumulate quietly.
if [[ -f "$DELETIONS_FILE" ]]; then
    STALE=""
    while IFS= read -r entry; do
        entry="${entry%%#*}"; entry="${entry//[[:space:]]/}"
        [[ -n "$entry" ]] || continue
        if [[ ! -f "$ACCEPTED_USED" ]] || ! grep -qxF -- "$entry" "$ACCEPTED_USED"; then
            STALE+="$entry"$'\n'
        fi
    done < "$DELETIONS_FILE"
    if [[ -n "$STALE" ]]; then
        warn "allowlist entries that silenced nothing this run:"
        warn "$(indent "${STALE%$'\n'}")"
        warn "Each is either obsolete, or covers a path no branch touches any more. Delete"
        warn "what no longer earns its place: an exemption nobody exercises still blinds"
        warn "the guard to a genuine drop on that path."
    else
        log "allowlist: every entry earned its place this run"
    fi
fi

# ------------------------------------------------- 6. verification gates

GATES_PASSED=1
TOLERATED=""

# A gate that fails only inside node_modules is failing on somebody else's code. The
# js-sdk is floated on purpose, so a bad commit upstream would otherwise wedge every
# unattended run until a human pinned it - which is the one thing the float exists to
# avoid. Tolerate that narrow case, and say so loudly enough that it cannot pass for a
# pass. Anything with a single error outside node_modules still blocks the push.
errors_are_all_vendored() {
    local out="$1" lines
    # A formatting failure is always one of our own files; a dependency cannot cause one.
    # Bail before looking at type errors so a real fmt failure is never tolerated because
    # the type errors alongside it happened to be vendored.
    grep -q 'Format issues found' "$out" && return 1
    # tsc colourises, so strip escapes first or every line reads as clean. Match on the
    # error code rather than a path shape: nx prints `file:line:col - error TS…` and bare
    # tsc prints `file(line,col): error TS…`, and only one of those was handled before.
    lines="$(sed -r 's/\x1B\[[0-9;]*[mK]//g' "$out" | grep -E 'error TS[0-9]+' || true)"
    [[ -n "$lines" ]] || return 1
    ! printf '%s\n' "$lines" | grep -qv 'node_modules'
}

gate() {
    local name="$1"; shift
    local out; out="$(mktemp)"
    log "gate: $name"
    if "$@" 2>&1 | tee "$out"; then
        ok "  PASS  $name"
    elif errors_are_all_vendored "$out"; then
        local n; n="$(sed -r 's/\x1B\[[0-9;]*[mK]//g' "$out" | grep -cE 'error TS[0-9]+')"
        warn "  TOLERATED  $name: $n error(s), every one inside node_modules"
        sed -r 's/\x1B\[[0-9;]*[mK]//g' "$out" | grep -E 'error TS[0-9]+' | head -10 | while IFS= read -r l; do
            warn "      $l"
        done
        warn "      Not fork code. Push allowed. Re-check when the dependency moves."
        TOLERATED+="$name "
    else
        warn "  FAIL  $name"
        GATES_PASSED=0
    fi
    rm -f "$out"
}
if (( SNAPSHOTS_STALE )); then
    warn "snapshots were conflicted and resolved to our side. If the test gate fails on a"
    warn "snapshot, regenerate rather than hand-editing:  pnpm -C apps/web test -- -u"
fi
if (( LOCKFILE_NEEDS_REGEN )); then
    log "pnpm-lock.yaml conflicted during this rebuild; pnpm install will rewrite it"
fi
# The lockfile is the one file a rebuild reliably invalidates: merging ninety-odd
# branches can change dependencies or, as here, the patchedDependencies set, and a frozen
# install then refuses on a config mismatch. Shipping a pre-generated lockfile in a patch
# only moves the problem - it goes stale the next time the workspace moves. Let pnpm write
# it, which is the only supported way, and commit what it wrote.
gate_install() {
    log "gate: pnpm install"
    if pnpm install --frozen-lockfile; then
        ok "  PASS  pnpm install"
        return
    fi
    warn "  frozen install refused the lockfile; letting pnpm rewrite it"
    if ! pnpm install --no-frozen-lockfile; then
        warn "  FAIL  pnpm install"
        GATES_PASSED=0
        return
    fi
    # Rewriting the lockfile can move a dependency that ships a binary rather than just
    # JavaScript. Relinking does not re-run its install script, so the package resolves
    # while the binary it needs is the previous version's or absent - which surfaces much
    # later as a test failing to collect, nowhere near the install that caused it.
    if ! pnpm rebuild electron 2>/dev/null; then
        warn "  could not rebuild electron; the desktop suites may not find its binary"
    fi
    if ! git diff --quiet -- pnpm-lock.yaml; then
        git add -- pnpm-lock.yaml
        git commit --quiet -m "Regenerate the lockfile for the rebuilt workspace" \
            -m "The rebuild changed what the workspace declares, so the committed lockfile no
longer matched and a frozen install refused it. Written by pnpm, never by hand."
        log "  lockfile regenerated and committed"
    fi
    ok "  PASS  pnpm install"
}
gate_install
# Run the lint steps individually rather than through `pnpm lint`. That script is a
# single && chain with lint:types first, so while the floated js-sdk carries type errors
# the chain exits there and the other five steps never execute - and the node_modules
# tolerance would then wave the whole thing through. Tolerating a dependency's type
# errors must not also mean skipping every check that would catch ours.
gate "lint:types"     pnpm -r --workspace-concurrency=1 lint:types
gate "lint:fmt"       pnpm lint:fmt
gate "lint:js"        pnpm lint:js
gate "lint:style"     pnpm -r lint:style
gate "lint:workflows" pnpm lint:workflows
gate "lint:knip"      pnpm lint:knip
gate "pnpm test:unit" pnpm test:unit

# There are two runners. vitest collects apps/web/src/**/*.test.*; jest collects
# apps/web/test/**/*-test.* - 191 files, including seventeen fork regression suites
# attached to pr/* branches. The root test:unit script runs vitest only, so none of that
# has ever been able to block a sync. Upstream gates it in its own job; we did not.
KNOWN_JEST_FAILURES="$REPO_ROOT/.fork/known-jest-failures.txt"
gate_jest() {
    local out json failed unknown
    log "gate: jest (apps/web)"
    out="$(mktemp)"; json="$(mktemp)"
    if ( cd "$REPO_ROOT/apps/web" && TZ=UTC NODE_OPTIONS=--max_old_space_size=8192 \
            pnpm exec jest --ci --maxWorkers=50% --json --outputFile="$json" ) >"$out" 2>&1; then
        ok "  PASS  jest"
        rm -f "$out" "$json"; return
    fi
    # Pass only if every failing test is named in the allowlist. One unlisted failure
    # stops the push, so this cannot quietly absorb a second, real regression.
    failed="$(python3 - "$json" <<'PYEOF' 2>/dev/null || true
import json, sys
try: d = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
for f in d.get("testResults", []):
    for a in f.get("assertionResults", []):
        if a.get("status") == "failed":
            print(" > ".join(a.get("ancestorTitles", []) + [a.get("title", "")]))
PYEOF
)"
    if [[ -z "$failed" ]]; then
        warn "  FAIL  jest (could not read which tests failed; treating as a real failure)"
        indent "$(tail -30 "$out")" >&2
        GATES_PASSED=0; rm -f "$out" "$json"; return
    fi
    unknown=""
    while IFS= read -r t; do
        [[ -n "$t" ]] || continue
        grep -qxF -- "$t" "$KNOWN_JEST_FAILURES" 2>/dev/null || unknown+="$t"$'\n'
    done <<< "$failed"
    if [[ -n "$unknown" ]]; then
        warn "  FAIL  jest: failing test(s) not in .fork/known-jest-failures.txt:"
        warn "$(indent "${unknown%$'\n'}")"
        GATES_PASSED=0
    else
        warn "  TOLERATED  jest: $(printf '%s\n' "$failed" | grep -c .) known upstream failure(s)"
        warn "$(indent "$failed")"
        warn "      Each is listed with its evidence in .fork/known-jest-failures.txt."
        TOLERATED+="jest "
    fi
    rm -f "$out" "$json"
}
gate_jest

if (( GATES_PASSED )); then ok "all verification gates passed"; else warn "one or more gates FAILED"; fi

# ------------------------------------------------- 7. push

restore_branch() {
    if ! git checkout --quiet "$ORIGINAL_BRANCH" 2>/dev/null; then
        warn "could not return to '$ORIGINAL_BRANCH'; you are on $(git rev-parse --abbrev-ref HEAD)."
        warn "Nothing is lost - '$INTEGRATION' holds the rebuild. Check 'git status'."
        return 1
    fi
    return 0
}

# The invariant already holds three ways over: REBASED is filled only from features.txt,
# validate_manifests dies on a pr/* entry in that file, and CONTRIBS is never handed to a
# push. None of that is visible from here, though, so an edit to the push list below could
# start pushing open pull request heads and nothing in the script would object. State the
# rule where the pushing happens, and let it fail loudly rather than silently.
assert_no_pr_pushes() {
    local ref
    for ref in "$MIRROR" "${REBASED[@]}" "$INTEGRATION"; do
        case "$ref" in
            pr/*) die "refusing to push '$ref'. A pr/* branch is the head of an open upstream
pull request: force-pushing one detaches its review threads and re-fires its CI, and it
carries commits from Element's maintainers that this fork has no other copy of.

Whatever put it in the push list is the bug. The only inputs are .fork/features.txt and
the REBASED array; contribution branches belong in .fork/contrib.txt and are merged, never
pushed." ;;
        esac
    done
}
assert_no_pr_pushes

# A rebuild that left a branch out is not the thing this fork ships, however green its
# gates are. Report it at the end rather than at the merge, so one drifted branch does not
# cost the run everything it would have told us - but never push it.
if [[ -s "$SKIPPED_CONTRIBS" ]]; then
    echo >&2
    printf '%s========== CONTRIBUTION BRANCHES LEFT OUT OF THIS REBUILD ==========%s\n' "$RED" "$RST" >&2
    while IFS=$'\t' read -r b ahead behind; do
        [[ -n "$b" ]] || continue
        printf '  %-48s %s ahead / %s behind %s\n' "$b" "$ahead" "$behind" "$REMOTE" >&2
    done < "$SKIPPED_CONTRIBS"
    cat >&2 <<EOF

Each had drifted from $REMOTE, so merging it would have baked a stale revision of an open
pull request into $INTEGRATION. The per-branch advice is earlier in this log.

$INTEGRATION was built without them and is NOT what the fork ships. Nothing was pushed.
Reconcile each branch above, then re-run.
EOF
    clear_state
    restore_branch || true
    exit 6
fi

# --------------------------------------- 6b. publish master as a fast-forward
# The rebuild starts from $MIRROR and shares no tip with what the remote holds, so the
# push used to need --force-with-lease. Forcing means every previous $INTEGRATION is
# reachable only from somebody's local reflog. Keep the rebuild's TREE verbatim and give
# it two parents - what the remote holds now, and the rebuild itself - and the result
# fast-forwards. The tree is byte-identical either way, so nothing that was built, gated
# or verified above is affected; only the ancestry changes.
publish_integration() {
    local tree new
    git update-ref refs/fork-sync/rebuild "$(git rev-parse "$INTEGRATION")"
    if [[ -z "$PREV_INTEGRATION" ]]; then
        log "no previous $INTEGRATION on $REMOTE or locally; publishing the rebuild as-is"
        return 0
    fi
    if git merge-base --is-ancestor "$PREV_INTEGRATION" "$INTEGRATION"; then
        log "$INTEGRATION already descends from ${PREV_INTEGRATION:0:10}; no graft needed"
        return 0
    fi
    tree="$(git rev-parse "$INTEGRATION^{tree}")"
    new="$(git commit-tree "$tree" -p "$PREV_INTEGRATION" -p refs/fork-sync/rebuild \
        -m "Rebuild $INTEGRATION on $MIRROR $(git rev-parse --short "$MIRROR")" \
        -m "Same tree as the rebuild, with the previous $INTEGRATION as first parent so the
branch fast-forwards. $INTEGRATION is still disposable and still built from scratch by
.fork/sync-upstream.sh; this only keeps the history it replaces reachable.")" \
        || die "could not create the fast-forward commit for $INTEGRATION"
    git update-ref "refs/heads/$INTEGRATION" "$new" \
        || die "could not move $INTEGRATION to the fast-forward commit"
    # The whole point is that publishing changed the ancestry and nothing else. If the
    # trees ever differ, something grafted the wrong commit and the push must not happen.
    if ! git diff --quiet refs/fork-sync/rebuild "$INTEGRATION"; then
        die "$INTEGRATION does not have the rebuild's tree after grafting. Refusing to push.
Inspect with:  git diff refs/fork-sync/rebuild $INTEGRATION"
    fi
    SYNC_TAG="sync/$(date +%Y%m%d-%H%M)"
    if git tag "$SYNC_TAG" "$new" 2>/dev/null; then
        log "tagged $SYNC_TAG"
    else
        warn "could not create tag $SYNC_TAG (it probably already exists); carrying on"
        SYNC_TAG=""
    fi
    ok "$INTEGRATION published as a fast-forward from ${PREV_INTEGRATION:0:10}"
}
SYNC_TAG=""

if (( NO_PUSH )); then
    publish_integration
    log "--no-push given; leaving everything local"
elif (( ! GATES_PASSED )); then
    warn "NOT pushing: verification gates failed. Fix them, then re-run."
    warn "Nothing was pushed, so the remote is untouched."
    warn "'$INTEGRATION' still holds the rebuild so you can debug it."
    clear_state
    restore_branch || true
    exit 5
else
    publish_integration
    log "pushing $MIRROR (fast-forward), feature branches and $INTEGRATION"
    push_failed=0
    git push "$REMOTE" "$MIRROR:$MIRROR" || push_failed=1
    for branch in "${REBASED[@]}"; do
        git push --force-with-lease "$REMOTE" "$branch:$branch" || push_failed=1
    done
    # No lease and no force: 6b made this a fast-forward. A rejection here means the
    # remote moved after section 1 fetched it, and re-running is the right answer.
    git push "$REMOTE" "$INTEGRATION:$INTEGRATION" || push_failed=1
    # One tag by name, never --tags: section 1 fetches upstream with --tags, so every
    # element-hq release tag is in refs/tags and --tags would push the lot to the fork.
    if [[ -n "$SYNC_TAG" ]]; then
        git push "$REMOTE" "refs/tags/$SYNC_TAG" || push_failed=1
    fi
    # Contribution branches are NEVER pushed here: they are open-PR heads.
    if (( push_failed )); then
        clear_state
        restore_branch || true
        die "one or more pushes FAILED. Some refs may have been updated and others not.
Re-run the script - it is idempotent - or inspect with:
    git for-each-ref --format='%(refname:short) %(objectname:short)' refs/heads
    git ls-remote $REMOTE"
    fi
    ok "pushed"
fi

clear_state
INTEGRATION_SHA="$(git rev-parse --short "$INTEGRATION")"
if restore_branch; then
    ok "sync complete - $INTEGRATION = $INTEGRATION_SHA"
else
    ok "sync finished - $INTEGRATION = $INTEGRATION_SHA (see the warning above about your current branch)"
fi
