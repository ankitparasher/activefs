# Browse with the TUI

Use the terminal UI to browse and preview a configured ActiveFS source, run a
direct search, export a selected path, or inspect local runtime health without
leaving the terminal.

The browser uses ActiveFS paths directly. A mounted OS folder is not required.

## Start the TUI

Confirm that the current workspace has a remote:

```bash
activefs remote list
activefs tui
```

To explore the UI without configuring a remote, select the explicit built-in
example:

```bash
activefs tui --source example
```

The TUI does not silently fall back to that example. If no source is configured,
it tells you to add a remote, pass `--source`, or use `--source example`.

`--debug` adds source details and local cache paths to the TUI. Enable it only
when those diagnostics are useful:

```bash
activefs tui --debug
```

## Browse and preview files

1. Press `tab` until **Browser** is selected.
2. Move with `j`/`k` or the arrow keys.
3. Press `enter` to open a directory or preview a file.
4. Press `backspace` or `escape` to return to the parent.
5. Press `p` to cycle the configured browser sources.

The Browser screen shows direct ActiveFS paths such as
`/repo/README.txt`. Those are not OS paths such as `./repo/README.txt`.

Press `y` to copy the selected ActiveFS path.

## Search and export

Press `/`, enter a pattern, and submit it. Search starts at the current Browser
path. On the Search screen:

- `enter` returns to the matching location in Browser;
- `y` copies the selected match path.

On the Browser screen, press `m` to export the selected path. Exported files go
under the OS directory `.activefs/exports/` by default. The selected path stays
an ActiveFS path; the export directory is a local OS path.

For repeatable scripted work, use the equivalent direct commands:

```bash
activefs grep TODO /repo
activefs export /repo --to exported-repo
```

## Inspect runtime state

The screens have distinct jobs:

| Screen | Use it for |
|---|---|
| Health | Source reachability plus session, freshness, mount, cache, operation, and activity summaries |
| Remotes | Add, edit, remove, or test Source API remotes |
| Mounts | Start or inspect the optional mounted-folder adapter |
| Cache | Inspect or clear mounted-folder cache state |
| Browser | List, preview, copy, and export ActiveFS paths |
| Search | Inspect direct ActiveFS search results and strategy |
| Logs | Read local mount-adapter logs |
| Settings | Inspect workspace and export roots |

WebDAV and rclone appear as local mounted-folder internals. They are not the
remote Source API.

## Use the main keys

| Key | Action |
|---|---|
| `tab` / `shift-tab` | Switch screens |
| `j` / `k` or arrows | Move selection |
| `enter` | Test a remote, open a Browser entry, or open a search result |
| `r` | Refresh |
| `/` | Search from the current Browser path |
| `m` | Mount on the Mounts screen or export on the Browser screen |
| `y` | Copy a Browser or Search path |
| `d` | Save a redacted diagnostic snapshot |
| `?` | Open in-app help |
| `q` / `ctrl-c` | Quit |

Remote removal, cache clearing, and other destructive actions require
confirmation. Press `?` for the screen-specific keys.

## Save diagnostics

Press `d` to write a redacted JSON snapshot under
`.activefs/diagnostics/`. It contains runtime status needed for debugging but
omits raw credentials and file contents.

## Fix common TUI problems

### `No ActiveFS sources are configured`

Run `activefs remote list` from the same workspace. Add or reconnect the
intended remote, or launch the explicit fixture:

```bash
activefs tui --source example
```

### Mount controls are unavailable

Direct browsing, search, and export do not need a mount. If you specifically
need the Mounts screen, check host prerequisites:

```bash
activefs doctor --mounts
```

### The wrong workspace appears

Run the TUI from the workspace whose `.activefs` state you want, or pass the
same `--state-root` used by the other commands.

## Next

Use [Choose how to use an ActiveFS tree](access-surfaces.md) to compare the TUI,
direct CLI, export, MCP, and a mounted OS folder.
