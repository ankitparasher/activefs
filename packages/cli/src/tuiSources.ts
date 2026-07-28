import {
  ActiveFSError,
  createActiveFS,
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSCommandInput,
  type ActiveFSCommandResultMap,
  type ActiveFSContext,
  type ActiveFSDirEntry,
  type ActiveFSPath,
  type ActiveFSReadOptions,
  type ActiveFSReadResult,
  type ActiveFSSearchResult,
  type ActiveFSStat,
  type ActiveFSTreeCommand,
  type ActiveFSTreeCommandResultMap,
  type ActiveFSTreeInfo,
  type ActiveFSTreeMutationResult,
  type ActiveFSTreeReadResult,
  type ActiveFSTreeSearchResult,
  type ActiveFSTree
} from "@activefs/core";
import { createLocalTree } from "@activefs/local";
import {
  authHeadersFromProvider,
  createActiveFSRemoteStateLayout,
  recordActiveFSOperationJournal,
  updateActiveFSOperationJournal,
  resolveActiveFSState,
  type ActiveFSPolicyOperation,
  type ActiveFSAuthProviderConfig
} from "@activefs/config";
import { createHttpSourceClient, type HttpSourceClientAuth } from "@activefs/source-http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createExampleActiveFS } from "./example.js";

export type ActiveFSTuiSourceKind = "example" | "local" | "http";

export interface ActiveFSTuiSourceDescriptor {
  id: string;
  label: string;
  kind: ActiveFSTuiSourceKind;
  mountPath: ActiveFSPath;
  detail: string;
}

export interface ActiveFSTuiRuntime {
  filesystem: ActiveFS;
  sources: ActiveFSTuiSourceDescriptor[];
}

export interface ActiveFSTuiRuntimeOptions {
  rootDir?: string;
}

interface ResolvedSourceSpec {
  spec: string;
  auth?: HttpSourceClientAuth | false;
  allowInsecureHttp?: boolean;
  rootDir?: string;
  remoteName?: string;
}

export function createActiveFSTuiRuntime(
  sourceSpecs: string[] = [],
  options: ActiveFSTuiRuntimeOptions = {}
): ActiveFSTuiRuntime {
  const configuredSourceSpecs: ResolvedSourceSpec[] = sourceSpecs.length > 0
    ? sourceSpecs.map((spec) => ({ spec }))
    : sourceSpecsFromConfig(options.rootDir);
  if (configuredSourceSpecs.length === 0) {
    throw new ActiveFSError(
      "INVALID_REQUEST",
      "No ActiveFS sources are configured. Add a remote, pass --source, or use --source example for the explicit demo tree."
    );
  }
  const specs = configuredSourceSpecs;
  if (specs.length === 1 && specs[0]?.spec === "example") {
    return {
      filesystem: createExampleActiveFS(),
      sources: [
        {
          id: "example",
          label: "Example",
          kind: "example",
          mountPath: "/",
          detail: "Built-in fake example tree."
        }
      ]
    };
  }

  const fs = createActiveFS();
  const sources: ActiveFSTuiSourceDescriptor[] = [];
  for (const { spec, auth, allowInsecureHttp, rootDir, remoteName } of specs) {
    if (spec === "example") {
      const mountPath = sources.length === 0 ? "/" : "/example";
      fs.mount(mountPath, activeFSAsTree(createExampleActiveFS()));
      sources.push({
        id: "example",
          label: "Example",
          kind: "example",
          mountPath,
          detail: "Built-in fake example tree."
      });
      continue;
    }

    const local = parseLocalTreeSpec(spec);
    if (local) {
      const tree = createLocalTree({ root: local.root });
      fs.mount(local.mountPath, tree as ActiveFSTree);
      sources.push({
        id: local.id,
        label: local.label,
        kind: "local",
        mountPath: local.mountPath,
        detail: local.root
      });
      continue;
    }

    const http = parseHttpSourceSpec(spec);
    const remoteTree = createHttpSourceClient({ url: http.url, auth, allowInsecureHttp });
    const tree = rootDir && remoteName
      ? withOperationJournal(remoteTree as ActiveFSTree, rootDir, remoteName)
      : remoteTree;
    fs.mount(http.mountPath, tree as ActiveFSTree);
    sources.push({
      id: http.id,
      label: http.label,
      kind: "http",
      mountPath: http.mountPath,
      detail: http.url
    });
  }

  if (sources.length === 0) {
    throw new Error("At least one TUI source must be configured.");
  }

  return { filesystem: fs, sources };
}

