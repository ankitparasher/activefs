# `@activefs/source-http` bindings

`@activefs/source-http` provides the shipped TypeScript bindings for Source
API protocol version 1. It contains a Node client, Node server adapters, and a
route-independent service for Fetch-compatible runtimes. The language-neutral
wire contract lives in the [Source API protocol](source-api.md).

## Package entry points

The package publishes two entry points:

| Import | Responsibility |
|---|---|
| `@activefs/source-http` | Node client, Node server adapters, shared service, protocol validators, and types |
| `@activefs/source-http/fetch` | Shared Web-standard service, protocol validators, and types; no Node client or Node server |

The root entry point includes:

- `createHttpSourceClient` for a discovery-driven `ActiveFSTree` client;
- `startActiveFSServer` for a standalone Node listener;
- `createActiveFSTreeServer` for an all-in-one Node request handler;
- `createActiveFSSourceNodeHandler` for binding one service operation to one
  Node route;
- `createActiveFSSourceService` for the shared route-independent service; and
- Source API types, validation helpers, endpoint helpers, and remote-spec
  parsing.

The `@activefs/source-http/fetch` entry point exports
`createActiveFSSourceService` plus the shared protocol constants,
validators, helpers, and types. It deliberately does not export
`createHttpSourceClient`, `startActiveFSServer`, or either Node request
handler.

The package metadata declares Node.js 22 or later. Both ESM and CommonJS
builds are published for each entry point.

## Fetch-compatible server

Create the shared service from the Fetch entry point:

```ts
import { createActiveFSSourceService } from "@activefs/source-http/fetch";

const source = createActiveFSSourceService({
  tree,
  endpoints: {
    stat: "./tree/stat",
    list: "./tree/list",
    read: "./tree/read"
  },
  resolveContext
});
```

An application router selects a trusted operation and passes its
Web-standard `Request` to `source.handle(operation, request, params?)`:

```ts
export const GET = (request: Request) =>
  source.handle("handshake", request);

export const POST = (request: Request) =>
  source.handle("read", request);
```

For resource routes, the router also supplies trusted route parameters:

```ts
export const GET = (
  request: Request,
  sessionId: string
) => source.handle("sessionEvents", request, { sessionId });
```

The service never infers an operation or resource ID from `request.url`. It
validates that the request method matches the selected operation, parses the
protocol envelope, invokes the tree, and serializes the response.

### Resource links

Applications that expose sessions or mutations must map generated IDs to
their public routes:

```ts
const source = createActiveFSSourceService({
  tree,
  endpoints,
  resourceLinks: {
    session: ({ request, sessionId }) => ({
      eventEndpoint: new URL(
        "/events/" + encodeURIComponent(sessionId),
        request.url
      ).href,
      ackEndpoint: new URL(
        "/acks/" + encodeURIComponent(sessionId),
        request.url
      ).href,
      activityEndpoint: new URL(
        "/activity/" + encodeURIComponent(sessionId),
        request.url
      ).href
    }),
    operationStatus: ({ request, operationId }) =>
      new URL(
        "/operations/" + encodeURIComponent(operationId),
        request.url
      ).href
  }
});
```

`resourceLinks.session` must return `eventEndpoint`, `ackEndpoint`, and
`activityEndpoint`. `resourceLinks.operationStatus` must return one concrete
status URL. The service validates each link as an HTTP(S) URL reference
without embedded credentials or a fragment. It fails before retaining a
session or mutation result when the required mapping is absent or invalid.

### Fetch runtime requirements

The Fetch binding requires standards-compatible implementations of:

- `Request`, `Response`, `Headers`, `URL`, and `AbortSignal`;
- `ReadableStream`, `setInterval`, and `clearInterval`;
- `TextEncoder` and `TextDecoder`;
- `Uint8Array` and `ArrayBuffer`;
- `atob` and `btoa`; and
- Web Crypto `crypto.randomUUID` and `crypto.subtle`.

