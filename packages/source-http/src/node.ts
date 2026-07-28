import { ActiveFSError, type ActiveFSTree, type MaybePromise } from "@activefs/core";
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createActiveFSSourceService } from "./service.js";
import {
  activeFSSourceCapabilities,
  type ActiveFSSourceContextResolver,
  type ActiveFSSourceEndpoints,
  type ActiveFSSourceHandshakeHints,
  type ActiveFSSourceOperation,
  type ActiveFSSourceOperationParams,
  type ActiveFSSourceService,
  type ActiveFSSourceServiceOptions,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeServiceCapabilities
} from "./protocol.js";

export type HttpSourceServerAuth =
  | false
  | { type?: "bearer"; token: string; realm?: string }
  | { type: "basic"; username: string; password: string; realm?: string }
  | ((request: IncomingMessage) => MaybePromise<boolean>);

export interface ActiveFSTreeHandshakeRequest<Auth = unknown, Meta = unknown> {
  request: IncomingMessage;
  tree: ActiveFSTree<Auth, Meta>;
  capabilities: ActiveFSTreeServiceCapabilities;
  defaultHandshake: ActiveFSTreeHandshake;
}

export type ActiveFSTreeHandshakeHints = ActiveFSSourceHandshakeHints;

export type ActiveFSTreeHandshakeOption<Auth = unknown, Meta = unknown> =
  | ActiveFSTreeHandshakeHints
  | ((request: ActiveFSTreeHandshakeRequest<Auth, Meta>) => MaybePromise<ActiveFSTreeHandshakeHints>);

export interface ActiveFSSourceNodeRoutes {
  handshake: string;
  capabilities: string;
  config: string;
  policy: string;
  changes: string;
  stat: string;
  list: string;
  read: string;
  search: string;
  command: string;
  write: string;
  delete: string;
  mkdir: string;
  rmdir: string;
  rename: string;
  copy: string;
  truncate: string;
  metadata: string;
  sessions: string;
  sessionEvents: string;
  sessionAck: string;
  sessionActivity: string;
  operationStatus: string;
}

export type ActiveFSTreeRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

export interface ActiveFSTreeServerOptions<Auth = unknown, Meta = unknown>
  extends Omit<
    ActiveFSSourceServiceOptions<Auth, Meta>,
    "endpoints" | "handshake" | "resourceLinks"
  > {
  auth?: HttpSourceServerAuth;
  routes?: Partial<ActiveFSSourceNodeRoutes>;
  handshake?: ActiveFSTreeHandshakeOption<Auth, Meta>;
}

export interface ActiveFSTreeServerStartOptions<Auth = unknown, Meta = unknown>
  extends ActiveFSTreeServerOptions<Auth, Meta> {
  hostname?: string;
  port?: number;
}

export interface ActiveFSTreeServerHandle {
  server: Server;
  /** Exact discovery URL to pass to `activefs remote add`. */
  url: string;
  close(): Promise<void>;
}

interface OperationBinding {
  operation: ActiveFSSourceOperation;
  template: string;
}

const DEFAULT_PREFIX = "/_activefs";

/** Default standalone Node routes. They are a helper choice, not protocol requirements. */
export function defaultActiveFSSourceNodeRoutes(prefix = DEFAULT_PREFIX): ActiveFSSourceNodeRoutes {
  const root = normalizeRoute(prefix);
  const child = (name: string): string => `${root}/${name}`;
  return {
    handshake: root,
    capabilities: child("capabilities"),
    config: child("config"),
    policy: child("policy"),
    changes: child("changes"),
    stat: child("stat"),
    list: child("list"),
    read: child("read"),
    search: child("search"),
    command: child("command"),
    write: child("write"),
    delete: child("delete"),
    mkdir: child("mkdir"),
    rmdir: child("rmdir"),
    rename: child("rename"),
    copy: child("copy"),
    truncate: child("truncate"),
    metadata: child("metadata"),
    sessions: child("sessions"),
    sessionEvents: child("sessions/:sessionId/events"),
    sessionAck: child("sessions/:sessionId/acks"),
    sessionActivity: child("sessions/:sessionId/activity"),
    operationStatus: child("operations/:operationId")
  };
}