function sourceSpecsFromConfig(rootDir: string | undefined): ResolvedSourceSpec[] {
  if (!rootDir) {
    return [];
  }
  try {
    const configPath = resolveActiveFSState(rootDir).configPath;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      schemaVersion?: number;
      remotes?: Record<string, {
        mountPath?: string;
        url?: string;
        auth?: ActiveFSAuthProviderConfig;
        insecureHttp?: { allowed?: boolean };
      }>;
    };
    if (parsed.schemaVersion !== 1 || !parsed.remotes) {
      return [];
    }
    return Object.entries(parsed.remotes)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, source]) => {
        if (
          typeof source.url !== "string" ||
          typeof source.mountPath !== "string"
        ) {
          return [];
        }
        return [{
          spec: `http:${source.mountPath}=${source.url}`,
          auth: sourceAuthProvider(rootDir, name, source.auth),
          allowInsecureHttp: Boolean(source.insecureHttp?.allowed),
          rootDir,
          remoteName: name
        }];
      });
  } catch {
    return [];
  }
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

export function activeFSAsTree(filesystem: ActiveFS): ActiveFSTree {
  return {
    name: "activefs",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      search: true,
      write: true,
      watch: true
    },
    set: unsupportedRuntimeTreeDeclarationMutation,
    path: unsupportedRuntimeTreePathHandle,
    pre() {
      return this;
    },
    post() {
      return this;
    },
    on() {
      return this;
    },
    onChange() {
      return this;
    },
    info: async (context: ActiveFSContext, path: ActiveFSPath) =>
      statToTreeInfo(await filesystem.stat(context, path)),
    list: async (context: ActiveFSContext, path: ActiveFSPath) =>
      (await filesystem.list(context, path)).map(entryToTreeInfo),
    read: (context: ActiveFSContext, path: ActiveFSPath, options) =>
      filesystem.read(context, path, options).then(readResultToTreeRead),
    search: (context, path, query) =>
      filesystem.search(context, path, query).then(searchResultToTreeSearch),
    walk: async (context, path, options) =>
      walkRuntimeTree(filesystem, context, path, options),
    write: async (context, path, content, options) =>
      writeResultToTreeMutation(path, await filesystem.write(context, path, content, options)),
    remove: async (context, path, options) => {
      const result = await filesystem.delete(context, path, options);
      return {
        removed: result.path,
        operationId: result.operationId,
        revision: result.revision,
        data: result.meta
      };
    },
    makeDir: async (context, path, options) =>
      mkdirResultToTreeMutation(path, await filesystem.mkdir(context, path, options)),
    move: async (context, path, toPath, options) => {
      const result = await filesystem.rename(context, path, toPath, options);
      return {
        moved: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        revision: result.revision,
        data: result.meta
      };
    },
    copy: async (context, path, toPath, options) => {
      const result = await filesystem.copy(context, path, toPath, options);
      return {
        copied: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        revision: result.revision,
        data: result.meta
      };
    },
    truncate: async (context, path, options) => {
      const result = await filesystem.truncate(context, path, options);
      return {
        modified: path,
        info: result.stat ? statToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        revision: result.revision,
        data: result.meta
      };
    },
    updateInfo: async (context, path, options) => {
      const result = await filesystem.updateMetadata(context, path, options);
      return {
        modified: path,
        info: result.stat ? statToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        revision: result.revision,
        data: result.meta
      };
    },
    watch: (context, path, onEvent, options) => filesystem.watch(context, path, onEvent, options),
    command: async (context, command, path, input) =>
      runRuntimeTreeCommand(filesystem, context, command, path, input)
  };
}

