# Configure MCP access to an ActiveFS remote

Use this guide when an MCP-native client needs to browse and read a configured
ActiveFS remote. You will verify the remote, generate client configuration,
reload the client, and test resource access.

The MCP adapter exposes the same source-backed tree that direct ActiveFS
commands use. The source still decides what data exists, who may access it, how
fresh it is, and whether a write succeeds.

## Prerequisites

- Node.js 22 or newer.
- The packaged CLI: `npm install -g activefs`.
- An ActiveFS remote that already works through direct commands.
- An MCP-capable client whose configuration you can edit and reload.

If you need a temporary remote, start the shipped read-only demo:

```bash
activefs remote add repo --demo --port 3999
```

## Verify the remote first

Confirm that ActiveFS can reach the remote before involving an MCP client:

```bash
activefs remote status repo
activefs list /repo
activefs read /repo/README.txt
```

If these commands fail, fix the remote or its credentials first.

## Inspect the MCP plan

Inspect the selected remote without starting a long-running server:

```bash
activefs mcp repo inspect
```

The command prints a redacted plan with the selected remote, transport, and
enabled capabilities. Review it before adding configuration to a client.

## Generate client configuration

Generate the snippet for your client instead of hand-writing the command or
state-root path:

```bash
activefs mcp repo config codex
activefs mcp repo config claude
activefs mcp repo config generic
```

For example, Codex output uses TOML:

```toml
[mcp_servers.activefs-repo]
command = "activefs"
args = ["mcp", "repo", "start", "--state-root", "/absolute/path/to/.activefs"]
```

Merge the generated snippet into the client's existing MCP configuration; do
not replace unrelated server entries:

- For Codex, add the generated TOML entry to `~/.codex/config.toml`.
- For Claude Desktop, merge the generated server entry into `mcpServers` in
  the existing `claude_desktop_config.json` file.
- For another client, use the `generic` output and follow that client's MCP
  configuration instructions.

Keep the generated absolute state-root path, then reload the client. Confirm
that the `activefs-repo` server connects and that resources under `repo` are
visible before continuing.

Omit the remote name only when you intentionally want to expose every
configured remote:

```bash
activefs mcp
```

## Verify selective access

Give the reloaded client a small grounded task:

> List the `repo` root, search for `Source API`, stat useful matches, read only
> those files, and cite the `activefs://repo/...` resources used.

This checks resource discovery and the default read-oriented tools without
enabling mutation. See the [agent tutorial](../examples/agents-and-mcp.md) for
the complete list-to-search-to-read workflow.

## Use Streamable HTTP when required

Desktop clients normally launch the adapter over stdio. Use Streamable HTTP
only when the client needs a local HTTP endpoint or when you are testing that
transport:

On macOS or Linux:

```bash
ACTIVEFS_MCP_TOKEN=dev-token \
  activefs mcp repo start --http --port 8765 --token env:ACTIVEFS_MCP_TOKEN
```

On Windows PowerShell:

```powershell
$env:ACTIVEFS_MCP_TOKEN = "dev-token"
activefs mcp repo start --http --port 8765 --token env:ACTIVEFS_MCP_TOKEN
```

Remove the temporary PowerShell variable with `Remove-Item
Env:ACTIVEFS_MCP_TOKEN` after stopping the server.

The default endpoint is `http://127.0.0.1:8765/mcp`. The client must send the
configured bearer token. For an explicit loopback-only test, you can disable
HTTP auth:

```bash
activefs mcp repo start --http --port 8765 --auth none
```

Do not use the unauthenticated form on a non-loopback interface.

## Use the standalone MCP package

Use `activefs mcp` when you already manage ActiveFS remotes with the main CLI.
For an MCP-only installation:

```bash
npm install -g @activefs/mcp
activefs-mcp --dry-run --demo
```

## Troubleshoot configuration

If the remote is missing or resources do not appear, check each boundary in
order:

```bash
activefs remote list
activefs list /repo
activefs mcp repo inspect
```

If direct commands fail, repair the remote first. If Streamable HTTP returns
`401`, the endpoint is reachable but the client did not provide the configured
bearer token. Keep tokens out of copied diagnostics.

If you created the demo for this guide, remove it when finished:

```bash
activefs remote remove repo
```

## Exact behavior

- [MCP reference](../reference/mcp.md): resources, tools, transports,
  subscriptions, limits, and disabled-by-default operations.
- [CLI reference](../reference/cli.md): exact `activefs mcp` command forms.
- [Security and identity](security-and-identity.md): credentials, source
  authority, and agent-content safety.
