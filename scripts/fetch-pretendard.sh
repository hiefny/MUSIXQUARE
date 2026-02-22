#!/usr/bin/env bash
set -euo pipefail

# Fetch Pretendard font files for self-hosting.
# Output: /fonts

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FONTS_DIR="${ROOT_DIR}/fonts"
mkdir -p "${FONTS_DIR}"

echo "Downloading Pretendard (v1.3.9) variable font..."
curl -L -o "${FONTS_DIR}/PretendardVariable.woff2" "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff2/PretendardVariable.woff2"

# Optional fallback (larger, older browsers):
# curl -L -o "${FONTS_DIR}/PretendardVariable.woff" "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/woff/PretendardVariable.woff"

echo "Downloading license..."
curl -L -o "${FONTS_DIR}/PRETENDARD_LICENSE.txt" "https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/LICENSE.txt"

echo "Done."
echo "Now serve the site and verify the font loads (Network tab should show PretendardVariable.woff2)."
