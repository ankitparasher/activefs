#!/usr/bin/env node
import {
  ActiveFSError,
  bytes,
  dir,
  fsTree,
  normalizeActiveFSPath,
  text,
  type ActiveFS,
  type ActiveFSCommandInput,
  type ActiveFSSearchQuery,
  type ActiveFSTree
} from "@activefs/core";
import {
  atomicWriteFile,
  exportTree
} from "@activefs/local";
import {
  authHeadersFromProvider,
  clearPrivateAuthSecret,
  createActiveFSRemoteStateLayout,
  loadActiveFSConfig,
  parseCommandArgv,
  recordActiveFSActivityBacklog,
  removeActiveFSRemoteConfig,
  resolveActiveFSState,
  updateActiveFSOperationJournal,
  upsertActiveFSRemote,
  writeActiveFSSessionState,
  type ActiveFSActivityPolicy,
  writePrivateBearerToken,
  type ActiveFSAuthProviderConfig,
  type ActiveFSConfig,
  type ActiveFSRemoteConfig,
  type ActiveFSSourceDiscoveryHints
} from "@activefs/config";
import {
  checkWebDAVRuntimeStatus,
  clearMountCache,
  cleanupMountRuntime,
  collectRcloneMountEvidence,
  createMountLayout,
  formatRcloneMountHostReport,
  hydrateActiveFSMountRemoteCredentials,
  inspectRcloneMountHost,
  loadActiveFSMountConfig,
  mountRcloneWebDAV,
  readMountFreshnessStatus,
  readMountCacheSnapshot,
  readRcloneMountStatus,
  refreshRcloneMount,
  remountRcloneWebDAV,
  startWebDAVServer,
  stopMountFreshnessRuntime,
  stopManagedWebDAVRuntime,
  tailMountLogs,
  unmountRcloneMount,
  writeMountFreshnessStatus,
  writeWebDAVRuntimeStatus,
  type ActiveFSMountRemote,
  type MountFreshnessMode,
  type MountCommandRunner,
  type RcloneMountActiveWaiter,
  type RcloneMountProcessSpawner,
  type RcloneMountStatus,
  type RcloneVfsCacheMode,
  type WebDAVAuth,
  type WebDAVRuntimeStatus
} from "@activefs/mount";
import {
  createHttpSourceClient,
  startActiveFSServer,
  validateActiveFSSourceDiscoveryUrl,
  type ActiveFSSessionEvent,
  type ActiveFSSessionEventVerificationState,
  type ActiveFSSourceConfigDocument,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeOperationStatus,
  type ActiveFSTreeServiceCapabilities,
  type ActiveFSTreeRemote,
  type HttpSourceClientAuth
} from "@activefs/source-http";
import {
  ACTIVEFS_MCP_PROTOCOL_VERSION,
  listActiveFSMCPPrompts,
  listActiveFSMCPTools,
  loadActiveFSMCPConfig,
  redactSecret,
  startActiveFSMCPHttpServer,
  startActiveFSMCPStdioServer,
  type ActiveFSMCPAuthConfig,
  type LoadedActiveFSMCPConfig
} from "@activefs/mcp";
import { spawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rmdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runActiveFSTui } from "./tui.js";
import { activeFSAsTree, createActiveFSTuiRuntime } from "./tuiSources.js";

/**
 * Dependency injection options for CLI tests and embedded callers.
 *
 * Production CLI use should rely on defaults. Tests can inject mount helpers,
 * Source API fetch, process lifecycle checks, and daemon launchers without
 * invoking host-specific rclone/FUSE behavior.
 */
export interface CliMainOptions {
  waitForInterrupt?: (close: () => void | Promise<void>) => Promise<void>;
  commandRunner?: MountCommandRunner;
  mountProcessSpawner?: RcloneMountProcessSpawner;
  daemonProcessSpawner?: CliDaemonProcessSpawner;
  waitForMountActive?: RcloneMountActiveWaiter;
  enableRcloneRc?: boolean;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  webDAVDaemonLauncher?: WebDAVDaemonLauncher;
  freshnessDaemonLauncher?: FreshnessDaemonLauncher;
  demoSourceDaemonLauncher?: DemoSourceDaemonLauncher;
  processExists?: (pid: number) => boolean;
  terminateProcess?: (pid: number) => boolean;
  waitForProcessExit?: (pid: number) => Promise<boolean>;
}

type CliDaemonProcessSpawner = (
  command: string,
  args: string[],
  options: SpawnOptions
) => { pid?: number; unref(): void };

interface SourceInvalidationWatcher {
  source: string;
  mode: "session";
  close(): void | Promise<void>;
}

interface ActiveFSExportManifest {
  schemaVersion: 1;
  sourcePath: string;
  destination: string;
  startedAt: string;
  completedAt: string;
  consistency: "live" | "revision-pinned";
  treeRevision?: string;
  files: Array<{
    path: string;
    size: number;
    digest: string;
    revision?: string;
  }>;
  warnings: string[];
  failures: Array<{ path: string; message: string }>;
}

interface ActiveFSStatusSummary {
  rootDir: string;
  remotes: ActiveFSRemoteStatusSummary[];
}

interface ActiveFSRemoteStatusSummary {
  name: string;
  endpoint: string;
  insecureHttp?: ActiveFSRemoteConfig["insecureHttp"];
  mountPath?: string;
  mountpoint?: string;
  remoteRoot?: string;
  auth: ActiveFSAuthProviderConfig;
  policy: {
    defaultAccess: string;
    revision?: string;
    digest?: string;
    ruleCount: number;
  };
  adapterCapabilityProfile?: string;
  cache: {
    mode: string;
    fileCount?: number;
    byteSize?: number;
  };
  mount?: RcloneMountStatus;
  session: Record<string, unknown>;
  operations: {
    unresolvedCount: number;
    ids: string[];
  };
  activity: {
    policy: ActiveFSActivityPolicy;
    backlogCount: number;
    files: string[];
  };
}

type SyncAction = "status" | "refresh" | "watch";

interface ParsedSyncCommand {
  action: SyncAction;
  remoteName?: string;
  path?: string;
}

interface WebDAVDaemonLaunchRequest {
  rootDir: string;
  remote: ActiveFSMountRemote;
  host: string;
  port: number;
  auth?: WebDAVAuth;
}

type WebDAVDaemonLauncher = (
  request: WebDAVDaemonLaunchRequest
) => Promise<{ pid?: number; url: string }>;

interface FreshnessDaemonLaunchRequest {
  rootDir: string;
  remoteName: string;
  sourceNames: string[];
  rcloneBinary?: string;
}

type FreshnessDaemonLauncher = (
  request: FreshnessDaemonLaunchRequest
) => Promise<{ pid?: number }>;

interface DemoSourceDaemonLaunchRequest {
  rootDir: string;
  remoteName: string;
  host: string;
  port: number;
  url: string;
}

type DemoSourceDaemonLauncher = (
  request: DemoSourceDaemonLaunchRequest
) => Promise<{ pid?: number; url: string }>;

/**
 * Runs the ActiveFS command-line entrypoint.
 *
 * @param argv CLI arguments after the executable name.
 * @param options Optional injected dependencies for tests or embedding.
 * @throws Errors from command handlers. The executable wrapper catches them,
 * writes a user-facing message, and exits non-zero.
 */
