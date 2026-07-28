#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  activefsMCPServerConfigJsonSchema
} from "./schemas.js";
import {
  loadActiveFSMCPConfig
} from "./config.js";
import {
  listActiveFSMCPTools
} from "./tools.js";
import {
  listActiveFSMCPPrompts
} from "./prompts.js";
import {
  redactSecret,
  type ActiveFSMCPAuthConfig
} from "./auth.js";
import {
  startActiveFSMCPHttpServer
} from "./transports/http.js";
import {
  startActiveFSMCPStdioServer
} from "./transports/stdio.js";
import {
  ACTIVEFS_MCP_PROTOCOL_VERSION
} from "./server.js";

const VERSION = "0.1.1";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (argv.includes("--print-config-schema")) {
    console.log(JSON.stringify(activefsMCPServerConfigJsonSchema, null, 2));
    return;
  }

  const parsed = parseArgs(argv);
  if (parsed.dryRun) {
    await printDryRun(parsed);
    return;
  }

  if (parsed.transport === "stdio") {
    await startActiveFSMCPStdioServer({
      configPath: parsed.configPath,
      workspace: parsed.workspace,
      demo: parsed.demo,
      installSignalHandlers: true
    });
    return;
  }

  const handle = await startActiveFSMCPHttpServer({
    configPath: parsed.configPath,
    workspace: parsed.workspace,
    demo: parsed.demo,
    host: parsed.host,
    port: parsed.port,
    endpoint: parsed.endpoint,
    auth: parsed.auth
  });
  console.log(`ActiveFS MCP HTTP server listening on ${handle.url}`);
  console.log(`Auth: ${handle.auth.mode}${handle.auth.token ? ` token ${redactSecret(handle.auth.token)}` : ""}`);
  await waitForInterrupt(async () => handle.close());
}

interface ParsedArgs {
  transport: "stdio" | "http";
  configPath?: string;
  workspace?: string;
  demo?: boolean;
  dryRun?: boolean;
  host?: string;
  port?: number;
  endpoint?: string;
  auth?: ActiveFSMCPAuthConfig;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    transport: argv.includes("--http") || optionValue(argv, "--transport") === "http" ? "http" : "stdio"
  };
  parsed.configPath = optionValue(argv, "--config");
  parsed.workspace = optionValue(argv, "--workspace") ?? optionValue(argv, "--root") ?? optionValue(argv, "--state-root");
  parsed.demo = argv.includes("--demo");
  parsed.dryRun = argv.includes("--dry-run");
  parsed.host = optionValue(argv, "--host");
  parsed.endpoint = optionValue(argv, "--endpoint");
  const port = optionValue(argv, "--port");
  if (port) {
    parsed.port = Number.parseInt(port, 10);
    if (!Number.isInteger(parsed.port) || parsed.port < 0) {
      throw new Error(`Invalid --port value: ${port}`);
    }
  }
  parsed.auth = parseAuthArgs(argv, parsed.transport);
  return parsed;
}

function parseAuthArgs(argv: string[], transport: "stdio" | "http"): ActiveFSMCPAuthConfig {
  const authMode = optionValue(argv, "--auth");
  const token = optionValue(argv, "--token");
  const auth: ActiveFSMCPAuthConfig = {
    mode: transport === "http" ? "bearer" : "stdio",
    allowInsecureHttp: argv.includes("--allow-insecure-http"),
    allowNetworkBind: argv.includes("--allow-network-bind")
  };
  if (authMode === "none") {
    auth.mode = "none";
  }
  if (authMode === "bearer") {
    auth.mode = "bearer";
  }
  if (token?.startsWith("env:")) {
    auth.tokenEnv = token.slice("env:".length);
  } else if (token) {
    auth.token = token;
  }
  const allowedOrigin = optionValues(argv, "--allow-origin");
  if (allowedOrigin.length) {
    auth.allowedOrigins = allowedOrigin;
  }
  const allowedHost = optionValues(argv, "--allow-host");
  if (allowedHost.length) {
    auth.allowedHosts = allowedHost;
  }
  return auth;
}

async function printDryRun(args: ParsedArgs): Promise<void> {
  const loaded = await loadActiveFSMCPConfig({
    configPath: args.configPath,
    workspace: args.workspace,
    demo: args.demo
  });
  const prompts = loaded.config.prompts.enabled ? listActiveFSMCPPrompts() : [];
  console.log(JSON.stringify({
    name: loaded.config.name,
    protocolVersion: ACTIVEFS_MCP_PROTOCOL_VERSION,
    remotes: loaded.remotes.map((remote) => ({
      name: remote.name,
      rootPath: remote.rootPath,
      title: remote.title,
      watchable: remote.watchable
    })),
    resources: loaded.config.resources,
    tools: listActiveFSMCPTools(loaded.config.tools).map((tool) => tool.name),
    prompts: prompts.map((prompt) => prompt.name),
    subscriptions: loaded.config.subscriptions,
    auth: {
      mode: args.auth?.mode ?? loaded.config.auth.mode,
      token: args.auth?.token ? redactSecret(args.auth.token) : undefined,
      tokenEnv: args.auth?.tokenEnv ?? loaded.config.auth.tokenEnv
    }
  }, null, 2));
}

function optionValue(argv: string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  return index >= 0 ? argv[index + 1] : undefined;
}

function optionValues(argv: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option && argv[index + 1]) {
      values.push(argv[index + 1]!);
    }
  }
  return values;
}

function waitForInterrupt(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const shutdown = () => {
      close().then(resolve, reject);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function printHelp(): void {
  console.log(`activefs-mcp [options]

Options:
  --transport stdio|http         Transport to start (default: stdio)
  --http                         Alias for --transport http
  --state-root <path>            ActiveFS .activefs state directory
  --workspace <path>             Compatibility alias for --state-root
  --root <path>                  Compatibility alias for --state-root
  --config <path>                Explicit activefs-mcp.config.json file
  --demo                         Use a deterministic in-memory demo fixture
  --host <host>                  HTTP host (default: 127.0.0.1)
  --port <port>                  HTTP port (default: 8765)
  --endpoint <path>              HTTP MCP endpoint (default: /mcp)
  --token env:NAME|VALUE         HTTP bearer token source
  --auth bearer|none             HTTP auth mode
  --allow-origin <origin>        Allowed HTTP Origin; repeatable
  --allow-host <host>            Allowed HTTP Host; repeatable
  --allow-network-bind           Permit non-loopback HTTP bind
  --allow-insecure-http          Permit --auth none outside loopback
  --dry-run                      Validate config and print redacted server plan
  --print-config-schema          Print JSON Schema for activefs-mcp config
  --version                      Print version
  --help                         Show help

Examples:
  activefs-mcp --state-root .activefs
  ACTIVEFS_MCP_TOKEN=dev-token activefs-mcp --http --state-root .activefs --port 8765 --token env:ACTIVEFS_MCP_TOKEN
`);
}

function isDirectRun(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
