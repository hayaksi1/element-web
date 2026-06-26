#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ACTIVE=db8976b1b8fb461895d1
echo "==== [1/3] Pruning stale bundle dirs (keep $ACTIVE) ===="
for base in apps/web/webapp apps/desktop/webapp; do
  for d in "$base"/bundles/*/; do
    name=$(basename "$d")
    if [ "$name" != "$ACTIVE" ]; then echo "  prune $d"; rm -rf "$d"; fi
  done
done
echo "Remaining bundle dirs in apps/desktop/webapp:"; ls -1d apps/desktop/webapp/bundles/*/
echo "==== [2/3] Re-packing webapp.asar ===="
rm -f apps/desktop/webapp.asar
corepack pnpm -C apps/desktop run asar-webapp
du -h apps/desktop/webapp.asar | cut -f1
echo "==== [3/3] Re-packaging unsigned arm64 app ===="
cd "$ROOT/apps/desktop"
CSC_IDENTITY_AUTO_DISCOVERY=false NODE_OPTIONS="--max-old-space-size=8192" \
  ./node_modules/.bin/electron-builder --mac --arm64
echo "==== DONE ===="
ls -la "$ROOT/apps/desktop/dist/mac-arm64/Element.app" >/dev/null 2>&1 && echo "APP_BUILD_OK" || echo "APP_BUILD_FAILED"
