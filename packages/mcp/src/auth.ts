import type { MaybePromise } from "@activefs/core";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type ActiveFSMCPTransportKind = "stdio" | "http" | "programmatic";

export interface ActiveFSMCPIdentity {
  subject: string;
  transport: ActiveFSMCPTransportKind;
  scopes?: string[];
  clientId?: string;
}

export interface ActiveFSMCPAuthRequest {
  transport: ActiveFSMCPTransportKind;
  token?: string;
  env?: Record<string, string | undefined>;
}

export type ActiveFSMCPAuthProvider = (
  request: ActiveFSMCPAuthRequest
) => MaybePromise<ActiveFSMCPIdentity | null>;

export interface ActiveFSMCPAuthConfig {
  mode?: "stdio" | "bearer" | "none";
  token?: string;
  tokenEnv?: string;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  allowInsecureHttp?: boolean;
  allowNetworkBind?: boolean;
}

export type ActiveFSMCPHttpAuthResult = {
  ok: true;
  identity: ActiveFSMCPIdentity;
  token: string;
} | {
  ok: false;
  status: 401 | 403;
  message: string;
  wwwAuthenticate?: string;
};

export function stdioMCPIdentity(subject = "local-stdio"): ActiveFSMCPIdentity {
  return { subject, transport: "stdio", scopes: ["local"] };
}

export function authContextForIdentity(identity: ActiveFSMCPIdentity): {
  mcp: ActiveFSMCPIdentity;
} {
  return { mcp: identity };
}

export function tokenFromConfig(
  config: ActiveFSMCPAuthConfig | undefined,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (config?.token) {
    return config.token;
  }
  if (config?.tokenEnv) {
    return env[config.tokenEnv];
  }
  return undefined;
}

export function authenticateHttpRequest(request: IncomingMessage, options: {
  auth: ActiveFSMCPAuthConfig;
  token: string;
  host: string;
  port: number;
}): ActiveFSMCPHttpAuthResult {
  const hostHeader = headerValue(request.headers.host);
  if (!isAllowedHost(hostHeader, options)) {
    return { ok: false, status: 403, message: "Forbidden host header." };
  }

  const origin = headerValue(request.headers.origin);
  if (origin && !isAllowedOrigin(origin, options)) {
    return { ok: false, status: 403, message: "Forbidden origin." };
  }

  if (options.auth.mode === "none") {
    return {
      ok: true,
      token: "",
      identity: { subject: "local-http", transport: "http", scopes: ["local"] }
    };
  }

  const authorization = headerValue(request.headers.authorization);
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  if (!token || !constantTimeEqual(token, options.token)) {
    return {
      ok: false,
      status: 401,
      message: "Unauthorized.",
      wwwAuthenticate: "Bearer realm=\"ActiveFS MCP\""
    };
  }

  return {
    ok: true,
    token,
    identity: {
      subject: "bearer-token",
      transport: "http",
      scopes: ["local"],
      clientId: "local-http-client"
    }
  };
}

export function writeHttpAuthError(response: ServerResponse, result: Exclude<ActiveFSMCPHttpAuthResult, { ok: true }>): void {
  response.statusCode = result.status;
  response.setHeader("content-type", "application/json");
  if (result.wwwAuthenticate) {
    response.setHeader("www-authenticate", result.wwwAuthenticate);
  }
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: result.status === 401 ? -32001 : -32003,
      message: result.message
    },
    id: null
  }));
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

function isAllowedHost(hostHeader: string | undefined, options: {
  auth: ActiveFSMCPAuthConfig;
  host: string;
  port: number;
}): boolean {
  if (!hostHeader) {
    return false;
  }
  const allowed = options.auth.allowedHosts ?? defaultAllowedHosts(options.host, options.port);
  return allowed.includes(hostHeader);
}

function isAllowedOrigin(origin: string, options: {
  auth: ActiveFSMCPAuthConfig;
  host: string;
  port: number;
}): boolean {
  const allowed = options.auth.allowedOrigins ?? defaultAllowedOrigins(options.host, options.port);
  return allowed.includes(origin);
}

function defaultAllowedHosts(host: string, port: number): string[] {
  const values = new Set<string>([
    `${host}:${port}`,
    host,
    `127.0.0.1:${port}`,
    "127.0.0.1",
    `localhost:${port}`,
    "localhost",
    `[::1]:${port}`,
    "::1"
  ]);
  return [...values];
}

function defaultAllowedOrigins(host: string, port: number): string[] {
  return [
    `http://${host}:${port}`,
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`
  ];
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
    return false;
  }
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
