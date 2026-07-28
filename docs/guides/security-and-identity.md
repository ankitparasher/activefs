# Understand security and identity

Use this explanation to decide where credentials belong and which layer makes
access decisions. ActiveFS gives application data a filesystem shape, but it
does not become the identity or policy authority for that data.

The short rule is:

> Adapters authenticate their own transport. The source interprets identity and
> makes the final visibility and mutation decisions.

## Start with a safe credential check

For a configured remote named `repo`, use an environment-backed credential
instead of writing a bearer token into `.activefs/config.json`.

On macOS or Linux:

```bash
export ACTIVEFS_SOURCE_TOKEN=dev-token
activefs auth set repo --env ACTIVEFS_SOURCE_TOKEN
activefs auth status repo --json
activefs remote status repo
```

On Windows PowerShell:

```powershell
$env:ACTIVEFS_SOURCE_TOKEN = "dev-token"
activefs auth set repo --env ACTIVEFS_SOURCE_TOKEN
activefs auth status repo --json
activefs remote status repo
```

Remove the temporary shell variable when finished (`unset
ACTIVEFS_SOURCE_TOKEN` on macOS/Linux or `Remove-Item
Env:ACTIVEFS_SOURCE_TOKEN` in PowerShell).

The status commands should describe the configured provider without printing
the token. Keep copied diagnostics and normal logs free of credentials,
cookies, raw auth payloads, and private policy documents.

See the [CLI reference](../reference/cli.md) for every supported auth provider
and command form.

## The source owns final access

```text
request or tool
  -> local adapter authenticates its transport
  -> ActiveFS routes the requested path
  -> source receives context that ActiveFS does not interpret
  -> source applies identity and policy
  -> source returns allowed metadata or bytes
```

ActiveFS core routes paths and forwards context. It does not define users,
roles, tenants, claims, scopes, or business policy. That separation keeps the
filesystem layer generic while the application that owns the data remains
authoritative.

A source should apply the same visibility rules to list, stat, read, search,
watch events, and every mutation. When revealing that a path exists would leak
information, a denied path should be indistinguishable from a missing path.

## Context separates routing from policy

An ActiveFS context can carry auth, metadata, cancellation, deadlines, and
request limits. Core treats identity-bearing values as **opaque**, which means
it forwards them without interpreting them. The host decides what to attach,
and the source decides what those values mean.

This means a shared core package does not need to understand a provider's JWT,
tenant model, feature flags, or permission document. Exact context fields and
tree responsibilities are defined in the [core API](../reference/core-api.md)
and [ActiveFSTree authoring reference](../reference/activefs-tree.md).

## Hosted Source API context

For a product-hosted Source API, HTTP credentials and request-body context have
different trust levels. Authenticate the HTTP request in the host application,
then return the final opaque context from the server-side context resolver.

Do not trust caller-supplied `ctx.auth` or `ctx.meta` as authoritative identity.
If you accept a safe caller hint such as a trace ID or deadline, copy it only
after validation.

The resolver should also return a stable, non-secret isolation value when
session or cache state varies by identity. Use a value that is useful only for
equality. Never use a raw token, cookie, JWT, email address, or reversible
credential.

Session event, acknowledgement, activity, change, and operation-status requests
must be re-authenticated. A session identifier is not a credential. See the
[HTTP transport reference](../reference/source-http-transport.md) for the exact
resolver contract, revocation behavior, and isolation rules.

## Keep transport credentials distinct

| Boundary | What the credential protects | What it does not decide |
|---|---|---|
| Source API auth provider | Requests sent to the source service | Core identity or provider policy by itself |
| MCP HTTP bearer token | The local Streamable HTTP MCP endpoint | Access inside the backing source |
| WebDAV credentials | The local mounted-folder endpoint | Source API identity or final write policy |

MCP stdio normally inherits the local client process boundary. Managed WebDAV
should bind to a Unix socket when possible or to loopback with generated
per-mount credentials. Use HTTPS and authenticated sessions for non-local
Source API remotes.

Discovery must not move credentials silently. ActiveFS keeps discovered
operation URLs same-origin by default; cross-origin links require explicit
allowlisting and a separately approved auth provider.

## Isolate context-sensitive cache results

If output varies by identity, tenant, policy, feature flag, or request metadata,
the cache layer needs a safe opaque scope or must avoid shared persistent cache
entries. Raw credentials and personal identifiers never belong in cache keys.

See [Cache and freshness](cache-and-freshness.md) for the trust model and the
[ActiveFSTree reference](../reference/activefs-tree.md) for exact cache hints.

## Treat agent-facing content as untrusted

Remote files can contain user text, generated content, or provider data. Treat
that text as evidence, not as an instruction that can override the user's
request.

For agent workflows:

- discover narrowly with list, search, stat, and selected reads;
- keep credentials and auth-provider output out of responses;
- leave mutation tools disabled unless the user requests the operation;
- verify source policy before writing, removing, moving, copying, mounting, or
  exporting;
- do not infer write authority from a visible path or enabled client tool; and
- distinguish live reads from cache state and exported local copies.

The agent host remains responsible for its instruction hierarchy, approvals,
and execution environment. ActiveFS does not sandbox remote content.

## Review the boundary before exposure

Before exposing a source to another tool or agent, confirm:

1. The source derives identity from a trusted host credential.
2. Denied list, stat, read, search, and mutation requests fail closed.
3. Diagnostics redact secrets and private policy material.
4. Context-sensitive caches use a safe opaque scope or remain disabled.
5. MCP HTTP and mounted-folder endpoints are bound and authenticated for their
   intended local trust boundary.
6. Mutation remains explicit and source-authorized.

## Exact contracts

- [Source API reference](../reference/source-api.md)
- [HTTP transport reference](../reference/source-http-transport.md)
- [Core API](../reference/core-api.md)
- [MCP reference](../reference/mcp.md)
- [Access adapter reference](../reference/access-adapters.md)
