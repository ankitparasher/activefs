# Source API protocol

The Source API is the language-neutral HTTP contract for exposing an
ActiveFS tree. This page defines protocol version 1: discovery, operation
methods and envelopes, authoritative request context, mutations, sessions,
and errors. For the shipped TypeScript bindings, see
[`@activefs/source-http` bindings](source-http-transport.md).

## Discovery is the configured URL

A client treats the configured remote URL as the exact discovery URL. It
sends one `GET` to that URL without appending a route, removing a filename,
adding a slash, or rewriting its query.

Valid discovery URL shapes include:

```txt
https://app.example.com/source
https://app.example.com/api/source-manifest.json
https://app.example.com/config/source?tenant=acme
```

The response is an `activefs-source` discovery document:

```json
{
  "protocol": "activefs-source",
  "protocolVersion": 1,
  "endpoints": {
    "stat": "./tree/stat",
    "list": "./tree/list",
    "read": "./tree/read",
    "search": "./tree/search",
    "command": "./tree/command",
    "capabilities": "./tree/capabilities",
    "config": "./tree/config",
    "policy": "./tree/policy"
  },
  "capabilities": {
    "protocolVersion": 1,
    "statable": true,
    "listable": true,
    "readable": true,
    "writable": false,
    "mutable": {
      "create": false,
      "write": false,
      "truncate": false,
      "delete": false,
      "mkdir": false,
      "rmdir": false,
      "rename": false,
      "copy": false,
      "updateMetadata": false
    },
    "searchable": true,
    "commands": ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"],
    "watchable": false,
    "rangeReadable": true,
    "activefs": {
      "stat": true,
      "list": true,
      "read": true,
      "search": true
    }
  }
}
```

`stat`, `list`, and `read` are required. An optional endpoint must agree
with its capability; contradictory documents fail closed. There is no
`endpoint: "http"` discriminator and no inferred service base.

The discovery document may include safe `server`, `workspace`, `cache`,
`auth`, `freshness`, `mutations`, and `revisions` hints. Advertised
`capabilities`, `config`, and `policy` endpoints provide richer documents.
Discovery data cannot select a local credential command or execute local
instructions.

A checked client may retain safe setup hints such as display metadata,
coarse capabilities, cache and authentication declarations, and revision
strings. It must not persist advertised operation URLs, credentials, raw
authentication hints, or server-derived identity as trusted local state.

## Endpoint resolution and security

Endpoint values are URI references:

- Relative references resolve against the final discovery response URL after
  allowed redirects.
- Same-origin absolute `https:` URLs are accepted.
- Plain `http:` is accepted only for loopback development or an explicit
  insecure opt-in.
- Other schemes, fragments, and URL-embedded credentials are rejected.
- Cross-origin endpoints and redirects are denied by default.

An explicit allowlist can approve another origin. Discovery credentials are
still not sent there unless the client also has an explicit authentication
provider for that origin. A discovery document cannot redirect bearer tokens,
cookies, or custom secret headers by itself.

Redirect hops are bounded. The protocol fixes each operation method; the
discovery document selects URLs, not methods or payload shapes.

Concrete session and operation-status links returned by an operation follow
the same HTTP(S), fragment, credential, origin, redirect, and authentication
rules. Clients resolve them against the response URL that supplied the link.

## Endpoint map

The discovery endpoint map uses these keys and methods:

| Key | Method | Required | Capability |
|---|---|---|---|
| `stat` | `POST` | Yes | `statable` |
| `list` | `POST` | Yes | `listable` |
| `read` | `POST` | Yes | `readable` |
| `search` | `POST` | No | `searchable` |
| `command` | `POST` | No | non-empty `commands` |
| `write` | `POST` | No | `mutable.write` |
| `delete` | `POST` | No | `mutable.delete` |
| `mkdir` | `POST` | No | `mutable.mkdir` |
| `rmdir` | `POST` | No | `mutable.rmdir` |
| `rename` | `POST` | No | `mutable.rename` |
| `copy` | `POST` | No | `mutable.copy` |
| `truncate` | `POST` | No | `mutable.truncate` |
| `metadata` | `POST` | No | `mutable.updateMetadata` |
| `sessions` | `POST` | No | session or freshness support |
| `changes` | `GET` | No | retained change support |
| `capabilities` | `GET` | No | standalone capability document |
| `config` | `GET` | No | revisioned generic configuration |
| `policy` | `GET` | No | source-owned policy metadata |

Discovery itself uses `GET`. Resource-specific URLs returned after discovery
have fixed methods too:

