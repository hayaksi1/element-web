#!/usr/bin/env bash
#
# Rebuild this fork against upstream.
#
#   develop              pristine mirror of upstream/develop, advanced only with --ff-only
#   feat/*               fork-local features, REBASED onto develop  (.fork/features.txt)
#   pr/*                 upstream contribution branches, MERGED as-is, never rewritten
#                                                          (.fork/contrib.txt)
#   combined/integration develop + every feat/* + every pr/*, rebuilt from scratch
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
INTEGRATION="${FORK_INTEGRATION_BRANCH:-combined/integration}"

DRY_RUN=0
NO_PUSH=0
LOCKFILE_NEEDS_REGEN=0
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
  combined/integration develop + every feat/* + every pr/*, rebuilt from scratch

Usage: .fork/sync-upstream.sh [flags]

  --dry-run           Report what would change. Touches nothing, pushes nothing.
  --no-push           Do all the work locally; never push.
  --continue          Resume after you resolved a conflict by hand.
  --features=a,b      Only process these feature branches (comma separated,
                      with or without the feat/ prefix).
  -h, --help          This text.

Environment: FORK_REMOTE (default gh), FORK_UPSTREAM (default upstream),
             FORK_MIRROR_BRANCH (default develop),
             FORK_INTEGRATION_BRANCH (default combined/integration).

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
resolve_lockfile() {
    local lock="pnpm-lock.yaml"
    git diff --name-only --diff-filter=U | grep -qxF "$lock" || return 1
    git show ":2:$lock" > "$lock"
    git add -- "$lock"
    log "    took our pnpm-lock.yaml; the install gate will regenerate it"
    LOCKFILE_NEEDS_REGEN=1
    return 0
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
    done < <(git status --porcelain | awk '$1=="DU"||$1=="UD"{print $2}')
    return $(( ! resolved ))
}

# Indent a multi-line string by four spaces, without shelling out.
indent() { local s="${1//$'\n'/$'\n'    }"; printf '    %s\n' "$s"; }

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
git checkout --quiet "$MIRROR"

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

if ! git merge --ff-only "$UPSTREAM/develop"; then
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
ok "$MIRROR = $(git rev-parse --short HEAD) ($UPSTREAM/develop)"

# ------------------------------------------------- 3. rebase feature branches

REBASED=()
for i in "${!FEATURES[@]}"; do
    branch="${FEATURES[$i]}"
    in_subset "$branch" || { log "skipping $branch (not in --features)"; continue; }
    if (( CONTINUE )) && [[ "${PHASE:-}" == "rebase" ]] && (( i < ${INDEX:-0} )); then
        REBASED+=("$branch"); continue
    fi
    n="$(git rev-list --count "$MIRROR..$branch")"
    if [[ "$n" == "0" ]]; then
        warn "$branch has no commits of its own - already contained in $MIRROR. Skipping."
        continue
    fi
    log "rebasing $branch ($n commit(s)) onto $MIRROR"
    save_state rebase "$i" "$branch"
    if ! git rebase "$MIRROR" "$branch"; then
        files="$(conflicting_files)"
        export_rr_cache
        echo >&2
        printf '%s================ REBASE CONFLICT ================%s\n' "$RED" "$RST" >&2
        printf 'branch : %s\n' "$branch" >&2
        printf 'onto   : %s (%s)\n' "$MIRROR" "$(git rev-parse --short "$MIRROR")" >&2
        printf 'files  :\n%s' "$(indent "$files")" >&2
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
    CONTINUE=0
done
ok "rebased ${#REBASED[@]} feature branch(es)"

# ------------------------------------------- 4. rebuild the integration branch

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
    if ! git merge --no-ff --no-edit -m "Merge $branch into ${INTEGRATION##*/}" "$branch"; then
        resolve_listed_deletions || true
        resolve_lockfile || true
        local files; files="$(conflicting_files)"
        if [[ -z "$files" ]]; then
            # rerere and/or the deletion list resolved everything; conclude the merge.
            git commit --no-edit && return 0
        fi
        export_rr_cache
        echo >&2
        printf '%s============== INTEGRATION MERGE CONFLICT ==============%s\n' "$RED" "$RST" >&2
        printf 'branch : %s  (%s)\n' "$branch" "$kind" >&2
        printf 'files  :\n%s' "$(indent "$files")" >&2
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

# ------------------------------------------------- 6. verification gates

GATES_PASSED=1
gate() {
    local name="$1"; shift
    log "gate: $name"
    if "$@"; then ok "  PASS  $name"; else warn "  FAIL  $name"; GATES_PASSED=0; fi
}
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
