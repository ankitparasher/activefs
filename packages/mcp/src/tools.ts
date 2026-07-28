import {
  ActiveFSError,
  activeFSContentByteLength,
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSContext,
  type ActiveFSPath,
  type MaybePromise
} from "@activefs/core";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ActiveFSMCPAdapter, ActiveFSMCPRemote } from "./index.js";
import {
  activefsMCPToolInputJsonSchemas,
  activefsMCPToolInputSchemas,
  type ActiveFSMCPToolName
} from "./schemas.js";
import {
  activeFSMCPRemotePath,
  activeFSMCPResourceUri,
  activeFSMCPRuntimePath,
  parseActiveFSMCPUri
} from "./uri.js";

export interface ActiveFSMCPToolRuntime<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  adapter: ActiveFSMCPAdapter<Auth, Meta>;
  remotes: ActiveFSMCPRemote[];
  pageSize: number;
  contextFor(request: {
    operation: "list" | "read" | "search" | "write";
    remote: string;
    path: ActiveFSPath;
    toolName: ActiveFSMCPToolName;
  }): MaybePromise<ActiveFSContext<Auth, Meta>>;
  authorizeTool(request: {
    operation: "list" | "read" | "search" | "write";
    remote: string;
    path: ActiveFSPath;
    toolName: ActiveFSMCPToolName;
    context: ActiveFSContext<Auth, Meta>;
  }): MaybePromise<boolean>;
}

export type ActiveFSMCPToolConfig = Partial<Record<
  "list" | "stat" | "read" | "grep" | "write" | "mkdir" | "rm" | "mv" | "cp" | "export",
  boolean
>>;

interface ToolDefinition {
  name: ActiveFSMCPToolName;
  key: keyof ActiveFSMCPToolConfig;
  title: string;
  description: string;
  readOnly: boolean;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "activefs_list",
    key: "list",
    title: "List ActiveFS directory",
    description: "List visible entries under an ActiveFS remote path.",
    readOnly: true
  },
  {
    name: "activefs_stat",
    key: "stat",
    title: "Stat ActiveFS path",
    description: "Read metadata for one ActiveFS path or activefs:// URI.",
    readOnly: true
  },
  {
    name: "activefs_read",
    key: "read",
    title: "Read ActiveFS resource",
    description: "Read one ActiveFS file by path or activefs:// URI.",
    readOnly: true
  },
  {
    name: "activefs_grep",
    key: "grep",
    title: "Search ActiveFS content",
    description: "Search text content below an ActiveFS path and return activefs:// links for matches.",
    readOnly: true
  },
  {
    name: "activefs_write",
    key: "write",
    title: "Write ActiveFS file",
    description: "Write text or base64 bytes through the authoritative ActiveFS tree.",
    readOnly: false
  },
  {
    name: "activefs_mkdir",
    key: "mkdir",
    title: "Create ActiveFS directory",
    description: "Create a directory through the authoritative ActiveFS tree.",
    readOnly: false
  },
  {
    name: "activefs_rm",
    key: "rm",
    title: "Remove ActiveFS path",
    description: "Delete a file or directory through the authoritative ActiveFS tree.",
    readOnly: false
  },
  {
    name: "activefs_mv",
    key: "mv",
    title: "Move ActiveFS path",
    description: "Rename a path within one ActiveFS remote.",
    readOnly: false
  },
  {
    name: "activefs_cp",
    key: "cp",
    title: "Copy ActiveFS path",
    description: "Copy a path within one ActiveFS remote.",
    readOnly: false
  },
  {
    name: "activefs_export",
    key: "export",
    title: "Export ActiveFS resources",
    description: "Return a bounded manifest of readable resources and activefs:// links for local client-side export.",
    readOnly: false
  }
];

const DEFAULT_TOOLS: Required<ActiveFSMCPToolConfig> = {
  list: true,
  stat: true,
  read: true,
  grep: true,
  write: false,
  mkdir: false,
  rm: false,
  mv: false,
  cp: false,
  export: false
};

