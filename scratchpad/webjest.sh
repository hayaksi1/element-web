#!/usr/bin/env bash
# Web (apps/web) jest runner with the matrix-js-sdk ESM transform workaround.
#
# Why: node_modules is installed in pnpm's *symlinked* `.pnpm` layout, but apps/web/jest.config.ts's
# `transformIgnorePatterns` is written for a *hoisted* layout, so TS-source matrix-js-sdk is excluded from
# babel transform and every test dies in setupTests.ts with "Cannot use import statement outside a module".
# Fix (no committed change): override `transformIgnorePatterns` on the CLI to allowlist matrix-js-sdk (+ the
# matrix family) WHILE keeping the package's existing allowlist entries — crucially @element-hq/web-shared-components,
# whose dist ESM is imported by the search-header tests. Must use `corepack pnpm -C apps/web exec jest`
# (the ./node_modules/.bin/jest form mis-resolves the babel config). See memorybank/activity-log.md.
#
# Usage: scratchpad/webjest.sh <jest-args...>   e.g. scratchpad/webjest.sh RoomSearchAuxPanel
set -euo pipefail
cd "$(dirname "$0")/.."

ALLOW='matrix-js-sdk|matrix-events-sdk|@matrix-org|oidc-client-ts|jwt-decode|mime|uuid|p-retry|is-network-error|react-merge-refs|is-ip|ip-regex|super-regex|function-timeout|time-span|convert-hrtime|clone-regexp|is-regexp|matrix-web-i18n|await-lock|@element-hq/web-shared-components|react-virtuoso|lodash|domutils|domhandler|domelementtype|dom-serializer|entities'

corepack pnpm -C apps/web exec jest "$@" --transformIgnorePatterns "node_modules/.pnpm/(?!($ALLOW)).+\$"
