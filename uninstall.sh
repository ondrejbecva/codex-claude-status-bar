#!/usr/bin/env bash
# Remove codex-claude-status-bar from the current user's GNOME Shell.
set -euo pipefail

UUID="codex-claude-status-bar@ondrejbecva.cz"
DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" || true
fi

rm -rf "$DEST_DIR"
echo "Removed $DEST_DIR"
echo "Log out and back in (Wayland) to fully unload it from the running shell."