function unsupportedRuntimeTreeDeclarationMutation(): never {
  throw new ActiveFSError("UNSUPPORTED", "Runtime-backed trees do not support declaration mutation");
}

function unsupportedRuntimeTreePathHandle(): never {
  throw new ActiveFSError("UNSUPPORTED", "Runtime-backed trees do not expose declaration path handles");
}

function statToTreeInfo<Meta>(stat: ActiveFSStat<Meta> | null): ActiveFSTreeInfo<Meta> {
  if (!stat) {
    return null;
  }
  return {
    path: stat.path,
    name: stat.name,
    kind: stat.kind,
    type: stat.mimeType,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    etag: stat.etag,
    revision: stat.revision,
    enumerable: stat.enumerable,
    data: stat.meta
  };
}

function entryToTreeInfo<Meta>(entry: ActiveFSDirEntry<Meta>): NonNullable<ActiveFSTreeInfo<Meta>> {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    type: entry.mimeType,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    enumerable: entry.enumerable,
    data: entry.meta
  };
}

function readResultToTreeRead<Meta>(result: ActiveFSReadResult<Meta>): ActiveFSTreeReadResult<Meta> {
  return {
    content: result.content,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    data: result.meta
  };
}

function searchResultToTreeSearch<Meta>(result: ActiveFSSearchResult<Meta>): ActiveFSTreeSearchResult<Meta> {
  return {
    matches: result.matches.map((match) => ({
      path: match.path,
      line: match.line,
      column: match.column,
      excerpt: match.excerpt,
      data: match.meta
    })),
    complete: result.complete,
    strategy: result.strategy,
    incompleteReasons: result.incompleteReasons
  };
}

function writeResultToTreeMutation<Meta>(
  path: ActiveFSPath,
  result: { stat?: ActiveFSStat<Meta>; created?: boolean; operationId?: string; revision?: string; meta?: Meta }
): ActiveFSTreeMutationResult<unknown, Meta> {
  const resultPath = result.stat?.path ?? normalizeActiveFSPath(path);
  return {
    [result.created ? "created" : "modified"]: resultPath,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    operationId: result.operationId,
    revision: result.revision,
    data: result.meta
  };
}

function mkdirResultToTreeMutation<Meta>(
  path: ActiveFSPath,
  result: { stat?: ActiveFSStat<Meta>; created?: boolean; operationId?: string; revision?: string; meta?: Meta }
): ActiveFSTreeMutationResult<unknown, Meta> {
  const resultPath = result.stat?.path ?? normalizeActiveFSPath(path);
  return {
    [result.created ? "created" : "modified"]: resultPath,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    operationId: result.operationId,
    revision: result.revision,
    data: result.meta
  };
}

async function walkRuntimeTree(
  filesystem: ActiveFS,
  context: ActiveFSContext,
  path: ActiveFSPath,
  options: { includeNonEnumerable?: boolean } = {}
): Promise<NonNullable<ActiveFSTreeInfo>[]> {
  const info = statToTreeInfo(await filesystem.stat(context, path));
  if (!info) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  const results: NonNullable<ActiveFSTreeInfo>[] = [info];
  if (info.kind !== "directory") {
    return results;
  }
  for (const entry of await filesystem.list(context, path)) {
    if (entry.enumerable === false && !options.includeNonEnumerable) {
      continue;
    }
    results.push(...await walkRuntimeTree(filesystem, context, entry.path, options));
  }
  return results;
}