| Resource URL | Method |
|---|---|
| session event URL | `GET` |
| session ACK URL | `POST` |
| session activity URL | `POST` |
| operation-status URL | `GET` |

A client never constructs an undisclosed operation or resource URL.

## Tree request envelopes

Tree operations use a normalized absolute tree path. In a local or public
source without an authoritative resolver, `ctx` carries opaque authentication
and metadata:

```json
{
  "path": "/context.md",
  "ctx": {
    "auth": { "providerOwned": "value" },
    "meta": { "requestId": "req-123" }
  }
}
```

With a hosted authoritative resolver, the body `ctx` is optional and
untrusted. The operation-specific fields are:

| Operation | Additional request fields |
|---|---|
| `read` | optional `options` and `responseFormat` (`"json"` or `"octet-stream"`) |
| `search` | required `query` with at least a string `pattern` |
| `command` | required supported `command` and typed `input` object |
| `write` | `content` or `contentBase64`, optional `options`, and optional SHA-256 `digest` |
| `delete`, `mkdir`, `rmdir`, `truncate` | optional operation-specific `options` |
| `rename`, `copy` | required `toPath` and optional `options` |
| `metadata` | required metadata-update `options` |

Supported command names are `ls`, `stat`, `cat`, `head`, `tail`, `sed`,
`grep`, `rg`, and `find`. A source-native command handler may preserve that
intent; otherwise canonical tree semantics provide the fallback.

A JSON read response contains one of `content` or `contentBase64`, plus
optional `stat` and `meta`:

```json
{
  "content": "file contents",
  "stat": {
    "name": "context.md",
    "path": "/context.md",
    "kind": "file",
    "size": 13
  },
  "meta": {}
}
```

A read request can select `responseFormat: "octet-stream"` or send
`Accept: application/octet-stream`. Byte responses use the file MIME type
when known, carry `content-length`, `content-digest`, and `repr-digest`, and
may encode `stat` and `meta` in `x-activefs-stat` and `x-activefs-meta`.
Read ranges travel in `options`.

Canonical JSON responses end with a newline and carry a SHA-256
`repr-digest`.

## Authoritative hosted identity

Request-body context is a compatibility mechanism, not a hosted credential
boundary. A hosted source must authenticate the HTTP request and derive final
tree context on the server.

When an authoritative context resolver is configured:

- it receives the HTTP request, selected operation, and any body context as
  `untrustedContext`;
- its returned context is final and authoritative;
- body `ctx.auth` and `ctx.meta` are not merged automatically;
- a host may explicitly copy a validated trace ID, deadline, or limit from
  untrusted context;
- the request abort signal is attached to the final context;
- the resolver runs once per request; and
- resolver failures use the normal sanitized Source API error envelope.

The same authority applies to discovery, capability/config/policy access,
list, stat, read, search and scan fallbacks, commands, every mutation, session
creation, event reconnect, ACK/activity, watch registration, changes, and
operation status.

The resolver also returns a server-only `isolationKey`. It must be stable,
opaque, and non-secret—not a bearer token, cookie, JWT, email, or reversible
credential value. It scopes retained sessions, events, ACK/activity state,
changes, operation status, and idempotency records. Without a resolver, the
generic service uses the `anonymous` isolation scope.

Path policy stays in the tree. A denied path may return not found when
distinguishing denial would reveal its existence. List, stat, read, search,
and commands must enforce one visibility model; adapter-side post-filtering is
not a substitute.

## Mutations and operation status

Mutation requests use the advertised endpoint and `POST`. Rename and copy add
`toPath` so the source can apply policy to both paths.

A successful response means the server committed its final result. ActiveFS
does not report optimistic local success or maintain an offline mutation
queue. Every mutation response includes a concrete status reference alongside
its operation-specific result:

```json
{
  "operationId": "opaque-operation-id",
  "operationStatusEndpoint": "./operations/opaque-operation-id",
  "revision": "source-owned-revision"
}
```

The operation-status response has this shape:

```json
{
  "operationId": "opaque-operation-id",
  "operationStatusEndpoint": "./operations/opaque-operation-id",
  "status": "succeeded",
  "operation": "write",
  "path": "/context.md",
  "startedAt": "2026-07-21T00:00:00.000Z",
  "completedAt": "2026-07-21T00:00:00.010Z",
  "revision": "source-owned-revision",
  "result": {}
}
```

`status` is `running`, `succeeded`, or `failed`. `operation` is `write`,
`delete`, `mkdir`, `rmdir`, `rename`, `copy`, `truncate`, or `metadata`.
Rename and copy status also includes `targetPath`; a failed status includes
`error` instead of a successful `result`.

