import { describe, expect, it } from "vitest";
import { createActiveFS } from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { startActiveFSMCPHttpServer } from "./http.js";

describe("startActiveFSMCPHttpServer", () => {
  it("serves a demo ActiveFS MCP server over authenticated Streamable HTTP", async () => {
    const token = "test-token";
    const handle = await startActiveFSMCPHttpServer({
      demo: true,
      host: "127.0.0.1",
      port: 0,
      auth: { mode: "bearer", token }
    });
    const client = new Client({ name: "activefs-mcp-http-test", version: "0.1.0" });
    try {
      const unauthorized = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      expect(unauthorized.status).toBe(401);

      await client.connect(new StreamableHTTPClientTransport(new URL(handle.url), {
        requestInit: {
          headers: { authorization: `Bearer ${token}` }
        }
      }));
      expect(client.getServerCapabilities()?.resources).toMatchObject({ subscribe: true });

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("activefs://demo/hello.md");

      const read = await client.readResource({ uri: "activefs://demo/hello.md" });
      const firstContent = read.contents[0];
      expect(firstContent && "text" in firstContent ? firstContent.text : undefined).toContain("Hello ActiveFS MCP");
    } finally {
      await client.close().catch(() => undefined);
      await handle.close();
    }
  });

  it("handles local HTTP errors and rejects unsafe network auth combinations", async () => {
    await expect(startActiveFSMCPHttpServer({
      demo: true,
      host: "0.0.0.0",
      port: 0
    })).rejects.toThrow("outside loopback");
    await expect(startActiveFSMCPHttpServer({
      demo: true,
      host: "0.0.0.0",
      port: 0,
      auth: { mode: "none", allowNetworkBind: true }
    })).rejects.toThrow("--auth none outside loopback");

    const handle = await startActiveFSMCPHttpServer({
      demo: true,
      host: "127.0.0.1",
      port: 0,
      endpoint: "mcp",
      auth: { mode: "none" }
    });
    try {
      expect(handle.endpoint).toBe("/mcp");
      expect(handle.auth.mode).toBe("none");
      expect(handle.sessionCount()).toBe(0);

      const missing = await fetch(handle.url.replace("/mcp", "/missing"));
      expect(missing.status).toBe(404);
      await expect(missing.text()).resolves.toBe("Not found");

      const encodedBackslash = await fetch(handle.url.replace("/mcp", "/%5C..%5Cmcp"));
      expect(encodedBackslash.status).toBe(404);
      await expect(encodedBackslash.text()).resolves.toBe("Not found");

      const method = await fetch(handle.url, { method: "PUT" });
      expect(method.status).toBe(405);
      expect(method.headers.get("allow")).toBe("GET, POST, DELETE");

      const noSession = await fetch(handle.url, { method: "GET" });
      expect(noSession.status).toBe(400);
      await expect(noSession.text()).resolves.toContain("No valid MCP session ID");

      const noInitialize = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(noInitialize.status).toBe(400);
      await expect(noInitialize.text()).resolves.toContain("initialize request required");

      const invalidJson = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      });
      expect(invalidJson.status).toBe(500);
      await expect(invalidJson.text()).resolves.toContain("Expected");

      const unsupportedProtocol = await fetch(handle.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "1900-01-01"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      });
      expect(unsupportedProtocol.status).toBe(400);
      await expect(unsupportedProtocol.text()).resolves.toContain("Unsupported MCP protocol version");
    } finally {
      await handle.close();
    }
  });

  it("keeps resource notifications scoped to the subscribed HTTP session", async () => {
    const filesystem = createActiveFS().mount("/demo", createMemoryTree({
      writable: true,
      watchable: true,
      searchable: true,
      files: { "/hello.md": "# Hello MCP\n" }
    }));
    const handle = await startActiveFSMCPHttpServer({
      filesystem,
      remotes: [{ name: "demo", rootPath: "/demo", watchable: true }],
      host: "127.0.0.1",
      port: 0,
      auth: { mode: "none" }
    });
    const clientA = new Client({ name: "activefs-mcp-http-a", version: "0.1.0" });
    const clientB = new Client({ name: "activefs-mcp-http-b", version: "0.1.0" });
    const notificationsA: string[] = [];
    const notificationsB: string[] = [];
    clientA.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      notificationsA.push(notification.params.uri);
    });
    clientB.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      notificationsB.push(notification.params.uri);
    });
    try {
      await clientA.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
      await clientB.connect(new StreamableHTTPClientTransport(new URL(handle.url)));

      await clientA.subscribeResource({ uri: "activefs://demo/hello.md" });
      await filesystem.write({}, "/demo/hello.md", "# Updated MCP\n", { overwrite: true });
      await waitFor(() => notificationsA.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(notificationsA).toContain("activefs://demo/hello.md");
      expect(notificationsB).toEqual([]);
      expect(handle.sessionCount()).toBe(2);
    } finally {
      await clientA.close().catch(() => undefined);
      await clientB.close().catch(() => undefined);
      await handle.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