export async function main(argv: string[], options: CliMainOptions = {}): Promise<void> {
  const [command, ...args] = argv;
  const wait = options.waitForInterrupt ?? waitForInterrupt;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "list":
    case "ls": {
      const fs = createCommandRuntime(args).filesystem;
      const path = firstPositional(args, workspaceOptions("--source")) ?? "/";
      const entries = command === "ls"
        ? await fs.command({}, "ls", path, {
            includeNonEnumerable: args.includes("--include-non-enumerable")
          })
        : await fs.list({}, path);
      for (const entry of entries) {
        console.log(`${entry.kind.padEnd(9)} ${entry.path}`);
      }
      return;
    }

    case "stat": {
      const fs = createCommandRuntime(args).filesystem;
      const path = requirePath(firstPositional(args, workspaceOptions("--source")), "stat");
      const stat = await fs.command({}, "stat", path, {});
      if (!stat) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`);
      }
      console.log(JSON.stringify(stat, null, 2));
      return;
    }

    case "read":
    case "cat": {
      const fs = createCommandRuntime(args).filesystem;
      const path = requirePath(firstPositional(args, workspaceOptions("--source")), command);
      const result = command === "cat"
        ? await fs.command({}, "cat", path, {})
        : await fs.read({}, path);
      process.stdout.write(
        typeof result.content === "string" ? result.content : Buffer.from(result.content)
      );
      return;
    }

    case "head":
    case "tail": {
      const fs = createCommandRuntime(args).filesystem;
      const path = requirePath(firstPositional(args, workspaceOptions("--lines", "--source")), command);
      const lines = positiveIntegerOption(args, "--lines");
      const result = await fs.command({}, command, path, { lines });
      process.stdout.write(typeof result.content === "string" ? result.content : Buffer.from(result.content));
      return;
    }

    case "sed": {
      const fs = createCommandRuntime(args).filesystem;
      const sed = parseSedArgs(args);
      const result = await fs.command({}, "sed", sed.path, sed.input);
      process.stdout.write(typeof result.content === "string" ? result.content : Buffer.from(result.content));
      return;
    }

    case "grep":
    case "rg": {
      const fs = createCommandRuntime(args).filesystem;
      const grep = parseGrepArgs(args, command);
      const result = await fs.command({}, command, grep.path, grep.query);
      if (grep.json) {
        printJson({
          path: grep.path,
          query: grep.query,
          strategy: result.strategy,
          complete: result.complete,
          incompleteReasons: result.incompleteReasons,
          matches: result.matches
        });
        return;
      }
      console.log(`# activefs ${command}: ${result.strategy}${result.complete ? "" : " incomplete"}`);
      for (const match of result.matches) {
        console.log(`${match.path}:${match.line ?? 0}:${match.column ?? 0}:${match.excerpt ?? ""}`);
      }
      return;
    }

    case "find": {
      const fs = createCommandRuntime(args).filesystem;
      const path = firstPositional(args, workspaceOptions("--source")) ?? "/";
      const entries = await fs.command({}, "find", path, {
        includeNonEnumerable: args.includes("--include-non-enumerable")
      });
      for (const entry of entries) {
        console.log(entry.path);
      }
      return;
    }

    case "tui": {
      if (args.includes("--help") || args.includes("-h")) {
        printTuiHelp();
        return;
      }
      const rootDir = workspaceDir(args);
      const runtime = createActiveFSTuiRuntime(optionValues(args, "--source"), { rootDir });
      await runActiveFSTui({
        filesystem: runtime.filesystem,
        sources: runtime.sources,
        rootDir,
        exportDir: optionValue(args, "--export-dir") ?? ".activefs/exports",
        commandRunner: options.commandRunner,
        platform: options.platform,
        fetch: options.fetch,
        debug: args.includes("--debug")
      });
      return;
    }

    case "doctor": {
      validateDoctorArgs(args);
      await printDoctor(args, options);
      return;
    }

    case "status": {
      await printStatus(args, options);
      return;
    }

    case "remote": {
      await handleRemoteCommand(args, options);
      return;
    }

    case "server": {
      await handleServerCommand(args, options, wait);
      return;
    }

    case "demo-source-api": {
      await serveDemoSourceApi(args, wait);
      return;
    }

    case "mcp": {
      await handleMCPCommand(args, options, wait);
      return;
    }

    case "auth": {
      await handleAuthCommand(args);
      return;
    }

    case "sync": {
      await handleSyncCommand(args, options, wait);
      return;
    }

    case "mount": {
      if (args[0] === "status") {
        await printMountStatus(args.slice(1), options);
        return;
      }
      if (args[0] === "cleanup") {
        await cleanupMount(args.slice(1), options);
        return;
      }
      await startMount(args, options);
      return;
    }

    case "remount": {
      await remount(args, options);
      return;
    }

    case "unmount": {
      await unmount(args, options);
      return;
    }

    case "refresh": {
      await refreshMount(args, options);
      return;
    }

    case "export": {
      const sourcePath = requirePath(args[0], "export");
      const outDir = requireOptionValue(args, "--to", "Usage: activefs export <path> --to <dir>");
      const manifest = await exportCurrentTree(sourcePath, outDir, args);
      console.log(`Exported ${manifest.files.length} file${manifest.files.length === 1 ? "" : "s"} to ${outDir}`);
      return;
    }

    case "watch": {
      throw new Error("activefs watch is no longer a public command. Use activefs export <path> --to <dir> for copied trees, or activefs sync watch as a support command.");
    }

    case "cache": {
      if (args[0] === "watch") {
        await watchCacheInvalidation(args.slice(1), options, wait);
        return;
      }
      if (args[0] === "status") {
        await printCacheStatus(args.slice(1));
        return;
      }
      if (args[0] === "clear") {
        await clearCache(args.slice(1), options);
        return;
      }
      throw new Error("Usage: activefs cache status|clear|watch [remote] [--state-root .activefs] [--json]");
    }

    case "logs": {
      await printLogs(args);
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function createCommandRuntime(args: string[]): ReturnType<typeof createActiveFSTuiRuntime> {
  return createActiveFSTuiRuntime(optionValues(args, "--source"), {
    rootDir: workspaceDir(args)
  });
}

async function handleMCPCommand(
  args: string[],
  options: CliMainOptions,
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    printMCPHelp();
    return;
  }
  const parsed = parseMCPCommand(args);
  if (parsed.action === "inspect") {
    await inspectMCPServer(parsed.args, parsed.remoteName);
    return;
  }
  if (parsed.action === "config") {
    await printMCPClientConfig(parsed.args, parsed.remoteName, parsed.clientConfigTarget);
    return;
  }
  if (parsed.action === "stop" || parsed.action === "status") {
    await printMCPRuntimeStatus(parsed.args, parsed.remoteName, parsed.action, options);
    return;
  }
  const transport = parseMCPTransport(parsed.args);
  const loaded = await loadSelectedMCPConfig(parsed.args, parsed.remoteName);
  const rootDir = workspaceDir(parsed.args);
  if (transport === "stdio") {
    await startActiveFSMCPStdioServer({
      filesystem: loaded.filesystem,
      remotes: loaded.remotes,
      config: loaded.config,
      installSignalHandlers: false
    });
    return;
  }
  const handle = await startActiveFSMCPHttpServer({
    filesystem: loaded.filesystem,
    remotes: loaded.remotes,
    config: loaded.config,
    host: optionValue(parsed.args, "--host"),
    port: parseOptionalPort(parsed.args),
    endpoint: optionValue(parsed.args, "--endpoint"),
    auth: parseMCPAuthArgs(parsed.args)
  });
  if (!parsed.args.includes("--demo")) {
    await writeMCPRuntimeStatuses(rootDir, loaded.remotes, {
      state: "up",
      transport: "http",
      url: handle.url,
      pid: process.pid,
      reachable: true,
      checkedAt: new Date().toISOString(),
      auth: {
        mode: handle.auth.mode,
        hasToken: Boolean(handle.auth.token),
        tokenEnv: handle.auth.tokenEnv
      }
    });
  }
  console.log(`ActiveFS MCP HTTP server listening on ${handle.url}`);
  console.log(`Auth: ${handle.auth.mode}${handle.auth.token ? ` token ${redactSecret(handle.auth.token)}` : ""}`);
  await wait(async () => {
    await handle.close();
    if (!parsed.args.includes("--demo")) {
      await writeMCPRuntimeStatuses(rootDir, loaded.remotes, {
        state: "down",
        transport: "http",
        url: handle.url,
        pid: process.pid,
        reachable: false,
        checkedAt: new Date().toISOString(),
        auth: {
          mode: handle.auth.mode,
          hasToken: Boolean(handle.auth.token),
          tokenEnv: handle.auth.tokenEnv
        },
        error: "MCP HTTP server stopped."
      });
    }
  });
}

type MCPCommandAction = "start" | "inspect" | "stop" | "status" | "config";
type MCPCommandTransport = "stdio" | "http";
type MCPClientConfigTarget = "claude" | "codex" | "generic";

interface MCPRuntimeStatus {
  remote: string;
  state: "up" | "down" | "not_recorded";
  transport?: MCPCommandTransport;
  url?: string;
  pid?: number;
  reachable?: boolean;
  checkedAt?: string;
  auth?: {
    mode: "bearer" | "none" | "stdio";
    hasToken?: boolean;
    tokenEnv?: string;
  };
  updatedAt: string;
  message?: string;
  error?: string;
}

interface DemoSourceRuntimeStatus {
  remote: string;
  kind: "source-api-demo";
  state: "up" | "down";
  url: string;
  host: string;
  port: number;
  pid?: number;
  reachable?: boolean;
  checkedAt?: string;
  updatedAt: string;
  message?: string;
  error?: string;
}

interface ParsedMCPCommand {
  action: MCPCommandAction;
  remoteName?: string;
  clientConfigTarget?: MCPClientConfigTarget;
  args: string[];
}

function parseMCPCommand(args: string[]): ParsedMCPCommand {
  const positionals = remainingPositionals(args, workspaceOptions(
    "--transport",
    "--config",
    "--host",
    "--port",
    "--endpoint",
    "--auth",
    "--token",
    "--allow-origin",
    "--allow-host"
  ));
  let action: MCPCommandAction = "start";
  let remoteName: string | undefined;
  let clientConfigTarget: MCPClientConfigTarget | undefined;
  for (const positional of positionals) {
    if (positional === "serve" || positional === "start") {
      action = "start";
      continue;
    }
    if (positional === "inspect" || positional === "stop" || positional === "status" || positional === "config") {
      action = positional;
      continue;
    }
    if (action === "config" && !clientConfigTarget && isMCPClientConfigTarget(positional)) {
      clientConfigTarget = positional;
      continue;
    }
    if (!remoteName) {
      remoteName = positional;
      continue;
    }
    throw new Error(`Usage: ${mcpUsageLine()}`);
  }
  return { action, remoteName, clientConfigTarget, args };
}

function mcpUsageLine(): string {
  return "activefs mcp [remote] [start|inspect|status|stop|config claude|codex|generic] [--http|--transport stdio|http] [--state-root .activefs]";
}

function isMCPClientConfigTarget(value: string): value is MCPClientConfigTarget {
  return value === "claude" || value === "codex" || value === "generic";
}

function parseMCPTransport(args: string[]): MCPCommandTransport {
  const transport = optionValue(args, "--transport");
  if (args.includes("--http")) {
    return "http";
  }
  if (args.includes("--stdio")) {
    return "stdio";
  }
  if (!transport) {
    return "stdio";
  }
  if (transport === "stdio" || transport === "http") {
    return transport;
  }
  throw new Error(`Invalid --transport value: ${transport}. Expected stdio or http.`);
}

async function loadSelectedMCPConfig(
  args: string[],
  remoteName?: string
): Promise<LoadedActiveFSMCPConfig> {
  const loaded = await loadActiveFSMCPConfig({
    workspace: workspaceDir(args),
    configPath: optionValue(args, "--config"),
    demo: args.includes("--demo")
  });
  return selectLoadedMCPRemote(loaded, remoteName);
}

function selectLoadedMCPRemote(
  loaded: LoadedActiveFSMCPConfig,
  remoteName?: string
): LoadedActiveFSMCPConfig {
  if (!remoteName) {
    return loaded;
  }
  const selected = loaded.remotes.filter((remote) => remote.name === remoteName);
  if (!selected.length) {
    const available = loaded.remotes.map((remote) => remote.name).sort().join(", ") || "none";
    throw new Error(`Unknown ActiveFS MCP remote: ${remoteName}. Available remotes: ${available}`);
  }
  return {
    ...loaded,
    remotes: selected,
    adapterOptions: {
      ...loaded.adapterOptions,
      remotes: selected,
      resourceTemplates: loaded.adapterOptions.resourceTemplates?.filter((template) =>
        template.uriTemplate === `activefs://${remoteName}` ||
        template.uriTemplate.startsWith(`activefs://${remoteName}/`)
      )
    }
  };
}

async function inspectMCPServer(args: string[], remoteName?: string): Promise<void> {
  const loaded = await loadSelectedMCPConfig(args, remoteName);
  const transport = parseMCPTransport(args);
  const auth = transport === "http"
    ? { ...loaded.config.auth, ...parseMCPAuthArgs(args) }
    : loaded.config.auth;
  printJson({
    name: loaded.config.name,
    protocolVersion: ACTIVEFS_MCP_PROTOCOL_VERSION,
    rootDir: resolve(workspaceDir(args)),
    remote: remoteName,
    transport,
    remotes: loaded.remotes,
    resources: loaded.config.resources,
    tools: listActiveFSMCPTools(loaded.config.tools).map((tool) => tool.name),
    prompts: loaded.config.prompts.enabled
      ? listActiveFSMCPPrompts().map((prompt) => prompt.name)
      : [],
    subscriptions: {
      ...loaded.config.subscriptions,
      advertised: loaded.config.subscriptions.enabled && loaded.remotes.some((remote) => remote.watchable === true)
    },
    auth: {
      mode: auth.mode,
      token: auth.token ? redactSecret(auth.token) : undefined,
      tokenEnv: auth.tokenEnv
    }
  });
}

async function printMCPClientConfig(
  args: string[],
  remoteName: string | undefined,
  target: MCPClientConfigTarget | undefined
): Promise<void> {
  const loaded = await loadSelectedMCPConfig(args, remoteName);
  const serverName = remoteName ? `activefs-${remoteName}` : "activefs";
  const command = "activefs";
  const commandArgs = mcpStdioClientArgs(args, remoteName);
  switch (target ?? "generic") {
    case "claude":
      printJson({
        mcpServers: {
          [serverName]: {
            command,
            args: commandArgs
          }
        }
      });
      return;
    case "codex":
      console.log(`[mcp_servers.${tomlBareKey(serverName)}]`);
      console.log(`command = ${tomlString(command)}`);
      console.log(`args = [${commandArgs.map(tomlString).join(", ")}]`);
      return;
    case "generic":
      printJson({
        name: serverName,
        transport: "stdio",
        command,
        args: commandArgs,
        remotes: loaded.remotes.map((remote) => ({
          name: remote.name,
          rootPath: remote.rootPath,
          watchable: remote.watchable
        }))
      });
      return;
  }
}

function mcpStdioClientArgs(args: string[], remoteName: string | undefined): string[] {
  const commandArgs = ["mcp"];
  if (remoteName) {
    commandArgs.push(remoteName);
  }
  commandArgs.push("start");
  const configPath = optionValue(args, "--config");
  if (configPath) {
    commandArgs.push("--config", resolve(configPath));
  }
  if (args.includes("--demo")) {
    commandArgs.push("--demo");
  } else {
    commandArgs.push("--state-root", resolve(workspaceDir(args)));
  }
  return commandArgs;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlBareKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

async function printMCPRuntimeStatus(
  args: string[],
  remoteName: string | undefined,
  action: "stop" | "status",
  options: CliMainOptions = {}
): Promise<void> {
  const rootDir = workspaceDir(args);
  const loaded = await loadSelectedMCPConfig(args, remoteName);
  const remotes: MCPRuntimeStatus[] = [];
  for (const remote of loaded.remotes) {
    const current = await readMCPRuntimeStatus(rootDir, remote.name);
    remotes.push(action === "stop"
      ? await stopMCPRuntime(rootDir, remote.name, current, options)
      : await reconcileMCPRuntimeStatus(rootDir, remote.name, current, options));
  }
  if (args.includes("--json")) {
    printJson({
      rootDir: resolve(rootDir),
      action,
      remotes
    });
    return;
  }
  for (const remote of remotes) {
    console.log(`${remote.remote}: ${remote.state}${remote.url ? ` ${remote.url}` : ""}`);
    if (remote.message) {
      console.log(remote.message);
    }
    if (remote.error) {
      console.log(`  error: ${remote.error}`);
    }
  }
}

async function writeMCPRuntimeStatuses(
  rootDir: string,
  remotes: LoadedActiveFSMCPConfig["remotes"],
  status: Omit<MCPRuntimeStatus, "remote" | "updatedAt">
): Promise<void> {
  await Promise.all(remotes.map((remote) => writeMCPRuntimeStatus(rootDir, remote.name, status)));
}

async function writeMCPRuntimeStatus(
  rootDir: string,
  remoteName: string,
  status: Omit<MCPRuntimeStatus, "remote" | "updatedAt">
): Promise<MCPRuntimeStatus> {
  const layout = createActiveFSRemoteStateLayout(rootDir, remoteName);
  const next: MCPRuntimeStatus = {
    ...status,
    remote: remoteName,
    updatedAt: new Date().toISOString()
  };
  await atomicWriteFile(join(layout.runtimeDir, "mcp.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function readMCPRuntimeStatus(rootDir: string, remoteName: string): Promise<MCPRuntimeStatus | undefined> {
  const layout = createActiveFSRemoteStateLayout(rootDir, remoteName);
  try {
    const parsed = JSON.parse(await readFile(join(layout.runtimeDir, "mcp.json"), "utf8")) as Partial<MCPRuntimeStatus>;
    if (parsed && typeof parsed === "object" && parsed.remote === remoteName) {
      return parsed as MCPRuntimeStatus;
    }
    return {
      remote: remoteName,
      state: "down",
      updatedAt: new Date().toISOString(),
      error: "Invalid MCP runtime status shape."
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    return {
      remote: remoteName,
      state: "down",
      updatedAt: new Date().toISOString(),
      error: `Unable to read MCP runtime status: ${errorMessage(error)}`
    };
  }
}

async function reconcileMCPRuntimeStatus(
  rootDir: string,
  remoteName: string,
  status: MCPRuntimeStatus | undefined,
  options: CliMainOptions
): Promise<MCPRuntimeStatus> {
  if (!status) {
    return notRecordedMCPRuntimeStatus(remoteName);
  }
  const processExists = options.processExists ?? defaultProcessExists;
  if (status.state === "up" && status.pid && !processExists(status.pid)) {
    return writeMCPRuntimeStatus(rootDir, remoteName, {
      ...status,
      state: "down",
      error: "MCP runtime pid is not running."
    });
  }
  if (status.state === "up" && status.transport === "http" && status.url) {
    const probe = await probeMCPRuntimeEndpoint(status, options.fetch ?? fetch);
    if (!probe.reachable) {
      return writeMCPRuntimeStatus(rootDir, remoteName, {
        ...status,
        state: "down",
        reachable: false,
        checkedAt: probe.checkedAt,
        error: probe.error
      });
    }
    return writeMCPRuntimeStatus(rootDir, remoteName, {
      ...status,
      reachable: true,
      checkedAt: probe.checkedAt
    });
  }
  return status;
}

async function probeMCPRuntimeEndpoint(
  status: MCPRuntimeStatus,
  fetchImpl: typeof fetch
): Promise<{ reachable: boolean; checkedAt: string; error?: string }> {
  const checkedAt = new Date().toISOString();
  if (!status.url) {
    return { reachable: false, checkedAt, error: "No MCP HTTP URL was recorded." };
  }
  const headers = new Headers();
  const token = status.auth?.tokenEnv ? process.env[status.auth.tokenEnv] : undefined;
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  try {
    const response = await fetchImpl(status.url, { method: "GET", headers });
    if (isReachableMCPProbeStatus(response.status)) {
      return { reachable: true, checkedAt };
    }
    return {
      reachable: false,
      checkedAt,
      error: `MCP HTTP endpoint responded with HTTP ${response.status}.`
    };
  } catch (error) {
    return {
      reachable: false,
      checkedAt,
      error: `MCP HTTP endpoint probe failed: ${errorMessage(error)}`
    };
  }
}

function isReachableMCPProbeStatus(status: number): boolean {
  return status === 200 || status === 202 || status === 400 || status === 401 || status === 405;
}

async function stopMCPRuntime(
  rootDir: string,
  remoteName: string,
  status: MCPRuntimeStatus | undefined,
  options: CliMainOptions
): Promise<MCPRuntimeStatus> {
  if (!status) {
    return notRecordedMCPRuntimeStatus(remoteName);
  }
  const processExists = options.processExists ?? defaultProcessExists;
  const terminateProcess = options.terminateProcess ?? defaultTerminateProcess;
  let message = "No MCP runtime pid was recorded.";
  if (status.pid) {
    if (processExists(status.pid)) {
      message = terminateProcess(status.pid)
        ? `Requested stop for MCP runtime pid ${status.pid}.`
        : `Failed to stop MCP runtime pid ${status.pid}.`;
    } else {
      message = `MCP runtime pid ${status.pid} is not running.`;
    }
  }
  return writeMCPRuntimeStatus(rootDir, remoteName, {
    ...status,
    state: "down",
    message
  });
}

function notRecordedMCPRuntimeStatus(remoteName: string): MCPRuntimeStatus {
  return {
    remote: remoteName,
    state: "not_recorded",
    updatedAt: new Date().toISOString(),
    message: "No managed MCP server is recorded. Stdio MCP servers are normally started and stopped by the MCP client; HTTP MCP records runtime status while ActiveFS runs it."
  };
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultTerminateProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function serveDemoSourceApi(
  args: string[],
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  const rootDir = workspaceDir(args);
  const remoteName = requirePath(optionValue(args, "--remote"), "demo-source-api --remote");
  const host = parseDemoSourceApiHost(args);
  const port = parseDemoSourceApiPort(args, { allowZero: true });
  const server = await startActiveFSServer({
    tree: createDemoSourceApiTree(),
    hostname: host,
    port,
    handshake: {
      server: { name: "activefs-demo-source-api", version: "1.0.0" },
      workspace: {
        displayName: "ActiveFS Demo Source API",
        suggestedMountPath: `/${remoteName}`
      },
      cache: { directoryTtlMs: 60_000 }
    }
  });
  const resolvedUrl = server.url;
  const resolved = new URL(resolvedUrl);
  await writeDemoSourceRuntimeStatus(rootDir, remoteName, {
    kind: "source-api-demo",
    state: "up",
    url: resolvedUrl,
    host,
    port: Number.parseInt(resolved.port || String(port), 10),
    pid: process.pid,
    reachable: true,
    checkedAt: new Date().toISOString()
  });
  console.log(`ActiveFS demo Source API serving at ${resolvedUrl}`);
  await wait(async () => {
    await server.close();
    await writeDemoSourceRuntimeStatus(rootDir, remoteName, {
      kind: "source-api-demo",
      state: "down",
      url: resolvedUrl,
      host,
      port: Number.parseInt(resolved.port || String(port), 10),
      pid: process.pid,
      reachable: false,
      checkedAt: new Date().toISOString(),
      error: "Demo Source API server stopped."
    });
  });
}

function createDemoSourceApiTree(): ActiveFSTree {
  return fsTree({
    "/README.txt": text("Hello from the ActiveFS demo Source API.\n", { type: "text/plain" }),
    notes: dir({
      "source-api.txt": text("Source API exposes a generic HTTP tree service.\n")
    }),
    bin: dir({
      "sample.bin": bytes(new Uint8Array([0, 1, 2, 3, 255]))
    })
  }, {
    name: "activefs-demo-source-api",
    capabilities: { search: true, searchable: true }
  });
}

function demoSourceRuntimePath(rootDir: string, remoteName: string): string {
  return join(createActiveFSRemoteStateLayout(rootDir, remoteName).runtimeDir, "source-demo.json");
}

async function writeDemoSourceRuntimeStatus(
  rootDir: string,
  remoteName: string,
  status: Omit<DemoSourceRuntimeStatus, "remote" | "updatedAt">
): Promise<DemoSourceRuntimeStatus> {
  const next: DemoSourceRuntimeStatus = {
    ...status,
    remote: remoteName,
    updatedAt: new Date().toISOString()
  };
  await atomicWriteFile(demoSourceRuntimePath(rootDir, remoteName), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function readDemoSourceRuntimeStatus(
  rootDir: string,
  remoteName: string
): Promise<DemoSourceRuntimeStatus | undefined> {
  try {
    const parsed = JSON.parse(await readFile(demoSourceRuntimePath(rootDir, remoteName), "utf8")) as Partial<DemoSourceRuntimeStatus>;
    if (parsed && typeof parsed === "object" && parsed.kind === "source-api-demo" && parsed.remote === remoteName) {
      return parsed as DemoSourceRuntimeStatus;
    }
    return undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function startDemoSourceRuntime(
  rootDir: string,
  remoteName: string,
  args: string[],
  options: CliMainOptions
): Promise<DemoSourceRuntimeStatus> {
  const host = parseDemoSourceApiHost(args);
  const port = parseDemoSourceApiPort(args, { allowZero: false });
  const url = demoSourceApiUrl(host, port);
  const existing = await readDemoSourceRuntimeStatus(rootDir, remoteName);
  const processExists = options.processExists ?? defaultProcessExists;
  if (existing?.state === "up" && existing.pid && processExists(existing.pid)) {
    if (existing.url === url) {
      return existing;
    }
    await stopDemoSourceRuntime(rootDir, remoteName, options);
  }
  const launched = options.demoSourceDaemonLauncher
    ? await options.demoSourceDaemonLauncher({ rootDir, remoteName, host, port, url })
    : await defaultDemoSourceDaemonLauncher({ rootDir, remoteName, host, port, url }, options.daemonProcessSpawner);
  return writeDemoSourceRuntimeStatus(rootDir, remoteName, {
    kind: "source-api-demo",
    state: "up",
    url: validateActiveFSSourceDiscoveryUrl(launched.url),
    host,
    port,
    pid: launched.pid,
    reachable: false,
    message: "Demo Source API daemon launched; reachability pending."
  });
}

async function stopDemoSourceRuntime(
  rootDir: string,
  remoteName: string,
  options: CliMainOptions,
  waitForExit = false
): Promise<DemoSourceRuntimeStatus | undefined> {
  const status = await readDemoSourceRuntimeStatus(rootDir, remoteName);
  if (!status) {
    return undefined;
  }
  const processExists = options.processExists ?? defaultProcessExists;
  const terminateProcess = options.terminateProcess ?? defaultTerminateProcess;
  let message = "No demo Source API runtime pid was recorded.";
  if (status.pid) {
    if (processExists(status.pid)) {
      const terminationRequested = terminateProcess(status.pid);
      message = terminationRequested
        ? `Requested stop for demo Source API runtime pid ${status.pid}.`
        : `Failed to stop demo Source API runtime pid ${status.pid}.`;
      if (!terminationRequested && waitForExit) {
        throw new Error(
          `Failed to stop demo Source API runtime pid ${status.pid}. Retry remote remove after the process stops.`
        );
      }
      if (terminationRequested && waitForExit) {
        const exited = await waitForDemoSourceProcessExit(status.pid, processExists, options.waitForProcessExit);
        if (!exited) {
          throw new Error(
            `Demo Source API runtime pid ${status.pid} did not exit. Retry remote remove after the process stops.`
          );
        }
      }
    } else {
      message = `Demo Source API runtime pid ${status.pid} is not running.`;
    }
  }
  return writeDemoSourceRuntimeStatus(rootDir, remoteName, {
    ...status,
    state: "down",
    reachable: false,
    message
  });
}

async function waitForDemoSourceProcessExit(
  pid: number,
  processExists: (pid: number) => boolean,
  waiter?: (pid: number) => Promise<boolean>
): Promise<boolean> {
  if (waiter) {
    return waiter(pid);
  }
  const deadline = Date.now() + 3_000;
  while (processExists(pid) && Date.now() < deadline) {
    await delay(25);
  }
  return !processExists(pid);
}

async function clearInactiveDemoSourceRuntime(
  rootDir: string,
  remoteName: string,
  options: CliMainOptions
): Promise<void> {
  const status = await readDemoSourceRuntimeStatus(rootDir, remoteName);
  if (!status) {
    return;
  }
  const processExists = options.processExists ?? defaultProcessExists;
  if (status.pid && processExists(status.pid)) {
    if (status.state === "up") {
      return;
    }
    const exited = await waitForDemoSourceProcessExit(status.pid, processExists, options.waitForProcessExit);
    if (!exited) {
      return;
    }
  }
  await rm(demoSourceRuntimePath(rootDir, remoteName), { force: true });
}

function defaultDemoSourceDaemonLauncher(
  request: DemoSourceDaemonLaunchRequest,
  processSpawner: CliDaemonProcessSpawner = spawn
): Promise<{ pid?: number; url: string }> {
  const cliPath = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const args = [
    cliPath,
    "demo-source-api",
    "--host",
    request.host,
    "--port",
    String(request.port),
    "--root",
    request.rootDir,
    "--remote",
    request.remoteName
  ];
  const child = processSpawner(process.execPath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return Promise.resolve({
    pid: child.pid,
    url: request.url
  });
}

async function waitForDemoSourceApiCheck(
  endpoint: string,
  name: string,
  options: CliMainOptions
): Promise<RemoteEndpointCheck> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await checkRemoteEndpoint(endpoint, name, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function parseMCPAuthArgs(args: string[]): ActiveFSMCPAuthConfig {
  const token = optionValue(args, "--token");
  const auth: ActiveFSMCPAuthConfig = {
    mode: optionValue(args, "--auth") === "none" ? "none" : "bearer",
    allowInsecureHttp: args.includes("--allow-insecure-http"),
    allowNetworkBind: args.includes("--allow-network-bind")
  };
  if (token?.startsWith("env:")) {
    auth.tokenEnv = token.slice("env:".length);
  } else if (token) {
    auth.token = token;
  }
  const allowedOrigins = optionValues(args, "--allow-origin");
  if (allowedOrigins.length) {
    auth.allowedOrigins = allowedOrigins;
  }
  const allowedHosts = optionValues(args, "--allow-host");
  if (allowedHosts.length) {
    auth.allowedHosts = allowedHosts;
  }
  return auth;
}

function parseOptionalPort(args: string[]): number | undefined {
  const value = optionValue(args, "--port");
  if (!value) {
    return undefined;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`Invalid --port value: ${value}`);
  }
  return port;
}

function parseDemoSourceApiPort(args: string[], options: { allowZero: boolean }): number {
  const value = optionValue(args, "--port") ?? "3999";
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || (!options.allowZero && port === 0)) {
    throw new Error(options.allowZero
      ? `Invalid --port value: ${value}`
      : `Demo Source API --port must be a positive integer: ${value}`);
  }
  return port;
}

function parseDemoSourceApiHost(args: string[]): string {
  const host = optionValue(args, "--host") ?? optionValue(args, "--hostname") ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`Demo Source API can only bind loopback hosts: ${host}`);
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

function demoSourceApiUrl(host: string, port: number): string {
  const hostForUrl = host.includes(":") ? `[${host}]` : host;
  return `http://${hostForUrl}:${port}/_activefs/`;
}

async function exportCurrentTree(
  sourcePath: string,
  outDir: string,
  args: string[] = []
): Promise<ActiveFSExportManifest> {
  const startedAt = new Date().toISOString();
  const rootDir = workspaceDir(args);
  const treeRevision = optionValue(args, "--tree-revision");
  if (isAmbiguousHostRootExport(sourcePath, args)) {
    throw new Error("Refusing ambiguous host-root export of /. Use a remote path such as repo:/, pass --source, or pass an explicit --state-root.");
  }
  const exported = isRemoteNamespacePath(sourcePath)
    ? await exportConfiguredRemote(sourcePath, outDir, rootDir, { treeRevision })
    : shouldUseActiveFSExport(sourcePath, args, rootDir)
      ? await exportTree(
        activeFSAsTree(createActiveFSTuiRuntime(optionValues(args, "--source"), { rootDir }).filesystem),
        outDir,
        { rootPath: normalizeActiveFSPath(sourcePath), treeRevision }
      )
      : await exportTree(sourcePath, outDir, { treeRevision });
  const files = await Promise.all(exported.entries.map(async (entry) => {
    const localPath = join(outDir, entry.path.slice(1));
    const bytes = await readFile(localPath);
    return {
      path: entry.path,
      size: entry.size,
      digest: `sha-256:${createHash("sha256").update(bytes).digest("hex")}`,
      revision: entry.revision
    };
  }));
  const manifest: ActiveFSExportManifest = {
    schemaVersion: 1,
    sourcePath,
    destination: resolve(outDir),
    startedAt,
    completedAt: new Date().toISOString(),
    consistency: exported.consistency,
    files,
    warnings: exported.consistency === "live"
      ? ["This export is a live multi-request copy, not a stable server snapshot."]
      : [],
    failures: []
  };
  if (exported.treeRevision) {
    manifest.treeRevision = exported.treeRevision;
  }
  await atomicWriteFile(
    join(outDir, "activefs-export-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return manifest;
}

async function exportConfiguredRemote(
  sourcePath: string,
  outDir: string,
  rootDir: string,
  options: { treeRevision?: string } = {}
): Promise<Awaited<ReturnType<typeof exportTree>>> {
  const parsed = parseRemotePath(sourcePath);
  const unifiedConfig = await loadActiveFSConfig(rootDir);
  const remote = sourceRemoteFromUnifiedConfig(unifiedConfig, parsed.remote);
  if (!remote) {
    throw new Error(unknownActiveFSRemoteMessage(parsed.remote));
  }
  const source = createHttpSourceClient({
    url: remote.url,
    name: remote.name,
    allowInsecureHttp: remote.allowInsecureHttp,
    auth: sourceAuthProvider(rootDir, remote.name, unifiedConfig.remotes[remote.name]?.auth)
  });
  return exportTree(source, outDir, { rootPath: normalizeActiveFSPath(parsed.path), treeRevision: options.treeRevision });
}

function shouldUseActiveFSExport(sourcePath: string, args: string[], rootDir: string): boolean {
  if (!sourcePath.startsWith("/")) {
    return false;
  }
  if (optionValues(args, "--source").length > 0) {
    return true;
  }
  if (isExistingNonRootHostPath(sourcePath) && !hasExplicitWorkspaceOption(args)) {
    return false;
  }
  if (hasExplicitWorkspaceOption(args)) {
    return true;
  }
  return existsSync(resolveActiveFSState(rootDir).configPath);
}

function isExistingNonRootHostPath(sourcePath: string): boolean {
  return normalizeActiveFSPath(sourcePath) !== "/" && existsSync(resolve(sourcePath));
}

function hasExplicitWorkspaceOption(args: string[]): boolean {
  return Boolean(optionValue(args, "--state-root") || optionValue(args, "--workspace") || optionValue(args, "--root"));
}

function isAmbiguousHostRootExport(sourcePath: string, args: string[]): boolean {
  return normalizeActiveFSPath(sourcePath) === "/" &&
    !isRemoteNamespacePath(sourcePath) &&
    optionValues(args, "--source").length === 0 &&
    !hasExplicitWorkspaceOption(args);
}

function isRemoteNamespacePath(value: string): boolean {
  const separator = value.indexOf(":");
  const path = value.slice(separator + 1);
  return separator > 0 && path.startsWith("/") && !path.startsWith("//");
}

function workspaceDir(args: string[]): string {
  const explicit = optionValue(args, "--state-root") ?? optionValue(args, "--workspace") ?? optionValue(args, "--root");
  if (explicit) {
    return explicit;
  }
  return discoverWorkspaceDirFromCwd() ?? ".activefs";
}

function workspaceOptions(...options: string[]): Set<string> {
  return new Set(["--root", "--workspace", "--state-root", ...options]);
}

function remoteAddOptionsWithValues(): Set<string> {
  return workspaceOptions(
    "--activity-policy",
    "--host",
    "--hostname",
    "--mount",
    "--mount-ready-timeout-ms",
    "--mount-path",
    "--port",
    "--protocol"
  );
}

function discoverWorkspaceDirFromCwd(): string | undefined {
  let current = resolve(".");
  while (true) {
    const state = resolveActiveFSState(current);
    if (existsSync(state.configPath) || existsSync(state.stateDir)) {
      return state.stateDir;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function mountLayoutForRemote(rootDir: string, remote: ActiveFSMountRemote): ReturnType<typeof createMountLayout> {
  return createMountLayout(rootDir, remote.name, { mountpoint: remote.mountpoint });
}

function sourceAuthProvider(
  rootDir: string,
  remoteName: string,
  provider: ActiveFSAuthProviderConfig | undefined
): HttpSourceClientAuth | undefined {
  if (!provider || provider.type === "none") {
    return undefined;
  }
  return () => authHeadersFromProvider(provider, {
    layout: createActiveFSRemoteStateLayout(rootDir, remoteName)
  });
}

async function invalidateMountCaches(request: {
  rootDir: string;
  remoteName?: string;
  path?: string;
  recursive?: boolean;
  args: string[];
  options: CliMainOptions;
}): Promise<Array<Awaited<ReturnType<typeof clearMountCache>> & {
  refresh?: Awaited<ReturnType<typeof refreshRcloneMount>>;
}>> {
  const config = await loadActiveFSMountConfig(request.rootDir);
  const remotes = selectedRemotes(config.remotes, request.remoteName, false);
  const results: Array<Awaited<ReturnType<typeof clearMountCache>> & {
    refresh?: Awaited<ReturnType<typeof refreshRcloneMount>>;
  }> = [];

  for (const remote of remotes) {
    const layout = mountLayoutForRemote(request.rootDir, remote);
    const path = request.path ? normalizeActiveFSPath(request.path) : undefined;
    const cleared = await clearMountCache(layout, { path });
    let refresh: Awaited<ReturnType<typeof refreshRcloneMount>> | undefined;
    const status = await readRcloneMountStatus(layout, {
      remote,
      commandRunner: request.options.commandRunner,
      platform: request.options.platform,
      fetch: request.options.fetch,
      checkWebDAV: false
    });
    if (status.mounted) {
      refresh = await refreshRcloneMount(layout, {
        remote,
        path: path ?? "/",
        recursive: request.recursive ?? path === undefined,
        rcloneBinary: optionValue(request.args, "--rclone") ?? undefined,
        commandRunner: request.options.commandRunner,
        platform: request.options.platform,
        fetch: request.options.fetch
      });
    }
    results.push({ ...cleared, refresh });
  }

  return results;
}

async function printDoctor(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const insecureHttpRemotes = insecureHttpRemoteSummaries(config);
  if (args.includes("--json")) {
    const evidence = await collectRcloneMountEvidence(rootDir, {
      commandRunner: options.commandRunner,
      platform: options.platform,
      fetch: options.fetch
    });
    printJson({ ...evidence, insecureHttpRemotes });
    return;
  }

  console.log(formatRcloneMountHostReport(inspectRcloneMountHost({
    commandRunner: options.commandRunner,
    platform: options.platform
  })));
  if (!args.includes("--mounts")) {
    return;
  }

  const evidence = await collectRcloneMountEvidence(rootDir, {
    commandRunner: options.commandRunner,
    platform: options.platform,
    fetch: options.fetch
  });
  if (evidence.activeMounts.lines.length > 0) {
    console.log("activefs mounted folders:");
    for (const line of evidence.activeMounts.lines) {
      console.log(`  ${line}`);
    }
  } else {
    console.log("activefs mounted folders: none");
  }
  if (evidence.remotes.length > 0) {
    console.log("configured remotes:");
    for (const status of evidence.remotes) {
      console.log(`  ${status.remote}: ${mountStatusDisplayState(status)}${status.mounted ? " (mounted)" : ""}`);
    }
  }
  if (insecureHttpRemotes.length > 0) {
    console.log("insecure http Source API remotes:");
    for (const remote of insecureHttpRemotes) {
      console.log(`  ${remote.name}: ${remote.reason}, dev only`);
    }
  }
}

async function printStatus(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const mountConfig = await loadActiveFSMountConfig(rootDir);
  const selection = resolveStatusSelection(config, firstPositional(args, workspaceOptions()));
  const remotes = selectedStatusRemotes(config.remotes, selection);
  const summaries: ActiveFSRemoteStatusSummary[] = [];

  for (const remote of remotes) {
    const mountRemote = mountConfig.remotes[remote.name];
    const mount = mountRemote
      ? await readRcloneMountStatus(mountLayoutForRemote(rootDir, mountRemote), {
        remote: mountRemote,
        commandRunner: options.commandRunner,
        platform: options.platform,
        fetch: options.fetch
      })
      : undefined;
    const cache = mountRemote
      ? await readMountCacheSnapshot(mountLayoutForRemote(rootDir, mountRemote)).catch(() => undefined)
      : undefined;
    const layout = createActiveFSRemoteStateLayout(rootDir, remote.name);
    const session = summarizeSessionRecord(await readJsonIfExists(layout.sessionPath));
    await reconcileOperationJournal(rootDir, remote, layout, options);
    const operationIds = await listUnresolvedOperationIds(layout.journalDir);
    const activityFiles = await listStateFileNames(layout.activityDir);
    summaries.push({
      name: remote.name,
      endpoint: remote.url,
      insecureHttp: remote.insecureHttp,
      mountPath: remote.mountPath,
      mountpoint: remote.mountpoint,
      remoteRoot: remote.remoteRoot,
      auth: remote.auth ?? { type: "none" },
      policy: {
        defaultAccess: remote.policy?.defaultAccess ?? "readonly",
        revision: remote.policy?.revision,
        digest: remote.policy?.digest,
        ruleCount: remote.policy?.rules.length ?? 0
      },
      adapterCapabilityProfile: remote.adapterCapabilityProfile,
      cache: {
        mode: remote.cacheMode ?? "off",
        fileCount: cache?.fileCount,
        byteSize: cache?.byteSize
      },
      mount,
      session,
      operations: {
        unresolvedCount: operationIds.length,
        ids: operationIds
      },
      activity: {
        policy: remote.activityPolicy ?? "best-effort",
        backlogCount: activityFiles.length,
        files: activityFiles
      }
    });
  }

  const summary: ActiveFSStatusSummary = {
    rootDir: resolve(rootDir),
    remotes: summaries
  };
  if (args.includes("--json")) {
    printJson(summary);
    return;
  }
  printStatusText(summary);
}

async function handleRemoteCommand(args: string[], options: CliMainOptions = {}): Promise<void> {
  switch (args[0]) {
    case "add":
      await addRemote(args.slice(1), options);
      return;
    case "list":
    case "ls":
      await listRemotes(args.slice(1));
      return;
    case "status":
      await printRemoteStatus(args.slice(1), options);
      return;
    case "remove":
    case "rm":
      await removeRemote(args.slice(1), options);
      return;
    default:
      throw new Error("Usage: activefs remote add|list|status|remove ...");
  }
}

async function handleAuthCommand(args: string[]): Promise<void> {
  switch (args[0]) {
    case "set":
      await setRemoteAuth(args.slice(1));
      return;
    case "status":
      await printAuthStatus(args.slice(1));
      return;
    case "clear":
      await clearRemoteAuth(args.slice(1));
      return;
    default:
      throw new Error("Usage: activefs auth set|status|clear <remote> [--state-root .activefs]");
  }
}

async function setRemoteAuth(args: string[]): Promise<void> {
  const remoteName = requirePath(firstPositional(args, workspaceOptions(
    "--env",
    "--scheme",
    "--token-command",
    "--headers-command",
    "--cookie-provider",
    "--static-header"
  )), "auth set");
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const remote = config.remotes[remoteName];
  if (!remote) {
    throw new Error(unknownActiveFSRemoteMessage(remoteName));
  }
  const scheme = optionValue(args, "--scheme") ?? "Bearer";
  let provider: ActiveFSAuthProviderConfig | undefined;
  const envName = optionValue(args, "--env");
  const tokenCommand = optionValue(args, "--token-command");
  const headersCommand = optionValue(args, "--headers-command");
  const cookieProvider = optionValue(args, "--cookie-provider");
  const staticHeader = optionValue(args, "--static-header");
  const selected = [envName, tokenCommand, headersCommand, cookieProvider, staticHeader, args.includes("--bearer-stdin") ? "stdin" : undefined]
    .filter(Boolean);
  if (selected.length !== 1) {
    throw new Error(
      "Usage: activefs auth set <remote> --env NAME|--token-command '[\"cmd\"]'|--headers-command '[\"cmd\"]'|--cookie-provider '[\"cmd\"]'|--static-header Header:ENV|--bearer-stdin"
    );
  }
  if (envName) {
    provider = { type: "bearer-env", env: envName, scheme };
  } else if (tokenCommand) {
    provider = { type: "token-command", argv: parseCommandArgv(tokenCommand), scheme };
  } else if (headersCommand) {
    provider = { type: "headers-command", argv: parseCommandArgv(headersCommand) };
  } else if (cookieProvider) {
    provider = { type: "cookie-provider", argv: parseCommandArgv(cookieProvider) };
  } else if (staticHeader) {
    const separator = staticHeader.indexOf(":");
    if (separator <= 0 || separator === staticHeader.length - 1) {
      throw new Error("--static-header must be Header-Name:ENV_NAME");
    }
    provider = {
      type: "static-header",
      header: staticHeader.slice(0, separator),
      env: staticHeader.slice(separator + 1)
    };
  } else {
    const token = (await readStdin()).trim();
    if (!token) {
      throw new Error("--bearer-stdin requires a non-empty token on stdin.");
    }
    const layout = createActiveFSRemoteStateLayout(rootDir, remoteName);
    await writePrivateBearerToken(layout, token);
    provider = { type: "private-bearer-token", scheme };
  }
  await upsertActiveFSRemote(rootDir, { ...remote, auth: provider });
  console.log(`${remoteName}: auth ${provider.type}`);
}

async function printAuthStatus(args: string[]): Promise<void> {
  const remoteName = requirePath(firstPositional(args, workspaceOptions()), "auth status");
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const remote = config.remotes[remoteName];
  if (!remote) {
    throw new Error(unknownActiveFSRemoteMessage(remoteName));
  }
  if (args.includes("--json")) {
    printJson({ remote: remoteName, auth: remote.auth ?? { type: "none" } });
    return;
  }
  console.log(`${remoteName}: ${(remote.auth ?? { type: "none" }).type}`);
}

async function clearRemoteAuth(args: string[]): Promise<void> {
  const remoteName = requirePath(firstPositional(args, workspaceOptions()), "auth clear");
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const remote = config.remotes[remoteName];
  if (!remote) {
    throw new Error(unknownActiveFSRemoteMessage(remoteName));
  }
  await clearPrivateAuthSecret(createActiveFSRemoteStateLayout(rootDir, remoteName));
  await upsertActiveFSRemote(rootDir, { ...remote, auth: { type: "none" } });
  console.log(`${remoteName}: auth cleared`);
}

async function addRemote(args: string[], options: CliMainOptions = {}): Promise<void> {
  const demo = args.includes("--demo");
  const positionals = remainingPositionals(args, remoteAddOptionsWithValues());
  const name = requirePath(positionals[0], "remote add");
  if (demo && positionals.length > 1) {
    throw new Error("Usage: activefs remote add <name> --demo [--port 3999]");
  }
  const endpoint = demo
    ? demoSourceApiUrl(parseDemoSourceApiHost(args), parseDemoSourceApiPort(args, { allowZero: false }))
    : requirePath(positionals[1], "remote add");
  const rootDir = workspaceDir(args);
  if (!demo) {
    await clearInactiveDemoSourceRuntime(rootDir, name, options);
  }
  validateDeprecatedRemoteProtocolOption(optionValue(args, "--protocol"));
  const shouldCheck = !args.includes("--no-check");
  const allowInsecureHttp = args.includes("--allow-insecure-http");
  const requestedMountPath = optionValue(args, "--mount-path");
  const mountpoint = optionValue(args, "--mount");
  const activityPolicy = parseActivityPolicyOption(optionValue(args, "--activity-policy") ?? "best-effort");
  const watchableOverride = parseRemoteWatchableOption(args);
  const insecureHttp = sourceApiHttpSecurity(endpoint, allowInsecureHttp);
  const discoveryUrl = validateActiveFSSourceDiscoveryUrl(endpoint, { allowInsecureHttp });

  let demoRuntime = demo
    ? await startDemoSourceRuntime(rootDir, name, args, options)
    : undefined;
  let check: RemoteEndpointCheck | undefined;
  try {
    check = shouldCheck
      ? demo
        ? await waitForDemoSourceApiCheck(endpoint, name, options)
        : await checkRemoteEndpoint(endpoint, name, options, allowInsecureHttp)
      : undefined;
  } catch (error) {
    if (demoRuntime) {
      await stopDemoSourceRuntime(rootDir, name, options);
    }
    throw error;
  }
  if (demoRuntime && check?.reachable) {
    demoRuntime = await writeDemoSourceRuntimeStatus(rootDir, name, {
      ...demoRuntime,
      reachable: true,
      checkedAt: check.checkedAt,
      message: "Demo Source API daemon is reachable."
    });
  }
  const sourceSpec = {
    name,
    mountPath: normalizeActiveFSPath(requestedMountPath ?? `/${name}`),
    url: discoveryUrl
  } satisfies ActiveFSTreeRemote;

  const unified = await loadActiveFSConfig(rootDir);
  const existing = unified.remotes[name];
  await upsertActiveFSRemote(rootDir, {
    ...(existing ?? {}),
    name: sourceSpec.name,
    url: sourceSpec.url,
    mountPath: sourceSpec.mountPath,
    remoteRoot: existing?.remoteRoot ?? "/",
    adapterCapabilityProfile: existing?.adapterCapabilityProfile ?? "full-filesystem-semantics",
    cacheMode: existing?.cacheMode ?? "off",
    watchable: watchableOverride ?? check?.capabilities?.watchable ?? existing?.watchable,
    sourceHints: check ? sourceDiscoveryHints(check) : existing?.sourceHints,
    insecureHttp,
    mountpoint,
    activityPolicy,
    managedWebDAV: mountpoint || args.includes("--manage-webdav")
      ? { enabled: true, host: "127.0.0.1" }
      : existing?.managedWebDAV
  });
  const source = sourceSpec;
  let layout: ReturnType<typeof createMountLayout> | undefined;
  let mountStatus: RcloneMountStatus | undefined;
  let freshness: Awaited<ReturnType<typeof ensureMountFreshnessForMount>> | undefined;
  if (mountpoint) {
    const mountConfig = await loadActiveFSMountConfig(rootDir);
    const mountRemote = mountConfig.remotes[name];
    if (!mountRemote) {
      throw new Error(`Configured remote ${name}, but no internal mount target was available.`);
    }
    const mounted = await mountConfiguredRemote(rootDir, mountRemote, args, options, "mount");
    layout = mounted.layout;
    mountStatus = mounted.result.status;
    freshness = mounted.freshness;
  }
  if (args.includes("--json")) {
    printJson({
      rootDir: resolve(rootDir),
      remote: {
        ...source,
        insecureHttp,
        mountpoint,
        watchable: watchableOverride ?? check?.capabilities?.watchable ?? existing?.watchable
      },
      demo: demoRuntime,
      layout,
      mount: mountStatus,
      freshness,
      check
    });
    return;
  }
  console.log(`Configured remote ${source.name} ${source.mountPath} -> ${source.url}`);
  if (demoRuntime) {
    console.log(`demo: Source API listening at ${demoRuntime.url}${demoRuntime.pid ? ` (pid ${demoRuntime.pid})` : ""}`);
  }
  if (mountStatus) {
    console.log(`Mounted ${name} at ${layout!.vfsDir}`);
  } else if (mountpoint) {
    console.log(`mountpoint: ${mountpoint}`);
  }
  if (freshness) {
    console.log(`freshness: ${freshness.mode}${freshness.active ? " active" : ""}`);
  }
  if (insecureHttp) {
    console.log(`security: insecure http (${insecureHttp.reason}, dev only)`);
  }
  const watchable = watchableOverride ?? check?.capabilities?.watchable;
  if (watchable !== undefined) {
    console.log(`watchable: ${watchable}`);
  }
  printRemoteCheckSummary(check);
  if (demoRuntime) {
    console.log(`next: activefs list /${name}`);
  }
}

async function listRemotes(args: string[]): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const remotes = Object.values(config.remotes)
    .sort((left, right) => left.name.localeCompare(right.name));
  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes });
    return;
  }
  if (remotes.length === 0) {
    console.log("No ActiveFS remotes configured.");
    console.log("For a local demo, run activefs remote add repo --demo --port 3999.");
    return;
  }
  for (const remote of remotes) {
    const pieces = [
      remote.mountPath ? `namespace ${remote.mountPath}` : undefined,
      remote.mountpoint ? `mountpoint ${remote.mountpoint}` : undefined,
      remote.auth && remote.auth.type !== "none" ? `auth ${remote.auth.type}` : undefined
    ].filter(Boolean);
    console.log(`${remote.name}: ${remote.url}${pieces.length > 0 ? ` (${pieces.join(", ")})` : ""}`);
  }
}

async function removeRemote(args: string[], options: CliMainOptions = {}): Promise<void> {
  validateRemoteRemoveArgs(args);
  const remoteName = requirePath(firstPositional(args, workspaceOptions()), "remote remove");
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSConfig(rootDir);
  const remote = config.remotes[remoteName];
  if (!remote) {
    throw new Error(unknownActiveFSRemoteMessage(remoteName));
  }

  if (!args.includes("--force")) {
    const mountConfig = await loadActiveFSMountConfig(rootDir);
    const mountRemote = mountConfig.remotes[remoteName];
    if (mountRemote) {
      const status = await readRcloneMountStatus(mountLayoutForRemote(rootDir, mountRemote), {
        remote: mountRemote,
        commandRunner: options.commandRunner,
        platform: options.platform,
        fetch: options.fetch,
        checkWebDAV: false
      });
      if (status.mounted) {
        throw new Error(`Remote ${remoteName} is mounted. Run activefs unmount ${remoteName} first, or pass --force.`);
      }
    }
  }

  const layout = createActiveFSRemoteStateLayout(rootDir, remoteName);
  const demoRuntime = await stopDemoSourceRuntime(rootDir, remoteName, options, true);
  await clearPrivateAuthSecret(layout);
  const result = await removeActiveFSRemoteConfig(rootDir, remoteName);
  await rm(layout.remoteDir, { recursive: true, force: true });
  if (args.includes("--json")) {
    printJson({
      rootDir: resolve(rootDir),
      remote: remoteName,
      removed: result.removed,
      demo: demoRuntime
    });
    return;
  }
  if (demoRuntime) {
    console.log(`demo: ${demoRuntime.message ?? "stopped"}`);
  }
  console.log(`${remoteName}: removed`);
}

async function printRemoteStatus(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const remoteName = firstPositional(args, workspaceOptions());
  const [mountConfig, unifiedConfig] = await Promise.all([
    loadActiveFSMountConfig(rootDir),
    loadActiveFSConfig(rootDir)
  ]);
  const results: unknown[] = [];

  const sourceRemotes = remoteName
    ? sourceRemoteFromUnifiedConfig(unifiedConfig, remoteName) ? [sourceRemoteFromUnifiedConfig(unifiedConfig, remoteName)!] : []
    : sourceRemotesFromUnifiedConfig(unifiedConfig);
  for (const source of sourceRemotes) {
    const unifiedRemote = unifiedConfig.remotes[source.name];
    const mountRemote = mountConfig.remotes[source.name];
    const mount = mountRemote
      ? await readRcloneMountStatus(mountLayoutForRemote(rootDir, mountRemote), {
        remote: mountRemote,
        commandRunner: options.commandRunner,
        platform: options.platform,
        fetch: options.fetch
      })
      : undefined;
    results.push({
      name: source.name,
      endpoint: source.url,
      insecureHttp: unifiedRemote?.insecureHttp,
      mountPath: source.mountPath,
      mount,
      check: await checkSourceEndpoint(
        source.url,
        source.name,
        options,
        sourceAuthProvider(rootDir, source.name, unifiedRemote?.auth),
        source.allowInsecureHttp
      )
    });
  }

  if (remoteName && results.length === 0) {
    throw new Error(unknownActiveFSRemoteMessage(remoteName));
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: results });
    return;
  }

  if (results.length === 0) {
    console.log("No ActiveFS remotes configured.");
    console.log("For a local demo, run activefs remote add repo --demo --port 3999.");
    return;
  }

  for (const result of results) {
    const entry = result as {
      name: string;
      endpoint: string;
      insecureHttp?: ActiveFSRemoteConfig["insecureHttp"];
      mountPath?: string;
      check?: { reachable: boolean; diagnostics?: string };
      mount?: RcloneMountStatus;
    };
    console.log(
      `${entry.name}: ${entry.check?.reachable ? "reachable" : "unreachable"} ${entry.endpoint}`
    );
    if (entry.mountPath) {
      console.log(`  mount path: ${entry.mountPath}`);
    }
    if (entry.insecureHttp) {
      console.log(`  security: insecure http (${entry.insecureHttp.reason}, dev only)`);
    }
    if (entry.mount) {
      console.log(`  mount: ${entry.mount.state}${entry.mount.mounted ? " (mounted)" : ""}`);
      if (entry.mount.freshness) {
        console.log(
          `  freshness: ${entry.mount.freshness.mode}${entry.mount.freshness.active ? " active" : ""}`
        );
      }
    }
    if (entry.check?.diagnostics) {
      console.log(`  diagnostics: ${entry.check.diagnostics}`);
    }
  }
}

async function handleServerCommand(
  args: string[],
  options: CliMainOptions,
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  switch (args[0]) {
    case "start":
      await startServer(args.slice(1), wait);
      return;
    case "status":
      await printWebDAVStatus(args.slice(1), options);
      return;
    case "stop":
      await stopWebDAV(args.slice(1), options);
      return;
    default:
      throw new Error("Usage: activefs server start|status|stop [name] [--state-root .activefs]");
  }
}

async function startServer(
  args: string[],
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  const protocol = parseServerProtocolOption(optionValue(args, "--protocol") ?? "webdav");
  if (protocol !== "webdav") {
    throw new Error(`Unsupported server protocol: ${protocol}`);
  }
  const rootDir = workspaceDir(args);
  const remoteName = firstPositional(args, workspaceOptions(
    "--protocol",
    "--port",
    "--host",
    "--hostname",
    "--auth",
    "--source"
  ));
  const serveArgs: string[] = [];
  copyOption(args, serveArgs, "--port");
  copyOption(args, serveArgs, "--host");
  copyOption(args, serveArgs, "--hostname");
  copyOption(args, serveArgs, "--auth");
  if (remoteName) {
    serveArgs.push("--state-root", rootDir, "--remote", remoteName);
  }
  await serveWebDAV(serveArgs, createCommandRuntime(args).filesystem, wait);
}

async function serveWebDAV(
  args: string[],
  fs: ActiveFS,
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  const port = Number.parseInt(optionValue(args, "--port") ?? "3847", 10);
  if (!Number.isFinite(port) || port < 0) {
    throw new Error("WebDAV port must be a non-negative integer.");
  }
  const hostname = optionValue(args, "--host") ?? optionValue(args, "--hostname") ?? "127.0.0.1";
  const auth = optionValue(args, "--auth");
  const rootDir = optionValue(args, "--state-root") ?? optionValue(args, "--workspace") ?? optionValue(args, "--root");
  const remoteName = optionValue(args, "--remote");
  if ((rootDir && !remoteName) || (!rootDir && remoteName)) {
    throw new Error("Use --state-root and --remote together when recording WebDAV runtime status.");
  }
  const remote = rootDir && remoteName
    ? (await loadActiveFSMountConfig(rootDir)).remotes[remoteName]
    : undefined;
  const layout = rootDir && remoteName
    ? createMountLayout(rootDir, remoteName, { mountpoint: remote?.mountpoint })
    : undefined;
  const server = await startWebDAVServer({
    filesystem: fs,
    hostname,
    port,
    auth: auth ? parseAuth(auth) : false,
    policy: remote?.policy,
    adapterCapabilityProfile: remote?.adapterCapabilityProfile,
    logger: layout
      ? (entry) => appendJsonLine(join(layout.runtimeDir, "webdav.log"), entry)
      : undefined
  });
  if (layout) {
    await writeWebDAVRuntimeStatus(layout, {
      remote: remoteName!,
      state: "up",
      url: server.url,
      pid: process.pid,
      reachable: true,
      auth: server.auth
        ? { username: server.auth.username, hasPassword: true }
        : { hasPassword: false }
    });
  }
  console.log(`ActiveFS mount server serving at ${server.url}`);
  await wait(async () => {
    await server.close();
    if (layout) {
      await writeWebDAVRuntimeStatus(layout, {
        remote: remoteName!,
        state: "down",
        url: server.url,
        pid: process.pid,
        reachable: false,
        auth: server.auth
          ? { username: server.auth.username, hasPassword: true }
          : { hasPassword: false },
        error: "WebDAV server stopped."
      });
    }
  });
}

async function printWebDAVStatus(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  const statuses: WebDAVRuntimeStatus[] = [];

  for (const remote of remotes) {
    const layout = mountLayoutForRemote(rootDir, remote);
    const status = await checkWebDAVRuntimeStatus(layout, remote, {
      fetch: options.fetch
    });
    if (status) {
      statuses.push(status);
    }
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: statuses });
    return;
  }

  if (statuses.length === 0) {
    console.log("No ActiveFS mount servers configured.");
    return;
  }
  for (const status of statuses) {
    console.log(`${status.remote}: ${status.state}${status.url ? ` ${status.url}` : ""}`);
    if (status.error) {
      console.log(`  error: ${status.error}`);
    }
  }
}

async function stopWebDAV(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  const statuses: WebDAVRuntimeStatus[] = [];

  for (const remote of remotes) {
    statuses.push(await stopManagedWebDAVRuntime(mountLayoutForRemote(rootDir, remote), {
      processExists: options.processExists,
      terminateProcess: options.terminateProcess
    }));
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: statuses });
    return;
  }

  if (statuses.length === 0) {
    console.log("No ActiveFS mount servers configured.");
    return;
  }
  for (const status of statuses) {
    console.log(`${status.remote}: ${status.state}`);
    if (status.error) {
      console.log(`  message: ${status.error}`);
    }
  }
}

async function printMountStatus(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  if (remotes.length === 0) {
    if (args.includes("--json")) {
      printJson({ rootDir: resolve(rootDir), remotes: [] });
      return;
    }
    console.log("No ActiveFS mounts configured.");
    return;
  }

  const statuses: RcloneMountStatus[] = [];
  const cleanupActions = new Map<string, Awaited<ReturnType<typeof cleanupMountRuntime>>["actions"]>();
  for (const remote of remotes) {
    const layout = mountLayoutForRemote(rootDir, remote);
    const { status, actions } = await readMountStatusWithAutoCleanup(layout, remote, options);
    statuses.push(status);
    cleanupActions.set(remote.name, actions);
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: statuses });
    return;
  }

  for (const status of statuses) {
    console.log(`${status.remote}: ${mountStatusDisplayState(status)}${status.mounted ? " (mounted)" : ""}`);
    console.log(`  mount: ${status.mounted ? "mounted" : "not mounted"}`);
    console.log(`  vfs: ${status.vfsDir}`);
    console.log(`  log: ${status.logFile}`);
    for (const action of cleanupActions.get(status.remote) ?? []) {
      if (action.kind !== "noop") {
        console.log(`  cleanup: ${action.message}`);
      }
    }
    if (status.webdav) {
      console.log(`  server: ${status.webdav.state}${status.webdav.url ? ` ${status.webdav.url}` : ""}`);
      if (status.webdav.error) {
        console.log(`  server error: ${status.webdav.error}`);
      }
    }
    const hint = mountStatusHint(status);
    if (hint) {
      console.log(`  hint: ${hint}`);
    }
    if (status.rc) {
      console.log(`  rc: ${status.rc.addr}`);
    }
    if (status.freshness) {
      console.log(
        `  freshness: ${status.freshness.mode}${status.freshness.active ? " active" : ""}`
      );
      if (status.freshness.error) {
        console.log(`  freshness error: ${status.freshness.error}`);
      } else if (status.freshness.message) {
        console.log(`  freshness message: ${status.freshness.message}`);
      }
    }
    if (status.staleReason) {
      console.log(`  stale: ${status.staleReason}`);
    }
    if (status.lastRefresh) {
      console.log(
        `  last refresh: ${status.lastRefresh.ok ? "ok" : "failed"} ${status.lastRefresh.path}`
      );
    }
    if (status.error) {
      console.log(`  error: ${status.error}`);
    } else if (status.message) {
      console.log(`  message: ${status.message}`);
    }
  }
}

async function readMountStatusWithAutoCleanup(
  layout: ReturnType<typeof createMountLayout>,
  remote: ActiveFSMountRemote,
  options: CliMainOptions
): Promise<{
  status: RcloneMountStatus;
  actions: Awaited<ReturnType<typeof cleanupMountRuntime>>["actions"];
}> {
  const status = await readRcloneMountStatus(layout, {
    remote,
    commandRunner: options.commandRunner,
    platform: options.platform,
    fetch: options.fetch
  });
  if (!shouldAutoCleanupMountStatus(status)) {
    return { status, actions: [] };
  }
  const cleanup = await cleanupMountRuntime(layout, {
    remote,
    commandRunner: options.commandRunner,
    platform: options.platform,
    fetch: options.fetch,
    processExists: options.processExists,
    terminateProcess: options.terminateProcess
  });
  return { status: cleanup.status, actions: cleanup.actions };
}

function shouldAutoCleanupMountStatus(status: RcloneMountStatus): boolean {
  return !status.mounted && (
    ["mounting", "mounted", "rclone-down", "webdav-down", "stale"].includes(status.state) ||
    status.freshness?.active === true ||
    Boolean(status.rc)
  );
}

function mountStatusDisplayState(status: RcloneMountStatus): string {
  if (status.state === "webdav-down") {
    return "server-down";
  }
  if (status.state === "rclone-down") {
    return "not-mounted";
  }
  return status.state;
}

function mountStatusHint(status: RcloneMountStatus): string | undefined {
  if (status.webdav?.state === "down" && status.webdav.url?.endsWith(":0/")) {
    return `runtime endpoint was stale and is safe to remount with activefs mount ${status.remote} ${status.vfsDir}.`;
  }
  if (status.state === "rclone-down") {
    return `the OS mountpoint is not active; run activefs mount ${status.remote} ${status.vfsDir} to remount.`;
  }
  return undefined;
}

async function refreshMount(args: string[], options: CliMainOptions = {}): Promise<void> {
  const target = requirePath(args[0], "refresh");
  const parsed = parseRemotePath(target);
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remote = config.remotes[parsed.remote];
  if (!remote) {
    throw new Error(unknownActiveFSMountRemoteMessage(parsed.remote));
  }
  const result = await refreshRcloneMount(mountLayoutForRemote(rootDir, remote), {
    remote,
    path: parsed.path,
    recursive: args.includes("--recursive"),
    rcloneBinary: optionValue(args, "--rclone") ?? undefined,
    commandRunner: options.commandRunner,
    platform: options.platform,
    fetch: options.fetch
  });
  if (args.includes("--json")) {
    printJson({
      remote: remote.name,
      path: parsed.path,
      recursive: args.includes("--recursive"),
      ...result
    });
  }
  if (!result.ok) {
    throw new Error(result.error ?? "rclone refresh failed.");
  }
  if (args.includes("--json")) {
    return;
  }
  console.log(`${remote.name}: refreshed ${parsed.path}${args.includes("--recursive") ? " recursively" : ""}`);
}

async function handleSyncCommand(
  args: string[],
  options: CliMainOptions,
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  if (args.includes("--poll-interval")) {
    throw new Error("--poll-interval is not supported for mounted coherence. Source API backed mounts require session SSE.");
  }
  const sync = parseSyncCommand(args);
  if (sync.action === "status") {
    await printMountStatus(syncMountStatusArgs(sync, args), options);
    return;
  }
  if (sync.action === "refresh") {
    await refreshMount(syncRefreshArgs(sync, args), options);
    return;
  }
  await watchCacheInvalidation(syncWatchArgs(sync, args), options, wait);
}

async function startMount(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  rejectRemovedFreshnessPollingOption(args);
  const positionals = remainingPositionals(args, workspaceOptions("--rclone", "--rclone-vfs-cache-mode", "--mount-ready-timeout-ms"));
  if (positionals.length > 2) {
    throw new Error(
      "Usage: activefs mount [remote] [mountpoint] [--read-only] [--cache] [--state-root .activefs]"
    );
  }
  const remoteName = positionals[0];
  const requestedMountpoint = positionals[1];
  const config = await loadActiveFSMountConfig(rootDir);
  let [remote] = selectedRemotes(config.remotes, remoteName, true);
  if (!remote) {
    throw new Error("No ActiveFS remotes configured. For a local demo, run activefs remote add repo --demo --port 3999. For a Source API discovery URL, run activefs remote add <name> <discovery-url>.");
  }

  if (requestedMountpoint) {
    remote = await configureRemoteMountpoint(rootDir, remote.name, requestedMountpoint);
  }

  const { layout, result, freshness } = await mountConfiguredRemote(rootDir, remote, args, options, "mount");
  console.log(`${remote.name}: ${result.status.state} at ${layout.vfsDir}`);
  console.log(`log: ${layout.rcloneLogPath}`);
  if (freshness) {
    console.log(`freshness: ${freshness.mode}${freshness.active ? " active" : ""}`);
  }
}

async function configureRemoteMountpoint(
  rootDir: string,
  remoteName: string,
  mountpoint: string
): Promise<ActiveFSMountRemote> {
  const config = await loadActiveFSConfig(rootDir);
  const remote = config.remotes[remoteName];
  if (!remote) {
    throw new Error(unknownActiveFSMountRemoteMessage(remoteName));
  }
  await upsertActiveFSRemote(rootDir, {
    ...remote,
    mountpoint,
    managedWebDAV: {
      ...remote.managedWebDAV,
      enabled: true,
      host: remote.managedWebDAV?.host ?? "127.0.0.1"
    }
  });
  const mountConfig = await loadActiveFSMountConfig(rootDir);
  const mountRemote = mountConfig.remotes[remoteName];
  if (!mountRemote) {
    throw new Error(`Configured remote ${remoteName}, but no internal mount target was available.`);
  }
  return mountRemote;
}

async function mountConfiguredRemote(
  rootDir: string,
  remote: ActiveFSMountRemote,
  args: string[],
  options: CliMainOptions,
  operation: "mount" | "remount"
): Promise<{
  layout: ReturnType<typeof createMountLayout>;
  result: Awaited<ReturnType<typeof mountRcloneWebDAV>>;
  freshness: Awaited<ReturnType<typeof ensureMountFreshnessForMount>> | undefined;
}> {
  const layout = mountLayoutForRemote(rootDir, remote);
  await cleanupMountRuntime(layout, {
    remote,
    checkWebDAV: false,
    commandRunner: options.commandRunner,
    platform: options.platform,
    fetch: options.fetch,
    processExists: options.processExists,
    terminateProcess: options.terminateProcess
  });
  const mountRemote = await ensureManagedWebDAVForMount(rootDir, remote, args, options);
  const mountOptions = {
    remote: mountRemote,
    layout,
    rcloneBinary: optionValue(args, "--rclone") ?? undefined,
    commandRunner: options.commandRunner,
    processSpawner: options.mountProcessSpawner,
    waitForMountActive: options.waitForMountActive,
    platform: options.platform,
    foreground: args.includes("--foreground"),
    daemon: !args.includes("--foreground"),
    debug: args.includes("--debug"),
    enableRc: options.enableRcloneRc,
    vfsCacheMode: rcloneVfsCacheModeFromArgs(args),
    mountReadyTimeoutMs: positiveIntegerOption(args, "--mount-ready-timeout-ms"),
    readOnly: args.includes("--read-only")
  };
  const result = operation === "remount"
    ? await remountRcloneWebDAV(mountOptions)
    : await mountRcloneWebDAV(mountOptions);
  if (result.status.state === "failed") {
    throw new Error(result.status.error ?? `rclone ${operation} failed.`);
  }
  const freshness = await ensureMountFreshnessForMount(rootDir, remote, args, options);
  return { layout, result, freshness };
}

function rcloneVfsCacheModeFromArgs(args: string[]): RcloneVfsCacheMode {
  const explicit = parseRcloneVfsCacheModeOption(optionValue(args, "--rclone-vfs-cache-mode"));
  if (explicit) {
    return explicit;
  }
  return args.includes("--cache") ? "full" : "off";
}

function parseRcloneVfsCacheModeOption(value: string | undefined): RcloneVfsCacheMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "off" || value === "minimal" || value === "writes" || value === "full") {
    return value;
  }
  throw new Error("--rclone-vfs-cache-mode must be one of: off, minimal, writes, full.");
}

async function remount(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  rejectRemovedFreshnessPollingOption(args);
  const remoteName = firstPositional(args, workspaceOptions("--rclone", "--rclone-vfs-cache-mode", "--mount-ready-timeout-ms"));
  const [remote] = selectedRemotes(config.remotes, remoteName, true);
  if (!remote) {
    throw new Error("No ActiveFS remotes configured. For a local demo, run activefs remote add repo --demo --port 3999, then activefs mount repo <mountpoint>.");
  }

  const { layout, result, freshness } = await mountConfiguredRemote(rootDir, remote, args, options, "remount");
  console.log(`${remote.name}: ${result.status.state} at ${layout.vfsDir}`);
  console.log(`log: ${layout.rcloneLogPath}`);
  if (freshness) {
    console.log(`freshness: ${freshness.mode}${freshness.active ? " active" : ""}`);
  }
}

async function cleanupMount(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  const results = [];

  for (const remote of remotes) {
    results.push(await cleanupMountRuntime(mountLayoutForRemote(rootDir, remote), {
      remote,
      commandRunner: options.commandRunner,
      platform: options.platform,
      fetch: options.fetch,
      processExists: options.processExists,
      terminateProcess: options.terminateProcess
    }));
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: results });
    return;
  }

  if (results.length === 0) {
    console.log("No ActiveFS mounts configured.");
    return;
  }
  for (const result of results) {
    console.log(`${result.remote}: ${result.status.state}`);
    for (const action of result.actions) {
      console.log(`  ${action.kind}: ${action.message}`);
    }
  }
}

