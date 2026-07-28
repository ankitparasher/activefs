# Resolve dynamic user paths

This example reads a user profile by exact path while keeping the route
non-enumerable. It also shows an explicit search that opts into the tree's
non-enumerable entries.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-dynamic-users build
node examples/dynamic-users/dist/index.js
```

## Expected result

The command prints the generated `# Ada` profile and:

```text
recursive matches: 2
```

The example calls the tree directly; it does not start a Source API server.

## Paths

| Tree path | Result |
|---|---|
| `/users` | Dynamic-user namespace with an explicit `ada` listing hint |
| `/users/ada.md` | Generated profile read by exact path |
| `/users/:id.md` | Non-enumerable path pattern |

## Limits

The fixture accepts alphanumeric and hyphenated IDs and renders them in memory.
It has no provider lookup, authorization, pagination, write support, or search
index. A real source must authorize each concrete path.

## Next

Follow [Build dynamic routes](../../docs/guides/dynamic-routes.md) for a
standalone Source API version.
