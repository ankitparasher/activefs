# Supported environments

This reference lists the runtime and host requirements for ActiveFS. Direct
commands, Source API clients, export, MCP, and the TUI do not require an OS
mount. Only the optional mounted-folder workflow needs rclone and a platform
mount backend.

## Runtime requirements

| Area | Requirement |
|---|---|
| Node.js | ActiveFS `0.1.1` requires Node.js `>=22`. Node.js 20 is not supported. |
| Package modules | Every package publishes ESM. `@activefs/config`, `@activefs/core`, `@activefs/local`, `@activefs/mcp`, `@activefs/mount`, `@activefs/source-http`, and `@activefs/testing` also publish CommonJS. |
| TypeScript | Package builds include type declarations. |
| Source checkout | The workspace declares `pnpm@11.7.0`. npm-package users do not need pnpm. |

Node.js 20 reached upstream end-of-life on 2026-03-24 and no longer receives
security fixes. ActiveFS therefore develops and tests `0.1.1` on maintained
Node.js versions, currently Node.js 22 and 24. See the
[Node.js release schedule](https://nodejs.org/en/about/previous-releases).

The `@activefs/source-http/fetch` entry point is a Web-standard server binding.
Its runtime must provide:

- `Request`, `Response`, `Headers`, `URL`, and `AbortSignal`;
- `ReadableStream`, `setInterval`, and `clearInterval`;
- `TextEncoder` and `TextDecoder`;
- `Uint8Array` and `ArrayBuffer`;
- `atob` and `btoa`; and
- Web Crypto `crypto.randomUUID` and `crypto.subtle`.

The Fetch entry point contains no Node built-in imports. It works in runtimes
that provide the Web APIs above. The application router must pass each
operation and its route parameters explicitly. See the
[Source HTTP bindings](source-http-transport.md) for setup details.

## Operating systems

| Platform | Direct CLI, packages, MCP, TUI, and export | Optional mounted folder |
|---|---|---|
| macOS | Supported on Node.js 22 or newer | Supported with rclone and macFUSE 5.x or newer |
| Linux | Supported on Node.js 22 or newer | Supported with rclone and working FUSE access |
| Windows | Supported on Node.js 22 or newer | Supported with rclone and WinFsp; follow the [Windows guide](../guides/windows.md) |
| Other platforms | No support claim | No support claim |

Node-based features include the CLI, package APIs, Source API Node client and
server, export, MCP, and TUI. A Fetch-compatible server follows the Web API
requirements above instead of this operating-system table.

Mounted folders are optional. They do not promise full native-filesystem
semantics, and host security settings may require extra approval or
configuration. See [Mount an ActiveFS remote](../guides/mounted-folder.md).
Windows users should also follow [Use ActiveFS on Windows](../guides/windows.md)
for PowerShell syntax, prerequisites, and mount troubleshooting.

### Windows paths and commands

Direct ActiveFS commands use the same syntax on every supported operating
system:

```powershell
activefs list /repo
activefs read /repo/README.txt
activefs grep "Source" /repo
```

These commands do not require rclone or WinFsp. Only the optional Windows
mounted-folder workflow requires both components. After mounting, PowerShell
cmdlets operate on the WinFsp-backed OS path; they are not ActiveFS subcommands.

Keep ActiveFS namespace paths in `/repo/...` form on Windows. Use Windows path
syntax such as `.\repo\README.txt` only after a folder is mounted or exported.

## Check your environment

Check the installed Node runtime and CLI:

```bash
node --version
activefs --help
```

`node --version` must report `v22` or newer. `activefs --help` should print
the available command list.

Check the current npm version:

```bash
npm view activefs version
```

Before mounting, inspect the target host:

```bash
activefs doctor --mounts
```

The doctor output reports whether rclone and the platform mount backend are
available. If they are not, use direct commands or
`activefs export /REMOTE/PATH --to OUTPUT_DIR` instead.

For product boundaries, see [Current limits](current-limits.md). For
diagnosis, see [Troubleshooting](../troubleshooting.md).
