# Changelog

`0.1.1` is ActiveFS's first supported public release. All nine package entries
and their `latest` tags were verified on 2026-07-28.

## 0.1.1 - 2026-07-28

### Highlights

- Gives live application data a programmable file tree. A source can compute a
  file from current application state when it is read while remaining in
  control of paths, content, metadata, visibility, freshness, and writes.
- Supports direct `list`, `stat`, `read`, and `search` operations through the
  installed CLI and Node client. Sources can also handle `ls`, `stat`, `cat`,
  `head`, `tail`, `sed`, `grep`, `rg`, and `find`; ActiveFS uses its built-in
  behavior when a source does not customize a command.
- Reports search as `source`, `scan`, or `mixed`, together with completeness and
  typed reasons for incomplete results. Built-in scan search is
  case-insensitive by default, returns matching lines up to the requested
  limit, and reports when more matches exist.
- Searches nested mounts as one file tree, including a more-specific mount below
  a root-mounted source.
- Carries source commands and request context through the Source API. MCP can
  expose a configured tree to MCP-native clients as an optional access method.
- Lets consumers export current reads as local files or optionally mount a tree
  as an operating-system folder.

### Changes from the public 0.1.0 preview

- ActiveFS now fails when no source is configured instead of loading demo data
  implicitly. The built-in demo requires an explicit option.
- `activefs remote remove <name>` waits for a managed demo Source API process to
  stop before deleting its configuration and local state. Reusing a remote name
  also clears inactive demo runtime markers.
- The mount command uses one canonical signature. On Windows, absent or empty
  directory mountpoints are accepted, while non-empty targets are rejected
  without deleting their contents.

### Requirements and limits

- Node.js 22 or newer is required. All nine public packages use version `0.1.1`
  for this release.
- Direct CLI, Node, MCP, and export workflows do not require host mount
  software. An operating-system mount requires rclone plus macFUSE on macOS,
  FUSE on Linux, or WinFsp on Windows.
- See [current limits](docs/reference/current-limits.md) for filesystem,
  freshness, search, and mount boundaries.

### Documentation

- Adds a first-run path from the demo to a computed file backed by the reader's
  own application data.
- Adds an MCP agent workflow, a portable `use-activefs` agent skill, and a
  Windows guide for PowerShell, export, rclone, WinFsp, and mounted-folder
  troubleshooting.