async function unmount(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  if (remotes.length === 0) {
    console.log("No ActiveFS mounts configured.");
    return;
  }

  for (const remote of remotes) {
    const layout = mountLayoutForRemote(rootDir, remote);
    const status = await unmountRcloneMount(layout, {
      commandRunner: options.commandRunner,
      platform: options.platform
    });
    console.log(`${remote.name}: ${status.state}`);
    if (status.error) {
      console.log(`  error: ${status.error}`);
    }
    if (!status.mounted && !args.includes("--keep-freshness")) {
      const freshness = await stopMountFreshnessRuntime(layout, {
        processExists: options.processExists,
        terminateProcess: options.terminateProcess
      });
      console.log(`  freshness: ${freshness.mode}`);
    }
    if (!status.mounted && args.includes("--stop-webdav")) {
      const webdav = await stopManagedWebDAVRuntime(layout, {
        processExists: options.processExists,
        terminateProcess: options.terminateProcess
      });
      console.log(`  server: ${webdav.state}`);
    }
    const cleanup = await cleanupMountRuntime(layout, {
      remote,
      commandRunner: options.commandRunner,
      platform: options.platform,
      fetch: options.fetch,
      processExists: options.processExists,
      terminateProcess: options.terminateProcess
    });
    for (const action of cleanup.actions) {
      if (action.kind !== "noop") {
        console.log(`  cleanup: ${action.message}`);
      }
    }
    if (!cleanup.status.mounted && !args.includes("--keep-mountpoint")) {
      console.log(`  mountpoint: ${await removeEmptyVisibleMountpoint(remote)}`);
    } else if (cleanup.status.mounted && !args.includes("--keep-mountpoint")) {
      console.log("  mountpoint: kept (mount is still active)");
    }
  }
}

