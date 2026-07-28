# Declare a finite tree with `fsTree`

This example builds a small known tree from sparse absolute paths, nested
directories, text files, and a computed JSON file.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-fs-tree-basic build
node examples/fs-tree-basic/dist/index.js
```

## Expected result

The command lists `/README.md`, `/data`, and `/docs`, reads the nested intro,
and prints the paths that match `nested`.

## Paths

| Tree path | Result |
|---|---|
| `/README.md` | Markdown declared with `file` |
| `/docs/intro.md` | Text in a nested `dir` |
| `/docs/nested/more.md` | Deeper nested text |
| `/data/status.json` | JSON computed when read |

## Limits

The example calls the tree in process. It is read-only and has no Source API
server, remote state, persistence, or cache layer.

## Next

Use [Dynamic paths](../fs-tree-dynamic-paths/README.md) when the complete path
set is not known in advance.
