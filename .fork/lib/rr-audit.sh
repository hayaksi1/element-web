#!/usr/bin/env bash
# Sourced by .fork/sync-upstream.sh. Functions only. No top-level side effects.
#
# Ported from element-x-android's .fork/lib/audit.sh, trimmed to what this
# repo can use. Kotlin semantic scanners stay there: brace-balance heuristics
# produced dozens of false positives against TypeScript here, and the compiler
# plus the two test suites are the detector (see pr-branch-stale-base memory).
#
# What this file owns:
#   * quarantine a bad rerere entry instead of dying or clearing the cache
#   * refuse to export a failing entry into the committed cache
#   * import never overwrites a live entry
#   * export copies only preimage/postimage (thisimage is scratch)
#   * audit only entries recorded during this run, after the merges
#   * report gh branches that are in neither manifest
#
# Reads: REPO_ROOT GIT_COMMON RR_LIVE RR_REPO REMOTE MIRROR INTEGRATION
#        FEATURES CONTRIBS DETECT DRY_RUN
# Calls: log warn die run

_rr_gitdir() {
    printf '%s\n' "${GIT_COMMON:?}"
}

rr_live_dir() {
    printf '%s\n' "${RR_LIVE:?}"
}

rr_quarantine_dir() {
    printf '%s\n' "$(_rr_gitdir)/rr-cache-quarantine"
}

rr_skip_file() {
    printf '%s\n' "$(_rr_gitdir)/rr-cache-skip"
}

_rr_has_all_markers() {
    grep -qa '^<<<<<<<' -- "$1" &&
        grep -qa '^=======' -- "$1" &&
        grep -qa '^>>>>>>>' -- "$1"
}

_rr_has_any_marker() {
    grep -qaE '^(<<<<<<<|=======|>>>>>>>)' -- "$1"
}

_rr_skipped() {
    local id="$1" f
    f="$(rr_skip_file)"
    [[ -f "$f" ]] && grep -qxF -- "$id" "$f"
}

_rr_mark_skipped() {
    local id="$1" f
    f="$(rr_skip_file)"
    mkdir -p -- "$(dirname "$f")"
    grep -qxF -- "$id" "$f" 2>/dev/null && return 0
    printf '%s\n' "$id" >> "$f"
}

# Print TSV rows: variant <TAB> rule <TAB> detail. Exit 0 clean, 1 dirty.
_rr_entry_problems() {
    local dir="${1%/}"
    local id="${dir##*/}"
    local bad=0
    local -a images=() variants=()
    local f v pre post

    mapfile -t images < <(find "$dir" -maxdepth 1 -type f \
        \( -name 'preimage' -o -name 'preimage.*' \
        -o -name 'postimage' -o -name 'postimage.*' \) -printf '%f\n' 2>/dev/null | sort)

    if [[ ${#images[@]} -eq 0 ]]; then
        printf '%s\t%s\t%s\n' '-' 'malformed' "no preimage and no postimage in $dir"
        return 1
    fi

    for f in "${images[@]}"; do
        case "$f" in
            preimage) variants+=('') ;;
            preimage.*) variants+=("${f#preimage}") ;;
            postimage) variants+=('') ;;
            postimage.*) variants+=("${f#postimage}") ;;
        esac
    done
    mapfile -t variants < <(printf '%s\n' "${variants[@]}" | sort -u)

    for v in "${variants[@]}"; do
        pre="$dir/preimage$v"
        post="$dir/postimage$v"

        if [[ ! -f "$pre" ]]; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'missing-preimage' \
                "postimage$v exists with no matching preimage$v; rerere cannot match it to any conflict"
            bad=1
            continue
        fi

        if ! _rr_has_all_markers "$pre"; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'preimage-no-marker' \
                "preimage$v carries no conflict markers; a preimage is a recorded conflict"
            bad=1
        fi

        [[ -f "$post" ]] || continue

        if _rr_has_any_marker "$post"; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'postimage-marker' \
                "postimage$v still contains conflict markers; replaying it would write a half-resolved file and report the merge clean"
            bad=1
        fi

        if [[ ! -s "$post" && -s "$pre" ]]; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'postimage-empty' \
                "postimage$v is zero bytes while preimage$v is not; replaying it would empty the file"
            bad=1
        fi

        if grep -q 'from "vitest"' "$post" && grep -qE '(^|[^-[:alnum:]])jest([^-[:alnum:]]|$)' "$post"; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'jest-in-vitest' \
                "postimage$v imports vitest but still contains jest idioms"
            bad=1
        fi

        if grep -qE '\bvi\.(SpyInstance|Mocked|Mock)\b' "$post"; then
            printf '%s\t%s\t%s\n' "${v:-0}" 'vi-as-type' \
                "postimage$v uses vi.SpyInstance/Mocked/Mock as a type; vitest exports those as named types"
            bad=1
        fi
    done

    return "$bad"
}

