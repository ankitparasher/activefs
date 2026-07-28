import { describe, expect, it, vi } from "vitest";
import { createActiveFS, type ActiveFS, type ActiveFSPath, type ActiveFSTree } from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  activefsMCPToolInputSchemas,
  ActiveFSMCPSubscriptionManager,
  createActiveFSMCPServer,
  getActiveFSMCPPrompt,
  type ActiveFSMCPRemote,
  type ActiveFSMCPServerHandle
} from "@activefs/mcp";

describe("createActiveFSMCPServer", () => {
  it("negotiates capabilities and serves resources, templates, tools, and prompts", async () => {
    const { client, handle } = await connectTestServer();
    try {
      expect(client.getServerCapabilities()).toMatchObject({
        resources: { subscribe: true, listChanged: true }
      });
      expect(client.getServerCapabilities()?.tools?.listChanged).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts?.listChanged).toBeUndefined();

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([
        "activefs://demo/",
        "activefs://demo/hello.md",
        "activefs://demo/notes",
        "activefs://demo/notes/today.txt"
      ]);

      await expect(client.readResource({ uri: "activefs://demo/hello.md" })).resolves.toMatchObject({
        contents: [{ uri: "activefs://demo/hello.md", text: "# Hello MCP\n" }]
      });

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates[0]).toMatchObject({
        name: "demo files",
        uriTemplate: "activefs://demo/{path}"
      });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "activefs_grep",
        "activefs_list",
        "activefs_read",
        "activefs_stat"
      ]);

      const grep = await client.callTool({
        name: "activefs_grep",
        arguments: { remote: "demo", path: "/", query: "MCP" }
      });
      expect(grep.isError).not.toBe(true);
      expect(grep.structuredContent).toMatchObject({
        remote: "demo",
        complete: true
      });

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("activefs_search_then_read");
      const prompt = await client.getPrompt({
        name: "activefs_investigate_path",
        arguments: { remote: "demo", path: "/hello.md" }
      });
      expect(prompt.messages[0]?.content).toMatchObject({
        type: "text",
        text: expect.stringContaining("activefs_stat")
      });
    } finally {
      await closeClient(client, handle);
    }
  });

  it("paginates resource lists and omits disabled mutating tools", async () => {
    const { client, handle } = await connectTestServer({
      config: {
        resources: { pageSize: 2 },
        tools: { write: false, rm: false }
      }
    });
    try {
      const first = await client.listResources();
      expect(first.resources).toHaveLength(2);
      expect(first.nextCursor).toBe("2");
      const second = await client.listResources({ cursor: first.nextCursor });
      expect(second.resources.map((resource) => resource.uri)).toContain("activefs://demo/notes/today.txt");

      const tools = await client.listTools();
      expect(tools.tools.some((tool) => tool.name === "activefs_write")).toBe(false);
      await expect(client.callTool({
        name: "activefs_write",
        arguments: { remote: "demo", path: "/new.txt", text: "no" }
      })).rejects.toThrow("disabled or unknown");
    } finally {
      await closeClient(client, handle);
    }
  });

  it("gates resources before touching unauthorized trees", async () => {
    let readCount = 0;
    const inner = createMemoryTree({ files: { "/secret.txt": "secret" } });
    const tree: ActiveFSTree = {
      ...inner,
      read: async (context, path, options) => {
        readCount += 1;
        return inner.read(context, path, options);
      }
    };
    const fs = createActiveFS().mount("/secure", tree);
    const { client, handle } = await connectTestServer({
      filesystem: fs,
      rootPath: "/secure",
      config: {
        authorization: {
          default: "allow",
          remotes: {
            demo: { read: false }
          }
        }
      }
    });
    try {
      await expect(client.readResource({ uri: "activefs://demo/secret.txt" })).rejects.toThrow();
      expect(readCount).toBe(0);
    } finally {
      await closeClient(client, handle);
    }
  });

  it("sends resource update notifications only for subscribed resources", async () => {
    const tree = createMemoryTree({
      writable: true,
      watchable: true,
      searchable: true,
      files: { "/hello.md": "# Hello MCP\n" }
    });
    const fs = createActiveFS().mount("/demo", tree);
    const { client, handle } = await connectTestServer({
      filesystem: fs,
      remote: { name: "demo", rootPath: "/demo", watchable: true }
    });
    const notifications: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      notifications.push(notification.params.uri);
    });
    try {
      await client.subscribeResource({ uri: "activefs://demo/hello.md" });
      await fs.write({}, "/demo/hello.md", "# Updated MCP\n", { overwrite: true });
      await waitFor(() => notifications.length > 0);
      expect(notifications).toContain("activefs://demo/hello.md");
      await client.unsubscribeResource({ uri: "activefs://demo/hello.md" });
    } finally {
      await closeClient(client, handle);
    }
  });

  it("omits subscription capabilities for remotes without known watch support", async () => {
    const fs = createActiveFS().mount("/demo", createMemoryTree({
      files: { "/hello.md": "# Hello MCP\n" },
      watchable: false
    }));
    const { client, handle } = await connectTestServer({
      filesystem: fs,
      remote: { name: "demo", rootPath: "/demo", watchable: false }
    });
    try {
      expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
      expect(client.getServerCapabilities()?.resources?.listChanged).toBeUndefined();
      await expect(client.subscribeResource({ uri: "activefs://demo/hello.md" })).rejects.toThrow();
    } finally {
      await closeClient(client, handle);
    }
  });

  it("exports runtime validation schemas", () => {
    expect(activefsMCPToolInputSchemas.activefs_grep.parse({ query: "needle" })).toMatchObject({
      path: "/",
      query: "needle"
    });
    expect(activefsMCPToolInputSchemas.activefs_read.parse({
      uri: "activefs://demo/hello.md",
      encoding: "base64"
    })).toMatchObject({
      uri: "activefs://demo/hello.md",
      encoding: "base64"
    });
    expect(activefsMCPToolInputSchemas.activefs_write.parse({
      uri: "activefs://demo/blob.bin",
      blob: "aGVsbG8=",
      overwrite: false
    })).toMatchObject({
      uri: "activefs://demo/blob.bin",
      blob: "aGVsbG8=",
      overwrite: false
    });
    expect(activefsMCPToolInputSchemas.activefs_rm.parse({
      uri: "activefs://demo/old.txt"
    })).toMatchObject({
      uri: "activefs://demo/old.txt"
    });
    expect(activefsMCPToolInputSchemas.activefs_mv.parse({
      fromUri: "activefs://demo/old.txt",
      toPath: "/new.txt"
    })).toMatchObject({
      fromUri: "activefs://demo/old.txt",
      toPath: "/new.txt"
    });
    expect(activefsMCPToolInputSchemas.activefs_cp.parse({
      fromUri: "activefs://demo/source.txt",
      toPath: "/copy.txt"
    })).toMatchObject({
      fromUri: "activefs://demo/source.txt",
      toPath: "/copy.txt"
    });
    expect(() => activefsMCPToolInputSchemas.activefs_read.parse({})).toThrow();
    expect(() => activefsMCPToolInputSchemas.activefs_write.parse({ text: "missing target" })).toThrow();
    expect(() => activefsMCPToolInputSchemas.activefs_write.parse({ path: "/missing-content.txt" })).toThrow();
    expect(() => activefsMCPToolInputSchemas.activefs_rm.parse({})).toThrow();
    expect(() => activefsMCPToolInputSchemas.activefs_mv.parse({ toPath: "/missing-source.txt" })).toThrow();
    expect(() => activefsMCPToolInputSchemas.activefs_cp.parse({ toPath: "/missing-source.txt" })).toThrow();
  });

  it("builds prompt text with defaults and rejects unknown prompts", () => {
    expect(getActiveFSMCPPrompt("activefs_search_then_read", undefined).messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("the user's query")
    });
    expect(getActiveFSMCPPrompt("activefs_investigate_path", { path: "/README.md" }).messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("Investigate /README.md")
    });
    expect(getActiveFSMCPPrompt("activefs_summarize_tree", {
      remote: "repo",
      path: "/docs"
    }).messages[0]?.content).toMatchObject({
      type: "text",
      text: expect.stringContaining("repo:/docs")
    });
    expect(() => getActiveFSMCPPrompt("missing_prompt", undefined)).toThrow("Unknown ActiveFS MCP prompt");
  });

  it("debounces subscription notifications and cleans up duplicate subscriptions", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    let callback: ((event: { path: ActiveFSPath }) => void) | undefined;
    const watch = vi.fn(async (
      _context: unknown,
      _path: ActiveFSPath,
      handler: (event: { path: ActiveFSPath }) => void
    ) => {
      callback = handler;
      return { close };
    });
    const server = {
      sendResourceUpdated: vi.fn(async () => undefined),
      sendResourceListChanged: vi.fn(async () => undefined)
    };
    const manager = new ActiveFSMCPSubscriptionManager({
      filesystem: { watch } as unknown as ActiveFS,
      remotes: [{ name: "demo", rootPath: "/demo" }],
      server: server as never,
      debounceMs: 25
    });
    const uri = "activefs://demo/hello.md";

    try {
      await manager.subscribe(uri, {});
      await manager.subscribe(uri, {});
      expect(watch).toHaveBeenCalledTimes(1);

      await manager.unsubscribe("activefs://demo/missing.md");
      callback?.({ path: "/demo/hello.md" });
      callback?.({ path: "/demo/hello.md" });
      await manager.unsubscribe(uri);
      await vi.advanceTimersByTimeAsync(25);
      expect(server.sendResourceUpdated).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);

      await manager.subscribe(uri, {});
      callback?.({ path: "/demo/hello.md" });
      await vi.advanceTimersByTimeAsync(25);
      expect(server.sendResourceUpdated).toHaveBeenCalledWith({ uri });
      expect(server.sendResourceListChanged).toHaveBeenCalledTimes(1);
      await manager.close();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await manager.close();
    }
  });
});

async function connectTestServer(options: {
  filesystem?: ActiveFS;
  rootPath?: ActiveFSPath;
  remote?: ActiveFSMCPRemote;
  config?: Parameters<typeof createActiveFSMCPServer>[0]["config"];
} = {}): Promise<{
  client: Client;
  handle: ActiveFSMCPServerHandle;
}> {
  const filesystem = options.filesystem ?? createActiveFS().mount(
    "/demo",
    createMemoryTree({
      searchable: true,
      watchable: true,
      writable: true,
      files: {
        "/hello.md": "# Hello MCP\n",
        "/notes/today.txt": "MCP can read ActiveFS resources."
      }
    })
  );
  const handle = createActiveFSMCPServer({
    filesystem,
    remotes: [options.remote ?? { name: "demo", rootPath: options.rootPath ?? "/demo", watchable: options.filesystem ? undefined : true }],
    config: options.config
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  const client = new Client({ name: "activefs-mcp-test", version: "0.1.0" });
  await client.connect(clientTransport);
  return { client, handle };
}

async function closeClient(client: Client, handle: ActiveFSMCPServerHandle): Promise<void> {
  await client.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