The ESM and CommonJS `/fetch` bundles contain no Node built-in imports. They
work in runtimes that provide the Web APIs above. The application router must
pass an explicit operation and any route parameters to `source.handle(...)`.

See the runnable
[Fetch source handler example](../../examples/fetch-source-handler/README.md).

## Node server APIs

### Standalone server

Use `startActiveFSServer` when ActiveFS owns the Node listener:

```ts
import { fsTree, text } from "@activefs/core";
import { startActiveFSServer } from "@activefs/source-http";

const tree = fsTree({ "/README.md": text("# Docs\n") });
const server = await startActiveFSServer({ tree, port: 3999 });

console.log(server.url); // Exact discovery URL
```

The default returned discovery URL ends in `/_activefs/`. That prefix is an
adapter convenience, not part of the Source API protocol. The default route
layout is:

| Operation | Default route |
|---|---|
| discovery | `/_activefs` |
| capabilities, config, policy, changes | `/_activefs/capabilities`, `/_activefs/config`, `/_activefs/policy`, `/_activefs/changes` |
| stat, list, read, search, command | `/_activefs/stat`, `/_activefs/list`, `/_activefs/read`, `/_activefs/search`, `/_activefs/command` |
| write, delete, mkdir, rmdir | `/_activefs/write`, `/_activefs/delete`, `/_activefs/mkdir`, `/_activefs/rmdir` |
| rename, copy, truncate, metadata | `/_activefs/rename`, `/_activefs/copy`, `/_activefs/truncate`, `/_activefs/metadata` |
| create session | `/_activefs/sessions` |
| session events | `/_activefs/sessions/:sessionId/events` |
| session ACK | `/_activefs/sessions/:sessionId/acks` |
| session activity | `/_activefs/sessions/:sessionId/activity` |
| operation status | `/_activefs/operations/:operationId` |

The all-in-one handler accepts the discovery route with or without its trailing
slash. Override any route through `routes`:

```ts
const server = await startActiveFSServer({
  tree,
  routes: {
    handshake: "/api/source-manifest.json",
    read: "/internal/tree/read"
  }
});
```

When `routes.handshake` is set, `server.url` uses that exact configured path.

### Node request handlers

`createActiveFSTreeServer(options)` creates one `IncomingMessage` /
`ServerResponse` handler that matches the configured route set:

```ts
import { createServer } from "node:http";
import { createActiveFSTreeServer } from "@activefs/source-http";

const handler = createActiveFSTreeServer({
  tree,
  routes: {
    handshake: "/source",
    read: "/source/read"
  },
  resolveContext
});

createServer(handler).listen(3999);
```

`createActiveFSSourceNodeHandler(service, operation, params?, auth?)` binds one
existing shared-service operation to an application-owned Node route:

```ts
import {
  createActiveFSSourceNodeHandler,
  createActiveFSSourceService
} from "@activefs/source-http";

const service = createActiveFSSourceService({ tree, endpoints });
const readHandler = createActiveFSSourceNodeHandler(service, "read");
```

Both Node adapters convert Node requests and responses to the Web-standard
objects used by the shared service. The shared service remains responsible
for method validation, body parsing, tree dispatch, serialization, errors,
digests, sessions, and mutation state.

## Authoritative request context

`resolveContext` is the identity boundary shared by the Fetch and Node
bindings:

```ts
const source = createActiveFSSourceService({
  tree,
  endpoints,
  resolveContext: async ({ request, operation, untrustedContext }) => {
    const identity = await authenticate(request, operation);
    return {
      context: {
        auth: { subject: identity.subject },
        meta: { tenant: identity.tenant }
      },
      isolationKey: identity.opaqueIsolationKey
    };
  }
});
```

The returned context is final. The service does not merge body `ctx.auth` or
`ctx.meta` into it. A host may explicitly copy validated trace or request
metadata from `untrustedContext`. The service attaches the request abort
signal and calls the resolver once for every request.

