import {
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSContext,
  type ActiveFSPath,
  type MaybePromise
} from "@activefs/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  LATEST_PROTOCOL_VERSION,
  McpError,
  ReadResourceRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type Resource,
  type ServerNotification,
  type ServerRequest
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  authContextForIdentity,
  stdioMCPIdentity,
  type ActiveFSMCPIdentity
} from "./auth.js";
import {
  normalizeActiveFSMCPServerConfig,
  type NormalizedActiveFSMCPServerConfig
} from "./config.js";
import {
  combinePolicies,
  createConfigPolicy,
  policyAllows,
  type ActiveFSMCPPolicy
} from "./policy.js";
import {
  getActiveFSMCPPrompt,
  listActiveFSMCPPrompts
} from "./prompts.js";
import type { ActiveFSMCPServerConfigFile } from "./schemas.js";
import { ActiveFSMCPSubscriptionManager } from "./subscriptions.js";
import {
  callActiveFSMCPTool,
  isActiveFSMCPToolEnabled,
  listActiveFSMCPTools
} from "./tools.js";
import {
  parseActiveFSMCPUri
} from "./uri.js";
import {
  createMCPAdapter,
  type ActiveFSMCPAdapter,
  type ActiveFSMCPRemote,
  type MCPAdapterOptions
} from "./index.js";

export const ACTIVEFS_MCP_PROTOCOL_VERSION = LATEST_PROTOCOL_VERSION;
export const ACTIVEFS_MCP_SUPPORTED_PROTOCOL_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS];

export interface ActiveFSMCPServerContextRequest {
  operation: string;
  remote: string;
  path: ActiveFSPath;
  identity: ActiveFSMCPIdentity;
  sessionId?: string;
  requestId?: string | number;
}

export type ActiveFSMCPServerContextProvider<Auth = unknown, Meta = unknown> = (
  request: ActiveFSMCPServerContextRequest
) => MaybePromise<ActiveFSContext<Auth, Meta>>;

export interface ActiveFSMCPServerOptions<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  remotes: ActiveFSMCPRemote[];
  config?: Partial<ActiveFSMCPServerConfigFile>;
  adapterOptions?: Partial<MCPAdapterOptions<Auth, Meta>>;
  policy?: ActiveFSMCPPolicy<Auth, Meta>;
  context?: ActiveFSContext<Auth, Meta> | ActiveFSMCPServerContextProvider<Auth, Meta>;
  identity?: ActiveFSMCPIdentity;
}

export interface ActiveFSMCPServerHandle<Auth = unknown, Meta = unknown> {
  server: Server;
  adapter: ActiveFSMCPAdapter<Auth, Meta>;
  filesystem: ActiveFS<Auth, Meta>;
  remotes: ActiveFSMCPRemote[];
  config: NormalizedActiveFSMCPServerConfig;
  subscriptions: ActiveFSMCPSubscriptionManager<Auth, Meta>;
  close(): Promise<void>;
}

