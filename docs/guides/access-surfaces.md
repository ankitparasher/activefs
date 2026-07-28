# Choose how to use an ActiveFS tree

Start with direct ActiveFS commands. Choose another method only when the
consumer requires application APIs, MCP resources, local files, an interactive
browser, or OS-visible paths.

Every method reads the same source-owned tree. The choice changes how the
consumer reaches the tree; it does not change who controls the data or access
rules.

## Choose by consumer need

| Consumer need | Choose | Why | Guide or reference |
|---|---|---|---|
| Inspect, script, troubleshoot, or search a configured tree | Direct commands | Lowest setup and the clearest view of ActiveFS behavior | [CLI reference](../reference/cli.md) |
| Read the tree from Node.js application code | Programmatic client | Filesystem-like methods without an OS mount | [Core API](../reference/core-api.md#logical-client) |
| Give an MCP-native agent browsable resources and generic read tools | MCP | Lets an agent explore the tree selectively through MCP | [MCP guide](mcp.md) |
| Give a build, editor, or review tool ordinary local files | Export | Creates a local copy without mount prerequisites | [Export guide](export.md) |
| Browse remotes and diagnostics interactively | TUI | Combines navigation and operational state in one terminal UI | [TUI guide](tui.md) |
| Give a tool live OS-visible paths | Mounted folder | Supports consumers that require normal filesystem calls | [Mounted-folder guide](mounted-folder.md) |

If two options could work, prefer the one higher in the table. Mounting has the
most host-specific prerequisites and should be reserved for tools that truly
need OS paths.

All methods that do not require a mount work from PowerShell. See [Use ActiveFS on
Windows](windows.md) for Windows path syntax and optional rclone plus WinFsp
mount setup.

## Use direct commands as the default

Direct commands are the best first check because they need no mount software
and expose the ActiveFS path explicitly. Use them to confirm that a remote can
list, stat, read, or search the intended data before adding another adapter.

For a runnable first loop, use the [quickstart](../quickstart.md). For exact
command syntax, use the [CLI reference](../reference/cli.md).

## Keep the path forms distinct

The same source can appear in several forms:

- `/repo/status.json` is an ActiveFS path used by direct commands and runtime
  APIs.
- `activefs://repo/status.json` is an MCP resource URI.
- `./repo/status.json` is an OS path only after a mounted folder exists.
- An exported file is a local copy, not a live remote path.

See [Path syntax](../path-syntax.md) for the exact forms and
[Cache and freshness](cache-and-freshness.md) for the freshness implications.

## Remember the authority boundary

No access method grants more authority than the source provides. The source
still decides which paths exist, which bytes a caller can read, how fresh they
are, and whether a mutation commits.

For adapter implementation contracts rather than user choice, use the
[Access adapter reference](../reference/access-adapters.md).