_rr_record_quarantine_tsv() {
    local id="$1" reason="$2" tsv
    tsv="${RR_REPO%/*}/rr-cache-quarantined.tsv"
    [[ -d "$(dirname "$tsv")" ]] || return 0
    if [[ ! -f "$tsv" ]]; then
        printf '%s\n' $'# id\trules\tdetail\tdate' > "$tsv"
    fi
    printf '%s\t%s\t%s\n' "$id" "$reason" "$(date -u +%Y-%m-%d)" >> "$tsv"
}

# Move ONE failing entry aside. Never clear the cache.
rr_quarantine_entry() {
    local id="$1" reason="$2" q d
    d="$(rr_live_dir)"
    q="$(rr_quarantine_dir)"
    [[ -d "$d/$id" ]] || return 0
    mkdir -p -- "$q"
    if [[ -e "$q/$id" ]]; then
        rm -rf -- "$q/$id"
    fi
    mv -- "$d/$id" "$q/$id"
    printf '%s\n' "$reason" > "$q/$id/QUARANTINE_REASON.txt"
    _rr_mark_skipped "$id"
    if [[ -d "${RR_REPO:-}/$id" ]]; then
        rm -rf -- "${RR_REPO}/$id"
    fi
    _rr_record_quarantine_tsv "$id" "$reason"
    warn "rr-cache QUARANTINED $id -> $q/$id ($reason)"
    return 0
}

rr_snapshot_ids() {
    local d
    d="$(rr_live_dir)"
    [[ -d "$d" ]] || return 0
    find "$d" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort
}

rr_reaudit_begin() {
    RR_SNAPSHOT_FILE="${STATE_FILE:-$(_rr_gitdir)/fork-sync-state}.rr-before"
    rr_snapshot_ids > "$RR_SNAPSHOT_FILE" 2>/dev/null || : > "$RR_SNAPSHOT_FILE"
    log "rerere cache: snapshotted $(wc -l < "$RR_SNAPSHOT_FILE" | tr -d '[:space:]') entry id(s) before integration"
    return 0
}

# Audit only what this run recorded. Quarantine a bad new entry; do not die.
# The tree may already hold the replay; the gates catch that. Detect mode
# never quarantines: it must not mutate the operator's live cache.
rr_reaudit_recorded() {
    local before after id probs first='' n=0 bad=0
    if (( DETECT )); then
        log "rerere re-audit: skipped in --detect (would mutate the live cache)"
        return 0
    fi
    before="${RR_SNAPSHOT_FILE:-${STATE_FILE:-$(_rr_gitdir)/fork-sync-state}.rr-before}"
    if [[ ! -f "$before" ]]; then
        warn "no pre-integration rerere snapshot at $before; re-auditing the WHOLE cache instead"
        : > "$before"
    fi
    after="$(mktemp)"
    rr_snapshot_ids > "$after"

    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        n=$((n + 1))
        if ! probs="$(_rr_entry_problems "$(rr_live_dir)/$id")"; then
            bad=$((bad + 1))
            local reason
            reason="$(printf '%s\n' "$probs" | head -1 | cut -f2,3 | tr '\t' ' ')"
            [[ -z "$first" ]] && first="$id ($reason)"
            while IFS=$'\t' read -r v rule detail; do
                [[ -z "$rule" ]] && continue
                warn "rr-cache RECORDED-AND-REJECTED $id variant=$v rule=$rule: $detail"
            done <<< "$probs"
            rr_quarantine_entry "$id" "recorded during sync $(date -u +%Y-%m-%dT%H:%M:%SZ): $reason"
        fi
    done < <(comm -13 "$before" "$after")
    rm -f -- "$after"

    log "rerere re-audit: $n entry/entries recorded during this run, $bad quarantined"
    if [[ $bad -gt 0 ]]; then
        warn "The quarantined resolution(s) were staged by rerere.autoUpdate and are now moved aside (first: $first)."
        warn "They are still in the tree that was built. Re-resolve those paths by hand and re-run with --continue."
    fi
    return 0
}

