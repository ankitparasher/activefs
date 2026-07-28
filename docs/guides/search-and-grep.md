# Search and grep

Use `activefs grep` to search a configured source directly. Use ordinary
`rg` or `grep` only after the files exist at an OS path through export or a
mounted folder.

This guide assumes a remote named `repo` is already configured.

## Run a direct search

Pass the pattern first and an ActiveFS path second:

```console
$ activefs grep Source /repo

# activefs grep: scan
/repo/notes/source-api.txt:1:1:Source API exposes a generic HTTP tree service.
/repo/README.txt:1:30:Hello from the ActiveFS demo Source API.
```

`/repo` is an ActiveFS path. It does not mean `./repo` exists on local disk.
Each text result uses `path:line:column:excerpt`.

Search is case-insensitive by default:

```bash
activefs grep source /repo
```

Require exact letter case with:

```bash
activefs grep Source /repo --case-sensitive
```

## Get structured results

Use JSON for scripts and agents:

```bash
activefs grep Source /repo --json
```

The result identifies its `strategy` and whether it is `complete`, followed by
the normalized query and matches. See the [CLI reference](../reference/cli.md)
for the output contract.

Limit the number of matches:

```bash
activefs grep TODO /repo --limit 50
```

Ask the source to include non-enumerable entries when it can expose them:

```bash
activefs grep TODO /repo --include-non-enumerable
```

That flag cannot invent concrete dynamic paths. The source must expose or
search those paths safely.

## Read the strategy label

The first output line explains how ActiveFS produced the result:

- `source`: the source handled search;
- `scan`: ActiveFS traversed readable, enumerable files with list and read;
- `mixed`: source results and scanning were combined.

An `incomplete` label means a limit, timeout, unreadable path, or incomplete
source result prevented a full answer. Use `--json` when you need the typed
reason.

## Choose direct search or an OS tool

| Files are available as | Use | Example |
|---|---|---|
| ActiveFS paths | `activefs grep` | `activefs grep TODO /repo` |
| Exported OS files | `rg`, `grep`, or PowerShell `Select-String` | `rg TODO ./exported-repo/repo` or `Get-ChildItem .\exported-repo\repo -Recurse -File \| Select-String TODO` |
| Mounted OS files | `rg`, `grep`, or PowerShell `Select-String` | `rg TODO ./repo` or `Get-ChildItem .\repo -Recurse -File \| Select-String TODO` |

A mounted `rg`, `grep`, or PowerShell `Select-String` process makes ordinary
directory and file reads through the OS adapter. It does not send an ActiveFS
grep command or its flags to the source. Use `activefs grep` when you want
source-owned search, OCR, an index, or the reported strategy.

## Search a smaller scope

Point the command at a subtree:

```bash
activefs grep TODO /repo/docs
```

For a known dynamic file, search that concrete path:

```bash
activefs grep Analyst /repo/users/ada.md
```

Scan cannot discover a non-enumerable route from its parent. See
[Dynamic routes](dynamic-routes.md) for the resolvable-versus-enumerable
behavior.

## Fix common search problems

### No matches are returned

Confirm the scope and one expected file first:

```bash
activefs list /repo
activefs read /repo/README.txt
```

An empty result means that query returned no matches. It does not prove the
source has no other searchable content.

### The output says `scan`

The source did not handle search for that scope. Scan is suitable for ordinary
enumerable text trees. Large, binary, indexed, or dynamic sources may need a
source-owned search handler.

### Mounted `rg` is slow

Mounted search reads files through the OS adapter and its cache. Run
`activefs grep` against the ActiveFS path to use direct source-aware search.

## Next

Use [Export files](export.md) when the matching files must become normal local
files.
