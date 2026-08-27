#!/usr/bin/env bash

set -euo pipefail

REPORT="${1:-.fork/detect-report.tsv}"
REMOTE="${FORK_REMOTE:-gh}"
UPSTREAM="${FORK_UPSTREAM:-upstream}"
TITLE="${FORK_ISSUE_TITLE:-Sync conflicts}"
LABEL="${FORK_ISSUE_LABEL:-fork-sync}"
DRY_RUN="${FORK_ISSUE_DRY_RUN:-0}"
MARK_OPEN='<!-- fork-sync:state'
MARK_CLOSE='fork-sync:state -->'

log()  { printf '[fork-sync] %s\n' "$*"; }
die()  { printf '[fork-sync] ERROR: %s\n' "$*" >&2; exit 1; }
gh_write() {
    if (( DRY_RUN )); then printf '  would run: gh %s\n' "$*"; else gh "$@"; fi
}

case "${1:-}" in -h|--help)
    cat <<'EOF'
Reflect a detect report in the one "Sync conflicts" issue this fork keeps.

  .fork/sync-upstream.sh --detect          writes .fork/detect-report.tsv
  .fork/report-sync-conflicts.sh [report]  updates the issue from it

The body is the current state. A comment is posted only when the set of
(branch, path) changes. The issue is closed when the set is empty and the same
issue is reopened when it fills again; a second one is never created.

Environment: FORK_REMOTE (default gh), FORK_UPSTREAM (default upstream),
             FORK_ISSUE_TITLE (default "Sync conflicts"), FORK_ISSUE_LABEL
             (default fork-sync), GH_REPO to override the owner/repo derived
             from the remote, FORK_ISSUE_DRY_RUN=1 to print every gh write.
EOF
    exit 0 ;;
esac

[[ -f "$REPORT" ]] || die "no report at $REPORT. Run .fork/sync-upstream.sh --detect first;
a missing report means the detect run never finished, which is not the same as clean."
command -v gh >/dev/null || die "gh is not installed"

