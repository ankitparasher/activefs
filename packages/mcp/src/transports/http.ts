import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as NodeHttpServer,
  type ServerResponse
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  authenticateHttpRequest,
  tokenFromConfig,
  writeHttpAuthError,
  type ActiveFSMCPAuthConfig,
  type ActiveFSMCPIdentity
} from "../auth.js";
import {
  loadActiveFSMCPConfig,
  type LoadActiveFSMCPConfigOptions
} from "../config.js";
import type { ActiveFSMCPPolicy } from "../policy.js";
import {
  ACTIVEFS_MCP_SUPPORTED_PROTOCOL_VERSIONS,
  createActiveFSMCPServer,
  type ActiveFSMCPServerContextProvider,
  type ActiveFSMCPServerHandle
} from "../server.js";

export interface ActiveFSMCPHttpServerOptions<Auth = unknown, Meta = unknown>
  extends LoadActiveFSMCPConfigOptions<Auth, Meta> {
  host?: string;
  port?: number;
  endpoint?: string;
  auth?: ActiveFSMCPAuthConfig;
  context?: ActiveFSMCPServerContextProvider<Auth, Meta>;
  policy?: ActiveFSMCPPolicy<Auth, Meta>;
}

export interface ActiveFSMCPHttpServerHandle<Auth = unknown, Meta = unknown> {
  url: string;
  host: string;
  port: number;
  endpoint: string;
  auth: ActiveFSMCPAuthConfig & { mode: "bearer" | "none"; token?: string };
  server: NodeHttpServer;
  close(): Promise<void>;
  sessionCount(): number;
}

interface HttpSession<Auth = unknown, Meta = unknown> {
  transport: StreamableHTTPServerTransport;
  handle: ActiveFSMCPServerHandle<Auth, Meta>;
}

export async function startActiveFSMCPHttpServer<Auth = unknown, Meta = unknown>(
  options: ActiveFSMCPHttpServerOptions<Auth, Meta> = {}
): Promise<ActiveFSMCPHttpServerHandle<Auth, Meta>> {
  const loaded = await loadActiveFSMCPConfig(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const endpoint = normalizeEndpoint(options.endpoint ?? "/mcp");
  const configuredAuth = {
    ...loaded.config.auth,
    ...options.auth
  };
  const auth = normalizeHttpAuth(configuredAuth, host);
  const token = auth.mode === "bearer"
    ? tokenFromConfig(auth) ?? randomUUID()
    : undefined;
  const sessions = new Map<string, HttpSession<Auth, Meta>>();

  const httpServer = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${actualPort(httpServer, port)}`}`);
      if (url.pathname !== endpoint) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const authResult = authenticateHttpRequest(request, {
        auth,
        token: token ?? "",
        host,
        port: actualPort(httpServer, port)
      });
      if (!authResult.ok) {
        writeHttpAuthError(response, authResult);
        return;
      }
      const protocolVersionError = unsupportedProtocolVersionError(request);
      if (protocolVersionError) {
        writeJsonError(response, 400, protocolVersionError);
        return;
      }
      const authedRequest = request as IncomingMessage & { auth?: AuthInfo };
      authedRequest.auth = {
        token: authResult.token,
        clientId: authResult.identity.clientId ?? authResult.identity.subject,
        scopes: authResult.identity.scopes ?? [],
        extra: { activefsMCPIdentity: authResult.identity }
      };

      if (request.method === "POST") {
        await handlePost({
          request: authedRequest,
          response,
          sessions,
          identity: authResult.identity,
          loaded,
          context: options.context,
          policy: options.policy
        });
        return;
      }

      if (request.method === "GET" || request.method === "DELETE") {
        const session = sessionForRequest(request, sessions);
        if (!session) {
          writeJsonError(response, 400, "Bad Request: No valid MCP session ID provided.");
          return;
        }
        await session.transport.handleRequest(authedRequest, response);
        return;
      }

      response.statusCode = 405;
      response.setHeader("allow", "GET, POST, DELETE");
      response.end("Method not allowed");
    } catch (error) {
      if (!response.headersSent) {
        writeJsonError(response, 500, error instanceof Error ? error.message : String(error));
      } else {
        response.end();
      }
    }
  });

  await listen(httpServer, host, port);
  const boundPort = actualPort(httpServer, port);
  return {
    url: `http://${host}:${boundPort}${endpoint}`,
    host,
    port: boundPort,
    endpoint,
    auth: token ? { ...auth, token } : auth,
    server: httpServer,
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.handle.close()));
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    },
    sessionCount: () => sessions.size
  };
}