async function runRuntimeTreeCommand<Command extends ActiveFSTreeCommand>(
  filesystem: ActiveFS,
  context: ActiveFSContext,
  command: Command,
  path: string,
  input: ActiveFSCommandInput<Command>
): Promise<ActiveFSTreeCommandResultMap<unknown>[Command]> {
  const normalizedPath = normalizeActiveFSPath(path);
  const result = await filesystem.command(context, command, normalizedPath, input);
  if (command === "ls") {
    return (result as ActiveFSCommandResultMap["ls"]).map(statToTreeInfo).filter(Boolean) as ActiveFSTreeCommandResultMap<unknown>[Command];
  }
  if (command === "stat") {
    return statToTreeInfo(result as ActiveFSCommandResultMap["stat"]) as ActiveFSTreeCommandResultMap<unknown>[Command];
  }
  if (command === "cat" || command === "head" || command === "tail" || command === "sed") {
    const read = result as ActiveFSReadResult;
    return {
      content: read.content,
      info: statToTreeInfo(read.stat ?? null),
      data: read.meta
    } as ActiveFSTreeCommandResultMap<unknown>[Command];
  }
  if (command === "grep" || command === "rg") {
    return searchResultToTreeSearch(result as ActiveFSCommandResultMap["grep"]) as ActiveFSTreeCommandResultMap<unknown>[Command];
  }
  if (command === "find") {
    return (result as ActiveFSCommandResultMap["find"]).map(statToTreeInfo).filter(Boolean) as ActiveFSTreeCommandResultMap<unknown>[Command];
  }
  throw new ActiveFSError("UNSUPPORTED", `Unsupported runtime tree command: ${command}`, { path: normalizedPath });
}