/** Binds one trusted Source API operation to an arbitrary Node route. */
export function createActiveFSSourceNodeHandler(
  service: ActiveFSSourceService,
  operation: ActiveFSSourceOperation,
  params?: ActiveFSSourceOperationParams,
  auth?: HttpSourceServerAuth
): ActiveFSTreeRequestHandler {
  return async (request, response) => {
    try {
      if (!(await authorizeNodeRequest(request, auth))) {
        await writeWebResponse(response, unauthorizedResponse(auth));
        return;
      }
      const webRequest = await nodeRequestToWebRequest(request, response);
      await writeWebResponse(response, await service.handle(operation, webRequest, params));
    } catch (error) {
      await writeWebResponse(response, nodeAdapterErrorResponse(error));
    }
  };
}

/** Creates the existing all-in-one Node handler over explicitly configurable routes. */
export function createActiveFSTreeServer<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeServerOptions<Auth, Meta>
): ActiveFSTreeRequestHandler {
  const routes = { ...defaultActiveFSSourceNodeRoutes(), ...options.routes };
  const capabilities = activeFSSourceCapabilities(options.tree);
  const nodeRequests = new WeakMap<Request, IncomingMessage>();
  const service = createActiveFSSourceService<Auth, Meta>({
    tree: options.tree,
    endpoints: endpointsForRoutes(routes, capabilities),
    resolveContext: options.resolveContext,
    eventSigningSecret: options.eventSigningSecret,
    maxRequestBodyBytes: options.maxRequestBodyBytes,
    maxRetainedOperationStatuses: options.maxRetainedOperationStatuses,
    maxRetainedIdempotencyRecords: options.maxRetainedIdempotencyRecords,
    maxRetainedChanges: options.maxRetainedChanges,
    maxRetainedSessions: options.maxRetainedSessions,
    maxRetainedSessionEvents: options.maxRetainedSessionEvents,
    maxSessionActivityBacklog: options.maxSessionActivityBacklog,
    maxRetainedIsolationScopes: options.maxRetainedIsolationScopes,
    resourceLinks: {
      session: ({ sessionId }) => ({
        eventEndpoint: fillRoute(routes.sessionEvents, { sessionId }),
        ackEndpoint: fillRoute(routes.sessionAck, { sessionId }),
        activityEndpoint: fillRoute(routes.sessionActivity, { sessionId })
      }),
      operationStatus: ({ operationId }) => fillRoute(routes.operationStatus, { operationId })
    },
    handshake: async (input) => {
      const nodeRequest = nodeRequests.get(input.request);
      if (!nodeRequest) {
        throw new ActiveFSError("SOURCE_ERROR", "Node Source API handshake request was not available");
      }
      const hints = typeof options.handshake === "function"
        ? await options.handshake({
          request: nodeRequest,
          tree: options.tree,
          capabilities: input.capabilities,
          defaultHandshake: withNodeAuthHints(input.defaultHandshake, options.auth)
        })
        : options.handshake;
      return {
        ...hints,
        auth: hints?.auth ?? withNodeAuthHints(input.defaultHandshake, options.auth).auth
      };
    }
  });
  const bindings = operationBindings(routes);

  return async (request, response) => {
    try {
      if (!(await authorizeNodeRequest(request, options.auth))) {
        await writeWebResponse(response, unauthorizedResponse(options.auth));
        return;
      }
      const pathname = new URL(request.url ?? "/", "http://activefs.local").pathname;
      const match = matchBinding(bindings, pathname);
      if (!match) {
        await writeWebResponse(response, nodeAdapterErrorResponse(new ActiveFSError("NOT_FOUND", `Unknown Source API route: ${pathname}`)));
        return;
      }
      const webRequest = await nodeRequestToWebRequest(request, response);
      nodeRequests.set(webRequest, request);
      await writeWebResponse(response, await service.handle(match.operation, webRequest, match.params));
    } catch (error) {
      await writeWebResponse(response, nodeAdapterErrorResponse(error));
    }
  };
}

