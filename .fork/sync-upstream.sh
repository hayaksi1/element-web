#!/usr/bin/env bash
#
# Rebuild this fork against upstream.
#
#   develop              pristine mirror of upstream/develop, advanced only with --ff-only
#   feat/*               fork-local features, REBASED onto develop  (.fork/features.txt)
#   pr/*                 upstream contribution branches, MERGED as-is, never rewritten
#                                                          (.fork/contrib.txt)
#   combined develop + every feat/* + every pr/*, rebuilt from scratch
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
INTEGRATION="${FORK_INTEGRATION_BRANCH:-combined}"

DRY_RUN=0
NO_PUSH=0
LOCKFILE_NEEDS_REGEN=0
SNAPSHOTS_STALE=0
CONTINUE=0
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
  combined develop + every feat/* + every pr/*, rebuilt from scratch

Usage: .fork/sync-upstream.sh [flags]

  --dry-run           Report what would change. Touches nothing, pushes nothing.
  --no-push           Do all the work locally; never push.
  --continue          Resume after you resolved a conflict by hand.
  --features=a,b      Only process these feature branches (comma separated,
                      with or without the feat/ prefix).
  -h, --help          This text.

Environment: FORK_REMOTE (default gh), FORK_UPSTREAM (default upstream),
             FORK_MIRROR_BRANCH (default develop),
             FORK_INTEGRATION_BRANCH (default combined).

Exit codes: 0 ok - 1 error - 2 feature rebase conflict - 3 integration merge
            conflict - 4 patch failed - 5 verification gate failed.
EOF
}

for arg in "$@"; do
    case "$arg" in
        --dry-run)     DRY_RUN=1 ;;
        --no-push)     NO_PUSH=1 ;;
        --continue)    CONTINUE=1 ;;
        --features=*)  FEATURE_SUBSET="${arg#*=}" ;;
        -h|--help)     usage; exit 0 ;;
        *)             die "unknown flag: $arg (try --help)" ;;
    esac
done

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
        if git show-ref --verify --quiet "refs/heads/$ref"; then
            printf '%s\n' "$ref"
        else
            warn "listed in ${file##*/} but no such local branch, skipping: $ref"
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
    done <<< "$(git status --porcelain | awk '$1=="UA"||$1=="AU"{print $1, $2}')"
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
                # side is right: the combined UI carries every branch's visual change, so any
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
    done <<< "$(git status --porcelain | awk '$1=="DU"||$1=="UD"{print $2}')"
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
    done <<< "$(git status --porcelain | awk '$1 == "DU" { print $2 }')"

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
    local f target lost=0
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
        if [[ -n "$accepted" ]] && printf '%s\n' "$accepted" | grep -qxF -- "$f"; then
            log "    $f: upstream deleted it and the allowlist accepts that; not a drop"
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
            warn "    LOST: $f is not in the merge result (nor at $target)"
            lost=1
        elif [[ "$after" == "$before" ]]; then
            warn "    LOST: $target is byte-identical to our pre-merge version;"
            warn "          $branch changed $f and the merge kept none of it"
            lost=1
        fi
    done <<< "$(git diff --name-only "$base" "$branch")"

    (( lost == 0 )) && return 0

    # Recorded, not raised. A nightly run that stops on the fifth of ninety-odd branches
    # tells you almost nothing; one that finishes and hands back every branch that
    # dropped content tells you where to spend the morning. A conflict still halts -
    # nothing can be committed until a human resolves it - but a drop is only visible
    # after the merge commit exists, and costs nothing to carry to the end of the run.
    printf '%s\n' "$branch" >> "$DROPS_FILE"
    return 0
}

# Indent a multi-line string by four spaces, without shelling out.
indent() { local s="${1//$'\n'/$'\n'    }"; printf '    %s\n' "$s"; }

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
(( CONTINUE )) || rm -f "$DROPS_FILE"
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
fi

mapfile -t FEATURES < <(read_list "$FEATURES_FILE")
mapfile -t CONTRIBS < <(read_list "$CONTRIB_FILE")
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
    if ! git merge --no-ff --no-edit -m "Merge $branch into ${INTEGRATION##*/}" "$branch"; then
        # MUST run before resolve_listed_deletions: the allowlist would take the
        # deletion and the branch's tests would vanish with it.
        resolve_relocations || true
        resolve_rr_cache_conflicts || true
        resolve_listed_deletions || true
        resolve_lockfile || true
        resolve_snapshots || true
        resolve_one_sided_adds || true
        local files; files="$(conflicting_files)"
        if [[ -z "$files" ]]; then
            # rerere and/or the deletion list resolved everything; conclude the merge.
            if git commit --no-edit; then
                assert_branch_landed "$branch" "$mbase" "$mpre"
                return 0
            fi
        fi
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
for i in "${!CONTRIBS[@]}"; do
    skip_done contrib "$i" && continue
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
        log "  $(basename "$p")"
        if git apply --check "$p" 2>/dev/null; then
            git apply "$p"
        elif git apply --3way --check "$p" 2>/dev/null; then
            git apply --3way "$p"
        else
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
        # Stage ONLY what the patch touches. `git add -A` would sweep in any unrelated
        # untracked file sitting in the tree and publish it.
        while IFS= read -r pf; do
            [[ -n "$pf" ]] && git add -- "$pf"
        done < <(git apply --numstat -z "$p" 2>/dev/null | tr '\0' '\n' | awk 'NR%3==0')
        git commit --quiet -m "Apply integration patch $(basename "$p")" \
                            -m "Cross-feature fix that belongs to no single branch. Source: .fork/integration-patches/$(basename "$p")"
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
    export_rr_cache
    echo >&2
    printf '%s============== MERGES THAT DROPPED BRANCH CONTENT ==============%s\n' "$RED" "$RST" >&2
    sort -u "$DROPS_FILE" | while read -r b; do printf '  %s\n' "$b" >&2; done
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

# ------------------------------------------------- 6. verification gates

GATES_PASSED=1
gate() {
    local name="$1"; shift
    log "gate: $name"
    if "$@"; then ok "  PASS  $name"; else warn "  FAIL  $name"; GATES_PASSED=0; fi
}
if (( SNAPSHOTS_STALE )); then
    warn "snapshots were conflicted and resolved to our side. If the test gate fails on a"
    warn "snapshot, regenerate rather than hand-editing:  pnpm -C apps/web test -- -u"
fi
if (( LOCKFILE_NEEDS_REGEN )); then
    log "pnpm-lock.yaml conflicted during this rebuild; pnpm install will rewrite it"
fi
gate "pnpm install"   pnpm install
gate "pnpm lint"      pnpm lint
gate "pnpm test:unit" pnpm test:unit

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

if (( NO_PUSH )); then
    log "--no-push given; leaving everything local"
elif (( ! GATES_PASSED )); then
    warn "NOT pushing: verification gates failed. Fix them, then re-run."
    warn "Nothing was pushed, so the remote is untouched."
    warn "'$INTEGRATION' still holds the rebuild so you can debug it."
    clear_state
    restore_branch || true
    exit 5
else
    log "pushing $MIRROR (fast-forward), feature branches and $INTEGRATION"
    push_failed=0
    git push "$REMOTE" "$MIRROR:$MIRROR" || push_failed=1
    for branch in "${REBASED[@]}"; do
        git push --force-with-lease "$REMOTE" "$branch:$branch" || push_failed=1
    done
    git push --force-with-lease "$REMOTE" "$INTEGRATION:$INTEGRATION" || push_failed=1
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
