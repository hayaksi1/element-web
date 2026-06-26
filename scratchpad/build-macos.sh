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

# Inject config.json into the webapp BEFORE packing the asar. The webpack build (`nx build`) does NOT
# emit a config.json, and the canonical desktop build copies one in via fetch-package.ts's `-d <cfgdir>`
# step (<cfgdir>/config.json -> webapp/config.json). Without this the app ships configless and boots to
# "Invalid configuration: no default server specified" — never reaching the welcome/login page.
CFG="$ROOT/apps/web/config.json"
if [ ! -f "$CFG" ]; then
    echo "WARN: $CFG missing — writing offline-safe default (matrix.org default, custom URLs allowed)"
    cat > "$CFG" <<'JSON'
{
    "default_server_config": { "m.homeserver": { "base_url": "https://matrix-client.matrix.org", "server_name": "matrix.org" } },
    "disable_custom_urls": false,
    "brand": "Element"
}
JSON
fi
cp "$CFG" apps/desktop/webapp/config.json
echo "Injected config.json into webapp:"
cat apps/desktop/webapp/config.json

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