async function removeEmptyVisibleMountpoint(remote: ActiveFSMountRemote): Promise<string> {
  if (!remote.mountpoint) {
    return "kept (no external mountpoint configured)";
  }
  try {
    await rmdir(remote.mountpoint);
    return `removed ${remote.mountpoint}`;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return `already absent ${remote.mountpoint}`;
    }
    if (isNodeError(error, "ENOTEMPTY") || isNodeError(error, "EEXIST")) {
      return `kept ${remote.mountpoint} (not empty)`;
    }
    throw error;
  }
}

async function printCacheStatus(args: string[]): Promise<void> {
  const rootDir = workspaceDir(args);
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions());
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  const snapshots = [];

  for (const remote of remotes) {
    snapshots.push(await readMountCacheSnapshot(mountLayoutForRemote(rootDir, remote)));
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: snapshots });
    return;
  }

  if (snapshots.length === 0) {
    console.log("No ActiveFS caches configured.");
    return;
  }
  for (const snapshot of snapshots) {
    console.log(`${snapshot.remote}: ${snapshot.fileCount} files, ${snapshot.byteSize} bytes`);
    console.log(`  meta: ${snapshot.sections.meta.fileCount} files, ${snapshot.sections.meta.byteSize} bytes`);
    console.log(`  search: ${snapshot.sections.search.fileCount} files, ${snapshot.sections.search.byteSize} bytes`);
    console.log(`  content: ${snapshot.sections.content.fileCount} files, ${snapshot.sections.content.byteSize} bytes`);
    console.log(`  manifests: ${snapshot.sections.manifests.fileCount} files, ${snapshot.sections.manifests.byteSize} bytes`);
    console.log(`  rclone: ${snapshot.sections.rclone.fileCount} files, ${snapshot.sections.rclone.byteSize} bytes`);
  }
}

