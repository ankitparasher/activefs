import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActiveFS } from "@activefs/core";
import {
  activefsMCPServerConfigJsonSchema,
  activefsMCPToolInputJsonSchemas,
  loadActiveFSMCPConfig,
  normalizeActiveFSMCPServerConfig
} from "@activefs/mcp";

describe("ActiveFS MCP config", () => {
  it("normalizes safe defaults and keeps mutating tools disabled", () => {
    const config = normalizeActiveFSMCPServerConfig({});

    expect(config.resources).toMatchObject({
      includeDirectories: true,
      maxDepth: 8,
      maxResources: 1000,
      pageSize: 100
    });
    expect(config.tools).toMatchObject({
      list: true,
      read: true,
      grep: true,
      write: false,
      rm: false
    });
    expect(config.subscriptions.enabled).toBe(true);
  });

  it("loads deterministic demo remotes", async () => {
    const loaded = await loadActiveFSMCPConfig({ demo: true });

    expect(loaded.remotes).toEqual([
      { name: "demo", rootPath: "/demo", title: "ActiveFS MCP demo", watchable: true }
    ]);
    expect(loaded.adapterOptions.resourceTemplates?.[0]).toMatchObject({
      uriTemplate: "activefs://demo/{path}"
    });
  });

  it("fails closed when neither remotes nor an explicit demo are configured", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "activefs-mcp-empty-"));
    try {
      await expect(loadActiveFSMCPConfig({ workspace: join(tempDir, ".activefs") })).rejects.toMatchObject({
        code: "INVALID_REQUEST"
      });
      await expect(loadActiveFSMCPConfig({ filesystem: createActiveFS() })).rejects.toThrow(
        "requires at least one explicit remote descriptor"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses programmatic filesystems and explicit Source API remotes", async () => {
    const filesystem = createActiveFS();
    const provided = await loadActiveFSMCPConfig({
      filesystem,
      remotes: [{ name: "provided", rootPath: "/provided", title: "Provided" }],
      config: {
        resources: { includeDirectories: false },
        prompts: { enabled: false },
        subscriptions: { debounceMs: 50 },
        auth: { mode: "none" },
        authorization: { default: "deny" }
      }
    });
    expect(provided.filesystem).toBe(filesystem);
    expect(provided.remotes).toEqual([{ name: "provided", rootPath: "/provided", title: "Provided" }]);
    expect(provided.config.resources.includeDirectories).toBe(false);
    expect(provided.config.prompts.enabled).toBe(false);
    expect(provided.config.subscriptions.debounceMs).toBe(50);
    expect(provided.config.auth.mode).toBe("none");
    expect(provided.config.authorization.default).toBe("deny");

    const explicit = await loadActiveFSMCPConfig({
      env: { SOURCE_TOKEN: "token" },
      config: {
        remotes: [
          {
            name: "docs",
            url: "http://127.0.0.1:3999/activefs/v1",
            rootPath: "/subtree",
            title: "Docs",
            watchable: true,
            auth: { type: "bearer-env", env: "SOURCE_TOKEN", scheme: "Token" }
          },
          {
            name: "public",
            url: "http://127.0.0.1:4000/activefs/v1",
            rootPath: "/"
          }
        ]
      }
    });
    expect(explicit.remotes).toEqual([
      { name: "docs", title: "Docs", rootPath: "/docs/subtree", watchable: true },
      { name: "public", title: undefined, rootPath: "/public", watchable: undefined }
    ]);
    expect(explicit.adapterOptions.resourceTemplates?.map((template) => template.uriTemplate)).toEqual([
      "activefs://docs/{path}",
      "activefs://public/{path}"
    ]);
  });

  it("loads watchable Source API remotes from ActiveFS workspace config", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "activefs-mcp-config-"));
    const workspace = join(tempDir, ".activefs");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "config.json"), JSON.stringify({
        schemaVersion: 1,
        stateRoot: workspace,
        remotes: {
          docs: {
            name: "docs",
            url: "http://127.0.0.1:3999/activefs/v1/",
            mountPath: "/docs",
            remoteRoot: "/",
            watchable: true
          }
        }
      }));

      const loaded = await loadActiveFSMCPConfig({ workspace });

      expect(loaded.remotes).toEqual([
        { name: "docs", title: "docs", rootPath: "/docs", watchable: true }
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exports config and tool JSON schemas", () => {
    expect(activefsMCPServerConfigJsonSchema).toMatchObject({ type: "object" });
    expect(activefsMCPToolInputJsonSchemas.activefs_grep).toMatchObject({ type: "object" });
  });
});
