#!/usr/bin/env bash
# Install codex-claude-status-bar into the current user's GNOME Shell.
set -euo pipefail

UUID="codex-claude-status-bar@ondrejbecva.cz"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

echo "Installing $UUID"
echo "  from: $SRC_DIR"
echo "  to:   $DEST_DIR"

rm -rf "$DEST_DIR"
mkdir -p "$DEST_DIR"
cp -r "$SRC_DIR/." "$DEST_DIR/"

# Compile the GSettings schema so preferences work.
glib-compile-schemas "$DEST_DIR/schemas"

# Enable it (ignore failure if gnome-extensions is unavailable, e.g. headless).
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" || true
fi

echo
echo "Installed. On Wayland you must log out and back in for GNOME Shell to load"
echo "the extension (Alt+F2 -> 'r' only works on X11)."