async function clearCache(args: string[], options: CliMainOptions = {}): Promise<void> {
  const rootDir = workspaceDir(args);
  const path = optionValue(args, "--path");
  const remoteName = firstPositional(args, workspaceOptions("--path", "--rclone"));
  const results = await invalidateMountCaches({
    rootDir,
    remoteName,
    path,
    recursive: args.includes("--recursive"),
    args,
    options
  });

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: results });
    return;
  }

  if (results.length === 0) {
    console.log("No ActiveFS caches configured.");
    return;
  }
  for (const result of results) {
    console.log(
      `${result.remote}: cleared ${result.clearedFiles} files, ${result.clearedBytes} bytes${result.path ? ` for ${result.path}` : ""}`
    );
    if (result.refresh) {
      console.log(`  refresh: ${result.refresh.ok ? "ok" : "failed"} ${result.refresh.status.lastRefresh?.path ?? path}`);
    }
  }
}

async function watchCacheInvalidation(
  args: string[],
  options: CliMainOptions,
  wait: (close: () => void | Promise<void>) => Promise<void>
): Promise<void> {
  const rootDir = workspaceDir(args);
  if (args.includes("--poll-interval")) {
    throw new Error("--poll-interval is not supported for mounted coherence. Source API backed mounts require session SSE.");
  }
  const unifiedConfig = await loadActiveFSConfig(rootDir);
  const sourceNames = optionValues(args, "--source-remote");
  const sourceRemotes = selectedSourceRemotes(sourceRemotesByNameFromUnifiedConfig(unifiedConfig), sourceNames);
  if (sourceRemotes.length === 0) {
    throw new Error("No ActiveFS remotes configured. For a local demo, run activefs remote add repo --demo --port 3999.");
  }
  const mountRemoteName = firstPositional(args, workspaceOptions(
    "--source-remote",
    "--rclone"
  ));
  const freshnessLayout = mountRemoteName ? createMountLayout(rootDir, mountRemoteName) : undefined;
  let watchers: SourceInvalidationWatcher[];
  try {
    watchers = await Promise.all(
      sourceRemotes.map((sourceRemote) =>
        startSourceInvalidationWatcher({
          sourceRemote,
          rootDir,
          mountRemoteName,
          args,
          options
        })
      )
    );
  } catch (error) {
    if (freshnessLayout) {
      await writeMountFreshnessStatus(freshnessLayout, {
        remote: mountRemoteName!,
        mode: "unavailable",
        active: false,
        sources: sourceRemotes.map((sourceRemote) => sourceRemote.name),
        error: errorMessage(error)
      });
    }
    throw error;
  }

  for (const watcher of watchers) {
    console.log(`${watcher.source}: invalidation ${watcher.mode}`);
  }
  if (freshnessLayout) {
    await writeMountFreshnessStatus(freshnessLayout, {
      remote: mountRemoteName!,
      mode: freshnessModeForWatchers(watchers.map((watcher) => watcher.mode)),
      active: true,
      pid: process.pid,
      sources: watchers.map((watcher) => watcher.source),
      message: "Source API invalidation watcher is running."
    });
  }
  let closed = false;
  const closeWatchers = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await Promise.all(watchers.map((watcher) => watcher.close()));
    if (freshnessLayout) {
      await writeMountFreshnessStatus(freshnessLayout, {
        remote: mountRemoteName!,
        mode: "stopped",
        active: false,
        pid: process.pid,
        sources: watchers.map((watcher) => watcher.source),
        message: "Source API invalidation watcher stopped."
      });
    }
  };
  try {
    await wait(closeWatchers);
  } finally {
    await closeWatchers();
  }
}