async function handlePost<Auth, Meta>(request: {
  request: IncomingMessage & { auth?: AuthInfo };
  response: ServerResponse;
  sessions: Map<string, HttpSession<Auth, Meta>>;
  identity: ActiveFSMCPIdentity;
  loaded: Awaited<ReturnType<typeof loadActiveFSMCPConfig<Auth, Meta>>>;
  context?: ActiveFSMCPServerContextProvider<Auth, Meta>;
  policy?: ActiveFSMCPPolicy<Auth, Meta>;
}): Promise<void> {
  const body = await readJsonBody(request.request);
  const existing = sessionForRequest(request.request, request.sessions);
  if (existing) {
    await existing.transport.handleRequest(request.request, request.response, body);
    return;
  }

  if (!isInitializeRequest(body)) {
    writeJsonError(request.response, 400, "Bad Request: initialize request required for new MCP sessions.");
    return;
  }

  let transport: StreamableHTTPServerTransport;
  const handle = createActiveFSMCPServer<Auth, Meta>({
    filesystem: request.loaded.filesystem,
    remotes: request.loaded.remotes,
    config: {
      ...request.loaded.config,
      auth: { ...request.loaded.config.auth, mode: "bearer" }
    },
    adapterOptions: request.loaded.adapterOptions,
    identity: request.identity,
    context: request.context,
    policy: request.policy
  });
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      request.sessions.set(sessionId, { transport, handle });
    },
    onsessionclosed: async (sessionId) => {
      const session = request.sessions.get(sessionId);
      request.sessions.delete(sessionId);
      await session?.handle.close();
    }
  });
  await handle.server.connect(transport);
  await transport.handleRequest(request.request, request.response, body);
}

function sessionForRequest<Auth, Meta>(
  request: IncomingMessage,
  sessions: Map<string, HttpSession<Auth, Meta>>
): HttpSession<Auth, Meta> | undefined {
  const sessionId = request.headers["mcp-session-id"];
  return typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

function normalizeHttpAuth(
  auth: ActiveFSMCPAuthConfig | undefined,
  host: string
): ActiveFSMCPAuthConfig & { mode: "bearer" | "none" } {
  const mode = auth?.mode === "none" ? "none" : "bearer";
  const loopback = isLoopbackHost(host);
  if (!loopback && !auth?.allowNetworkBind) {
    throw new Error("Refusing to bind ActiveFS MCP HTTP outside loopback without --allow-network-bind.");
  }
  if (mode === "none" && !loopback && !auth?.allowInsecureHttp) {
    throw new Error("Refusing --auth none outside loopback without --allow-insecure-http.");
  }
  return {
    ...auth,
    mode,
    allowInsecureHttp: auth?.allowInsecureHttp ?? false,
    allowNetworkBind: auth?.allowNetworkBind ?? false
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function actualPort(server: NodeHttpServer, fallback: number): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : fallback;
}

function unsupportedProtocolVersionError(request: IncomingMessage): string | undefined {
  const protocolVersion = headerValue(request.headers["mcp-protocol-version"]);
  if (!protocolVersion || ACTIVEFS_MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return undefined;
  }
  return `Bad Request: Unsupported MCP protocol version: ${protocolVersion}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function listen(server: NodeHttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function writeJsonError(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: status === 400 ? -32600 : -32603,
      message
    },
    id: null
  }));
}