export function listActiveFSMCPTools(config: ActiveFSMCPToolConfig | undefined): Tool[] {
  const enabled = { ...DEFAULT_TOOLS, ...config };
  return TOOL_DEFINITIONS
    .filter((definition) => enabled[definition.key])
    .map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      inputSchema: toolInputSchema(definition.name),
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: !definition.readOnly && ["rm", "mv", "write"].includes(definition.key)
      }
    }));
}

export function isActiveFSMCPToolEnabled(
  name: string,
  config: ActiveFSMCPToolConfig | undefined
): name is ActiveFSMCPToolName {
  const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name);
  if (!definition) {
    return false;
  }
  const enabled = { ...DEFAULT_TOOLS, ...config };
  return Boolean(enabled[definition.key]);
}

export async function callActiveFSMCPTool<Auth, Meta>(
  name: ActiveFSMCPToolName,
  args: unknown,
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>
): Promise<CallToolResult> {
  try {
    if (name === "activefs_list") {
      return await listTool(activefsMCPToolInputSchemas.activefs_list.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_stat") {
      return await statTool(activefsMCPToolInputSchemas.activefs_stat.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_read") {
      return await readTool(activefsMCPToolInputSchemas.activefs_read.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_grep") {
      return await grepTool(activefsMCPToolInputSchemas.activefs_grep.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_write") {
      return await writeTool(activefsMCPToolInputSchemas.activefs_write.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_mkdir") {
      return await mkdirTool(activefsMCPToolInputSchemas.activefs_mkdir.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_rm") {
      return await rmTool(activefsMCPToolInputSchemas.activefs_rm.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_mv") {
      return await mvTool(activefsMCPToolInputSchemas.activefs_mv.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_cp") {
      return await cpTool(activefsMCPToolInputSchemas.activefs_cp.parse(args ?? {}), runtime, name);
    }
    if (name === "activefs_export") {
      return await exportTool(activefsMCPToolInputSchemas.activefs_export.parse(args ?? {}), runtime, name);
    }
    throw new ActiveFSError("UNSUPPORTED", `Unknown ActiveFS MCP tool: ${name}`);
  } catch (error) {
    return toolError(error);
  }
}

async function listTool<Auth, Meta>(
  input: { remote?: string; path?: string; limit?: number; cursor?: string; includeNonEnumerable?: boolean },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes, input.path ?? "/");
  const context = await authorizedContext(runtime, {
    operation: "list",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const entries = await runtime.filesystem.list(context, target.runtimePath);
  const visible = input.includeNonEnumerable
    ? entries
    : entries.filter((entry) => entry.enumerable !== false);
  const paged = paginate(visible, input.limit ?? runtime.pageSize, input.cursor);
  const structuredContent = {
    remote: target.remote.name,
    path: target.path,
    entries: paged.items.map((entry) => ({
      ...entry,
      path: activeFSMCPRemotePath(target.remote, entry.path),
      uri: activeFSMCPResourceUri(target.remote.name, activeFSMCPRemotePath(target.remote, entry.path))
    })),
    nextCursor: paged.nextCursor
  };
  return toolResult(`Listed ${paged.items.length} ActiveFS entr${paged.items.length === 1 ? "y" : "ies"}.`, structuredContent);
}

async function statTool<Auth, Meta>(
  input: { remote?: string; path?: string; uri?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "read",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const stat = await runtime.filesystem.stat(context, target.runtimePath);
  if (!stat) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${target.path}`, { path: target.path });
  }
  const structuredContent = {
    ...stat,
    path: target.path,
    uri: activeFSMCPResourceUri(target.remote.name, target.path)
  };
  return toolResult(`Read metadata for ${structuredContent.uri}.`, structuredContent);
}

async function readTool<Auth, Meta>(
  input: { remote?: string; path?: string; uri?: string; encoding?: "utf8" | "base64" | "binary"; offset?: number; length?: number },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "read",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const read = await runtime.filesystem.read(context, target.runtimePath, {
    encoding: input.encoding,
    offset: input.offset,
    length: input.length
  });
  const uri = activeFSMCPResourceUri(target.remote.name, target.path);
  const payload = typeof read.content === "string"
    ? { text: read.content }
    : { blob: Buffer.from(read.content).toString("base64") };
  return {
    content: [
      typeof read.content === "string"
        ? { type: "text", text: read.content }
        : { type: "text", text: `Read ${read.content.byteLength} byte${read.content.byteLength === 1 ? "" : "s"} from ${uri}.` }
    ],
    structuredContent: {
      uri,
      mimeType: read.stat?.mimeType,
      byteLength: activeFSContentByteLength(read.content),
      ...payload
    }
  };
}

async function grepTool<Auth, Meta>(
  input: { remote?: string; path?: string; query: string; caseSensitive?: boolean; limit?: number; includeNonEnumerable?: boolean },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes, input.path ?? "/");
  await authorizedContext(runtime, {
    operation: "search",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const result = await runtime.adapter.grep({
    remote: target.remote.name,
    path: target.path,
    query: input.query,
    caseSensitive: input.caseSensitive,
    limit: input.limit,
    includeNonEnumerable: input.includeNonEnumerable
  });
  return toolResult(`Found ${result.matches.length} ActiveFS match${result.matches.length === 1 ? "" : "es"}.`, {
    ...result
  });
}

async function writeTool<Auth, Meta>(
  input: { remote?: string; path?: string; uri?: string; text?: string; blob?: string; mimeType?: string; create?: boolean; overwrite?: boolean; idempotencyKey?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const content = input.text !== undefined
    ? input.text
    : Buffer.from(input.blob ?? "", "base64");
  const result = await runtime.filesystem.write(context, target.runtimePath, content, {
    create: input.create,
    overwrite: input.overwrite,
    contentType: input.mimeType,
    idempotencyKey: input.idempotencyKey
  });
  return toolResult(`Wrote ${activeFSMCPResourceUri(target.remote.name, target.path)}.`, {
    uri: activeFSMCPResourceUri(target.remote.name, target.path),
    ...result
  });
}

async function mkdirTool<Auth, Meta>(
  input: { remote?: string; path: string; recursive?: boolean; idempotencyKey?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes, input.path);
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const result = await runtime.filesystem.mkdir(context, target.runtimePath, {
    recursive: input.recursive,
    idempotencyKey: input.idempotencyKey
  });
  return toolResult(`Created directory ${activeFSMCPResourceUri(target.remote.name, target.path)}.`, {
    ...result
  });
}

async function rmTool<Auth, Meta>(
  input: { remote?: string; path?: string; uri?: string; recursive?: boolean; idempotencyKey?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const result = await runtime.filesystem.delete(context, target.runtimePath, {
    recursive: input.recursive,
    idempotencyKey: input.idempotencyKey
  });
  return toolResult(`Removed ${activeFSMCPResourceUri(target.remote.name, target.path)}.`, {
    ...result
  });
}

async function mvTool<Auth, Meta>(
  input: { remote?: string; fromPath?: string; fromUri?: string; toPath: string; overwrite?: boolean; idempotencyKey?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget({ remote: input.remote, path: input.fromPath, uri: input.fromUri }, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const toRuntimePath = activeFSMCPRuntimePath(target.remote, normalizeActiveFSPath(input.toPath));
  const result = await runtime.filesystem.rename(context, target.runtimePath, toRuntimePath, {
    overwrite: input.overwrite,
    idempotencyKey: input.idempotencyKey
  });
  return toolResult(`Moved ${activeFSMCPResourceUri(target.remote.name, target.path)}.`, {
    ...result
  });
}

async function cpTool<Auth, Meta>(
  input: { remote?: string; fromPath?: string; fromUri?: string; toPath: string; overwrite?: boolean; recursive?: boolean; idempotencyKey?: string },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget({ remote: input.remote, path: input.fromPath, uri: input.fromUri }, runtime.remotes);
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const toRuntimePath = activeFSMCPRuntimePath(target.remote, normalizeActiveFSPath(input.toPath));
  const result = await runtime.filesystem.copy(context, target.runtimePath, toRuntimePath, {
    overwrite: input.overwrite,
    recursive: input.recursive,
    idempotencyKey: input.idempotencyKey
  });
  return toolResult(`Copied ${activeFSMCPResourceUri(target.remote.name, target.path)}.`, {
    ...result
  });
}

async function exportTool<Auth, Meta>(
  input: { remote?: string; path?: string; maxFiles?: number },
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  toolName: ActiveFSMCPToolName
): Promise<CallToolResult> {
  const target = resolveToolTarget(input, runtime.remotes, input.path ?? "/");
  const context = await authorizedContext(runtime, {
    operation: "write",
    remote: target.remote.name,
    path: target.path,
    toolName
  });
  const adapterResult = await runtime.adapter.listResources({ context });
  const resources = adapterResult.resources
    .filter((resource) => resource.uri.startsWith(`activefs://${target.remote.name}/`))
    .slice(0, input.maxFiles ?? 1000);
  return toolResult(`Prepared ${resources.length} ActiveFS resource link${resources.length === 1 ? "" : "s"} for export.`, {
    remote: target.remote.name,
    path: target.path,
    resources,
    truncated: adapterResult.truncated || resources.length >= (input.maxFiles ?? 1000)
  });
}

function resolveToolTarget(
  input: { remote?: string; path?: string; uri?: string },
  remotes: ActiveFSMCPRemote[],
  defaultPath = "/"
): {
  remote: Required<Pick<ActiveFSMCPRemote, "name" | "rootPath">> & Pick<ActiveFSMCPRemote, "title">;
  path: ActiveFSPath;
  runtimePath: ActiveFSPath;
} {
  if (input.uri) {
    const parsed = parseActiveFSMCPUri(input.uri, remotes);
    return {
      ...parsed,
      runtimePath: activeFSMCPRuntimePath(parsed.remote, parsed.path)
    };
  }
  const remote = input.remote
    ? remotes.find((candidate) => candidate.name === input.remote)
    : remotes[0];
  if (!remote) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS MCP remote: ${input.remote ?? ""}`);
  }
  const normalizedRemote = {
    name: remote.name,
    rootPath: normalizeActiveFSPath(remote.rootPath ?? "/"),
    title: remote.title
  };
  const path = normalizeActiveFSPath(input.path ?? defaultPath);
  return {
    remote: normalizedRemote,
    path,
    runtimePath: activeFSMCPRuntimePath(normalizedRemote, path)
  };
}

async function authorizedContext<Auth, Meta>(
  runtime: ActiveFSMCPToolRuntime<Auth, Meta>,
  request: {
    operation: "list" | "read" | "search" | "write";
    remote: string;
    path: ActiveFSPath;
    toolName: ActiveFSMCPToolName;
  }
): Promise<ActiveFSContext<Auth, Meta>> {
  const context = await runtime.contextFor(request);
  if (!(await runtime.authorizeTool({ ...request, context }))) {
    throw new ActiveFSError("FORBIDDEN", `ActiveFS MCP tool is not authorized: ${request.toolName}`);
  }
  return context;
}

function paginate<T>(items: T[], limit: number, cursor: string | undefined): {
  items: T[];
  nextCursor?: string;
} {
  const offset = cursor ? parseCursor(cursor) : 0;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined
  };
}

function parseCursor(cursor: string): number {
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ActiveFSError("INVALID_REQUEST", `Invalid MCP pagination cursor: ${cursor}`);
  }
  return parsed;
}

function toolInputSchema(name: ActiveFSMCPToolName): Tool["inputSchema"] {
  const schema = activefsMCPToolInputJsonSchemas[name];
  return {
    type: "object",
    ...schema
  } as Tool["inputSchema"];
}

function toolResult(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: message }]
  };
}
