#!/usr/bin/env bash
# Harness for .fork/lib/rr-audit.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$HERE/t"
FAILED=0

log()  { printf '==> %s\n' "$*"; }
warn() { printf '!!! %s\n' "$*" >&2; }
die()  { printf 'ERR %s\n' "$*" >&2; exit 1; }
run()  { "$@"; }

DRY_RUN=0
DETECT=0
CONTINUE=0
REMOTE=origin
MIRROR=develop
INTEGRATION=master
FEATURES=()
CONTRIBS=()
STATE_FILE=""

# shellcheck source=/dev/null
. "$HERE/../lib/rr-audit.sh"

pass() { printf '  PASS %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*"; FAILED=$((FAILED + 1)); }

expect_eq() {
    if [[ "$1" == "$2" ]]; then pass "$3"; else fail "$3 -- got [$1], want [$2]"; fi
}
expect_true() {
    if [[ "$1" -eq 0 ]]; then pass "$2"; else fail "$2"; fi
}

mkrepo() {
    local d="$1"
    rm -rf "$d"; mkdir -p "$d"
    git -C "$d" init -q -b master
    git -C "$d" config user.email 'test@test.invalid'
    git -C "$d" config user.name 'test'
    git -C "$d" config commit.gpgsign false
    git -C "$d" commit -q --allow-empty -m 'base'
}

conflict_text() { printf 'a\n<<<<<<<\nours\n=======\ntheirs\n>>>>>>>\nz\n'; }
resolved_text() { printf 'a\nours\nz\n'; }
vitest_jest() {
    printf '%s\n' 'import { vi, describe, it, expect } from "vitest"' \
        '            getValueSpy = jest' \
        '                .spyOn(SettingsStore, "getValue")'
}

setup_env() {
    local d="$1"
    REPO_ROOT="$d"
    GIT_COMMON="$d/.git"
    RR_LIVE="$d/.git/rr-cache"
    RR_REPO="$d/.fork/rr-cache"
    STATE_FILE="$d/.git/fork-sync-state"
    mkdir -p "$RR_LIVE" "$RR_REPO" "$d/.fork"
}

rm -rf "$T"; mkdir -p "$T"
printf 'rr-audit harness -- workspace %s\n' "$T"

###############################################################################
printf '\n=== 1 clean cache passes ===\n'
###############################################################################
R="$T/clean"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/aaa0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/aaa0000000000000000000000000000000000001/preimage"
resolved_text > "$RR_LIVE/aaa0000000000000000000000000000000000001/postimage"
mkdir -p "$RR_LIVE/aaa0000000000000000000000000000000000002"
conflict_text > "$RR_LIVE/aaa0000000000000000000000000000000000002/preimage"
DETECT=0
if ( cd "$R" && audit_rr_cache ); then pass "clean cache exits 0"; else fail "clean cache should pass"; fi

###############################################################################
printf '\n=== 2 postimage markers are quarantined, not fatal ===\n'
###############################################################################
R="$T/markers"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/bad0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/bad0000000000000000000000000000000000001/preimage"
conflict_text > "$RR_LIVE/bad0000000000000000000000000000000000001/postimage"
DETECT=0
rc=0
( cd "$R" && audit_rr_cache ) || rc=$?
expect_eq "$rc" "0" "audit exits 0 after quarantining"
expect_true "$([[ -d "$R/.git/rr-cache-quarantine/bad0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "the entry moved to rr-cache-quarantine"
expect_true "$([[ ! -d "$RR_LIVE/bad0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "the entry is gone from the live cache"
expect_true "$(grep -qxF 'bad0000000000000000000000000000000000001' "$R/.git/rr-cache-skip" && echo 0 || echo 1)" \
    "the id is recorded in rr-cache-skip"

###############################################################################
printf '\n=== 3 jest-in-vitest is quarantined ===\n'
###############################################################################
R="$T/jest"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/jest0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/jest0000000000000000000000000000000000001/preimage"
vitest_jest > "$RR_LIVE/jest0000000000000000000000000000000000001/postimage"
( cd "$R" && audit_rr_cache >/dev/null )
expect_true "$([[ -d "$R/.git/rr-cache-quarantine/jest0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "jest-in-vitest entry quarantined"

###############################################################################
printf '\n=== 4 import never overwrites a live entry ===\n'
###############################################################################
R="$T/import"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_REPO/aaa0000000000000000000000000000000000001"
conflict_text > "$RR_REPO/aaa0000000000000000000000000000000000001/preimage"
resolved_text > "$RR_REPO/aaa0000000000000000000000000000000000001/postimage"
mkdir -p "$RR_LIVE/aaa0000000000000000000000000000000000001"
printf 'LIVE\n' > "$RR_LIVE/aaa0000000000000000000000000000000000001/postimage"
( cd "$R" && import_rr_cache >/dev/null )
expect_eq "$(cat "$RR_LIVE/aaa0000000000000000000000000000000000001/postimage")" "LIVE" \
    "live postimage is unchanged after import"

###############################################################################
printf '\n=== 5 import does not reimport a quarantined id ===\n'
###############################################################################
R="$T/skip"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_REPO/skip0000000000000000000000000000000000001"
conflict_text > "$RR_REPO/skip0000000000000000000000000000000000001/preimage"
resolved_text > "$RR_REPO/skip0000000000000000000000000000000000001/postimage"
printf 'skip0000000000000000000000000000000000001\n' > "$R/.git/rr-cache-skip"
( cd "$R" && import_rr_cache >/dev/null )
expect_true "$([[ ! -d "$RR_LIVE/skip0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "quarantined id is not copied into the live cache"

###############################################################################
printf '\n=== 6 export copies preimage/postimage and skips thisimage ===\n'
###############################################################################
R="$T/export"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/exp0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/exp0000000000000000000000000000000000001/preimage"
resolved_text > "$RR_LIVE/exp0000000000000000000000000000000000001/postimage"
printf 'scratch\n' > "$RR_LIVE/exp0000000000000000000000000000000000001/thisimage"
( cd "$R" && export_rr_cache >/dev/null )
expect_true "$([[ -f "$RR_REPO/exp0000000000000000000000000000000000001/postimage" ]] && echo 0 || echo 1)" \
    "postimage exported"
expect_true "$([[ ! -f "$RR_REPO/exp0000000000000000000000000000000000001/thisimage" ]] && echo 0 || echo 1)" \
    "thisimage scratch is not exported"

###############################################################################
printf '\n=== 7 export of a bad entry dies and quarantines ===\n'
###############################################################################
R="$T/refuse"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/ref0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/ref0000000000000000000000000000000000001/preimage"
conflict_text > "$RR_LIVE/ref0000000000000000000000000000000000001/postimage"
rc=0
( cd "$R" && export_rr_cache >/dev/null ) || rc=$?
expect_true "$([[ "$rc" -ne 0 ]] && echo 0 || echo 1)" "export exits non-zero on a bad entry"
expect_true "$([[ -d "$R/.git/rr-cache-quarantine/ref0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "the refused entry was quarantined"
expect_true "$([[ ! -d "$RR_REPO/ref0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "the refused entry was not copied into the committed cache"

###############################################################################
printf '\n=== 8 --detect reports but does not quarantine ===\n'
###############################################################################
R="$T/detect"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/det0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/det0000000000000000000000000000000000001/preimage"
conflict_text > "$RR_LIVE/det0000000000000000000000000000000000001/postimage"
DETECT=1
( cd "$R" && audit_rr_cache >/dev/null )
DETECT=0
expect_true "$([[ -d "$RR_LIVE/det0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "--detect left the bad entry in the live cache"
expect_true "$([[ ! -d "$R/.git/rr-cache-quarantine/det0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "--detect did not quarantine"

###############################################################################
printf '\n=== 9 postimage.1 variants are inspected ===\n'
###############################################################################
R="$T/variant"; mkrepo "$R"; setup_env "$R"
mkdir -p "$RR_LIVE/var0000000000000000000000000000000000001"
conflict_text > "$RR_LIVE/var0000000000000000000000000000000000001/preimage"
resolved_text > "$RR_LIVE/var0000000000000000000000000000000000001/postimage"
conflict_text > "$RR_LIVE/var0000000000000000000000000000000000001/preimage.1"
vitest_jest > "$RR_LIVE/var0000000000000000000000000000000000001/postimage.1"
( cd "$R" && audit_rr_cache >/dev/null )
expect_true "$([[ -d "$R/.git/rr-cache-quarantine/var0000000000000000000000000000000000001" ]] && echo 0 || echo 1)" \
    "a defective postimage.1 variant is quarantined"

echo
if [[ $FAILED -eq 0 ]]; then
    printf 'ALL PASSED\n'
    rm -rf "$T"
    exit 0
fi
printf '%d FAILED\n' "$FAILED"
exit 1