/** Starts the standalone Node helper and returns its exact discovery URL. */
export async function startActiveFSServer<Auth = unknown, Meta = unknown>(
  options: ActiveFSTreeServerStartOptions<Auth, Meta>
): Promise<ActiveFSTreeServerHandle> {
  const hostname = options.hostname ?? "127.0.0.1";
  const routes = { ...defaultActiveFSSourceNodeRoutes(), ...options.routes };
  const server = createServer(createActiveFSTreeServer({ ...options, routes }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const discoveryPath = options.routes?.handshake ?? `${routes.handshake}/`;
  return {
    server,
    url: `http://${formatHostname(hostname)}:${port}${discoveryPath}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function endpointsForRoutes(
  routes: ActiveFSSourceNodeRoutes,
  capabilities: ActiveFSTreeServiceCapabilities
): ActiveFSSourceEndpoints {
  return {
    stat: routes.stat,
    list: routes.list,
    read: routes.read,
    command: routes.command,
    ...(capabilities.searchable ? { search: routes.search } : {}),
    ...(capabilities.mutable.write ? { write: routes.write } : {}),
    ...(capabilities.mutable.delete ? { delete: routes.delete } : {}),
    ...(capabilities.mutable.mkdir ? { mkdir: routes.mkdir } : {}),
    ...(capabilities.mutable.rmdir ? { rmdir: routes.rmdir } : {}),
    ...(capabilities.mutable.rename ? { rename: routes.rename } : {}),
    ...(capabilities.mutable.copy ? { copy: routes.copy } : {}),
    ...(capabilities.mutable.truncate ? { truncate: routes.truncate } : {}),
    ...(capabilities.mutable.updateMetadata ? { metadata: routes.metadata } : {}),
    sessions: routes.sessions,
    changes: routes.changes,
    capabilities: routes.capabilities,
    config: routes.config,
    policy: routes.policy
  };
}

function operationBindings(routes: ActiveFSSourceNodeRoutes): OperationBinding[] {
  return [
    { operation: "handshake", template: routes.handshake },
    { operation: "capabilities", template: routes.capabilities },
    { operation: "config", template: routes.config },
    { operation: "policy", template: routes.policy },
    { operation: "changes", template: routes.changes },
    { operation: "stat", template: routes.stat },
    { operation: "list", template: routes.list },
    { operation: "read", template: routes.read },
    { operation: "search", template: routes.search },
    { operation: "command", template: routes.command },
    { operation: "write", template: routes.write },
    { operation: "delete", template: routes.delete },
    { operation: "mkdir", template: routes.mkdir },
    { operation: "rmdir", template: routes.rmdir },
    { operation: "rename", template: routes.rename },
    { operation: "copy", template: routes.copy },
    { operation: "truncate", template: routes.truncate },
    { operation: "metadata", template: routes.metadata },
    { operation: "createSession", template: routes.sessions },
    { operation: "sessionEvents", template: routes.sessionEvents },
    { operation: "sessionAck", template: routes.sessionAck },
    { operation: "sessionActivity", template: routes.sessionActivity },
    { operation: "operationStatus", template: routes.operationStatus }
  ];
}

function matchBinding(
  bindings: OperationBinding[],
  pathname: string
): { operation: ActiveFSSourceOperation; params: ActiveFSSourceOperationParams } | undefined {
  for (const binding of bindings) {
    const names: string[] = [];
    const expression = new RegExp(`^${binding.template
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          names.push(segment.slice(1));
          return "([^/]+)";
        }
        return escapeRegExp(segment);
      })
      .join("/")}/?$`);
    const match = expression.exec(pathname);
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]));
    return {
      operation: binding.operation,
      params: {
        sessionId: values.sessionId,
        operationId: values.operationId
      }
    };
  }
  return undefined;
}

async function nodeRequestToWebRequest(request: IncomingMessage, response: ServerResponse): Promise<Request> {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => controller.abort());
  const method = request.method ?? "GET";
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : Readable.toWeb(request) as ReadableStream<Uint8Array>;
  const host = request.headers.host ?? "activefs.local";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method,
    headers: nodeHeaders(request),
    body,
    signal: controller.signal,
    ...(body ? { duplex: "half" } : {})
  } as RequestInit & { duplex?: "half" });
}

function nodeHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function writeWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  if (response.headersSent) return;
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    }
    response.end();
  } catch (error) {
    if (!response.destroyed) response.destroy(error as Error);
  } finally {
    reader.releaseLock();
  }
}

async function authorizeNodeRequest(request: IncomingMessage, auth: HttpSourceServerAuth | undefined): Promise<boolean> {
  if (!auth) return true;
  if (typeof auth === "function") return auth(request);
  if (auth.type === "basic") {
    return request.headers.authorization === `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
  }
  return request.headers.authorization === `Bearer ${auth.token}`;
}