REPO="${GH_REPO:-$(git remote get-url "$REMOTE" | sed -E 's#/?$##; s#\.git$##; s#^.*[:/]([^/]+/[^/]+)$#\1#')}"
[[ "$REPO" == */* ]] || die "could not derive owner/repo from remote $REMOTE"

STATE="$(LC_ALL=C sort -u "$REPORT" | sed '/^$/d')"
BASE="$(git rev-parse --short "$UPSTREAM/develop" 2>/dev/null || echo unknown)"
RR="$(git rev-parse --short "HEAD:.fork/rr-cache" 2>/dev/null || echo unknown)"
TODAY="$(date -u +%Y-%m-%d)"

read -r NUMBER ISSUE_STATE < <(gh issue list -R "$REPO" --label "$LABEL" --state all --limit 100 \
    --json number,title,state \
    --jq "[.[] | select(.title == \"$TITLE\")] | sort_by(.number) | first // empty | [.number, .state] | @tsv"; echo)
OLD_STATE=""
if [[ -n "${NUMBER:-}" ]]; then
    OLD_STATE="$(gh issue view "$NUMBER" -R "$REPO" --json body --jq .body \
        | sed -n "/^$MARK_OPEN\$/,/^$MARK_CLOSE\$/p" | sed '1d;$d' | LC_ALL=C sort -u | sed '/^$/d')"
fi

if [[ -z "$STATE" ]]; then
    if [[ -n "${NUMBER:-}" && "$ISSUE_STATE" == "OPEN" ]]; then
        gh_write issue close "$NUMBER" -R "$REPO" --comment \
            "Clean on $TODAY: every branch merged and every integration patch applied on \`$UPSTREAM/develop\` \`$BASE\` with rerere cache \`$RR\`."
        log "closed #$NUMBER: detect is clean"
    else
        log "clean, and no open issue to close"
    fi
    exit 0
fi

BODY="$(mktemp)"
{
    printf 'Detected on %s by `.fork/sync-upstream.sh --detect`, against `%s/develop` `%s` with rerere cache `.fork/rr-cache` `%s`.\n\n' \
        "$TODAY" "$UPSTREAM" "$BASE" "$RR"
    printf 'The publish run would stop on each of these. The verdict for a branch is: it did not merge cleanly onto `develop` **after every manifest branch before it**, with the recorded rerere resolutions replayed. A branch after a conflicted one was merged without it, so its verdict is conditional on that skip. None of this claims the branch conflicts with `develop` on its own.\n\n'
    printf '| Branch or patch | Unresolved paths |\n|---|---|\n'
    printf '%s\n' "$STATE" | awk -F'\t' '
        { if ($2 == "") paths[$1] = paths[$1]; else paths[$1] = paths[$1] (paths[$1] == "" ? "" : ", ") "`" $2 "`"; if (!($1 in order)) { order[$1] = ++n; names[n] = $1 } }
        END { for (i = 1; i <= n; i++) { b = names[i]; p = paths[b]; if (p == "") p = "_none left unresolved: rerere replayed every one, but the publish run still stops here for a `--continue`_"; printf "| `%s` | %s |\n", b, p } }'
    printf '\n### Reproduce\n```bash\ngit fetch %s --prune && git fetch %s --prune\n.fork/sync-upstream.sh --detect     # same verdict, throwaway worktree, nothing pushed\n```\n\n' "$UPSTREAM" "$REMOTE"
    printf '### Resolve\n```bash\n.fork/sync-upstream.sh --no-push    # stops at the first branch above with exact instructions\n# resolve inside that merge: keep upstream'"'"'s logic, re-apply the fork'"'"'s intent, never -X ours / -X theirs\ngit add <files> && git commit --no-edit && .fork/sync-upstream.sh --continue\ngit switch feat/fork-tooling && git add .fork/rr-cache && git commit -m "Record conflict resolutions from this sync"\n```\n\n'
    printf 'A `pr/*` branch is the head of an open upstream pull request: never rebase, amend or force-push it; resolve in the integration merge only, and commit the rerere cache so the resolution replays. A `feat/*` branch is fixed by a commit on that branch. An `integration-patches/*` entry is a patch upstream has outgrown: regenerate it from the rebuilt tree or delete it.\n\n'
    printf '%s\n%s\n%s\n' "$MARK_OPEN" "$STATE" "$MARK_CLOSE"
} > "$BODY"

if [[ -z "${NUMBER:-}" ]]; then
    gh_write issue create -R "$REPO" --title "$TITLE" --label "$LABEL" --body-file "$BODY"
    log "opened the $TITLE issue"
    rm -f "$BODY"
    exit 0
fi

gh_write issue edit "$NUMBER" -R "$REPO" --body-file "$BODY"
CHANGED=0
if [[ "$ISSUE_STATE" != "OPEN" ]]; then
    gh_write issue reopen "$NUMBER" -R "$REPO"
    CHANGED=1
fi
if [[ "$OLD_STATE" != "$STATE" ]]; then
    CHANGED=1
fi
if (( CHANGED )); then
    DELTA="$(mktemp)"
    {
        printf 'State changed on %s against `%s/develop` `%s`:\n\n```diff\n' "$TODAY" "$UPSTREAM" "$BASE"
        LC_ALL=C comm -13 <(printf '%s\n' "$OLD_STATE") <(printf '%s\n' "$STATE") | sed 's/^/+ /'
        LC_ALL=C comm -23 <(printf '%s\n' "$OLD_STATE") <(printf '%s\n' "$STATE") | sed 's/^/- /'
        printf '```\n\nThe issue body carries the full current state.\n'
    } > "$DELTA"
    gh_write issue comment "$NUMBER" -R "$REPO" --body-file "$DELTA"
    log "#$NUMBER updated and commented: the conflict set changed"
    rm -f "$DELTA"
else
    log "#$NUMBER body refreshed; the conflict set is unchanged, so no comment"
fi
rm -f "$BODY"
