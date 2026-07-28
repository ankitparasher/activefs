# Browse database-shaped data

This example maps a small in-memory database fixture to schema, row, and named
query-result files. It gives `cat`, `jq`, editors, and agents a predictable file
tree without accepting arbitrary SQL.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-database-tree build
node examples/database-tree/dist/index.js
```

## Expected result

The command lists `/db/schema`, `/db/tables`, and `/db/queries`, reads the
`# Query: active-users` result, and reports source-owned matches for
`Ada Lovelace`.

## Paths

| ActiveFS path | Result |
|---|---|
| `/db/schema/tables.md` | Table index |
| `/db/schema/users.json` | Users schema |
| `/db/tables/users/rows/1.json` | One user row |
| `/db/tables/projects/rows/1.json` | One project row |
| `/db/queries/active-users.md` | Named query result |
| `/db/queries/projects-by-owner/1.md` | Parameter-shaped query result |

## Limits

This is a static, read-only fixture. It does not connect to a database or
implement SQL, transactions, schema changes, row-level security, credentials,
or write validation.

## Next

Use [Dynamic users](../dynamic-users/README.md) when exact record paths should
resolve without enumerating the full key space.