function withOperationJournal(tree: ActiveFSTree, rootDir: string, remoteName: string): ActiveFSTree {
  const layout = createActiveFSRemoteStateLayout(rootDir, remoteName);
  const track = async <Result>(
    operation: ActiveFSPolicyOperation,
    path: ActiveFSPath,
    targetPath: ActiveFSPath | undefined,
    idempotencyKey: string | undefined,
    execute: () => Result | Promise<Result>
  ): Promise<Result> => {
    const operationId = idempotencyKey ? `idempotency:${idempotencyKey}` : `local:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const startedAt = new Date().toISOString();
    await recordActiveFSOperationJournal(layout, {
      operationId,
      operation,
      path,
      targetPath,
      status: "pending",
      startedAt,
      idempotencyKey
    });
    try {
      const result = await execute();
      const committedOperationId = operationIdFromResult(result) ?? operationId;
      await updateActiveFSOperationJournal(layout, operationId, {
        status: "committed",
        completedAt: new Date().toISOString(),
        operationStatusEndpoint: operationStatusEndpointFromResult(result),
        result: scrubOperationResult(result)
      });
      if (committedOperationId !== operationId) {
        await recordActiveFSOperationJournal(layout, {
          operationId: committedOperationId,
          operation,
          path,
          targetPath,
          status: "committed",
          startedAt,
          completedAt: new Date().toISOString(),
          idempotencyKey,
          operationStatusEndpoint: operationStatusEndpointFromResult(result),
          result: scrubOperationResult(result)
        });
      }
      return result;
    } catch (error) {
      await updateActiveFSOperationJournal(layout, operationId, {
        status: journalFailureStatus(error),
        completedAt: new Date().toISOString(),
        operationStatusEndpoint: operationStatusEndpointFromResult(error),
        lastFailureReason: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };

  return {
    ...tree,
    write: (context, path, content, options) =>
      track("write", normalizeActiveFSPath(path), undefined, options?.idempotencyKey, () =>
        tree.write(context, path, content, options)
      ),
    remove: (context, path, options) =>
      track("delete", normalizeActiveFSPath(path), undefined, options?.idempotencyKey, () =>
        tree.remove(context, path, options)
      ),
    makeDir: (context, path, options) =>
      track("mkdir", normalizeActiveFSPath(path), undefined, options?.idempotencyKey, () =>
        tree.makeDir(context, path, options)
      ),
    move: (context, path, toPath, options) =>
      track("rename", normalizeActiveFSPath(path), normalizeActiveFSPath(toPath), options?.idempotencyKey, () =>
        tree.move(context, path, toPath, options)
      ),
    copy: (context, path, toPath, options) =>
      track("copy", normalizeActiveFSPath(path), normalizeActiveFSPath(toPath), options?.idempotencyKey, () =>
        tree.copy(context, path, toPath, options)
      ),
    truncate: (context, path, options) =>
      track("truncate", normalizeActiveFSPath(path), undefined, options?.idempotencyKey, () =>
        tree.truncate(context, path, options)
      ),
    updateInfo: (context, path, options) =>
      track("updateMetadata", normalizeActiveFSPath(path), undefined, options?.idempotencyKey, () =>
        tree.updateInfo(context, path, options)
      )
  };
}

function operationIdFromResult(result: unknown): string | undefined {
  return result && typeof result === "object" && "operationId" in result &&
    typeof (result as { operationId?: unknown }).operationId === "string"
    ? (result as { operationId: string }).operationId
    : undefined;
}

function operationStatusEndpointFromResult(result: unknown): string | undefined {
  return result && typeof result === "object" && "operationStatusEndpoint" in result &&
    typeof (result as { operationStatusEndpoint?: unknown }).operationStatusEndpoint === "string"
    ? (result as { operationStatusEndpoint: string }).operationStatusEndpoint
    : undefined;
}

function scrubOperationResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }
  const { content, contentBase64, ...rest } = result as Record<string, unknown>;
  return rest;
}

function journalFailureStatus(error: unknown): "rejected" | "conflict" | "transient" | "unsupported" | "unknown" {
  if (error instanceof ActiveFSError && (error.code === "CONFLICT" || error.code === "PRECONDITION_FAILED")) {
    return "conflict";
  }
  if (error instanceof ActiveFSError && error.code === "UNSUPPORTED") {
    return "unsupported";
  }
  if (error instanceof ActiveFSError && (error.code === "TRANSIENT" || error.code === "SOURCE_ERROR")) {
    return "transient";
  }
  if (error instanceof ActiveFSError && ["FORBIDDEN", "UNAUTHORIZED", "INVALID_REQUEST"].includes(error.code)) {
    return "rejected";
  }
  return "unknown";
}

function parseLocalTreeSpec(spec: string): {
  id: string;
  label: string;
  mountPath: ActiveFSPath;
  root: string;
} | null {
  if (!spec.startsWith("local")) {
    return null;
  }

  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error("Local TUI sources must use local=/path or local:/mount=/path.");
  }

  const left = spec.slice(0, separator);
  if (!left.startsWith("local") || (left !== "local" && !left.startsWith("local:/"))) {
    throw new Error("Local TUI sources must use local=/path or local:/mount=/path.");
  }
  const root = resolve(spec.slice(separator + 1));
  const mountPath = left === "local"
    ? "/local"
    : normalizeActiveFSPath(left.slice("local:".length));
  const idSuffix = mountPath === "/" ? "root" : mountPath.split("/").filter(Boolean).join("-");
  return {
    id: `local:${idSuffix}`,
    label: `Local ${mountPath}`,
    mountPath,
    root
  };
}

function parseHttpSourceSpec(spec: string): {
  id: string;
  label: string;
  mountPath: ActiveFSPath;
  url: string;
} {
  if (!spec.startsWith("http")) {
    throw new Error(`Unsupported TUI source spec: ${spec}`);
  }

  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error("HTTP TUI sources must use http=https://host or http:/mount=https://host.");
  }

  const left = spec.slice(0, separator);
  if (!left.startsWith("http") || (left !== "http" && !left.startsWith("http:/"))) {
    throw new Error("HTTP TUI sources must use http=https://host or http:/mount=https://host.");
  }
  const url = spec.slice(separator + 1);
  const mountPath = left === "http"
    ? "/remote"
    : normalizeActiveFSPath(left.slice("http:".length));
  const idSuffix = mountPath === "/" ? "root" : mountPath.split("/").filter(Boolean).join("-");
  return {
    id: `http:${idSuffix}`,
    label: `HTTP ${mountPath}`,
    mountPath,
    url
  };
}