export function createActiveFSMCPServer<Auth = unknown, Meta = unknown>(
  options: ActiveFSMCPServerOptions<Auth, Meta>
): ActiveFSMCPServerHandle<Auth, Meta> {
  const config = normalizeActiveFSMCPServerConfig(options.config);
  const policy = combinePolicies(createConfigPolicy(config) as ActiveFSMCPPolicy<Auth, Meta>, options.policy);
  const identityFallback = options.identity ?? stdioMCPIdentity();
  const supportsSubscriptions = config.subscriptions.enabled && options.remotes.some(remoteSupportsSubscriptions);
  const server = new Server(
    { name: config.name, version: config.version },
    {
      capabilities: {
        resources: {
          ...(supportsSubscriptions ? { subscribe: true, listChanged: true } : {})
        },
        tools: {},
        ...(config.prompts.enabled ? { prompts: {} } : {})
      },
      instructions: "Expose ActiveFS remotes as MCP resources and tools while keeping tree/provider authority inside ActiveFS."
    }
  );

  const contextFor = async (
    extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined,
    request: Omit<ActiveFSMCPServerContextRequest, "identity" | "sessionId" | "requestId">
  ): Promise<ActiveFSContext<Auth, Meta>> => {
    const identity = identityFromExtra(extra, identityFallback);
    const fullRequest: ActiveFSMCPServerContextRequest = {
      ...request,
      identity,
      sessionId: extra?.sessionId,
      requestId: extra?.requestId
    };
    const base = typeof options.context === "function"
      ? await options.context(fullRequest)
      : options.context ?? {};
    const baseMeta = isRecord(base.meta) ? base.meta : {};
    return {
      ...base,
      auth: base.auth ?? authContextForIdentity(identity) as Auth,
      meta: {
        ...baseMeta,
        adapter: "mcp-server",
        operation: request.operation,
        remote: request.remote,
        path: request.path,
        sessionId: extra?.sessionId
      } as Meta,
      signal: extra?.signal ?? base.signal
    };
  };

  const adapter = createMCPAdapter<Auth, Meta>({
    filesystem: options.filesystem,
    remotes: options.remotes,
    includeDirectories: config.resources.includeDirectories,
    maxDepth: config.resources.maxDepth,
    maxResources: config.resources.maxResources,
    resourceTemplates: options.adapterOptions?.resourceTemplates ?? options.remotes.map((remote) => ({
      name: `${remote.name} files`,
      title: `${remote.title ?? remote.name} files`,
      uriTemplate: `activefs://${remote.name}/{path}`,
      description: `Files exposed from the ${remote.name} ActiveFS remote.`
    })),
    authorizeResource: async (request) =>
      policyAllows(policy, "resource", {
        identity: identityFromContext(request.context),
        context: request.context,
        remote: request.remote,
        path: request.path,
        uri: request.uri,
        operation: request.operation === "listResources" ? "list" : "read"
      }),
    authorizeGrep: async (request) =>
      policyAllows(policy, "resource", {
        identity: identityFromContext(request.context),
        context: request.context,
        remote: request.remote,
        path: request.path,
        operation: "search"
      }),
    ...options.adapterOptions
  });

  const subscriptions = new ActiveFSMCPSubscriptionManager<Auth, Meta>({
    filesystem: options.filesystem,
    remotes: options.remotes,
    server,
    debounceMs: config.subscriptions.debounceMs
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request, extra) => {
    const context = await contextFor(extra, {
      operation: "resources/list",
      remote: "*",
      path: "/"
    });
    const result = await adapter.listResources({ context });
    return paginateResources(result.resources, config.resources.pageSize, request.params?.cursor);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra): Promise<ReadResourceResult> => {
    const parsed = parseActiveFSMCPUri(request.params.uri, options.remotes);
    const context = await contextFor(extra, {
      operation: "resources/read",
      remote: parsed.remote.name,
      path: parsed.path
    });
    return await adapter.readResource(request.params.uri, { context }) as ReadResourceResult;
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
    paginateTemplates(adapter.listResourceTemplates(), config.resources.pageSize, request.params?.cursor));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listActiveFSMCPTools(config.tools)
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    if (!isActiveFSMCPToolEnabled(request.params.name, config.tools)) {
      throw new McpError(ErrorCode.InvalidParams, `ActiveFS MCP tool is disabled or unknown: ${request.params.name}`);
    }
    return callActiveFSMCPTool(request.params.name, request.params.arguments, {
      filesystem: options.filesystem,
      adapter,
      remotes: options.remotes,
      pageSize: config.resources.pageSize,
      contextFor: (toolRequest) => contextFor(extra, {
        operation: `tools/${toolRequest.toolName}`,
        remote: toolRequest.remote,
        path: toolRequest.path
      }),
      authorizeTool: (toolRequest) =>
        policyAllows(policy, "tool", {
          identity: identityFromContext(toolRequest.context),
          context: toolRequest.context,
          remote: toolRequest.remote,
          path: toolRequest.path,
          operation: toolRequest.operation,
          toolName: toolRequest.toolName
        })
    });
  });

  if (config.prompts.enabled) {
    server.setRequestHandler(ListPromptsRequestSchema, () => ({
      prompts: listActiveFSMCPPrompts().map((prompt) => ({
        name: prompt.name,
        title: prompt.title,
        description: prompt.description,
        arguments: prompt.arguments
      }))
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
      const context = await contextFor(extra, {
        operation: "prompts/get",
        remote: typeof request.params.arguments?.remote === "string" ? request.params.arguments.remote : "*",
        path: typeof request.params.arguments?.path === "string"
          ? normalizePromptPath(request.params.arguments.path)
          : "/"
      });
      const allowed = await policyAllows(policy, "prompt", {
        identity: identityFromContext(context),
        context,
        remote: typeof request.params.arguments?.remote === "string" ? request.params.arguments.remote : undefined,
        path: typeof request.params.arguments?.path === "string"
          ? normalizePromptPath(request.params.arguments.path)
          : undefined,
        promptName: request.params.name
      });
      if (!allowed) {
        throw new McpError(ErrorCode.InvalidParams, `ActiveFS MCP prompt is not authorized: ${request.params.name}`);
      }
      return getActiveFSMCPPrompt(request.params.name, request.params.arguments);
    });
  }

  if (supportsSubscriptions) {
    server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
      const parsed = parseActiveFSMCPUri(request.params.uri, options.remotes);
      if (!remoteSupportsSubscriptions(parsed.remote)) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `ActiveFS MCP remote does not advertise subscription support: ${parsed.remote.name}`
        );
      }
      const context = await contextFor(extra, {
        operation: "resources/subscribe",
        remote: parsed.remote.name,
        path: parsed.path
      });
      const allowed = await policyAllows(policy, "subscribe", {
        identity: identityFromContext(context),
        context,
        remote: parsed.remote.name,
        path: parsed.path,
        uri: request.params.uri,
        operation: "subscribe"
      });
      if (!allowed) {
        throw new McpError(ErrorCode.InvalidParams, `ActiveFS MCP subscription is not authorized: ${request.params.uri}`);
      }
      await subscriptions.subscribe(request.params.uri, context);
      return {};
    });

    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      await subscriptions.unsubscribe(request.params.uri);
      return {};
    });
  }

  return {
    server,
    adapter,
    filesystem: options.filesystem,
    remotes: options.remotes,
    config,
    subscriptions,
    close: async () => {
      await subscriptions.close();
      await server.close();
    }
  };
}

