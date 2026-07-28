# Conformance testing

Use these contracts when you implement an `ActiveFSTree`, Source API server,
or access adapter. `@activefs/testing` provides reusable trees, fixtures, and
conformance helpers for ActiveFS packages and external source implementations.

## Goals

- Validate that trees obey the `ActiveFSTree<Auth, Meta>` contract.
- Validate that Source API servers behave like in-process sources.
- Validate that access adapters preserve core semantics.
- Keep conformance generic and product-agnostic.
- Catch drift between direct runtime, Source API, mounted, exported, CLI, TUI, and MCP behavior.

## Package scope

```txt
@activefs/testing
  test sources
  ActiveFSTree conformance helpers
  Source API conformance helpers
  adapter fixtures
  dynamic-route fixtures
  search fixtures
  watch/write fixtures
```

The testing package must not import product-specific implementations.

## Tree-source conformance

Every `ActiveFSTree` should prove:

- `info` returns `null` for missing paths.
- `list` returns entries that `info` can resolve.
- `read` fails for directories and missing files.
- `read` preserves exact bytes.
- `kind` is only `"file"` or `"directory"`.
- `capabilities` accurately describe supported operations.
- optional `search` returns paths readable for the same opaque context.
- ActiveFS scan can scan enumerable trees.
- dynamic non-enumerable paths are not accidentally listed.
- `auth` and `meta` pass through without core interpretation.
- raw credentials do not appear in cache metadata, errors, or logs.

`@activefs/testing/conformance` exposes `runActiveFSTreeConformance(...)` for
this contract. It is the preferred conformance helper for new `fsTree` and
provider-backed tree implementations.

## Source API validation

`pnpm conformance:source-api` validates the
bundled Source API client/server helpers. Users do not need to run it before
adding or using a remote. Normal remote setup uses handshake/reachability checks,
protocol-version handling, capability/config hints, and clear runtime
errors.

Contributors and SDK authors should validate:

- the configured URL is fetched exactly and every operation uses an advertised
  endpoint or concrete response link;
- protocol version and capability discovery are present;
- `stat`, `list`, `read`, `search`, canonical mutations, and watch/session
  events map to provider semantics;
- source search can be absent while list/read scanning still works where
  enumerable;
- optional command handlers preserve command input, opaque context, results,
  completeness, and strategy through the ActiveFS Source API;
- Source API credentials are separate from WebDAV credentials;
- public/local body context remains opaque, while hosted resolvers replace
  forged body auth/meta with server-derived authoritative context;
- structured errors map cleanly to ActiveFS error behavior;
- Source API v1 external error codes map to documented internal
  `ActiveFSError` codes;
- multiple trees can be exposed by one remote;
- watch/session event streams handle reconnect and cancellation;
- sessions, changes, activity, status, and idempotency are isolated by
  authenticated scope;
- write/mutation operations are generic and tree/provider-owned;
- Node and Fetch handlers produce equivalent protocol responses.

## Adapter conformance

Adapters should validate:

- CLI/TUI/MCP/WebDAV/export all resolve the same tree paths, including MCP
  stdio and Streamable HTTP server transports.
- WebDAV mount enforces local policy before tree-committed writes.
- Mounted `grep` uses list/read through WebDAV and rclone, not optional source
  search.
- `activefs grep` reports source, scan, or mixed plus completeness.
- export preserves bytes and writes manifests atomically.

## Fixture matrix

Recommended shared fixtures:

| Fixture | Purpose |
|---|---|
| memory tree | basic info/list/read |
| generated files | source-state-derived bytes |
| searchable tree | source search |
| scan-only tree | recursive list/read search |
| dynamic route tree | resolvable but non-enumerable paths |
| writable tree | generic mutation and policy behavior |
| watchable tree | event and invalidation behavior |
| multi-tree remote | multiple sources behind one endpoint |
| large tree | benchmark and traversal limits |

## Run conformance checks

For source or adapter changes, run the focused conformance check first, then
the broader workspace checks:

```bash
pnpm conformance:source-api -- --out artifacts/conformance/source-api-conformance.json
pnpm build
pnpm smoke:source-http:fetch
pnpm typecheck
pnpm test
```

To inspect a running implementation through its exact discovery URL without
mutating it:

```bash
pnpm conformance:source-api -- --url https://app.example.com/api/source-manifest.json
```

Add `--token TOKEN` for a bearer-protected service. External mode validates
discovery, advertised capabilities, root stat/list, and a readable root file
when one exists. The local fixture additionally exercises writes, status,
commands, binary reads, and SSE.

`--token` is an argv-based test hook, so its value may appear in shell history
or process listings. Use a disposable conformance credential, never a
long-lived production token.

With `--out`, `pnpm conformance:source-api` writes machine-readable validation
output for protocol versioning, capabilities, JSON/base64/octet-stream reads,
opaque context forwarding, writes, SSE/watch, error-code mapping, and runtime
adapter equivalence.

For mount-sensitive work:

```bash
pnpm smoke:mount:doctor
pnpm smoke:mount:rclone
```

Use `pnpm smoke:mount:real` only for host validation. It requires working
rclone plus FUSE, macFUSE, or WinFsp. Do not treat a missing host mount
dependency as an `ActiveFSTree` failure.

## Out of scope

- Product-specific conformance suites inside ActiveFS.
- Fixed actor models in tests.
- Policy-engine assertions in core tests.
- Treating WebDAV adapter checks as Source API validation.
- Treating Source API conformance as real mounted-directory validation.