The source must produce the concrete status URL before retaining mutation
state. Clients store the supplied `operationId` and URL; they never synthesize
an operations path.

An `Idempotency-Key` header or `options.idempotencyKey` indexes a mutation
within the authoritative isolation scope. A same-payload retry returns the
original in-flight or completed result without executing the tree mutation
again. Reusing the key for a different payload returns `CONFLICT`. Identical
keys in two isolation scopes do not collide. Generic service status and
idempotency retention is process-local; durable recovery is the source
server's responsibility.

## Sessions, watch, and changes

Session creation sends optional `path`, `options`, and `ctx` to the advertised
`sessions` endpoint. The default path is `/`. A successful response has this
shape:

```json
{
  "sessionId": "opaque-session-id",
  "createdAt": "2026-07-21T00:00:00.000Z",
  "cacheMode": "off",
  "eventEndpoint": "./opaque-session-id/events",
  "ackEndpoint": "./opaque-session-id/acks",
  "activityEndpoint": "./opaque-session-id/activity",
  "integrity": {
    "eventChain": "sha-256"
  }
}
```

`cacheMode` is `off` or `realtime/coherent`. If event MACs are enabled,
`integrity.eventMac` is `hmac-sha-256`.

The source must produce all three concrete session URLs before retaining the
session. It stores authoritative session context and re-authenticates event,
ACK, and activity requests. A different isolation scope receives not found,
even if it knows the session ID. Watch registration receives the session path,
options, and current authoritative context.

An ACK body contains `lastAppliedSequence`. The activity endpoint accepts a
JSON activity value and returns whether it was accepted plus the retained
backlog count. The event endpoint is an SSE stream; reconnects use
`Last-Event-ID` for replay.

Each SSE data object has `id`, `sessionId`, `sequence`, `issuedAt`, `type`,
`payload`, and `payloadDigest`. It may also have `previousEventDigest` and an
`eventMac` object using `hmac-sha-256`. Sequence numbers and the SHA-256
digest chain provide ordered integrity. An HMAC adds integrity, not
authorization.

A host may revoke a session after an authoritative policy or account-state
change. Revocation sends a final `session.revoked` event, closes active event
and watch resources, and removes the session. A normal isolation mismatch is
non-destructive so one principal cannot revoke another principal's session by
guessing its ID.

Visibility-safe watch events may carry paths. A source must not broadcast
mutation paths to unrelated sessions. If it cannot prove event visibility, it
sends a non-path-bearing `resync.required` event or disables watchability.

`GET` on the advertised changes endpoint accepts an optional integer `since`
query. It returns `schemaVersion`, isolation-scoped `changes`,
`latestSequence`, and `truncated`. Replay buffers, ACK/activity state,
changes, operation status, idempotency records, and retention limits remain
bounded and isolation-scoped. See the
[shared service resource bounds](source-http-transport.md#shared-service-resource-bounds)
for the shipped TypeScript service defaults and overrides.

## Errors

An error response contains a stable external code:

```json
{
  "error": {
    "name": "ActiveFSNotFoundError",
    "code": "NOT_FOUND",
    "internalCode": "NOT_FOUND",
    "message": "Path was not found",
    "path": "/missing.txt"
  }
}
```

`internalCode` and `path` are optional. A failed mutation may also include an
`operation` object with its concrete `operationId` and
`operationStatusEndpoint`.

External codes are:

```txt
NOT_FOUND
NOT_A_DIRECTORY
IS_DIRECTORY
PERMISSION_DENIED
CONFLICT
PRECONDITION_FAILED
UNSUPPORTED_OPERATION
INVALID_PATH
RANGE_NOT_SATISFIABLE
TRANSIENT_TRANSPORT
SOURCE_UNAVAILABLE
TIMEOUT
INTERNAL_ERROR
```

Unexpected exceptions become sanitized internal errors. Credentials, body
authentication, isolation keys, and private policy documents must not appear
in errors or logs.

## Implementing the wire contract elsewhere

A Python, Java, Go, Rust, or other service can implement the Source API
without a JavaScript package. It must return the discovery schema, honor fixed
methods and payloads, advertise consistent capabilities, emit canonical
errors and digests, and apply authorization across every operation and
session path.

ActiveFS does not currently claim shipped Python or Java SDKs.

## Related references

- [`@activefs/source-http` bindings](source-http-transport.md)
- [Security and identity](../guides/security-and-identity.md)
- [Build a source server](../guides/build-a-source-server.md)
- [Source API conformance](../contributing/source-api-conformance.md)
