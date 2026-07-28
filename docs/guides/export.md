# Export files

Use `activefs export` when an editor, build tool, language server, or review
workflow needs normal local files instead of direct ActiveFS paths.

Export copies the bytes available during that run. It does not create a live
folder or automatically write local edits back to the source.

## Before you start

You need:

- a configured source, such as the remote `repo`;
- an ActiveFS path to copy, such as `/repo` or `/repo/docs`;
- write access to a local destination directory.

Keep the two path types distinct:

- `/repo` is the source path inside ActiveFS;
- `exported-repo` is a destination on the local OS filesystem.

## Export a tree

Copy the remote tree:

```console
$ activefs export /repo --to exported-repo

Exported <N> files to exported-repo
```

Export preserves the selected ActiveFS namespace. Exporting `/repo` produces
this local layout:

```text
exported-repo/
  activefs-export-manifest.json
  repo/
    README.txt
    ...
```

Verify the copied files with ordinary local tools on macOS or Linux:

```bash
ls exported-repo/repo
cat exported-repo/repo/README.txt
rg ActiveFS exported-repo/repo
```

Or use Windows PowerShell:

```powershell
Get-ChildItem .\exported-repo\repo
Get-Content .\exported-repo\repo\README.txt
Get-ChildItem .\exported-repo\repo -Recurse -File |
  Select-String -Pattern "ActiveFS"
```

To copy only a subtree:

```bash
activefs export /repo/docs --to docs-copy
```

## Inspect the manifest

Every CLI export writes `activefs-export-manifest.json` at the destination
root. It records the source and destination, start and completion times,
consistency mode, file sizes and SHA-256 digests, optional revisions, warnings,
and failures.

A normal export has `"consistency": "live"`. ActiveFS reads files in separate
requests, so files can observe different source revisions if the source changes
during the run. The manifest warns that this is a live multi-request copy, not
a stable server snapshot.

See [Current limits](../reference/current-limits.md) for the snapshot boundary
and [CLI reference](../reference/cli.md) for command options.

## Request one tree revision

If the source reports a stable revision on every read, request it explicitly:

```bash
activefs export /repo --to exported-repo-rev --tree-revision rev-123
```

The resulting manifest uses `"consistency": "revision-pinned"` only when every
exported file proves `rev-123`. The command fails if a file cannot prove the
requested revision.

Do not pass `--tree-revision` merely to label an otherwise live copy; the
source must provide matching revision metadata.

## Export a known dynamic path

Recursive export discovers files through listings, so it cannot discover a
non-enumerable route. Name a known concrete path instead:

```bash
activefs export /repo/users/ada.md --to ada-profile
```

The source still decides whether that path exists and whether the current
request may read it.

## Fix common export problems

### Files are one directory deeper than expected

That is expected for `activefs export /repo --to exported-repo`. The command
preserves `/repo` under the destination, so the files start at
`exported-repo/repo/`.

### Exporting `/` is rejected

The CLI rejects an ambiguous host-root export with:

```text
Refusing ambiguous host-root export of /.
```

Name a configured remote path such as `/repo`. This keeps the ActiveFS source
path distinct from the host filesystem root.

### A live export contains different revisions

The source changed between reads. Use `--tree-revision REV` only if the source
can report and preserve that revision for every file.

## Next

Use [Mounted folder](mounted-folder.md) when a tool needs a continuously
available OS path instead of a copied tree.
