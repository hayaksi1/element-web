#!/usr/bin/env bash
# verify-combined.sh -- prove the `combined` integration branch is complete.
#
# Ref-only: reads history and blobs via git plumbing. Never touches the working
# tree or the index, so it is safe to run while a sync/merge is in progress.
#
# Exit status = number of FAILED checks (0 = all pass).

set -uo pipefail

REPO="${REPO:-$(pwd)}"
UPSTREAM="${UPSTREAM:-upstream/develop}"
COMBINED="${COMBINED:-combined}"
DEVELOP="${DEVELOP:-develop}"
TOOLING="${TOOLING:-feat/fork-tooling}"          # ref holding .fork/*.txt manifests
MAX_FILES_PER_BRANCH="${MAX_FILES_PER_BRANCH:-40}"
MAX_BRANCHES_CHECK4="${MAX_BRANCHES_CHECK4:-0}"  # 0 = no cap
VERBOSE_RELOC="${VERBOSE_RELOC:-0}"      # 1 = list every path upstream relocated
RRCACHE_EXCLUDE=':(exclude).fork/rr-cache/*'

cd "$REPO" || { echo "cannot cd to $REPO"; exit 99; }

FAILED=0
pass(){ printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail(){ printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=$((FAILED+1)); }
info(){ printf '  info  %s\n' "$*"; }
head1(){ printf '\n\033[1m%s\033[0m\n' "$*"; }

need_ref(){ git rev-parse --verify --quiet "$1^{commit}" >/dev/null || { echo "missing ref: $1"; exit 98; }; }
for r in "$UPSTREAM" "$COMBINED" "$DEVELOP" "$TOOLING"; do need_ref "$r"; done

printf '\033[1mverify-combined\033[0m  repo=%s\n' "$REPO"
printf '  %-18s %s  %s\n' upstream "$(git rev-parse --short "$UPSTREAM")" "$(git log -1 --format=%s "$UPSTREAM" | cut -c1-58)"
printf '  %-18s %s  %s\n' develop  "$(git rev-parse --short "$DEVELOP")"  "$(git log -1 --format=%s "$DEVELOP"  | cut -c1-58)"
printf '  %-18s %s  %s\n' combined "$(git rev-parse --short "$COMBINED")" "$(git log -1 --format=%s "$COMBINED" | cut -c1-58)"

# ---------------------------------------------------------------- 1. upstream
head1 "1. UPSTREAM COMPLETENESS  (every upstream commit reachable from combined)"
if git merge-base --is-ancestor "$UPSTREAM" "$COMBINED"; then
    pass "$UPSTREAM is an ancestor of $COMBINED"
else
    fail "$UPSTREAM is NOT an ancestor of $COMBINED"
fi
MISSING_UP=$(git rev-list --count "$COMBINED..$UPSTREAM")
if [ "$MISSING_UP" -eq 0 ]; then
    pass "0 upstream commits unreachable from $COMBINED"
else
    fail "$MISSING_UP upstream commit(s) NOT reachable from $COMBINED:"
    git log --oneline --max-count=25 "$COMBINED..$UPSTREAM" | sed 's/^/          /'
    [ "$MISSING_UP" -gt 25 ] && info "(showing first 25 of $MISSING_UP)"
fi

# ------------------------------------------------------------ 2. mirror purity
head1 "2. MIRROR PURITY  ($DEVELOP carries no commits of its own)"
OWN=$(git rev-list --count "$UPSTREAM..$DEVELOP")
if [ "$OWN" -eq 0 ]; then
    pass "$DEVELOP has 0 commits not in $UPSTREAM"
else
    fail "$DEVELOP has $OWN commit(s) not in $UPSTREAM:"
    git log --oneline --max-count=25 "$UPSTREAM..$DEVELOP" | sed 's/^/          /'
fi

# --------------------------------------------------------- 3. branch coverage
head1 "3. BRANCH COVERAGE  (every manifest branch is an ancestor of $COMBINED)"
manifest(){ git show "$TOOLING:.fork/$1" 2>/dev/null | sed 's/#.*//' | tr -d ' \t\r' | grep . ; }
BRANCHES=$( { manifest features.txt; manifest contrib.txt; } | awk '!seen[$0]++' )
TOTAL=$(printf '%s\n' "$BRANCHES" | grep -c . || true)
if [ "$TOTAL" -eq 0 ]; then
    fail "no branches read from $TOOLING:.fork/{features,contrib}.txt"
else
    MERGED=""; NOTMERGED=""; ABSENT=""
    while read -r B; do
        [ -z "$B" ] && continue
        if ! git rev-parse --verify --quiet "$B^{commit}" >/dev/null; then
            ABSENT="$ABSENT$B"$'\n'; continue
        fi
        if git merge-base --is-ancestor "$B" "$COMBINED"; then
            MERGED="$MERGED$B"$'\n'
        else
            NOTMERGED="$NOTMERGED$B"$'\n'
        fi
    done <<< "$BRANCHES"
    NM=$(printf '%s' "$NOTMERGED" | grep -c . || true)
    NA=$(printf '%s' "$ABSENT"    | grep -c . || true)
    NMG=$(printf '%s' "$MERGED"   | grep -c . || true)
    info "manifest lists $TOTAL branch(es): $NMG merged, $NM not yet merged, $NA missing locally"
    if [ "$NM" -eq 0 ] && [ "$NA" -eq 0 ]; then
        pass "all $TOTAL manifest branches are ancestors of $COMBINED"
    else
        [ "$NM" -gt 0 ] && { fail "$NM branch(es) NOT yet merged into $COMBINED:"; printf '%s' "$NOTMERGED" | sed 's/^/          /'; }
        [ "$NA" -gt 0 ] && { fail "$NA manifest branch(es) do NOT exist locally (ANOMALY - cannot be merged):"; printf '%s' "$ABSENT" | sed 's/^/          /'; }
    fi
fi

# ------------------------------------------------- 4. nothing silently dropped
head1 "4. NOTHING SILENTLY DROPPED  (merged branches' content survived)"
info "cap: <= $MAX_FILES_PER_BRANCH files per branch; pnpm-lock.yaml skipped (pure churn)"
[ "$MAX_BRANCHES_CHECK4" -gt 0 ] && info "cap: first $MAX_BRANCHES_CHECK4 merged branches only"
DROPPED=0; CHECKED_B=0; CHECKED_F=0; RELOC=0; CAPPED=""
norm(){ sed 's/[[:space:]]\+/ /g;s/^ //;s/ $//' | grep -v '^$' | awk 'length>=8' | sort -u; }
while read -r B; do
    [ -z "$B" ] && continue
    [ "$MAX_BRANCHES_CHECK4" -gt 0 ] && [ "$CHECKED_B" -ge "$MAX_BRANCHES_CHECK4" ] && break
    CHECKED_B=$((CHECKED_B+1))
    BASE=$(git merge-base "$UPSTREAM" "$B")
    mapfile -t FILES < <(git diff --name-only "$BASE" "$B" -- . ':(exclude)pnpm-lock.yaml')
    [ "${#FILES[@]}" -gt "$MAX_FILES_PER_BRANCH" ] && CAPPED="$CAPPED $B(${#FILES[@]})"
    n=0
    for f in "${FILES[@]}"; do
        n=$((n+1)); [ "$n" -gt "$MAX_FILES_PER_BRANCH" ] && break
        CHECKED_F=$((CHECKED_F+1))
        IN_COMBINED=1; git cat-file -e "$COMBINED:$f" 2>/dev/null || IN_COMBINED=0
        IN_BRANCH=1;   git cat-file -e "$B:$f"        2>/dev/null || IN_BRANCH=0
        if [ "$IN_BRANCH" -eq 0 ]; then
            # branch deleted it; combined should have deleted it too
            [ "$IN_COMBINED" -eq 1 ] && { fail "[$B] $f -- branch DELETED this file, $COMBINED still has it"; DROPPED=$((DROPPED+1)); }
            continue
        fi
        if [ "$IN_COMBINED" -eq 0 ]; then
            # The path is gone, but upstream renames it constantly (jest->vitest test
            # co-location, etc). Absence of a PATH is not loss of CONTENT: look for the
            # branch's own added lines anywhere in combined's tree before failing.
            # Upstream co-located its tests (apps/web/test/unit-tests/X/Y-test.tsx ->
            # apps/web/src/X/Y.test.tsx). Try that deterministic mapping FIRST and compare
            # full line-sets against it: far more accurate than grepping the whole tree.
            ALT=$(printf '%s' "$f" | sed -E 's|^apps/web/test/unit-tests/|apps/web/src/|; s|^apps/web/test/|apps/web/src/|; s|-test\.(tsx?)$|.test.\1|; s|-test\.tsx\.snap$|.test.tsx.snap|')
            if [ "$ALT" != "$f" ] && git cat-file -e "$COMBINED:$ALT" 2>/dev/null; then
                A2=$(git diff -U0 "$BASE" "$B" -- "$f" | grep '^+' | grep -v '^+++' | cut -c2- | norm)
                C2=$(git show "$COMBINED:$ALT" | tr -d '\000' | norm)
                n2=$(printf '%s' "$A2" | grep -c . || true)
                k2=$(comm -12 <(printf '%s\n' "$A2") <(printf '%s\n' "$C2") | grep -c . || true)
                if [ "$n2" -eq 0 ]; then RELOC=$((RELOC+1))
                elif [ "$k2" -eq 0 ]; then
                    fail "[$B] $f -> $ALT : 0/$n2 added lines survive (CONTRIBUTION LOST)"; DROPPED=$((DROPPED+1))
                elif [ $((k2*2)) -lt "$n2" ]; then
                    # Discriminator: if combined's copy is byte-identical to upstream's, the
                    # fork's change to it was dropped outright -- not an upstream rewrite.
                    if [ "$(git rev-parse "$UPSTREAM:$ALT" 2>/dev/null)" = "$(git rev-parse "$COMBINED:$ALT" 2>/dev/null)" ]; then
                        fail "[$B] $f -> $ALT : $k2/$n2 added lines survive AND $ALT is byte-identical to $UPSTREAM (CONFIRMED DROP)"
                    else
                        fail "[$B] $f -> $ALT : only $k2/$n2 added lines survive (PARTIAL LOSS - may be an upstream test rewrite; eyeball)"
                    fi
                    DROPPED=$((DROPPED+1))
                else
                    RELOC=$((RELOC+1)); [ "$VERBOSE_RELOC" = "1" ] && info "[$B] $f -> $ALT ($k2/$n2 added lines present)"
                fi
                continue
            fi
            # Pick the branch's most distinctive added lines and see how many survive in a
            # single file anywhere in the tree. A path vanishing is normal (upstream renames
            # constantly); a path vanishing AND its content not landing anywhere is the drop.
            PROBE=$(git diff -U0 "$BASE" "$B" -- "$f" | grep '^+' | grep -v '^+++' | cut -c2- \
                    | sed 's/[[:space:]]\+/ /g;s/^ //;s/ $//' | sort -u \
                    | awk 'length>=25{print length" "$0}' | sort -rn | head -8 | cut -d' ' -f2-)
            NP=$(printf '%s' "$PROBE" | grep -c . || true)
            if [ "$NP" -eq 0 ]; then
                fail "[$B] $f -- absent from $COMBINED and no distinctive line to trace (VERIFY BY HAND)"
                DROPPED=$((DROPPED+1)); continue
            fi
            HITS=$(while IFS= read -r L; do
                       [ -z "$L" ] && continue
                       git grep -l -F -- "$L" "$COMBINED" -- . "$RRCACHE_EXCLUDE" 2>/dev/null | sed "s|^$COMBINED:||"
                   done <<< "$PROBE" | sort | uniq -c | sort -rn | head -1)
            K=$(printf '%s' "$HITS" | awk '{print $1+0}'); K=${K:-0}
            BEST=$(printf '%s' "$HITS" | awk '{print $2}')
            if [ "$K" -eq 0 ]; then
                fail "[$B] $f -- absent from $COMBINED; 0/$NP of its distinctive lines found anywhere (CONTRIBUTION LOST)"
                DROPPED=$((DROPPED+1))
            elif [ $((K*2)) -lt "$NP" ]; then
                fail "[$B] $f -- absent from $COMBINED; only $K/$NP distinctive lines survive (best match: $BEST) (PARTIAL LOSS)"
                DROPPED=$((DROPPED+1))
            else
                RELOC=$((RELOC+1))
                [ "$VERBOSE_RELOC" = "1" ] && info "[$B] $f -> $BEST ($K/$NP lines present)"
            fi
            continue
        fi
        ADD=$(git diff -U0 "$BASE" "$B" -- "$f" | grep '^+' | grep -v '^+++' | cut -c2- | norm)
        DEL=$(git diff -U0 "$BASE" "$B" -- "$f" | grep '^-' | grep -v '^---' | cut -c2- | norm)
        CUR=$(git show "$COMBINED:$f" | tr -d '\000' | norm)
        na=$(printf '%s' "$ADD" | grep -c . || true)
        if [ "$na" -gt 0 ]; then
            kept=$(comm -12 <(printf '%s\n' "$ADD") <(printf '%s\n' "$CUR") | grep -c . || true)
            if [ "$kept" -eq 0 ]; then
                fail "[$B] $f -- ALL $na added line(s) absent from $COMBINED (contribution reverted?)"; DROPPED=$((DROPPED+1))
            fi
        else
            nd=$(printf '%s' "$DEL" | grep -c . || true)
            if [ "$nd" -gt 0 ]; then
                back=$(comm -12 <(printf '%s\n' "$DEL") <(printf '%s\n' "$CUR") | grep -c . || true)
                [ "$back" -eq "$nd" ] && { fail "[$B] $f -- deletion-only change fully REVERTED in $COMBINED ($nd line(s) back)"; DROPPED=$((DROPPED+1)); }
            fi
        fi
    done
done <<< "$MERGED"
[ -n "$CAPPED" ] && info "capped branches (files beyond limit unchecked):$CAPPED"
if [ "$DROPPED" -eq 0 ]; then
    pass "$CHECKED_B merged branch(es) / $CHECKED_F file(s): no contribution entirely lost"
    [ "$RELOC" -gt 0 ] && info "$RELOC file(s) moved to a new path upstream; content traced and present (VERBOSE_RELOC=1 to list)"
else
    info "$DROPPED suspect file(s) across $CHECKED_B branch(es) -- eyeball each; a reformat can also trip this"
    [ "$RELOC" -gt 0 ] && info "$RELOC further file(s) merely relocated upstream; content traced and present (not counted)"
fi

# --------------------------------------------- 5. duplicate snapshot keys
head1 "5. DUPLICATE SNAPSHOT KEYS  (jest evaluates .snap as a module; last key wins)"
DUPF=0; NSNAP=0
while read -r p; do
    [ -z "$p" ] && continue
    NSNAP=$((NSNAP+1))
    D=$(git show "$COMBINED:$p" | grep -oE '^exports\[.*\][[:space:]]*=' | sed 's/[[:space:]]*=$//' | sort | uniq -d)
    if [ -n "$D" ]; then
        DUPF=$((DUPF+1)); fail "$p -- duplicate key(s):"; printf '%s\n' "$D" | sed 's/^/          /'
    fi
done < <(git ls-tree -r --name-only "$COMBINED" | grep '\.snap$')
[ "$DUPF" -eq 0 ] && pass "$NSNAP snapshot file(s) scanned, no duplicate export keys"

# ------------------------------------------------------ 6. conflict markers
head1 "6. NO CONFLICT MARKERS  (.fork/rr-cache excluded -- rerere preimages contain markers by design)"
HARD=$(git grep -l -E '^(<<<<<<<|>>>>>>>)' "$COMBINED" -- . "$RRCACHE_EXCLUDE" 2>/dev/null | sed "s|^$COMBINED:||")
if [ -z "$HARD" ]; then
    pass "no '<<<<<<<' or '>>>>>>>' in any committed file"
else
    fail "conflict markers left in committed file(s):"; printf '%s\n' "$HARD" | sed 's/^/          /'
fi
SOFT=$(git grep -l -E '^=======$' "$COMBINED" -- . "$RRCACHE_EXCLUDE" 2>/dev/null | sed "s|^$COMBINED:||")
if [ -n "$SOFT" ]; then
    NS=$(printf '%s\n' "$SOFT" | grep -c .)
    info "$NS file(s) contain a bare '=======' line -- benign unless paired with <<<<<<</>>>>>>>:"
    printf '%s\n' "$SOFT" | sed 's/^/          /'
    while read -r f; do
        [ -z "$f" ] && continue
        if git cat-file -e "$UPSTREAM:$f" 2>/dev/null && \
           [ "$(git rev-parse "$UPSTREAM:$f")" = "$(git rev-parse "$COMBINED:$f")" ]; then
            info "  ^ $f is byte-identical to $UPSTREAM -- confirmed benign"
        fi
    done <<< "$SOFT"
fi

head1 "SUMMARY"
if [ "$FAILED" -eq 0 ]; then printf '  \033[32mALL CHECKS PASSED\033[0m\n'; else printf '  \033[31m%d CHECK(S) FAILED\033[0m\n' "$FAILED"; fi
exit "$FAILED"
