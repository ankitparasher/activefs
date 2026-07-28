# Declare dynamic path patterns

This example attaches read, metadata, and search handlers to route-like paths
whose concrete IDs are known only at request time.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-fs-tree-dynamic-paths build
node examples/fs-tree-dynamic-paths/dist/index.js
```

## Expected result

The command reads a generated Ada profile, reads the lazy `alpha` note, and
reports `/notes/alpha` as the source-search result.

## Paths

| Pattern | Example concrete path |
|---|---|
| `/users/:id/profile.md` | `/users/ada/profile.md` |
| `/notes/:id` | `/notes/alpha` |

Both patterns are non-enumerable. Name a concrete path to read it, or attach a
tree-owned search handler when the provider can discover authorized matches.

## Limits

The example renders read-only fixture content for any matching parameter. It
does not validate provider IDs, authorize callers, paginate a route space, or
persist writes.

## Next

Use [Dynamic users](../dynamic-users/README.md) for explicit metadata and
non-enumerable traversal behavior.