`isolationKey` is a stable, opaque, non-secret equality value. It scopes
sessions, replay, ACK/activity state, changes, operation status, and
idempotency records. It must not contain a bearer token, cookie, JWT, email,
or other reversible credential value.

Without `resolveContext`, the service forwards opaque request-body context
and uses the `anonymous` isolation scope. That mode is for local or public
sources, not hosted authentication.

The Node `auth` option checks static bearer credentials, Basic credentials, or
a Node callback at the transport boundary. It runs before the Node adapter
creates the Web `Request` and before `resolveContext`. It does not construct
tree identity. When both are configured, `auth` checks the request and
`resolveContext` still produces the authoritative context.

## Shared service resource bounds

`createActiveFSSourceService` bounds request size and retained in-memory state.
When `resolveContext` is configured, the lower hosted defaults limit each
authoritative isolation scope:

| Resource | Override option | Without `resolveContext` | With `resolveContext` |
|---|---|---:|---:|
| Request body | `maxRequestBodyBytes` | 8 MiB | 8 MiB |
| Operation-status records per isolation scope | `maxRetainedOperationStatuses` | 512 | 64 |
| Idempotency records per isolation scope | `maxRetainedIdempotencyRecords` | 512 | 64 |
| Change records per isolation scope | `maxRetainedChanges` | 512 | 64 |
| Sessions per isolation scope | `maxRetainedSessions` | 512 | 8 |
| Events per session | `maxRetainedSessionEvents` | 512 | 128 |
| Activity records per session | `maxSessionActivityBacklog` | 512 | 128 |
| Retained isolation scopes | `maxRetainedIsolationScopes` | 64 | 64 |

These records are process-local and are not durable across a service restart.
Applications that need durable sessions, mutation status, idempotency, or
change history must provide that durability outside this in-memory service.

## Node client

`createHttpSourceClient` creates an `ActiveFSTree` backed by an exact
discovery URL:

```ts
import { createHttpSourceClient } from "@activefs/source-http";

const tree = createHttpSourceClient({
  url: "https://app.example.com/api/source-manifest.json",
  auth: { type: "bearer", token }
});
```

Its options include per-origin authentication, an endpoint-origin allowlist,
the non-loopback insecure-HTTP opt-in, a redirect limit, an injectable
`fetch` implementation, and an optional session event-MAC secret. Discovery
and endpoint security follow the
[protocol rules](source-api.md#endpoint-resolution-and-security).

The returned tree adds explicit Source API methods:

- `fetchHandshake()` and `refreshHandshake()`;
- `fetchCapabilities()` and `fetchConfig()`;
- `createSession()`, `ackSession()`, and `reportSessionActivity()`;
- `streamSessionEvents()`, including replay and digest/MAC verification; and
- `fetchOperationStatus()`.

The client is exported only from the root entry point and currently imports
Node built-ins. It is not part of the runtime-neutral `/fetch` entry point.

## Adapter-owned route rules

Host routing owns the mapping from public URLs to operation names and trusted
`sessionId` or `operationId` parameters. The shared service owns method
validation and protocol behavior. Keep these responsibilities separate:

- do not derive an operation from an untrusted URL segment;
- do not let discovery data choose a method;
- pass decoded resource IDs only from the route that owns them;
- configure every advertised endpoint to reach the corresponding operation;
  and
- configure concrete session and status link builders before exposing those
  capabilities.

The Node route helper is one implementation of this mapping. A Fetch router
must provide the same trusted binding explicitly.

## Related references

- [Source API protocol](source-api.md)
- [Security and identity](../guides/security-and-identity.md)
- [Build a source server](../guides/build-a-source-server.md)
- [Fetch source handler example](../../examples/fetch-source-handler/README.md)
- [Source API conformance](../contributing/source-api-conformance.md)
