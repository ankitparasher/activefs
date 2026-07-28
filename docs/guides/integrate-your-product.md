# Integrate your product

Expose one useful piece of your application's current data as a small ActiveFS
tree. Begin with the result a consumer needs, verify that its first files list
and read correctly, and add policy or framework integration only after that
first slice works.

This guide assumes your application owns the data and will host the Source API.

## Choose the first useful slice

Pick a read-only result that is useful on its own. For a service application,
the first slice might be:

```txt
current service state
  -> /status.json
  -> /build.json
  -> /incidents/latest.md
```

Start with `/status.json` if that is enough. Its contents should come from the
same current state your application trusts, not from a second copy maintained
for ActiveFS.

Good first slices are:

- small enough to explain in one sentence;
- safe for the intended caller to read;
- useful as one or two clearly named files; and
- easy to verify against the application's source of truth.

## Build the file tree

Implement the slice as an `ActiveFSTree`. A lazy content factory can compute a
file from current application state each time it is read:

```js
import { fsTree, json } from "@activefs/core";

const tree = fsTree({
  "status.json": json(() => currentServiceStatus())
});
```

Keep provider-specific lookup, filtering, and policy in your application. The
tree presents that behavior as files and directories. Paths identify those
items inside the tree.

Use [Build a source server](build-a-source-server.md) for the complete package
setup and runnable server. Use the [ActiveFSTree reference](../reference/activefs-tree.md)
for dynamic routes, metadata, search, and writes.

## Serve the tree from your application

Expose the tree through Source API using the Node adapter or the
Fetch-compatible `@activefs/source-http/fetch` entrypoint. Your application can
choose any discovery route; clients use the exact URL you configure and follow
the operation URLs advertised by its discovery document.

For framework-owned routes, see the
[Fetch handler example](../../examples/fetch-source-handler/README.md). For the
wire contract, see [Source API](../reference/source-api.md).

## Verify the result

After the application prints or documents its discovery URL, connect it from a
separate working directory:

```bash
activefs remote add product https://app.example.com/api/activefs-source
activefs list /product
activefs read /product/status.json
```

Replace the example URL with your real discovery URL. A successful first slice
has these observable results:

- the remote appears at `/product`;
- listing shows `/product/status.json`; and
- reading the file returns status computed from current application state.

Add search only when consumers need discovery beyond listing known paths. Add
writes only after the application has an explicit validation, authorization,
conflict, and commit model.

## Preserve the application boundary

Your application remains authoritative for:

- data lookup and namespace;
- caller identity and path visibility;
- freshness and cache metadata;
- search results; and
- final write decisions.

ActiveFS stays generic. Keep product-specific packages, fixtures, deployment
instructions, and policy outside the ActiveFS repository.

For a hosted multi-user source, validate HTTP credentials in the host and
derive the final opaque ActiveFS context there. Do not trust caller-supplied
`auth` or `meta` as authoritative identity. See
[Security and identity](security-and-identity.md#hosted-source-api-context) for
the supported resolver pattern.

## Add confidence before expanding

Before expanding the file tree:

1. Check the first file through the application and through ActiveFS.
2. Document who can see it and what "current" means.
3. Add Source API conformance coverage.
4. Record unsupported write or filesystem behavior in the product docs.
5. Add the next file only when it improves a real consumer workflow.

Use [Source API conformance](../contributing/source-api-conformance.md) for the
shared behavior checks.

## Continue

- [Connect a source](connect-a-source.md) for remote configuration and auth.
- [Dynamic routes](dynamic-routes.md) for large or non-enumerable path spaces.
- [Cache and freshness](cache-and-freshness.md) for operational trust.
- [Current limits](../reference/current-limits.md) for public boundaries.