function freshnessModeForWatchers(modes: Array<SourceInvalidationWatcher["mode"]>): MountFreshnessMode {
  if (modes.every((mode) => mode === "session")) {
    return "session";
  }
  return "unavailable";
}

async function startSourceInvalidationWatcher(request: {
  sourceRemote: ActiveFSTreeRemote;
  rootDir: string;
  mountRemoteName?: string;
  args: string[];
  options: CliMainOptions;
}): Promise<SourceInvalidationWatcher> {
  const unifiedConfig = await loadActiveFSConfig(request.rootDir);
  const unifiedRemote = unifiedConfig.remotes[request.sourceRemote.name];
  const layout = createActiveFSRemoteStateLayout(request.rootDir, request.sourceRemote.name);
  const activityPolicy = unifiedRemote?.activityPolicy ?? "best-effort";
  const auth = sourceAuthProvider(request.rootDir, request.sourceRemote.name, unifiedRemote?.auth);
  const source = createHttpSourceClient({
    url: request.sourceRemote.url,
    name: request.sourceRemote.name,
    allowInsecureHttp: request.sourceRemote.allowInsecureHttp,
    auth,
    fetch: request.options.fetch
  });
  const invalidate = async (sourcePath: string): Promise<void> => {
    const path = joinSourceMountPath(request.sourceRemote.mountPath, sourcePath);
    await invalidateMountCaches({
      rootDir: request.rootDir,
      remoteName: request.mountRemoteName,
      path,
      recursive: true,
      args: request.args,
      options: request.options
    });
  };

  try {
    const session = await source.createSession();
    let cacheTrustDisabled = false;
    await writeActiveFSSessionState(layout, {
      state: "coherent",
      sessionId: session.sessionId,
      mode: "session",
      cacheMode: unifiedRemote?.cacheMode ?? "off",
      activityPolicy
    });
    const controller = new AbortController();
    let closed = false;
    let sessionFailed = false;
    let sessionFailureReason: string | undefined;
    let disconnected = false;
    let verification: ActiveFSSessionEventVerificationState = {
      sessionId: session.sessionId,
      lastSequence: 0
    };
    const pump = pumpSessionInvalidations({
      source,
      sessionId: session.sessionId,
      sourceRemote: request.sourceRemote.name,
      signal: controller.signal,
      getVerification: () => verification,
      onDisconnect: async (reason) => {
        disconnected = true;
        await writeActiveFSSessionState(layout, {
          state: "untrusted",
          sessionId: session.sessionId,
          mode: "session",
          lastEventSequence: verification.lastSequence,
          cacheMode: "off",
          activityPolicy,
          lastFailureReason: reason
        });
      },
      onEvent: async (event, verified) => {
        verification = verified;
        disconnected = false;
        if (
          event.type === "path.invalidated" ||
          event.type === "tree.changed" ||
          event.type === "config.changed" ||
          event.type === "policy.changed" ||
          event.type === "resync.required" ||
          event.type === "session.revoked"
        ) {
          const path = sessionEventPath(event);
          await invalidate(path);
          const activityAllowed = await reportSessionActivityWithPolicy({
            source,
            layout,
            rootDir: request.rootDir,
            remote: unifiedRemote,
            sessionId: session.sessionId,
            activityPolicy,
            operation: "cache.invalidate",
            path,
            event
          });
          if (!activityAllowed) {
            cacheTrustDisabled = true;
            return;
          }
        }
        await source.ackSession(session.sessionId, event.sequence);
        await writeActiveFSSessionState(layout, {
          state: event.type === "resync.required" ? "resync-required" : event.type === "session.revoked" ? "revoked" : "coherent",
          sessionId: session.sessionId,
          mode: "session",
          lastEventId: event.id,
          lastEventSequence: event.sequence,
          lastAckSequence: event.sequence,
          cacheMode: event.type === "resync.required" || event.type === "session.revoked"
            ? "off"
            : unifiedRemote?.cacheMode ?? "off",
          activityPolicy,
          lastResyncAt: event.type === "resync.required" ? new Date().toISOString() : undefined
        });
      }
    }).catch(async (error) => {
      if (!closed) {
        sessionFailed = true;
        sessionFailureReason = error instanceof Error ? error.message : String(error);
        if (unifiedRemote) {
          await upsertActiveFSRemote(request.rootDir, {
            ...unifiedRemote,
            cacheMode: "off"
          }).catch(() => undefined);
        }
        await writeActiveFSSessionState(layout, {
          state: "failed",
          sessionId: session.sessionId,
          mode: "session",
          cacheMode: "off",
          activityPolicy,
          lastFailureReason: sessionFailureReason
        }).catch(() => undefined);
        console.error(sessionFailureReason);
      }
    });
    return {
      source: request.sourceRemote.name,
      mode: "session",
      close: async () => {
        closed = true;
        controller.abort();
        await pump;
        await writeActiveFSSessionState(layout, {
          state: sessionFailed ? "failed" : cacheTrustDisabled || disconnected ? "untrusted" : "stopped",
          sessionId: session.sessionId,
          mode: "session",
          cacheMode: sessionFailed || cacheTrustDisabled || disconnected ? "off" : unifiedRemote?.cacheMode ?? "off",
          activityPolicy,
          lastFailureReason: sessionFailed
            ? sessionFailureReason
            : cacheTrustDisabled ? "Required activity reporting failed; cache remains disabled."
              : disconnected ? "Session SSE disconnected before a verified replay restored trust." : undefined
        });
      }
    };
  } catch (error) {
    const message = errorMessage(error);
    if (unifiedRemote) {
      await upsertActiveFSRemote(request.rootDir, {
        ...unifiedRemote,
        cacheMode: "off"
      });
    }
    await writeActiveFSSessionState(layout, {
      state: "failed",
      mode: "session",
      cacheMode: "off",
      activityPolicy,
      lastFailureReason: message
    });
    throw new ActiveFSError(
      "SOURCE_ERROR",
      `Source API session SSE for ${request.sourceRemote.name} is unavailable: ${message}`
    );
  }
}