# Validate every live entry. Quarantine failures instead of dying, except in
# --detect where we only report.
audit_rr_cache() {
    local d total=0 replayable=0 preonly=0 quarantined=0 resolutions=0
    local dir id probs n first=''
    d="$(rr_live_dir)"

    if [[ ! -d "$d" ]]; then
        log "rerere cache: nothing at $d, nothing to audit"
        return 0
    fi

    while IFS= read -r dir; do
        [[ -z "$dir" ]] && continue
        total=$((total + 1))
        id="${dir##*/}"
        _rr_skipped "$id" && continue

        if probs="$(_rr_entry_problems "$dir")"; then
            n="$(find "$dir" -maxdepth 1 -type f -name 'postimage*' | wc -l | tr -d '[:space:]')"
            if [[ "$n" -gt 0 ]]; then
                replayable=$((replayable + 1))
                resolutions=$((resolutions + n))
            else
                preonly=$((preonly + 1))
            fi
        else
            quarantined=$((quarantined + 1))
            while IFS=$'\t' read -r v rule detail; do
                [[ -z "$rule" ]] && continue
                warn "rr-cache BAD $id variant=$v rule=$rule: $detail"
                [[ -z "$first" ]] && first="$id ($rule)"
            done <<< "$probs"
            if (( DETECT )); then
                warn "rr-cache would quarantine $id in a publish run; --detect leaves it in place"
            else
                local reason
                reason="$(printf '%s\n' "$probs" | head -1 | cut -f2,3 | tr '\t' ' ')"
                rr_quarantine_entry "$id" "$reason"
            fi
        fi
    done < <(find "$d" -mindepth 1 -maxdepth 1 -type d | sort)

    log "rerere cache $d: $total entries, $replayable replayable ($resolutions resolution(s)), $preonly preimage-only, $quarantined quarantined"
    if [[ $quarantined -gt 0 ]]; then
        warn "quarantined $quarantined defective rerere entry/entries (first: $first). The rebuild continues without them; those conflicts will surface instead of silently replaying a broken file."
    fi
    return 0
}

