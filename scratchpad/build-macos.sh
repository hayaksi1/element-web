#!/usr/bin/env bash
# Build the unsigned macOS Element Desktop app from the LOCAL renderer (apps/web) so it contains the
# search Phase 7 fixes. Mirrors memorybank/element-desktop-build-recipe.md but builds the local webapp
# instead of fetching the prebuilt develop bundle.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
echo "==== [1/5] Building local renderer (apps/web webpack --mode production) ===="
date
corepack pnpm -C apps/web build

echo "==== [2/5] Staging local webapp into apps/desktop/webapp ===="
rm -rf apps/desktop/webapp
cp -R apps/web/webapp apps/desktop/webapp
ls apps/desktop/webapp/index.html

echo "==== [3/5] Packing webapp.asar ===="
rm -f apps/desktop/webapp.asar
corepack pnpm -C apps/desktop run asar-webapp
ls -la apps/desktop/webapp.asar

echo "==== [4/5] Desktop main-process TS + resources ===="
cd "$ROOT/apps/desktop"
./node_modules/.bin/tsc
node scripts/copy-res.ts

echo "==== [5/5] Packaging unsigned arm64 app (electron-builder) ===="
CSC_IDENTITY_AUTO_DISCOVERY=false NODE_OPTIONS="--max-old-space-size=8192" \
  ./node_modules/.bin/electron-builder --mac --arm64

echo "==== DONE ===="
date
ls -la "$ROOT/apps/desktop/dist/mac-arm64/Element.app" 2>/dev/null && echo "APP_BUILD_OK" || echo "APP_BUILD_FAILED"
