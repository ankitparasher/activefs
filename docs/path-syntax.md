# Path syntax

ActiveFS has a few path forms because the same source can be addressed as an
HTTP service, an ActiveFS tree path, a mounted OS path, or an MCP resource.

| Form | Example | Where you use it |
|---|---|---|
| Source API discovery URL | `http://127.0.0.1:3999/_activefs/` | The exact URL passed to `activefs remote add repo URL`. |
| ActiveFS path | `/repo/notes/source-api.txt` | Direct CLI, TUI, export, and runtime operations after the remote is configured. |
| Mounted OS path | `./repo/notes/source-api.txt` | Ordinary shell, editor, and tool access after `activefs mount repo ./repo`. |
| MCP URI | `activefs://repo/notes/source-api.txt` | MCP clients reading configured ActiveFS resources. |
| Remote-qualified selector | `repo:/notes/source-api.txt` | Selector-based commands such as `activefs export` and `activefs refresh`. |

## Source API discovery URL

The URL returns the discovery document for the tree. ActiveFS preserves it
exactly and follows the operation URLs advertised in the response:

```bash
activefs remote add repo http://127.0.0.1:3999/_activefs/
```

The `startActiveFSServer` Node helper uses the shown path by default. It is not
a required Source API prefix.

## ActiveFS path

After the remote is configured, direct ActiveFS commands use the remote's
logical path. Start by listing the remote root:

```bash
activefs list /repo
```

Then read a file by its ActiveFS path:

```bash
activefs read /repo/README.txt
```

Search and export are separate follow-up checks, not required setup steps:

```bash
activefs grep generated /repo
```

```bash
activefs export /repo --to exported-repo
```

## Mounted OS path

Mounting creates a normal local folder for tools that need OS paths:

```bash
activefs mount repo ./repo
```

After the mount is running, shell commands use the visible folder. On macOS or
Linux, these checks are independent:

```bash
ls ./repo
```

```bash
cat ./repo/README.txt
```

```bash
grep -R generated ./repo
```

The equivalent Windows PowerShell checks are:

```powershell
Get-ChildItem .\repo
Get-Content .\repo\README.txt
Get-ChildItem .\repo -Recurse -File | Select-String -Pattern "generated"
```

On Windows, ActiveFS namespace paths still use forward slashes, such as
`/repo/README.txt`. Backslashes belong only to the OS-visible path, such as
`.\repo\README.txt`. The PowerShell commands read through rclone and WinFsp;
ActiveFS does not parse the cmdlet names. See [Use ActiveFS on
Windows](guides/windows.md) for the complete Windows workflow.

## MCP URI

MCP resources use URI form:

```txt
activefs://repo/README.txt
```

## Remote-qualified selector

The `repo:/path` form names a configured remote independently of its mounted
ActiveFS path. Use it only with commands that document a remote-qualified
selector:

```bash
activefs export repo:/notes --to exported-notes
activefs refresh repo:/notes --recursive
```

Use `/repo/...` with normal namespace commands such as `list`, `read`,
`grep`, and `tui`.