# Seed the live cache from the committed copy. Never overwrite a live entry:
# it may be a resolution recorded since, and the committed copy is older.
# Never re-import an id that has been quarantined.
import_rr_cache() {
    local d src id n=0 skip=0
    d="$(rr_live_dir)"
    src="${RR_REPO:?}"
    [[ -d "$src" ]] || { log "no committed rerere cache at $src"; return 0; }
    mkdir -p -- "$d"
    while IFS= read -r id; do
        [[ -n "$id" ]] || continue
        id="$(basename "$id")"
        if _rr_skipped "$id" || [[ -d "$(rr_quarantine_dir)/$id" ]]; then
            skip=$((skip + 1))
            continue
        fi
        [[ -e "$d/$id" ]] && continue
        cp -a -- "$src/$id" "$d/" 2>/dev/null || continue
        n=$((n + 1))
    done < <(find "$src" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    if [[ $n -gt 0 ]]; then
        log "imported $n committed rerere resolution(s) into $d"
    else
        log "committed rerere cache already present in $d"
    fi
    [[ $skip -gt 0 ]] && log "rerere import: skipped $skip quarantined id(s)"
    return 0
}

# Copy live entries back into .fork/rr-cache. Never copies thisimage scratch.
# A failing entry is quarantined and not copied. The final export (no argument,
# or 1) dies on a refusal so a bad resolution cannot be committed. Conflict
# paths pass 0: saving what we can must not abort the operator mid-resolve.
export_rr_cache() {
    local strict="${1:-1}"
    local src dest dir id probs exported=0 skipped=0 first_bad=''
    src="$(rr_live_dir)"
    dest="${RR_REPO:?}"

    if [[ ! -d "$src" ]]; then
        log "no rerere cache to export"
        return 0
    fi

    mkdir -p -- "$dest"
    while IFS= read -r dir; do
        [[ -z "$dir" ]] && continue
        id="${dir##*/}"
        _rr_skipped "$id" && continue
        if ! probs="$(_rr_entry_problems "$dir")"; then
            while IFS=$'\t' read -r v rule detail; do
                [[ -z "$rule" ]] && continue
                warn "rr-cache export REFUSED $id variant=$v rule=$rule: $detail"
            done <<< "$probs"
            skipped=$((skipped + 1))
            [[ -z "$first_bad" ]] && first_bad="$id"
            if (( ! DETECT )); then
                local reason
                reason="$(printf '%s\n' "$probs" | head -1 | cut -f2,3 | tr '\t' ' ')"
                rr_quarantine_entry "$id" "export refused: $reason"
            fi
            continue
        fi
        mkdir -p -- "$dest/$id"
        find "$dir" -maxdepth 1 -type f \( -name 'preimage' -o -name 'preimage.*' \
            -o -name 'postimage' -o -name 'postimage.*' \) -exec cp -a -- {} "$dest/$id/" \;
        exported=$((exported + 1))
    done < <(find "$src" -mindepth 1 -maxdepth 1 -type d | sort)

    touch "$dest/.gitkeep"
    log "rerere cache export: $exported entry/entries copied to $dest, $skipped rejected"

    if [[ $skipped -gt 0 && "$strict" == "1" ]]; then
        die "rerere cache export refused: $skipped entry/entries fail the audit (first: $first_bad). They were NOT exported. Quarantine already moved them aside; re-resolve those paths and re-run."
    fi
    if [[ $skipped -gt 0 ]]; then
        warn "rerere cache export skipped $skipped bad entry/entries mid-conflict (first: $first_bad); they were quarantined and not committed"
    fi

    local n
    n="$(find "$dest" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
    log "rerere: exported cache back to .fork/rr-cache ($n resolutions)"
    if [[ -n "$(git status --porcelain -- .fork/rr-cache .fork/rr-cache-quarantined.tsv 2>/dev/null)" ]]; then
        warn "the rerere cache changed. Commit it to feat/fork-tooling so the next sync"
        warn "and every fresh clone replay these resolutions instead of re-deriving them:"
        warn "    git add .fork/rr-cache .fork/rr-cache-quarantined.tsv && git commit -m 'Record conflict resolutions from this sync'"
    fi
    return 0
}

# A branch on $REMOTE that is in neither manifest is silently never integrated.
# unmanaged-branches.txt is the acknowledged set; anything appearing after that
# seed is reported. Warning, not a failed run: the acknowledged set is large
# because absorbed PRs stay on the fork on purpose.
check_unmanaged_branches() {
    local managed allow b short n=0
    local allowfile="${REPO_ROOT}/.fork/unmanaged-branches.txt"
    managed=" "
    local x
    for x in "${FEATURES[@]:-}"; do managed+=" $x "; done
    for x in "${CONTRIBS[@]:-}"; do managed+=" $x "; done

    allow=" "
    if [[ -f "$allowfile" ]]; then
        allow=" $(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$allowfile" | grep -v '^$' | tr '\n' ' ' || true) "
    fi

    while IFS= read -r short; do
        b="${short#${REMOTE}/}"
        [[ -z "$b" || "$b" == "HEAD" || "$b" == "$short" ]] && continue
        [[ "$b" == "$MIRROR" || "$b" == "$INTEGRATION" || "$b" == "feat/fork-tooling" ]] && continue
        [[ "$managed" == *" $b "* ]] && continue
        [[ "$allow" == *" $b "* ]] && continue
        warn "UNMANAGED $REMOTE/$b is in neither manifest and not in .fork/unmanaged-branches.txt -- its work is not in $INTEGRATION"
        n=$((n + 1))
    done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$REMOTE")

    if [[ $n -gt 0 ]]; then
        warn "$n branch(es) on $REMOTE are unmanaged. Add each to a manifest to integrate it, or to .fork/unmanaged-branches.txt if that is deliberate."
    else
        log "unmanaged-branches: every $REMOTE ref is either in a manifest or acknowledged"
    fi
    return 0
}
