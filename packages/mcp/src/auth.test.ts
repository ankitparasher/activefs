import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import {
  authenticateHttpRequest,
  authContextForIdentity,
  redactSecret,
  stdioMCPIdentity,
  tokenFromConfig
} from "@activefs/mcp";

describe("ActiveFS MCP auth", () => {
  it("authenticates loopback bearer requests without leaking tokens", () => {
    const request = fakeRequest({
      host: "127.0.0.1:8765",
      authorization: "Bearer dev-token",
      origin: "http://127.0.0.1:8765"
    });

    const result = authenticateHttpRequest(request, {
      auth: { mode: "bearer" },
      token: "dev-token",
      host: "127.0.0.1",
      port: 8765
    });

    expect(result).toMatchObject({
      ok: true,
      identity: { transport: "http", subject: "bearer-token" }
    });
    expect(redactSecret("dev-token")).toBe("de...en");
  });

  it("rejects missing tokens and unexpected origins", () => {
    const missing = authenticateHttpRequest(fakeRequest({ host: "127.0.0.1:8765" }), {
      auth: { mode: "bearer" },
      token: "dev-token",
      host: "127.0.0.1",
      port: 8765
    });
    expect(missing).toMatchObject({ ok: false, status: 401 });

    const badOrigin = authenticateHttpRequest(fakeRequest({
      host: "127.0.0.1:8765",
      authorization: "Bearer dev-token",
      origin: "http://evil.example"
    }), {
      auth: { mode: "bearer" },
      token: "dev-token",
      host: "127.0.0.1",
      port: 8765
    });
    expect(badOrigin).toMatchObject({ ok: false, status: 403 });
  });

  it("handles auth modes, host validation, token sources, and redaction edge cases", () => {
    expect(tokenFromConfig({ token: "direct", tokenEnv: "TOKEN" }, { TOKEN: "env" })).toBe("direct");
    expect(tokenFromConfig({ tokenEnv: "TOKEN" }, { TOKEN: "env" })).toBe("env");
    expect(tokenFromConfig(undefined, {})).toBeUndefined();
    expect(stdioMCPIdentity()).toEqual({ subject: "local-stdio", transport: "stdio", scopes: ["local"] });
    expect(redactSecret(undefined)).toBeUndefined();
    expect(redactSecret("abc")).toBe("****");

    const noHost = authenticateHttpRequest(fakeRequest({ authorization: "Bearer dev-token" }), {
      auth: { mode: "bearer" },
      token: "dev-token",
      host: "127.0.0.1",
      port: 8765
    });
    expect(noHost).toMatchObject({ ok: false, status: 403 });

    const wrongTokenLength = authenticateHttpRequest(fakeRequest({
      host: "127.0.0.1:8765",
      authorization: "Bearer x"
    }), {
      auth: { mode: "bearer" },
      token: "dev-token",
      host: "127.0.0.1",
      port: 8765
    });
    expect(wrongTokenLength).toMatchObject({ ok: false, status: 401 });

    const noAuth = authenticateHttpRequest(fakeRequest({
      host: "custom.test",
      origin: "http://custom.test"
    }), {
      auth: {
        mode: "none",
        allowedHosts: ["custom.test"],
        allowedOrigins: ["http://custom.test"]
      },
      token: "",
      host: "127.0.0.1",
      port: 8765
    });
    expect(noAuth).toMatchObject({
      ok: true,
      identity: { subject: "local-http", transport: "http" }
    });
  });

  it("maps identity into opaque ActiveFS auth", () => {
    expect(authContextForIdentity({ subject: "alice", transport: "stdio" })).toEqual({
      mcp: { subject: "alice", transport: "stdio" }
    });
  });
});

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.headers = headers;
  return request;
}