function unauthorizedResponse(auth: HttpSourceServerAuth | undefined): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  const realm = typeof auth === "object" && auth.realm ? auth.realm : "ActiveFS";
  if (typeof auth === "object") {
    headers.set("www-authenticate", auth.type === "basic" ? `Basic realm="${realm}"` : `Bearer realm="${realm}"`);
  }
  return new Response(`${JSON.stringify({
    error: {
      name: "ActiveFSPermissionDeniedError",
      code: "PERMISSION_DENIED",
      internalCode: "UNAUTHORIZED",
      message: "Unauthorized Source API service request"
    }
  })}\n`, { status: 403, headers });
}

function nodeAdapterErrorResponse(error: unknown): Response {
  const activeError = error instanceof ActiveFSError
    ? error
    : new ActiveFSError("SOURCE_ERROR", "Node Source API adapter failed", { cause: error });
  const publicMessage = activeError.code === "SOURCE_ERROR"
    ? "Node Source API adapter failed"
    : activeError.code === "UNAUTHORIZED"
      ? "Unauthorized Source API service request"
      : activeError.message;
  const status = activeError.code === "NOT_FOUND" ? 404
    : activeError.code === "UNSUPPORTED" ? 405
      : activeError.code === "INVALID_REQUEST" || activeError.code === "INVALID_PATH" ? 400
        : 500;
  return new Response(`${JSON.stringify({
    error: {
      name: activeError.code === "NOT_FOUND" ? "ActiveFSNotFoundError" : "ActiveFSInternalError",
      code: activeError.code === "NOT_FOUND" ? "NOT_FOUND" : "INTERNAL_ERROR",
      internalCode: activeError.code,
      message: publicMessage,
      path: activeError.path
    }
  })}\n`, { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function withNodeAuthHints(handshake: ActiveFSTreeHandshake, auth: HttpSourceServerAuth | undefined): ActiveFSTreeHandshake {
  return {
    ...handshake,
    auth: !auth
      ? handshake.auth
      : typeof auth === "function"
        ? { required: true, schemes: ["custom"] }
        : { required: true, schemes: [auth.type === "basic" ? "basic" : "bearer"] }
  };
}

function fillRoute(template: string, values: Record<string, string>): string {
  return template.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, name: string) => {
    const value = values[name];
    if (!value) throw new ActiveFSError("INVALID_PATH", `Missing Source API route value: ${name}`);
    return encodeURIComponent(value);
  });
}

function normalizeRoute(route: string): string {
  const normalized = `/${route}`.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || "/";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatHostname(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}
