# Codex Claude Status Bar

A GNOME Shell extension that shows your **Claude** and **Codex** AI usage limits
— session (5h) and weekly (7d) — directly in the top panel.

Panel looks like: `Claude 5h X% / 7d Y%  │  Codex 5h X% / 7d Y%`

> **Fork of [`brainusage`](https://github.com/AltairInglorious/brainusage) by
> AltairInglorious** (MIT). This fork exists to fix Codex reporting after OpenAI
> changed its usage API — see [What's different](#whats-different).

## What it does

- Polls Claude and Codex usage endpoints on an interval.
- Panel shows remaining % per provider, colour-coded green → yellow → red.
- Click the indicator for a breakdown popup (per-window %, reset countdown),
  a manual **Refresh**, icon-style toggles, and layout options.
- Desktop notification when a window crosses a low-remaining threshold.

Credentials are read from the files the official CLIs already write — nothing to
configure:

| Provider | Credentials file      |
| -------- | --------------------- |
| Claude   | `~/.claude*` (OAuth)  |
| Codex    | `~/.codex/auth.json`  |

## What's different

OpenAI changed the Codex usage schema
(`https://chatgpt.com/backend-api/wham/usage`). The response now delivers the
**7-day weekly window as `primary_window`** (`limit_window_seconds: 604800`) and
often leaves `secondary_window: null`. Upstream assumed a fixed layout
(`primary_window` = 5h session, `secondary_window` = 7d weekly) and hard-failed
with `partial_data` whenever the secondary window was missing — so the Codex
session/weekly readouts were mislabelled and the weekly bar stuck at 0 % / red.

This fork rewrites `normalizeCodexUsage` to **classify each window by its own
`limit_window_seconds`** (< 1 day → session, ≥ 1 day → weekly) instead of trusting
slot position, and treats a single-window response as valid rather than partial
data. It works with both the old and new schema shapes. See
`src/lib/core/normalize.js`.

## Requirements

- GNOME Shell 45–50 (Wayland or X11)
- `glib-compile-schemas` (from `glib2` / `libglib2.0-dev`)

## Install

### Quick install on a new machine (prebuilt zip)

Download the latest release zip and install it — no clone, no build:

```bash
curl -LO https://github.com/ondrejbecva/codex-claude-status-bar/releases/latest/download/codex-claude-status-bar@ondrejbecva.cz.shell-extension.zip
gnome-extensions install --force codex-claude-status-bar@ondrejbecva.cz.shell-extension.zip
gnome-extensions enable codex-claude-status-bar@ondrejbecva.cz
```

Then **log out and back in** (Wayland). Sign in to the Claude Code / Codex CLIs
at least once so their credential files exist.

### From source (recommended for development)

```bash
git clone https://github.com/ondrejbecva/codex-claude-status-bar.git
cd codex-claude-status-bar
./install.sh
```

Then **log out and back in** (Wayland cannot hot-reload extension code; on X11
you can `Alt+F2` → `r`). Enable it if needed:

```bash
gnome-extensions enable codex-claude-status-bar@ondrejbecva.cz
```

### As a packaged zip

```bash
./pack.sh
gnome-extensions install --force dist/codex-claude-status-bar@ondrejbecva.cz.shell-extension.zip
```

### Uninstall

```bash
./uninstall.sh
```

## Configuration

Open the indicator's popup menu:

- **Per-provider panel layout** — ON (default) shows both providers side by
  side, each with `5h X% / 7d Y%` and its icon (a provider is hidden when it has
  no data). OFF collapses to a single label chosen in *Panel display*.
- **Panel display** — what the single-label mode shows. Default is `combined`
  (`5h X% / 7d Y%`, worst-case across both providers per window). Other options:
  `min` (lowest % across everything) or a specific metric (Claude/Codex ×
  session/weekly, plus Claude Fable).
- **Show Claude Fable usage** — when on, the Claude panel group gains a
  `F Z%` segment in the top bar (per-provider layout), the popup Claude section
  gains a **Fable** row, and the *Claude Fable* single-label metric unlocks.
  Reads Claude's model-scoped weekly cap (the `weekly_scoped` limit whose model
  display name is "Fable"). Off by default; the top-bar segment appears only
  when your account actually reports a Fable limit.
- **Colorize percentages** — colour the panel numbers by remaining %.
- **Colored icons** / **Claude icon** — brand colour vs mono; starburst vs
  brackets mark.

## Layout

```
src/                  # the installable extension (copied to ~/.local/share/gnome-shell/extensions/<uuid>)
  extension.js        # panel indicator + popup UI
  lib/core/           # scheduler, state, aggregate, normalize (schema parsing), notifications
  lib/providers/      # claude.js, codex.js — fetch + refresh tokens
  lib/runtime/        # fetch + file-read shims
  lib/ui/render.js    # view-model builder
  schemas/            # GSettings schema
  icons/              # provider SVGs
install.sh  uninstall.sh  pack.sh
```

## Credits & license

- Original work: **[brainusage](https://github.com/AltairInglorious/brainusage)**
  by AltairInglorious.
- Fork, Codex schema fix, and packaging: Ondřej Bečva.

MIT — see [LICENSE](LICENSE). Both copyright notices are retained.
