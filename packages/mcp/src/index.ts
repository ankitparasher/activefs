import {
  ActiveFSError,
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSSearchMatch,
  type ActiveFSSearchIncompleteReason,
  type ActiveFSSearchStrategy,
  type ActiveFSSearchQuery,
  type ActiveFSStat,
  type MaybePromise
} from "@activefs/core";
import { Buffer } from "node:buffer";

/**
 * Options for exposing one ActiveFS filesystem through MCP resource operations.
 *
 * Context is optional and remains opaque to the adapter except for MCP metadata
 * added under `meta` so tree implementations can distinguish adapter operations.
 */
export interface MCPAdapterOptions<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  name?: string;
  remote?: string;
  rootPath?: string;
  remotes?: ActiveFSMCPRemote[];
  context?: ActiveFSContext<Auth, Meta> | ActiveFSMCPContextProvider<Auth, Meta>;
  authorizeResource?: ActiveFSMCPAuthorizationProvider<Auth, Meta>;
  authorizeGrep?: ActiveFSMCPAuthorizationProvider<Auth, Meta>;
  resourceTemplates?: ActiveFSMCPResourceTemplate[];
  includeDirectories?: boolean;
  maxDepth?: number;
  maxResources?: number;
  enableGrep?: boolean;
}

/**
 * Logical remote exposed by the MCP adapter.
 */
export interface ActiveFSMCPRemote {
  name: string;
  rootPath?: string;
  title?: string;
  /** True only when this remote's backing tree is known to support ActiveFS watch events. */
  watchable?: boolean;
}

/**
 * MCP operations that can request context from a context provider.
 */
export type ActiveFSMCPOperation = "listResources" | "readResource" | "grep";

/**
 * Request metadata passed to an MCP context provider.
 */
export interface ActiveFSMCPContextRequest {
  operation: ActiveFSMCPOperation;
  remote: string;
  path: ActiveFSPath;
  uri?: string;
}

/**
 * Authorization request issued before the adapter touches the ActiveFS filesystem.
 */
export interface ActiveFSMCPAuthorizationRequest<Auth = unknown, Meta = unknown>
  extends ActiveFSMCPContextRequest {
  context: ActiveFSContext<Auth, Meta>;
}

/**
 * Callback that supplies per-request ActiveFS context for MCP operations.
 */
export type ActiveFSMCPContextProvider<Auth = unknown, Meta = unknown> = (
  request: ActiveFSMCPContextRequest
) => MaybePromise<ActiveFSContext<Auth, Meta>>;

/**
 * Callback that decides whether one resource/search path is visible to MCP.
 */
export type ActiveFSMCPAuthorizationProvider<Auth = unknown, Meta = unknown> = (
  request: ActiveFSMCPAuthorizationRequest<Auth, Meta>
) => MaybePromise<boolean>;

/**
 * Per-call options for MCP adapter methods.
 */
export interface ActiveFSMCPRequestOptions<Auth = unknown, Meta = unknown> {
  context?: ActiveFSContext<Auth, Meta>;
}

/**
 * MCP resource descriptor derived from ActiveFS stat/list data.
 */
export interface ActiveFSMCPResource {
  uri: string;
  name: string;
  title?: string;
  mimeType?: string;
  description?: string;
}

/**
 * MCP resource template descriptor supplied by the host application.
 */
export interface ActiveFSMCPResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  mimeType?: string;
  description?: string;
}

/**
 * Result of listing MCP resources.
 */
export interface ActiveFSMCPListResourcesResult {
  resources: ActiveFSMCPResource[];
  truncated: boolean;
}

/**
 * One content item returned by `readResource`.
 */
export interface ActiveFSMCPReadResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * Result of reading an MCP resource.
 */
export interface ActiveFSMCPReadResourceResult {
  contents: ActiveFSMCPReadResourceContent[];
}

/**
 * Input for MCP grep over an ActiveFS remote.
 */