async function pumpSessionInvalidations(request: {
  source: ReturnType<typeof createHttpSourceClient>;
  sessionId: string;
  sourceRemote: string;
  signal: AbortSignal;
  getVerification(): ActiveFSSessionEventVerificationState;
  onDisconnect(reason: string): Promise<void>;
  onEvent(event: ActiveFSSessionEvent, verification: ActiveFSSessionEventVerificationState): Promise<void>;
}): Promise<void> {
  while (!request.signal.aborted) {
    await request.source.streamSessionEvents(request.sessionId, request.onEvent, {
      signal: request.signal,
      verificationState: request.getVerification()
    });
    if (!request.signal.aborted) {
      const lastSequence = request.getVerification().lastSequence ?? 0;
      await request.onDisconnect(`Session SSE for ${request.sourceRemote} disconnected; reconnecting with Last-Event-ID ${lastSequence}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
}

function sessionEventPath(event: ActiveFSSessionEvent): string {
  const path = event.payload.path;
  return typeof path === "string" && path.startsWith("/") ? path : "/";
}

async function reportSessionActivityWithPolicy(request: {
  source: ReturnType<typeof createHttpSourceClient>;
  layout: ReturnType<typeof createActiveFSRemoteStateLayout>;
  rootDir: string;
  remote?: ActiveFSRemoteConfig;
  sessionId: string;
  activityPolicy: ActiveFSActivityPolicy;
  operation: string;
  path: string;
  event: ActiveFSSessionEvent;
}): Promise<boolean> {
  if (request.activityPolicy === "off") {
    return true;
  }
  const path = normalizeActiveFSPath(request.path);
  const payload = {
    events: [
      {
        session: request.sessionId,
        operation: request.operation,
        path,
        timestamp: new Date().toISOString(),
        source: "local",
        result: "succeeded",
        revision: typeof request.event.payload.revision === "string" ? request.event.payload.revision : undefined
      }
    ]
  };
  try {
    await request.source.reportSessionActivity(request.sessionId, payload);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordActiveFSActivityBacklog(request.layout, {
      policy: request.activityPolicy,
      sessionId: request.sessionId,
      operation: request.operation,
      path,
      timestamp: new Date().toISOString(),
      source: "local",
      result: "unknown",
      lastError: message,
      payload
    });
    if (request.activityPolicy === "required") {
      if (request.remote) {
        await upsertActiveFSRemote(request.rootDir, {
          ...request.remote,
          cacheMode: "off"
        });
      }
      await writeActiveFSSessionState(request.layout, {
        state: "untrusted",
        sessionId: request.sessionId,
        mode: "session",
        cacheMode: "off",
        activityPolicy: request.activityPolicy,
        lastFailureReason: message
      });
      return false;
    }
    return true;
  }
}

async function printLogs(args: string[]): Promise<void> {
  const rootDir = workspaceDir(args);
  const maxLinesValue = optionValue(args, "--lines");
  const maxLines = maxLinesValue ? Number.parseInt(maxLinesValue, 10) : undefined;
  if (maxLinesValue && (!Number.isFinite(maxLines) || maxLines! <= 0)) {
    throw new Error("--lines must be a positive integer.");
  }
  const config = await loadActiveFSMountConfig(rootDir);
  const remoteName = firstPositional(args, workspaceOptions("--lines"));
  const remotes = selectedRemotes(config.remotes, remoteName, false);
  const snapshots = [];

  for (const remote of remotes) {
    snapshots.push(await tailMountLogs(mountLayoutForRemote(rootDir, remote), { maxLines }));
  }

  if (args.includes("--json")) {
    printJson({ rootDir: resolve(rootDir), remotes: snapshots });
    return;
  }

  if (snapshots.length === 0) {
    console.log("No ActiveFS logs configured.");
    return;
  }
  for (const snapshot of snapshots) {
    console.log(`${snapshot.remote}:`);
    console.log("  server:");
    printIndented(snapshot.webdav, 4);
    console.log("  mount:");
    printIndented(snapshot.rclone, 4);
  }
}

async function ensureManagedWebDAVForMount(
  rootDir: string,
  remote: ActiveFSMountRemote,
  args: string[],
  options: CliMainOptions
): Promise<ActiveFSMountRemote> {
  if (!remote.managedWebDAV?.enabled && !args.includes("--manage-webdav")) {
    return remote;
  }

  const layout = mountLayoutForRemote(rootDir, remote);
  const hydrated = await hydrateActiveFSMountRemoteCredentials(layout, remote);
  const target = managedWebDAVTarget(hydrated);
  const managedRemote = {
    ...hydrated,
    url: target.url,
    managedWebDAV: {
      enabled: true,
      host: target.host,
      port: target.port
    }
  };
  const existing = await checkWebDAVRuntimeStatus(layout, target.port === 0 ? undefined : managedRemote, {
    fetch: options.fetch,
    timeoutMs: 500
  });
  if (existing?.state === "up" && existing.url) {
    return {
      ...managedRemote,
      url: existing.url
    };
  }

  const auth = hydrated.username && hydrated.password
    ? { username: hydrated.username, password: hydrated.password, realm: "ActiveFS" }
    : undefined;
  const launchRequest = {
    rootDir,
    remote: managedRemote,
    host: target.host,
    port: target.port,
    auth
  };
  const launched = options.webDAVDaemonLauncher
    ? await options.webDAVDaemonLauncher(launchRequest)
    : await defaultWebDAVDaemonLauncher(launchRequest, options.daemonProcessSpawner);
  await writeWebDAVRuntimeStatus(layout, {
    remote: remote.name,
    state: "up",
    url: launched.url,
    pid: launched.pid,
    reachable: false,
    auth: auth
      ? { username: auth.username, hasPassword: true }
      : { hasPassword: false },
    error: "Managed WebDAV daemon launched; reachability pending."
  });

  return waitForManagedWebDAV(layout, managedRemote, options);
}

async function waitForManagedWebDAV(
  layout: ReturnType<typeof createMountLayout>,
  remote: ActiveFSMountRemote,
  options: CliMainOptions
): Promise<ActiveFSMountRemote> {
  const startedAt = Date.now();
  let lastStatus: WebDAVRuntimeStatus | undefined;
  const dynamicPort = remote.managedWebDAV?.port === 0;
  while (Date.now() - startedAt < 5000) {
    lastStatus = await checkWebDAVRuntimeStatus(layout, dynamicPort ? undefined : remote, {
      fetch: options.fetch,
      timeoutMs: 500
    });
    if (lastStatus?.state === "up" && lastStatus.url) {
      return {
        ...remote,
        url: lastStatus.url
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(
    lastStatus?.error ??
    `Managed WebDAV adapter did not become reachable at ${remote.url}. Run activefs server status ${remote.name} --json, then activefs server stop ${remote.name} and retry the mount.`
  );
}

async function ensureMountFreshnessForMount(
  rootDir: string,
  remote: ActiveFSMountRemote,
  args: string[],
  options: CliMainOptions
): Promise<Awaited<ReturnType<typeof writeMountFreshnessStatus>> | undefined> {
  const remoteName = remote.name;
  const layout = mountLayoutForRemote(rootDir, remote);
  if (args.includes("--no-freshness")) {
    return writeMountFreshnessStatus(layout, {
      remote: remoteName,
      mode: "stopped",
      active: false,
      message: "Automatic freshness was disabled for this mount command."
    });
  }

  const sourceNames = Object.keys(sourceRemotesByNameFromUnifiedConfig(await loadActiveFSConfig(rootDir))).sort();
  if (sourceNames.length === 0) {
    return writeMountFreshnessStatus(layout, {
      remote: remoteName,
      mode: "ttl-only",
      active: false,
      message: "No ActiveFS remotes are configured; rclone cache TTL is the fallback freshness boundary."
    });
  }

  const previous = await readMountFreshnessStatus(layout);
  const processExists = options.processExists ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  if (previous?.active && previous.pid && processExists(previous.pid)) {
    return previous;
  }

  await writeMountFreshnessStatus(layout, {
    remote: remoteName,
    mode: "starting",
    active: true,
    sources: sourceNames,
    message: "Starting Source API invalidation watcher."
  });

  try {
    const launchRequest = {
      rootDir,
      remoteName,
      sourceNames,
      rcloneBinary: optionValue(args, "--rclone")
    };
    const launched = options.freshnessDaemonLauncher
      ? await options.freshnessDaemonLauncher(launchRequest)
      : await defaultFreshnessDaemonLauncher(launchRequest, options.daemonProcessSpawner);
    return writeMountFreshnessStatus(layout, {
      remote: remoteName,
      mode: "starting",
      active: true,
      pid: launched.pid,
      sources: sourceNames,
      message: "Source API invalidation watcher launched."
    });
  } catch (error) {
    return writeMountFreshnessStatus(layout, {
      remote: remoteName,
      mode: "unavailable",
      active: false,
      sources: sourceNames,
      error: errorMessage(error)
    });
  }
}

function defaultFreshnessDaemonLauncher(
  request: FreshnessDaemonLaunchRequest,
  processSpawner: CliDaemonProcessSpawner = spawn
): Promise<{ pid?: number }> {
  const cliPath = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const args = [
    cliPath,
    "cache",
    "watch",
    request.remoteName,
    "--root",
    request.rootDir
  ];
  for (const sourceName of request.sourceNames) {
    args.push("--source-remote", sourceName);
  }
  if (request.rcloneBinary) {
    args.push("--rclone", request.rcloneBinary);
  }
  const child = processSpawner(process.execPath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return Promise.resolve({ pid: child.pid });
}

function defaultWebDAVDaemonLauncher(
  request: WebDAVDaemonLaunchRequest,
  processSpawner: CliDaemonProcessSpawner = spawn
): Promise<{ pid?: number; url: string }> {
  const cliPath = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const args = [
    cliPath,
    "server",
    "start",
    "--host",
    request.host,
    "--port",
    String(request.port),
    "--root",
    request.rootDir,
    "--remote",
    request.remote.name
  ];
  if (request.auth) {
    args.push("--auth", `${request.auth.username}:${request.auth.password}`);
  }
  const child = processSpawner(process.execPath, args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return Promise.resolve({
    pid: child.pid,
    url: request.remote.url
  });
}

function managedWebDAVTarget(remote: ActiveFSMountRemote): { host: string; port: number; url: string } {
  const host = remote.managedWebDAV?.host ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`Managed WebDAV can only start loopback adapters: ${host}`);
  }
  const normalizedHost = host === "localhost" ? "127.0.0.1" : host;
  const port = remote.managedWebDAV?.port ?? 0;
  if (!Number.isFinite(port) || port < 0) {
    throw new Error(`Managed WebDAV adapter has an invalid port: ${String(remote.managedWebDAV?.port)}`);
  }
  const hostForUrl = normalizedHost.includes(":") ? `[${normalizedHost}]` : normalizedHost;
  return {
    host: normalizedHost,
    port,
    url: `http://${hostForUrl}:${port}/`
  };
}

type RemoteEndpointCheck = Awaited<ReturnType<typeof checkSourceEndpoint>>;

async function checkRemoteEndpoint(
  endpoint: string,
  name: string,
  options: CliMainOptions,
  allowInsecureHttp = false
): Promise<RemoteEndpointCheck> {
  const source = await checkSourceEndpoint(endpoint, name, options, undefined, allowInsecureHttp);
  if (source.reachable) {
    return source;
  }
  throw new Error(
    `Source API discovery URL is not reachable: ${source.diagnostics ?? endpoint}. Check that the server is running and the URL returns an ActiveFS discovery document, or pass --no-check only for an offline endpoint you will start later.`
  );
}

async function checkSourceEndpoint(
  endpoint: string,
  name: string,
  options: CliMainOptions,
  auth?: HttpSourceClientAuth | false,
  allowInsecureHttp = false
): Promise<{
  kind: "source-api";
  endpoint: string;
  reachable: boolean;
  checkedAt: string;
  handshake?: ActiveFSTreeHandshake;
  capabilities?: ActiveFSTreeServiceCapabilities;
  config?: ActiveFSSourceConfigDocument;
  diagnostics?: string;
}> {
  const checkedAt = new Date().toISOString();
  const client = createHttpSourceClient({ url: endpoint, name, fetch: options.fetch, auth, allowInsecureHttp });
  try {
    const handshake = await client.fetchHandshake();
    const capabilities = await fetchOptionalSetupDocument(
      () => client.fetchCapabilities(),
      handshake.capabilities
    );
    const config = await fetchOptionalSetupDocument(
      () => client.fetchConfig(),
      undefined
    );
    return {
      kind: "source-api",
      endpoint: client.discoveryUrl,
      reachable: true,
      checkedAt,
      handshake,
      capabilities,
      config
    };
  } catch (handshakeError) {
    return {
      kind: "source-api",
      endpoint: client.discoveryUrl,
      reachable: false,
      checkedAt,
      diagnostics: errorMessage(handshakeError)
    };
  }
}

async function fetchOptionalSetupDocument<Value>(
  load: () => Promise<Value>,
  fallback: Value
): Promise<Value> {
  try {
    return await load();
  } catch (error) {
    if (error instanceof ActiveFSError && (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")) {
      return fallback;
    }
    throw error;
  }
}

function sourceDiscoveryHints(check: RemoteEndpointCheck): ActiveFSSourceDiscoveryHints {
  const handshake = check.handshake;
  const config = check.config;
  const capabilities = check.capabilities;
  const workspace = config?.workspace ?? handshake?.workspace;
  const cache = config?.cache ?? handshake?.cache;
  const auth = config?.auth ?? handshake?.auth;
  const revisions = config?.revisions ?? handshake?.revisions;
  return {
    checkedAt: check.checkedAt,
    displayName: workspace?.displayName,
    suggestedMountPath: workspace?.suggestedMountPath,
    capabilities: capabilities ? {
      statable: capabilities.statable,
      listable: capabilities.listable,
      readable: capabilities.readable,
      writable: capabilities.writable,
      searchable: capabilities.searchable,
      watchable: capabilities.watchable,
      rangeReadable: capabilities.rangeReadable,
      commands: [...capabilities.commands]
    } : undefined,
    cache: cache ? {
      contentTtlMs: cache.contentTtlMs,
      directoryTtlMs: cache.directoryTtlMs
    } : undefined,
    auth: auth ? {
      required: auth.required,
      schemes: auth.schemes ? [...auth.schemes] : undefined,
      message: auth.message
    } : undefined,
    revisions: revisions ? { ...revisions } : undefined
  };
}

function validateDeprecatedRemoteProtocolOption(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  throw new Error("activefs remote add uses a Source API discovery URL; omit --protocol.");
}

function sourceApiHttpSecurity(
  endpoint: string,
  allowInsecureHttp: boolean
): ActiveFSRemoteConfig["insecureHttp"] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(
      `Invalid Source API discovery URL: ${endpoint}. Use an absolute http:// or https:// URL such as http://127.0.0.1:3900/_activefs/.`
    );
  }
  if (parsed.protocol === "https:") {
    return undefined;
  }
  if (parsed.protocol !== "http:") {
    return undefined;
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (loopback) {
    return {
      allowed: true,
      devOnly: true,
      loopback: true,
      reason: "loopback-development"
    };
  }
  if (!allowInsecureHttp) {
    throw new Error("Non-loopback http:// ActiveFS remotes require --allow-insecure-http. Use https:// for shared remotes.");
  }
  return {
    allowed: true,
    devOnly: true,
    loopback: false,
    reason: "allow-insecure-http"
  };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function parseActivityPolicyOption(value: string): ActiveFSActivityPolicy {
  if (value === "required" || value === "best-effort" || value === "off") {
    return value;
  }
  throw new Error("--activity-policy must be required, best-effort, or off.");
}

function parseRemoteWatchableOption(args: string[]): boolean | undefined {
  const watchable = args.includes("--watchable");
  const notWatchable = args.includes("--no-watchable");
  if (watchable && notWatchable) {
    throw new Error("Use only one of --watchable or --no-watchable.");
  }
  if (watchable) {
    return true;
  }
  if (notWatchable) {
    return false;
  }
  return undefined;
}

function parseServerProtocolOption(value: string): "webdav" {
  if (value === "webdav") {
    return value;
  }
  throw new Error("--protocol must be webdav.");
}

function printRemoteCheckSummary(check: RemoteEndpointCheck | undefined): void {
  if (!check) {
    console.log("check: skipped");
    return;
  }
  console.log(`check: Source API ${check.reachable ? "reachable" : "unreachable"}`);
  if (check.diagnostics) {
    console.log(`diagnostics: ${check.diagnostics}`);
  }
}

function resolveStatusSelection(config: ActiveFSConfig, selection: string | undefined): string | undefined {
  if (!selection || config.remotes[selection]) {
    return selection;
  }
  const resolved = resolve(selection);
  for (const association of Object.values(config.mountpoints ?? {})) {
    if (resolve(association.mountpoint) === resolved) {
      return association.remote;
    }
  }
  for (const remote of Object.values(config.remotes)) {
    if (remote.mountpoint && resolve(remote.mountpoint) === resolved) {
      return remote.name;
    }
  }
  return selection;
}

function selectedStatusRemotes(
  remotes: Record<string, ActiveFSRemoteConfig>,
  remoteName: string | undefined
): ActiveFSRemoteConfig[] {
  if (remoteName) {
    const remote = remotes[remoteName];
    if (!remote) {
      throw new Error(
        `Unknown ActiveFS remote or mountpoint: ${remoteName}. Run activefs remote list --state-root .activefs to see configured remotes and mountpoints. For a local demo, run activefs remote add repo --demo --port 3999.`
      );
    }
    return [remote];
  }
  return Object.values(remotes);
}

function insecureHttpRemoteSummaries(config: ActiveFSConfig): Array<{
  name: string;
  url: string;
  loopback: boolean;
  reason: string;
}> {
  return Object.values(config.remotes)
    .filter((remote) => remote.insecureHttp)
    .map((remote) => ({
      name: remote.name,
      url: remote.url,
      loopback: Boolean(remote.insecureHttp?.loopback),
      reason: remote.insecureHttp?.reason ?? "unknown"
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function selectedRemotes(
  remotes: Record<string, ActiveFSMountRemote>,
  remoteName: string | undefined,
  requireSingle: boolean
): ActiveFSMountRemote[] {
  if (remoteName) {
    const remote = remotes[remoteName];
    if (!remote) {
      throw new Error(unknownActiveFSMountRemoteMessage(remoteName));
    }
    return [remote];
  }

  const values = Object.values(remotes);
  if (requireSingle && values.length > 1) {
    throw new Error(`Select a remote: ${values.map((remote) => remote.name).join(", ")}`);
  }
  return values;
}

function selectedSourceRemotes(
  sources: Record<string, ActiveFSTreeRemote>,
  sourceNames: string[]
): ActiveFSTreeRemote[] {
  if (sourceNames.length === 0) {
    return Object.values(sources);
  }
  return sourceNames.map((name) => {
    const source = sources[name];
    if (!source) {
      throw new Error(unknownActiveFSRemoteMessage(name));
    }
    return source;
  });
}

function unknownActiveFSRemoteMessage(name: string): string {
  return `Unknown ActiveFS remote: ${name}. Run activefs remote list --state-root .activefs to see configured remotes. For a local demo, run activefs remote add repo --demo --port 3999. For a Source API discovery URL, run activefs remote add <name> <discovery-url>.`;
}

function unknownActiveFSMountRemoteMessage(name: string): string {
  return `Unknown ActiveFS mount remote: ${name}. Run activefs remote list --state-root .activefs to confirm the remote name. For a local demo, run activefs remote add repo --demo --port 3999, then activefs mount repo <mountpoint>.`;
}

function sourceRemotesByNameFromUnifiedConfig(config: ActiveFSConfig): Record<string, ActiveFSTreeRemote> {
  return Object.fromEntries(
    sourceRemotesFromUnifiedConfig(config).map((remote) => [remote.name, remote])
  );
}

function sourceRemotesFromUnifiedConfig(config: ActiveFSConfig): ActiveFSTreeRemote[] {
  return Object.values(config.remotes)
    .map((remote) => sourceRemoteFromUnifiedConfig(config, remote.name))
    .filter((remote): remote is ActiveFSTreeRemote => Boolean(remote))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sourceRemoteFromUnifiedConfig(
  config: ActiveFSConfig,
  remoteName: string
): ActiveFSTreeRemote | undefined {
  const remote = config.remotes[remoteName];
  if (!remote) {
    return undefined;
  }
  return {
    name: remote.name,
    mountPath: normalizeActiveFSPath(remote.mountPath ?? `/${remote.name}`),
    url: remote.url,
    allowInsecureHttp: Boolean(remote.insecureHttp?.allowed)
  };
}

function rejectRemovedFreshnessPollingOption(args: string[]): void {
  if (args.includes("--freshness-poll-interval")) {
    throw new Error("--freshness-poll-interval is not supported for mounted coherence. Source API backed mounts require session SSE.");
  }
}

function parseAuth(value: string): { username: string; password: string; realm: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error("--auth must be in username:password form.");
  }
  return {
    username: value.slice(0, separator),
    password: value.slice(separator + 1),
    realm: "ActiveFS"
  };
}

function parseRemotePath(value: string): { remote: string; path: string } {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error("Remote path must use remote:/path form.");
  }
  const remote = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (!path.startsWith("/")) {
    throw new Error("Remote path must use remote:/path form.");
  }
  return { remote, path };
}

function parseSyncCommand(args: string[]): ParsedSyncCommand {
  const positionals = remainingPositionals(args, syncOptionsWithValues());
  if (positionals.length === 0) {
    throw new Error(syncUsage());
  }

  const first = positionals[0];
  if (isSyncAction(first)) {
    assertSyncPositionals(positionals.length, first);
    return {
      action: first,
      remoteName: positionals[1],
      path: positionals[2]
    };
  }

  const action = positionals[1];
  if (!action) {
    return { action: "status", remoteName: first };
  }
  if (!isSyncAction(action)) {
    throw new Error(syncUsage());
  }
  assertSyncPositionals(positionals.length, action);
  return {
    action,
    remoteName: first,
    path: positionals[2]
  };
}

function assertSyncPositionals(count: number, action: SyncAction): void {
  const max = action === "refresh" ? 3 : 2;
  if (count > max) {
    throw new Error(syncUsage());
  }
}

function syncMountStatusArgs(sync: ParsedSyncCommand, originalArgs: string[]): string[] {
  const args: string[] = [];
  if (sync.remoteName) {
    args.push(sync.remoteName);
  }
  copyWorkspaceArgs(originalArgs, args);
  if (originalArgs.includes("--json")) {
    args.push("--json");
  }
  return args;
}

function syncRefreshArgs(sync: ParsedSyncCommand, originalArgs: string[]): string[] {
  const remoteName = requireSyncRemote(sync, "refresh");
  const args = [syncRefreshTarget(remoteName, optionValue(originalArgs, "--path") ?? sync.path)];
  copyWorkspaceArgs(originalArgs, args);
  copyOption(originalArgs, args, "--rclone");
  if (originalArgs.includes("--recursive")) {
    args.push("--recursive");
  }
  if (originalArgs.includes("--json")) {
    args.push("--json");
  }
  return args;
}

function syncWatchArgs(sync: ParsedSyncCommand, originalArgs: string[]): string[] {
  const args = [requireSyncRemote(sync, "watch")];
  copyWorkspaceArgs(originalArgs, args);
  copyOption(originalArgs, args, "--rclone");
  for (const sourceRemote of optionValues(originalArgs, "--source-remote")) {
    args.push("--source-remote", sourceRemote);
  }
  return args;
}

function syncRefreshTarget(remoteName: string, path: string | undefined): string {
  if (remoteName.includes(":")) {
    return remoteName;
  }
  return `${remoteName}:${normalizeActiveFSPath(path ? ensureAbsolutePath(path) : "/")}`;
}

function requireSyncRemote(sync: ParsedSyncCommand, action: SyncAction): string {
  if (!sync.remoteName) {
    throw new Error(`Usage: activefs sync <remote> ${action}${action === "refresh" ? " [path]" : ""}`);
  }
  return sync.remoteName;
}

function ensureAbsolutePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function isSyncAction(value: string | undefined): value is SyncAction {
  return value === "status" || value === "refresh" || value === "watch";
}

function syncOptionsWithValues(): Set<string> {
  return workspaceOptions("--path", "--rclone", "--source-remote");
}

function syncUsage(): string {
  return "Usage: activefs sync <remote> status|refresh|watch [path] [--state-root .activefs] [--json]";
}

function joinSourceMountPath(mountPath: string, sourcePath: string): `/${string}` {
  const normalizedMount = normalizeActiveFSPath(mountPath);
  const normalizedSource = normalizeActiveFSPath(sourcePath);
  if (normalizedMount === "/") {
    return normalizedSource;
  }
  if (normalizedSource === "/") {
    return normalizedMount;
  }
  return normalizeActiveFSPath(`${normalizedMount}/${normalizedSource.slice(1)}`);
}

function validateDoctorArgs(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" || arg === "--workspace" || arg === "--state-root") {
      if (!args[index + 1]) {
        throw new Error("Usage: activefs doctor [--mounts] [--state-root .activefs] [--json]");
      }
      index += 1;
      continue;
    }
    if (arg !== "--mounts" && arg !== "--json") {
      throw new Error("Usage: activefs doctor [--mounts] [--state-root .activefs] [--json]");
    }
  }
}

function validateRemoteRemoveArgs(args: string[]): void {
  const usage = "Usage: activefs remote remove <remote> [--force] [--state-root .activefs] [--json]";
  let remoteCount = 0;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root" || arg === "--workspace" || arg === "--state-root") {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) {
        throw new Error(usage);
      }
      index += 1;
      continue;
    }
    if (arg === "--force" || arg === "--json") {
      continue;
    }
    if (!arg || arg.startsWith("--")) {
      throw new Error(usage);
    }
    remoteCount += 1;
  }

  if (remoteCount !== 1) {
    throw new Error(usage);
  }
}

function parseGrepArgs(args: string[], command: "grep" | "rg"): {
  path: string;
  query: ActiveFSSearchQuery;
  json: boolean;
} {
  const positionals = remainingPositionals(args, workspaceOptions("--limit", "--source"));
  let pattern = positionals[0];
  let path = positionals[1] ?? "/";
  if (positionals.length >= 2 && positionals[0]?.startsWith("/")) {
    path = positionals[0];
    pattern = positionals[1];
  }
  if (!pattern) {
    throw new Error(
      `Usage: activefs ${command} <pattern> [path] [--json] [--case-sensitive] [--limit n] [--include-non-enumerable]`
    );
  }
  const limitValue = optionValue(args, "--limit");
  const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
  if (limitValue && (!Number.isFinite(limit) || limit! <= 0)) {
    throw new Error("--limit must be a positive integer.");
  }
  return {
    path,
    json: args.includes("--json"),
    query: {
      pattern,
      caseSensitive: args.includes("--case-sensitive"),
      maxResults: limit,
      includeNonEnumerable: args.includes("--include-non-enumerable")
    }
  };
}

function parseSedArgs(args: string[]): {
  path: string;
  input: ActiveFSCommandInput<"sed">;
} {
  const positionals = remainingPositionals(args, workspaceOptions("--source"));
  const [path, pattern, replacement] = positionals;
  if (!path || pattern === undefined || replacement === undefined) {
    throw new Error("Usage: activefs sed <path> <pattern> <replacement> [--global] [--ignore-case]");
  }
  return {
    path,
    input: {
      pattern,
      replacement,
      global: args.includes("--global"),
      caseSensitive: !args.includes("--ignore-case")
    }
  };
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveIntegerOption(args: string[], option: string): number | undefined {
  const value = optionValue(args, option);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function copyOption(source: string[], target: string[], option: string): void {
  const value = optionValue(source, option);
  if (value !== undefined) {
    target.push(option, value);
  }
}

function copyWorkspaceArgs(source: string[], target: string[]): void {
  copyOption(source, target, "--state-root");
  copyOption(source, target, "--workspace");
  copyOption(source, target, "--root");
}

function optionValues(args: string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function listStateFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function listUnresolvedOperationIds(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const unresolved: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const record = await readJsonIfExists(join(path, entry.name));
      const status = isRecord(record) ? scalarField(record, "status") : undefined;
      if (status === "pending" || status === "unknown" || status === "transient") {
        const operationId = isRecord(record) ? scalarField(record, "operationId") : undefined;
        unresolved.push(typeof operationId === "string" ? operationId : entry.name);
      }
    }
    return unresolved.sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function reconcileOperationJournal(
  rootDir: string,
  remote: ActiveFSRemoteConfig,
  layout: ReturnType<typeof createActiveFSRemoteStateLayout>,
  options: CliMainOptions
): Promise<void> {
  const records = await listOperationRecords(layout.journalDir);
  const unresolved = records.filter((record) =>
    record.status === "pending" || record.status === "unknown" || record.status === "transient"
  );
  if (unresolved.length === 0) {
    return;
  }
  const source = createHttpSourceClient({
    url: remote.url,
    name: remote.name,
    allowInsecureHttp: Boolean(remote.insecureHttp?.allowed),
    auth: sourceAuthProvider(rootDir, remote.name, remote.auth),
    fetch: options.fetch
  });
  for (const record of unresolved) {
    try {
      if (!record.operationStatusEndpoint) {
        continue;
      }
      const status = await source.fetchOperationStatus({
        operationId: record.operationId,
        operationStatusEndpoint: record.operationStatusEndpoint
      });
      await updateActiveFSOperationJournal(layout, record.operationId, operationJournalPatchFromTreeStatus(status));
    } catch {
      // Status lookups are recovery diagnostics. If the remote tree is unavailable,
      // keep the existing unresolved record visible.
    }
  }
}

async function listOperationRecords(path: string): Promise<Array<{
  operationId: string;
  status: string;
  operationStatusEndpoint?: string;
}>> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const records: Array<{ operationId: string; status: string; operationStatusEndpoint?: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const record = await readJsonIfExists(join(path, entry.name));
      if (!isRecord(record)) {
        continue;
      }
      const operationId = scalarField(record, "operationId");
      const status = scalarField(record, "status");
      const operationStatusEndpoint = scalarField(record, "operationStatusEndpoint");
      if (typeof operationId === "string" && typeof status === "string") {
        records.push({
          operationId,
          status,
          operationStatusEndpoint: typeof operationStatusEndpoint === "string"
            ? operationStatusEndpoint
            : undefined
        });
      }
    }
    return records;
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function operationJournalPatchFromTreeStatus(status: ActiveFSTreeOperationStatus): {
  status: "pending" | "committed" | "rejected" | "conflict" | "transient" | "unsupported" | "unknown";
  completedAt?: string;
  result?: unknown;
  lastFailureReason?: string;
} {
  if (status.status === "running") {
    return { status: "pending" };
  }
  if (status.status === "succeeded") {
    return {
      status: "committed",
      completedAt: status.completedAt ?? new Date().toISOString(),
      result: scrubOperationStatusResult(status.result)
    };
  }
  return {
    status: operationJournalFailureStatusFromTree(status),
    completedAt: status.completedAt ?? new Date().toISOString(),
    lastFailureReason: status.error?.message
  };
}

function operationJournalFailureStatusFromTree(
  status: ActiveFSTreeOperationStatus
): "rejected" | "conflict" | "transient" | "unsupported" | "unknown" {
  const code = status.error?.code;
  if (code === "CONFLICT" || code === "PRECONDITION_FAILED") {
    return "conflict";
  }
  if (code === "UNSUPPORTED_OPERATION") {
    return "unsupported";
  }
  if (code === "TRANSIENT_TRANSPORT" || code === "SOURCE_UNAVAILABLE" || code === "TIMEOUT" || code === "INTERNAL_ERROR") {
    return "transient";
  }
  if (code === "PERMISSION_DENIED" || code === "INVALID_PATH") {
    return "rejected";
  }
  return "unknown";
}

function scrubOperationStatusResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { content, contentBase64, ...rest } = result as Record<string, unknown>;
  return rest;
}

function summarizeSessionRecord(record: unknown): Record<string, unknown> {
  if (!isRecord(record)) {
    return { state: "none" };
  }
  return {
    state: scalarField(record, "state") ?? "recorded",
    sessionId: scalarField(record, "sessionId"),
    mode: scalarField(record, "mode"),
    lastEventId: scalarField(record, "lastEventId"),
    lastEventSequence: scalarField(record, "lastEventSequence"),
    lastAppliedAck: scalarField(record, "lastAppliedAck"),
    lastAckSequence: scalarField(record, "lastAckSequence"),
    lastFailureReason: scalarField(record, "lastFailureReason"),
    lastResyncAt: scalarField(record, "lastResyncAt"),
    updatedAt: scalarField(record, "updatedAt")
  };
}

function scalarField(record: Record<string, unknown>, field: string): string | number | boolean | undefined {
  const value = record[field];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printStatusText(summary: ActiveFSStatusSummary): void {
  if (summary.remotes.length === 0) {
    console.log("No ActiveFS remotes configured.");
    console.log("For a local demo, run activefs remote add repo --demo --port 3999.");
    return;
  }
  for (const remote of summary.remotes) {
    console.log(`${remote.name}: activefs${remote.mount?.mounted ? " (mounted)" : ""}`);
    console.log(`  discovery URL: ${remote.endpoint}`);
    if (remote.insecureHttp) {
      console.log(`  security: insecure http (${remote.insecureHttp.reason}, dev only)`);
    }
    if (remote.mountPath) {
      console.log(`  namespace: ${remote.mountPath}`);
    }
    if (remote.mountpoint) {
      console.log(`  mountpoint: ${remote.mountpoint}`);
    }
    if (remote.remoteRoot) {
      console.log(`  remote root: ${remote.remoteRoot}`);
    }
    console.log(`  auth: ${remote.auth.type}`);
    console.log(`  adapter: ${remote.adapterCapabilityProfile ?? "unknown"}`);
    console.log(
      `  policy: ${remote.policy.defaultAccess}, ${remote.policy.ruleCount} rule${remote.policy.ruleCount === 1 ? "" : "s"}${remote.policy.revision ? `, revision ${remote.policy.revision}` : ""}${remote.policy.digest ? `, digest ${remote.policy.digest}` : ""}`
    );
    console.log(
      `  cache: ${remote.cache.mode}${remote.cache.fileCount !== undefined ? `, ${remote.cache.fileCount} files, ${remote.cache.byteSize ?? 0} bytes` : ""}`
    );
    if (remote.mount) {
      console.log(`  mount: ${remote.mount.state}${remote.mount.staleReason ? `, stale ${remote.mount.staleReason}` : ""}`);
      if (remote.mount.freshness) {
        console.log(
          `  freshness: ${remote.mount.freshness.mode}${remote.mount.freshness.active ? " active" : ""}${remote.mount.freshness.error ? `, error ${remote.mount.freshness.error}` : ""}`
        );
      }
      if (remote.mount.lastRefresh) {
        console.log(`  last refresh: ${remote.mount.lastRefresh.ok ? "ok" : "failed"} ${remote.mount.lastRefresh.path}`);
      }
    }
    console.log(`  session: ${formatSessionStatus(remote.session)}`);
    console.log(`  operations: ${remote.operations.unresolvedCount} unresolved`);
    console.log(
      `  activity: ${remote.activity.policy}, ${remote.activity.backlogCount} backlog file${remote.activity.backlogCount === 1 ? "" : "s"}`
    );
  }
}

function formatSessionStatus(session: Record<string, unknown>): string {
  const parts = [
    `state=${String(session.state ?? "unknown")}`,
    session.sessionId ? `id=${String(session.sessionId)}` : undefined,
    session.lastEventId ? `lastEvent=${String(session.lastEventId)}` : undefined,
    session.lastEventSequence ? `lastEventSequence=${String(session.lastEventSequence)}` : undefined,
    session.lastAppliedAck ? `lastAppliedAck=${String(session.lastAppliedAck)}` : undefined,
    session.lastAckSequence ? `lastAckSequence=${String(session.lastAckSequence)}` : undefined,
    session.lastFailureReason ? `lastFailure=${String(session.lastFailureReason)}` : undefined,
    session.lastResyncAt ? `lastResync=${String(session.lastResyncAt)}` : undefined
  ].filter(Boolean);
  return parts.join(", ");
}

function printIndented(text: string, spaces: number): void {
  const prefix = " ".repeat(spaces);
  const lines = text.trimEnd().split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) {
    console.log(`${prefix}(empty)`);
    return;
  }
  for (const line of lines) {
    console.log(`${prefix}${line}`);
  }
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function firstPositional(args: string[], optionsWithValues: Set<string>): string | undefined {
  return remainingPositionals(args, optionsWithValues)[0];
}

function remainingPositionals(args: string[], optionsWithValues: Set<string>): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (optionsWithValues.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function requirePath(path: string | undefined, command: string): string {
  if (!path) {
    throw new Error(`Usage: activefs ${command} <path>`);
  }
  return path;
}

function requireOptionValue(args: string[], option: string, usage: string): string {
  const index = args.indexOf(option);
  if (index < 0 || !args[index + 1]) {
    throw new Error(usage);
  }
  return args[index + 1];
}

async function waitForInterrupt(close: () => void | Promise<void>): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await close();
}

function printHelp(): void {
  console.log(`activefs <command>

Commands:
  activefs list [path] [--state-root .activefs] [--source ...]
                                  List entries from configured ActiveFS remotes
  activefs ls [path] [--state-root .activefs] [--source ...]
                                  Command-aware listing; --source example selects the explicit demo
  activefs stat <path> [--state-root .activefs] [--source ...]
                                  Print entry metadata as JSON
  activefs read <path> [--state-root .activefs] [--source ...]
                                  Print file contents
  activefs cat <path> [--state-root .activefs] [--source ...]
                                  Command-aware file read
  activefs head|tail <path> [--lines n] [--state-root .activefs] [--source ...]
                                  Print the first or last lines
  activefs sed <path> <pattern> <replacement> [--global] [--ignore-case]
                                  Return a literal text replacement without writing the file
  activefs grep <pattern> [path] [--state-root .activefs] [--source ...] [--json] [--case-sensitive] [--limit n]
  activefs rg <pattern> [path] [--state-root .activefs] [--source ...] [--json] [--case-sensitive] [--limit n]
                                  Command-aware content search
  activefs find [path] [--include-non-enumerable] [--state-root .activefs] [--source ...]
                                  Walk entries through the optional source handler
  activefs tui [--state-root .activefs] [--source local=/path|local:/mount=/path|http:/remote=url] [--debug]
                                  Open the interactive ActiveFS developer/operator terminal UI
  activefs doctor [--mounts] [--state-root .activefs] [--json]
                                  Report mounted-folder prerequisites and evidence
  activefs status [remote|mountpoint] [--state-root .activefs] [--json]
                                  Summarize remote, mount, auth, cache, session, and backlog state
  activefs remote add <name> <discovery-url> [--allow-insecure-http] [--activity-policy required|best-effort|off] [--watchable|--no-watchable] [--mount <path>] [--no-check]
                                  Configure a Source API discovery URL; --mount also starts a visible mountpoint
  activefs remote add <name> --demo --port 3999 [--mount <path>]
                                  Start the shipped demo Source API server and configure it as a remote
  activefs remote list [--state-root .activefs] [--json]
                                  List configured remotes
  activefs remote status [remote] [--state-root .activefs] [--json]
                                  Check configured Source API and mount state
  activefs remote remove <remote> [--force]
                                  Remove its config and local state, stopping its demo server when recorded
  activefs auth set <remote> --env NAME|--token-command '["cmd"]'|--headers-command '["cmd"]'|--cookie-provider '["cmd"]'|--bearer-stdin
                                  Configure local credential acquisition for a remote
  activefs auth status <remote>   Show configured auth provider state without secrets
  activefs auth clear <remote>    Clear configured auth provider and private stored token
  activefs sync <remote> status   Show mount, freshness, and refresh state
  activefs sync <remote> refresh [path] [--recursive]
                                  Refresh a mounted path through the active adapter
  activefs sync <remote> watch [--source-remote name]
                                  Watch Source API invalidations for a mounted remote
  activefs server start [remote] [--host 127.0.0.1] [--port 3847] [--auth username:password]
                                  Start the foreground WebDAV adapter; --auth enables optional HTTP Basic authentication
                                  Default: unauthenticated loopback; this does not configure Source API or MCP authentication
                                  Command-line passwords may appear in shell history or process listings
  activefs server status [remote] Show recorded server runtime status
  activefs server stop [remote]   Stop a recorded server runtime
  activefs mcp [remote] [start|inspect|status|stop|config claude|codex|generic]
                                  Start, inspect, or print client config for the ActiveFS MCP access adapter
  activefs mount [remote] [mountpoint] [--read-only] [--cache]
                                  Start a configured mounted folder and attach freshness
  activefs mount status [remote] [--json]
                                  Show configured mount status
  activefs mount cleanup [remote] Remove stale runtime files and orphaned status
  activefs remount [remote] [--cache]
                                  Unmount and start a configured mounted folder
  activefs unmount [remote] [--keep-mountpoint]
                                  Unmount configured mounted folders
  activefs refresh <remote:/path> [--json]
                                  Support/debug refresh for a mounted path
  activefs cache status [remote]  Show mount cache file counts and byte sizes
  activefs cache clear [remote] [--path /path]
                                  Clear mount cache directories or a path key
  activefs cache watch [remote] [--source-remote name]
                                  Watch Source API invalidation events and refresh mounted cache
  activefs logs [remote]          Tail mount logs
  activefs export <path> --to <dir> [--tree-revision rev]
                                  Export a live or revision-pinned tree and write an export manifest

Mounted example trees:
  /hello.md       In-memory hello file mounted at the root
  /search         Searchable tree that implements tree.search
  /scan           Enumerable tree searched through list/read scanning
  /generated      Generated repo context plus non-enumerable users route`);
}

function printMCPHelp(): void {
  console.log(`${mcpUsageLine()}

Commands:
  activefs mcp                  Start a stdio MCP server for all configured remotes
  activefs mcp docs start       Start a stdio MCP server for the docs remote
  activefs mcp docs inspect     Validate config and print the selected MCP server plan
  activefs mcp docs status      Print managed MCP runtime status if ActiveFS recorded one
  activefs mcp docs stop        Stop a recorded managed MCP runtime if one exists
  activefs mcp docs config claude
                                Print a Claude Desktop stdio MCP config snippet
  activefs mcp docs config codex
                                Print a Codex config.toml stdio MCP config snippet
  activefs mcp docs config generic
                                Print a generic stdio command descriptor for MCP clients
  activefs mcp docs start --http --port 8765 --token env:ACTIVEFS_MCP_TOKEN
                                Start a loopback Streamable HTTP MCP server

Options:
  --state-root <dir>             ActiveFS state root, default .activefs or discovered parent
  --root <dir>                   Alias for --state-root
  --workspace <dir>              Compatibility alias for --state-root
  --config <path>                 Explicit activefs-mcp.config.json
  --demo                          Use deterministic in-memory demo fixture
  --http                          Alias for --transport http
  --transport stdio|http          Transport override, default stdio
  --host <host>                   HTTP host, default 127.0.0.1
  --port <port>                   HTTP port, default 8765
  --endpoint <path>               HTTP endpoint, default /mcp
  --auth bearer|none              HTTP auth mode
  --token env:NAME|VALUE          HTTP bearer token source
  --allow-origin <origin>         Allowed Origin, repeatable
  --allow-host <host>             Allowed Host, repeatable
  --allow-network-bind            Permit non-loopback HTTP bind
  --allow-insecure-http           Permit --auth none outside loopback
`);
}

function printTuiHelp(): void {
  console.log(`activefs tui [--state-root .activefs] [--source local=/path|local:/mount=/path|http:/remote=url] [--debug]

Open the ActiveFS developer/operator terminal UI.

Screens:
  Health    Source API, session/freshness, WebDAV, rclone, OS mount, cache, ops, activity
  Remotes   Source API handshake/capabilities, config, auth type, policy, operations, activity
  Mounts    WebDAV/rclone adapter state, VFS path, rclone RC, freshness, stale state
  Cache     Cache mode, size/count, clear, and mounted-path invalidation
  Browser   Direct ActiveFS stat/list/read preview and export
  Search    Direct ActiveFS search with mode/truncation labels
  Logs      Local WebDAV and rclone logs
  Settings  Workspace/export roots and adapter counts

Keys:
  tab / shift-tab   switch screens
  /                 search from current browser path
  d                 save redacted diagnostics snapshot
  ?                 in-app help
  q / ctrl-c        quit

WebDAV and rclone are shown as local mount adapter internals, not as the remote Source API.`);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    if (error instanceof ActiveFSError) {
      console.error(`${error.code}: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  });
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