function paginateResources(
  resources: Resource[],
  pageSize: number,
  cursor: string | undefined
): ListResourcesResult {
  const paged = paginate(resources, pageSize, cursor);
  return {
    resources: paged.items,
    nextCursor: paged.nextCursor
  };
}

function paginateTemplates(
  templates: Array<{ uriTemplate: string; name: string; title?: string; mimeType?: string; description?: string }>,
  pageSize: number,
  cursor: string | undefined
): ListResourceTemplatesResult {
  const paged = paginate(templates, pageSize, cursor);
  return {
    resourceTemplates: paged.items,
    nextCursor: paged.nextCursor
  };
}

function paginate<T>(items: T[], pageSize: number, cursor: string | undefined): {
  items: T[];
  nextCursor?: string;
} {
  const offset = cursor ? Number.parseInt(cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid pagination cursor: ${cursor}`);
  }
  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    items: page,
    nextCursor: nextOffset < items.length ? String(nextOffset) : undefined
  };
}

function identityFromExtra(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined,
  fallback: ActiveFSMCPIdentity
): ActiveFSMCPIdentity {
  if (extra?.authInfo) {
    return {
      subject: extra.authInfo.clientId || "http-client",
      transport: "http",
      scopes: extra.authInfo.scopes,
      clientId: extra.authInfo.clientId
    };
  }
  return fallback;
}

function identityFromContext(context: ActiveFSContext): ActiveFSMCPIdentity | undefined {
  const auth = context.auth;
  if (isRecord(auth) && isRecord(auth.mcp) && typeof auth.mcp.subject === "string") {
    return auth.mcp as unknown as ActiveFSMCPIdentity;
  }
  return undefined;
}

function remoteSupportsSubscriptions(remote: Pick<ActiveFSMCPRemote, "watchable">): boolean {
  return remote.watchable === true;
}

function normalizePromptPath(path: string): ActiveFSPath {
  return normalizeActiveFSPath(path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
