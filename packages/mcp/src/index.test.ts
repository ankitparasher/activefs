import { describe, expect, it } from "vitest";
import { createActiveFS, fsTree, text, type ActiveFSTree } from "@activefs/core";
import { createGeneratedTree, createMemoryTree } from "@activefs/testing";
import { createMCPAdapter } from "@activefs/mcp";

describe("@activefs/mcp", () => {
  it("lists enumerable resources without exposing non-enumerable dynamic routes", async () => {
    const fs = createActiveFS().mount(
      "/repo",
      createGeneratedTree({
        files: {
          "/README.md": { content: "# Repo\n", mimeType: "text/markdown" },
          "/docs/guide.md": "Guide"
        },
        dynamicFiles: {
          "/users/ada/profile.md": "secret profile"
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      remotes: [{ name: "repo", rootPath: "/repo", title: "Repository" }]
    });

    const result = await adapter.listResources();

    expect(result.truncated).toBe(false);
    expect(result.resources.map((resource) => resource.uri).sort()).toEqual([
      "activefs://repo/",
      "activefs://repo/README.md",
      "activefs://repo/docs",
      "activefs://repo/docs/guide.md"
    ]);
    expect(result.resources.some((resource) => resource.uri.includes("ada"))).toBe(false);
  });

  it("reads text and binary resources from stable ActiveFS URIs", async () => {
    const fs = createActiveFS().mount(
      "/mem",
      createMemoryTree({
        files: {
          "/hello.txt": "Hello MCP",
          "/bytes.bin": new Uint8Array([0, 1, 255])
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      remote: "mem",
      rootPath: "/mem"
    });

    const text = await adapter.readResource("activefs://mem/hello.txt");
    const binary = await adapter.readResource("activefs://mem/bytes.bin");

    expect(text.contents).toEqual([{ uri: "activefs://mem/hello.txt", text: "Hello MCP" }]);
    expect(binary.contents).toEqual([{ uri: "activefs://mem/bytes.bin", blob: "AAH/" }]);
  });

  it("uses the default root remote without rewriting ActiveFS paths", async () => {
    const fs = createActiveFS().mount(
      "/",
      createMemoryTree({
        searchable: true,
        files: {
          "/a.txt": "alpha root",
          "/b.txt": "beta root"
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      maxResources: 1
    });

    const resources = await adapter.listResources();
    const read = await adapter.readResource("activefs://activefs/a.txt");
    const grep = await adapter.grep({ query: "root" });

    expect(resources).toMatchObject({
      truncated: false,
      resources: [{ uri: "activefs://activefs/" }]
    });
    expect(read.contents).toEqual([{ uri: "activefs://activefs/a.txt", text: "alpha root" }]);
    expect(grep.matches.map((match) => match.uri)).toContain("activefs://activefs/a.txt");
  });

  it("exposes source-controlled templates without enumerating concrete dynamic paths", () => {
    const fs = createActiveFS().mount("/", createMemoryTree({ "/visible.txt": "visible" }));
    const adapter = createMCPAdapter({
      filesystem: fs,
      remote: "users",
      resourceTemplates: [
        {
          uriTemplate: "activefs://users/users/{id}/profile.md",
          name: "User profile",
          mimeType: "text/markdown"
        }
      ]
    });

    expect(adapter.listResourceTemplates()).toEqual([
      {
        uriTemplate: "activefs://users/users/{id}/profile.md",
        name: "User profile",
        mimeType: "text/markdown"
      }
    ]);
  });

  it("maps grep matches back to remote resource URIs", async () => {
    const fs = createActiveFS().mount(
      "/repo",
      createMemoryTree({
        searchable: true,
        files: {
          "/README.md": "ActiveFS MCP adapter"
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      remotes: [{ name: "repo", rootPath: "/repo" }]
    });

    const result = await adapter.grep({ remote: "repo", query: "MCP", path: "/" });

    expect(result).toMatchObject({
      remote: "repo",
      path: "/",
      complete: true,
      matches: [
        {
          path: "/README.md",
          uri: "activefs://repo/README.md",
          line: 1,
          column: 10
        }
      ]
    });
  });

  it("uses an optional source grep handler and reports its strategy", async () => {
    const tree = fsTree({
      "diagram.png": text("binary placeholder").setGrep(({ path, input }) => ({
        matches: [{ path, excerpt: `OCR:${input.pattern}` }],
        complete: true,
        strategy: "source"
      }))
    });
    const adapter = createMCPAdapter({
      filesystem: createActiveFS().mount("/images", tree),
      remote: "images",
      rootPath: "/images"
    });

    await expect(adapter.grep({ remote: "images", query: "architecture", path: "/diagram.png" }))
      .resolves.toMatchObject({
        strategy: "source",
        complete: true,
        matches: [{ uri: "activefs://images/diagram.png", excerpt: "OCR:architecture" }]
      });
  });

  it("forwards host-derived context without exposing auth in resource metadata", async () => {
    const seenContexts: unknown[] = [];
    const inner = createMemoryTree({ "/secure.txt": "secret" });
    const source: ActiveFSTree = {
      ...inner,
      read: async (context, path, options) => {
        seenContexts.push(context);
        return inner.read(context, path, options);
      }
    };
    const fs = createActiveFS().mount("/secure", source);
    const adapter = createMCPAdapter({
      filesystem: fs,
      remote: "secure",
      rootPath: "/secure",
      context: () => ({ auth: { subject: "ada" }, meta: { traceId: "trace-1" } })
    });

    const resources = await adapter.listResources();
    await adapter.readResource("activefs://secure/secure.txt", {
      context: { meta: { requestId: "req-1" } }
    });

    expect(resources.resources[0]).not.toHaveProperty("auth");
    expect(seenContexts).toEqual([
      {
        auth: { subject: "ada" },
        meta: {
          traceId: "trace-1",
          adapter: "mcp",
          remote: "secure",
          operation: "readResource",
          requestId: "req-1"
        }
      }
    ]);
  });

  it("applies traversal limits, directory visibility, and URI validation", async () => {
    const fs = createActiveFS().mount(
      "/repo",
      createGeneratedTree({
        files: {
          "/docs/guide.md": { content: "# Guide\n", mimeType: "text/markdown" },
          "/top.txt": "top"
        },
        dynamicFiles: {
          "/hidden.txt": {
            content: "hidden",
            enumerable: false
          }
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      remotes: [{ name: "repo", rootPath: "/repo", title: "Repository" }],
      includeDirectories: false,
      maxDepth: 0,
      maxResources: 1
    });

    const resources = await adapter.listResources();

    expect(resources.truncated).toBe(true);
    expect(resources.resources).toEqual([]);
    expect(adapter.remotes).toEqual([{ name: "repo", rootPath: "/repo", title: "Repository" }]);
    await expect(adapter.readResource("not a uri")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(adapter.readResource("file://repo/top.txt")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(adapter.readResource("activefs://missing/top.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(() =>
      createMCPAdapter({
        filesystem: fs,
        remotes: [{ name: "bad name", rootPath: "/" }]
      })
    ).toThrow("Invalid ActiveFS MCP remote name");
    expect(() => createMCPAdapter({ filesystem: fs, remotes: [] })).toThrow("requires at least one");
  });

  it("supports rooted remotes, disabled grep, grep limits, and non-enumerable matches", async () => {
    const fs = createActiveFS().mount(
      "/repo",
      createGeneratedTree({
        searchable: true,
        files: {
          "/docs/a.txt": "needle alpha",
          "/docs/b.txt": "needle beta"
        },
        dynamicFiles: {
          "/docs/hidden.txt": {
            content: "needle hidden",
            enumerable: false
          }
        }
      })
    );
    const adapter = createMCPAdapter({
      filesystem: fs,
      remotes: [{ name: "repo", rootPath: "/repo/docs" }]
    });

    const hidden = await adapter.grep({
      remote: "repo",
      query: "needle",
      includeNonEnumerable: true,
      limit: 2
    });

    expect(hidden.complete).toBe(false);
    expect(hidden.matches.map((match) => match.uri)).toEqual([
      "activefs://repo/a.txt",
      "activefs://repo/b.txt"
    ]);
    await expect(adapter.readResource("activefs://repo/a.txt")).resolves.toEqual({
      contents: [{ uri: "activefs://repo/a.txt", text: "needle alpha" }]
    });
    await expect(adapter.grep({ remote: "missing", query: "needle" })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    const disabled = createMCPAdapter({ filesystem: fs, enableGrep: false });
    await expect(disabled.grep({ query: "needle" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });
});
