#!/usr/bin/env bash
# Build a distributable GNOME Shell extension zip in dist/.
# The resulting zip installs with:  gnome-extensions install --force <zip>
set -euo pipefail

UUID="codex-claude-status-bar@ondrejbecva.cz"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$ROOT/src"
OUT_DIR="$ROOT/dist"

mkdir -p "$OUT_DIR"

# Collect the extra source trees so gnome-extensions packs lib/ and icons/ too.
gnome-extensions pack "$SRC_DIR" \
    --force \
    --out-dir "$OUT_DIR" \
    --extra-source=lib \
    --extra-source=icons

echo "Built $OUT_DIR/$UUID.shell-extension.zip"
