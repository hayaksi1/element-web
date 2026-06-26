#!/usr/bin/env bash
# Clean, from-scratch macOS Element Desktop build.
# Per user request: remove node_modules + dist, reinstall deps, rebuild everything, with config.json
# baked into the webapp (fix for "Invalid configuration: no default server specified").
# Preserves apps/desktop/.hak (native matrix-seshat module — avoids a slow Rust rebuild) and the global
# pnpm store + ~/Library/Caches/electron (so install/electron need not re-download everything).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# The root postinstall calls bare `pnpm`; make sure it resolves (nvm bin is normally on PATH already).
if ! command -v pnpm >/dev/null 2>&1; then
    SHIM="$(mktemp -d)"
    printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$SHIM/pnpm"
    chmod +x "$SHIM/pnpm"
    export PATH="$SHIM:$PATH"
    echo "Added pnpm shim at $SHIM"
fi
echo "pnpm: $(command -v pnpm)  ($(pnpm --version))"

echo "==== [0/6] CLEAN — removing node_modules + dist + stale build artifacts ===="
date
rm -rf node_modules apps/*/node_modules packages/*/node_modules modules/*/node_modules
rm -rf apps/desktop/dist apps/desktop/webapp apps/desktop/webapp.asar apps/desktop/lib apps/web/webapp
echo "Preserved: apps/desktop/.hak (native seshat), apps/desktop/deploys, global pnpm/electron caches."

echo "==== [1/6] pnpm install (from scratch) ===="
date
pnpm install

echo "==== [2/6..6/6] Renderer build + config inject + asar + desktop TS + package ===="
date
# Delegate the rest to the (now config-injecting) build script.
exec "$ROOT/scratchpad/build-macos.sh"