export interface ActiveFSMCPGrepInput {
  remote?: string;
  path?: string;
  query: string;
  caseSensitive?: boolean;
  limit?: number;
  includeNonEnumerable?: boolean;
}

/**
 * Search match mapped back to an MCP resource URI.
 */
export interface ActiveFSMCPGrepMatch extends ActiveFSSearchMatch {
  uri: string;
}

/**
 * Result of an MCP grep operation.
 */
export interface ActiveFSMCPGrepResult {
  remote: string;
  path: ActiveFSPath;
  complete: boolean;
  strategy: ActiveFSSearchStrategy;
  incompleteReasons?: ActiveFSSearchIncompleteReason[];
  matches: ActiveFSMCPGrepMatch[];
}

/**
 * MCP adapter facade over ActiveFS resources.
 *
 * Methods normalize `activefs://` URIs, forward opaque context, avoid exposing
 * non-enumerable entries during resource listing, and surface runtime errors as
 * rejected promises.
 */
export interface ActiveFSMCPAdapter<Auth = unknown, Meta = unknown> {
  name: string;
  remotes: ActiveFSMCPRemote[];
  /** Lists enumerable resources from configured remotes up to traversal limits. */
  listResources(
    options?: ActiveFSMCPRequestOptions<Auth, Meta>
  ): Promise<ActiveFSMCPListResourcesResult>;
  /** Reads one `activefs://` resource URI as text or base64 blob content. */
  readResource(
    uri: string,
    options?: ActiveFSMCPRequestOptions<Auth, Meta>
  ): Promise<ActiveFSMCPReadResourceResult>;
  /** Returns static resource templates supplied by the host. */
  listResourceTemplates(): ActiveFSMCPResourceTemplate[];
  /** Searches one remote/path and maps matches back to resource URIs. */
  grep(
    input: ActiveFSMCPGrepInput,
    options?: ActiveFSMCPRequestOptions<Auth, Meta>
  ): Promise<ActiveFSMCPGrepResult>;
}

interface NormalizedRemote {
  name: string;
  rootPath: ActiveFSPath;
  title?: string;
}

interface ParsedActiveFSUri {
  remote: NormalizedRemote;
  path: ActiveFSPath;
}

const DEFAULT_REMOTE = "activefs";
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_RESOURCES = 1000;

/**
 * Creates an MCP resource adapter for an ActiveFS filesystem.
 *
 * @param options Runtime, remotes, context provider, traversal limits, and
 * optional resource templates.
 * @returns Adapter methods for MCP list/read/template/grep operations.
 * @throws `ActiveFSError` for invalid remote names, invalid URIs, disabled grep,
 * or missing resources.
 */
