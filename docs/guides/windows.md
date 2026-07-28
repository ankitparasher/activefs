# Use ActiveFS on Windows

Use this guide when you run ActiveFS from PowerShell. Direct ActiveFS commands,
MCP, the TUI, and export work without WinFsp or rclone. Install those two tools
only when another program requires a mounted Windows folder.

## Install ActiveFS

ActiveFS requires Node.js 22 or newer:

```powershell
node --version
npm install -g activefs
activefs --help
```

Run ActiveFS from the project directory whose `.activefs` configuration you
want to use.

## Use direct ActiveFS paths

ActiveFS namespace paths always use forward slashes, including on Windows:

```powershell
activefs remote add repo --demo --port 3999
activefs list /repo
activefs read /repo/README.txt
activefs grep "Source" /repo
```

These commands talk directly to the configured source. They do not use a
Windows drive, WinFsp, or rclone.

Use backslashes only for normal Windows paths. For example, `/repo/README.txt`
is an ActiveFS path, while `.\exported-repo\repo\README.txt` is a local file.

## Set environment variables in PowerShell

Use `$env:NAME` instead of the POSIX `NAME=value command` or `export NAME=value`
forms:

```powershell
$env:ACTIVEFS_SOURCE_TOKEN = "dev-token"
activefs auth set repo --env ACTIVEFS_SOURCE_TOKEN
```

Remove a temporary value when finished:

```powershell
Remove-Item Env:ACTIVEFS_SOURCE_TOKEN
```

## Export local files

Export is the portable choice when a program needs ordinary local files but
does not need a live mounted view:

```powershell
activefs export /repo --to exported-repo
Get-ChildItem .\exported-repo\repo
Get-Content .\exported-repo\repo\README.txt
Get-ChildItem .\exported-repo\repo -Recurse -File |
  Select-String -Pattern "Source"
```

## Install optional mount support

Windows mounts use rclone and WinFsp. Install rclone from an ordinary
PowerShell session:

```powershell
winget install Rclone.Rclone
```

Install WinFsp from the [official WinFsp download page](https://winfsp.dev/rel/).
The [rclone Windows installation guide](https://rclone.org/install/#windows-installation)
also documents manual, Winget, Chocolatey, and Scoop options.

Open a new PowerShell session after installation, then verify the host:

```powershell
rclone version
activefs doctor --mounts
```

Both rclone and WinFsp must report ready. Run the mount from a normal,
non-administrator PowerShell session so the resulting folder is visible to the
same desktop user and applications.

## Mount a remote as a Windows folder

The target may be absent or an empty directory. ActiveFS removes an empty
target immediately before starting rclone because WinFsp creates the mounted
directory. ActiveFS rejects a non-empty target and leaves its contents alone.

```powershell
activefs mount repo .\repo
activefs mount status repo
```

Use normal PowerShell filesystem commands after the mount is active:

```powershell
Get-ChildItem .\repo
Get-Content .\repo\README.txt
Get-ChildItem .\repo -Recurse -File | Select-String -Pattern "Source"
```

These cmdlets are not ActiveFS subcommands. They read through WinFsp, rclone,
and the ActiveFS WebDAV adapter. `Select-String` scans mounted files on the
client; use `activefs grep` when you want source-aware search.

Unmount when finished:

```powershell
activefs unmount repo
```

## Troubleshoot a Windows mount

If `activefs doctor --mounts` reports a missing component, fix rclone or WinFsp
before retrying. Direct ActiveFS commands and export remain available while
mount support is unavailable.

If ActiveFS reports that the target is not empty, choose an absent or empty
directory. ActiveFS never deletes files from a non-empty mount target.

If a mount created from an administrator shell is not visible to Explorer or a
normal application, unmount it and start it again from a non-administrator
PowerShell session. Windows separates elevated and normal-user mount
visibility.

For stale data or interrupted runtime state, follow [Mounted folder
recovery](mounted-folder.md#recover-a-stale-or-interrupted-mount).

## Continue

- [Mount an ActiveFS remote](mounted-folder.md)
- [Export local files](export.md)
- [Configure MCP](mcp.md)
- [Supported environments](../reference/supported-environments.md)
- [Troubleshooting](../troubleshooting.md)
