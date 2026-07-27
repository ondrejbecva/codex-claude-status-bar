# Platforms

`core/` holds everything that fetches, parses and decides. It imports no
platform API. Each directory here is a *shell*: it supplies a runtime (how to
make an HTTP request, how to read a file) and a way to draw.

| | Shell | Status |
| --- | --- | --- |
| **Linux / GNOME** | `platforms/gnome/` + `src/extension.js` | Shipping |
| **macOS** | `platforms/xbar/` | Working — needs Node |
| **Any OS, scripting** | `platforms/cli/` | Working — needs Node |
| **Windows** | — | Not built; see below |
| **Linux / KDE** | — | Not built |

## macOS — menu bar via xbar

A plugin is just an executable script: xbar runs it, reads stdout, and draws
it. No app bundle, no Swift, no code signing.

1. Install [xbar](https://xbarapp.com) (or [SwiftBar](https://swiftbar.app),
   same format) and Node 18+.
2. Clone this repository somewhere permanent.
3. Symlink the plugin into the plugin folder:

```bash
ln -s "$PWD/platforms/xbar/ai-usage.3m.js" \
  ~/Library/Application\ Support/xbar/plugins/ai-usage.3m.js
```

Node resolves symlinks to their real path before resolving imports, so the
plugin finds `core/` inside the clone. Keep the clone where it is.

The `3m` in the filename *is* the refresh interval — rename the file to
`ai-usage.5m.js` for five minutes. To show Claude's Fable cap, set
`SHOW_FABLE = true` at the top of the plugin.

Credentials are read from the same paths the CLIs already write:
`~/.claude/.credentials.json` and `~/.codex/auth.json`.

## Any OS — command line

```bash
node platforms/cli/usage.js          # human readable
node platforms/cli/usage.js --json   # the raw summary
node platforms/cli/usage.js --fable  # include Claude's Fable cap
```

Exits non-zero when no provider returned usable data, so a caller can tell
"everything failed" from "here are the numbers" without parsing anything.

`--json` is the seam for any shell not written yet — a tray app, a prompt
segment, a Raycast script, a cron job.

## Windows — not built yet

The plan is a tray icon that opens a small panel on click. What exists already:
`core/` runs unchanged under Node, `platforms/node/runtime.js` supplies the
shims, and `platforms/cli/usage.js --json` gives a tray process its data
without it needing to know anything about OAuth or usage schemas.

What is missing is the tray shell itself. The options, roughly:

- **Node + a tray package** (`systray2` or similar) — one language for the whole
  project, but adds the repository's first runtime dependency, and shipping it
  means bundling Node with `bun build --compile` or Node's SEA so users are not
  asked to install a runtime.
- **PowerShell + `System.Windows.Forms.NotifyIcon`** — ships with Windows, so no
  bundling at all; it shells out to the CLI above for data. Least to install,
  most awkward to maintain.
- **Rust `tray-icon` + `tao`** — a single small static binary, but the usage
  logic would have to be reimplemented or driven as a subprocess.

Credential paths on Windows are `%USERPROFILE%\.claude\.credentials.json` and
`%USERPROFILE%\.codex\auth.json`; `platforms/node/runtime.js` already resolves
`~/` through `os.homedir()`, so no change is needed there.