export function createMCPAdapter<Auth = unknown, Meta = unknown>(
  options: MCPAdapterOptions<Auth, Meta>
): ActiveFSMCPAdapter<Auth, Meta> {
  const remotes = normalizeRemotes(options);
  const remoteByName = new Map(remotes.map((remote) => [remote.name, remote]));
  const includeDirectories = options.includeDirectories !== false;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxResources = options.maxResources ?? DEFAULT_MAX_RESOURCES;
  const enableGrep = options.enableGrep !== false;

  const contextFor = async (
    request: ActiveFSMCPContextRequest,
    override?: ActiveFSContext<Auth, Meta>
  ): Promise<ActiveFSContext<Auth, Meta>> => {
    const base = typeof options.context === "function"
      ? await options.context(request)
      : options.context ?? {};
    const baseMeta = isRecord(base.meta) ? base.meta : {};
    const overrideMeta = isRecord(override?.meta) ? override?.meta : {};
    return {
      ...base,
      ...override,
      meta: {
        ...baseMeta,
        adapter: "mcp",
        remote: request.remote,
        operation: request.operation,
        ...overrideMeta
      } as Meta
    };
  };

  const adapter: ActiveFSMCPAdapter<Auth, Meta> = {
    name: options.name ?? "activefs-mcp",
    remotes: remotes.map((remote) => ({
      name: remote.name,
      rootPath: remote.rootPath,
      title: remote.title
    })),
    listResources: async (requestOptions = {}) => {
      const resources: ActiveFSMCPResource[] = [];
      let truncated = false;

      const visit = async (
        remote: NormalizedRemote,
        runtimePath: ActiveFSPath,
        depth: number
      ): Promise<void> => {
        if (resources.length >= maxResources) {
          truncated = true;
          return;
        }
        const request: ActiveFSMCPContextRequest = {
            operation: "listResources",
            remote: remote.name,
            path: toRemotePath(remote, runtimePath)
          };
        const context = await contextFor(request, requestOptions.context);
        if (
          options.authorizeResource &&
          !(await options.authorizeResource({ ...request, context }))
        ) {
          return;
        }
        const stat = await options.filesystem.stat(context, runtimePath);
        if (!stat || stat.enumerable === false) {
          return;
        }
        if (stat.kind === "file" || includeDirectories) {
          resources.push(resourceFromStat(remote, stat));
        }
        if (stat.kind !== "directory" || depth >= maxDepth || resources.length >= maxResources) {
          truncated ||= stat.kind === "directory" && depth >= maxDepth;
          return;
        }
        const entries = await options.filesystem.list(context, runtimePath);
        for (const entry of entries) {
          if (entry.enumerable === false) {
            continue;
          }
          await visit(remote, entry.path, depth + 1);
          if (truncated) {
            return;
          }
        }
      };

      for (const remote of remotes) {
        await visit(remote, remote.rootPath, 0);
        if (truncated) {
          break;
        }
      }

      return { resources, truncated };
    },
    readResource: async (uri, requestOptions = {}) => {
      const parsed = parseActiveFSUri(uri, remoteByName);
      const runtimePath = fromRemotePath(parsed.remote, parsed.path);
      const request: ActiveFSMCPContextRequest = {
          operation: "readResource",
          remote: parsed.remote.name,
          path: parsed.path,
          uri
        };
      const context = await contextFor(request, requestOptions.context);
      if (
        options.authorizeResource &&
        !(await options.authorizeResource({ ...request, context }))
      ) {
        throw new ActiveFSError("FORBIDDEN", `ActiveFS MCP resource is not authorized: ${uri}`);
      }
      const result = await options.filesystem.read(context, runtimePath);
      const mimeType = result.stat?.mimeType;
      const content = {
        uri: resourceUri(parsed.remote.name, parsed.path),
        ...contentPayload(result.content, mimeType)
      };
      return {
        contents: [
          mimeType ? { ...content, mimeType } : content
        ]
      };
    },
    listResourceTemplates: () => [
      ...(options.resourceTemplates ?? []).map((template) => ({ ...template }))
    ],
    grep: async (input, requestOptions = {}) => {
      if (!enableGrep) {
        throw new ActiveFSError("UNSUPPORTED", "MCP grep is disabled for this adapter");
      }
      const remote = input.remote
        ? remoteByName.get(input.remote)
        : remotes[0];
      if (!remote) {
        throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS MCP remote: ${input.remote ?? ""}`);
      }
      const path = normalizeActiveFSPath(input.path ?? "/");
      const runtimePath = fromRemotePath(remote, path);
      const query: ActiveFSSearchQuery = {
        pattern: input.query,
        caseSensitive: input.caseSensitive,
        maxResults: input.limit,
        includeNonEnumerable: input.includeNonEnumerable
      };
      const request: ActiveFSMCPContextRequest = {
          operation: "grep",
          remote: remote.name,
          path
        };
      const context = await contextFor(request, requestOptions.context);
      if (
        options.authorizeGrep &&
        !(await options.authorizeGrep({ ...request, context }))
      ) {
        throw new ActiveFSError("FORBIDDEN", `ActiveFS MCP search is not authorized: ${remote.name}:${path}`);
      }
      const result = await options.filesystem.command(context, "grep", runtimePath, query);
      return {
        remote: remote.name,
        path,
        complete: result.complete,
        strategy: result.strategy,
        incompleteReasons: result.incompleteReasons,
        matches: result.matches.map((match) => {
          const remotePath = toRemotePath(remote, normalizeActiveFSPath(match.path));
          return {
            ...match,
            path: remotePath,
            uri: resourceUri(remote.name, remotePath)
          };
        })
      };
    }
  };

  return adapter;
}

function normalizeRemotes<Auth, Meta>(
  options: MCPAdapterOptions<Auth, Meta>
): NormalizedRemote[] {
  const remotes = options.remotes ?? [
    {
      name: options.remote ?? DEFAULT_REMOTE,
      rootPath: options.rootPath ?? "/"
    }
  ];
  if (remotes.length === 0) {
    throw new ActiveFSError("INVALID_REQUEST", "MCP adapter requires at least one remote");
  }
  return remotes.map((remote) => ({
    name: validateRemoteName(remote.name),
    rootPath: normalizeActiveFSPath(remote.rootPath ?? "/"),
    title: remote.title
  }));
}

function validateRemoteName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ActiveFSError("INVALID_REQUEST", `Invalid ActiveFS MCP remote name: ${name}`);
  }
  return name;
}

function parseActiveFSUri(
  uri: string,
  remoteByName: Map<string, NormalizedRemote>
): ParsedActiveFSUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new ActiveFSError("INVALID_PATH", `Invalid ActiveFS MCP URI: ${uri}`, {
      cause: error
    });
  }
  if (parsed.protocol !== "activefs:") {
    throw new ActiveFSError("INVALID_PATH", `Unsupported ActiveFS MCP URI scheme: ${uri}`);
  }
  const remoteName = decodeURIComponent(parsed.hostname);
  const remote = remoteByName.get(remoteName);
  if (!remote) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS MCP remote: ${remoteName}`);
  }
  return {
    remote,
    path: normalizeActiveFSPath(decodeURIComponent(parsed.pathname || "/"))
  };
}

function resourceFromStat(remote: NormalizedRemote, stat: ActiveFSStat): ActiveFSMCPResource {
  const remotePath = toRemotePath(remote, stat.path);
  return {
    uri: resourceUri(remote.name, remotePath),
    name: `${remote.name}:${remotePath}`,
    title: stat.path === remote.rootPath ? remote.title ?? remote.name : stat.name,
    mimeType: stat.mimeType,
    description: stat.kind
  };
}

function fromRemotePath(remote: NormalizedRemote, path: ActiveFSPath): ActiveFSPath {
  if (remote.rootPath === "/") {
    return path;
  }
  if (path === "/") {
    return remote.rootPath;
  }
  return normalizeActiveFSPath(`${remote.rootPath}/${path.slice(1)}`);
}

function toRemotePath(remote: NormalizedRemote, path: ActiveFSPath): ActiveFSPath {
  const normalizedPath = normalizeActiveFSPath(path);
  if (remote.rootPath === "/") {
    return normalizedPath;
  }
  if (normalizedPath === remote.rootPath) {
    return "/";
  }
  if (normalizedPath.startsWith(`${remote.rootPath}/`)) {
    return normalizeActiveFSPath(normalizedPath.slice(remote.rootPath.length));
  }
  return normalizedPath;
}

function resourceUri(remote: string, path: ActiveFSPath): string {
  return `activefs://${encodeURIComponent(remote)}${encodeURI(path)}`;
}

function contentPayload(
  content: string | Uint8Array,
  _mimeType: string | undefined
): Pick<ActiveFSMCPReadResourceContent, "text" | "blob"> {
  return typeof content === "string"
    ? { text: content }
    : { blob: Buffer.from(content).toString("base64") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * from "./auth.js";
export * from "./config.js";
export * from "./policy.js";
export * from "./prompts.js";
export * from "./schemas.js";
export * from "./server.js";
export * from "./subscriptions.js";
export * from "./tools.js";
export * from "./transports/http.js";
export * from "./transports/stdio.js";
export * from "./uri.js";
