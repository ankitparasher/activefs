import { describe, expect, it, vi } from "vitest";
import { createActiveFS } from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import {
  callActiveFSMCPTool,
  createMCPAdapter,
  isActiveFSMCPToolEnabled,
  listActiveFSMCPTools,
  type ActiveFSMCPToolName,
  type ActiveFSMCPToolRuntime
} from "@activefs/mcp";

describe("ActiveFS MCP tools", () => {
  it("lists, stats, reads, searches, mutates, and exports through the runtime", async () => {
    const runtime = createRuntime();

    expect(listActiveFSMCPTools({ write: true, mkdir: true, rm: true, mv: true, cp: true, export: true })
      .map((tool) => tool.name)).toContain("activefs_write");
    expect(isActiveFSMCPToolEnabled("activefs_write", { write: true })).toBe(true);
    expect(isActiveFSMCPToolEnabled("activefs_write", undefined)).toBe(false);
    expect(isActiveFSMCPToolEnabled("activefs_missing", undefined)).toBe(false);

    const defaultList = await callActiveFSMCPTool("activefs_list", undefined, runtime);
    expect(defaultList.structuredContent).toMatchObject({ remote: "demo", path: "/" });

    const list = await callActiveFSMCPTool("activefs_list", { remote: "demo", path: "/", limit: 1 }, runtime);
    expect(list.structuredContent).toMatchObject({ remote: "demo", nextCursor: "1" });

    const stat = await callActiveFSMCPTool("activefs_stat", { uri: "activefs://demo/hello.txt" }, runtime);
    expect(stat.structuredContent).toMatchObject({ uri: "activefs://demo/hello.txt", kind: "file" });

    const read = await callActiveFSMCPTool("activefs_read", { remote: "demo", path: "/hello.txt" }, runtime);
    expect(read.structuredContent).toMatchObject({ text: expect.stringContaining("hello ActiveFS") });

    const binaryRead = await callActiveFSMCPTool("activefs_read", {
      remote: "demo",
      path: "/bytes.bin",
      encoding: "binary"
    }, runtime);
    expect(binaryRead.structuredContent).toMatchObject({ blob: "AQID" });

    const grep = await callActiveFSMCPTool("activefs_grep", {
      remote: "demo",
      path: "/",
      query: "ActiveFS"
    }, runtime);
    expect(grep.structuredContent).toMatchObject({ complete: true });

    const write = await callActiveFSMCPTool("activefs_write", {
      remote: "demo",
      path: "/written.txt",
      text: "written"
    }, runtime);
    expect(write.isError).not.toBe(true);

    const binaryWrite = await callActiveFSMCPTool("activefs_write", {
      remote: "demo",
      path: "/written.bin",
      blob: "AQID"
    }, runtime);
    expect(binaryWrite.isError).not.toBe(true);

    const mkdir = await callActiveFSMCPTool("activefs_mkdir", {
      remote: "demo",
      path: "/created"
    }, runtime);
    expect(mkdir.isError).not.toBe(true);

    const copy = await callActiveFSMCPTool("activefs_cp", {
      remote: "demo",
      fromPath: "/written.txt",
      toPath: "/created/copied.txt"
    }, runtime);
    expect(copy.isError).not.toBe(true);

    const move = await callActiveFSMCPTool("activefs_mv", {
      remote: "demo",
      fromPath: "/created/copied.txt",
      toPath: "/created/moved.txt"
    }, runtime);
    expect(move.isError).not.toBe(true);

    const remove = await callActiveFSMCPTool("activefs_rm", {
      remote: "demo",
      path: "/created/moved.txt"
    }, runtime);
    expect(remove.isError).not.toBe(true);

    const exported = await callActiveFSMCPTool("activefs_export", {
      remote: "demo",
      path: "/",
      maxFiles: 2
    }, runtime);
    expect(exported.structuredContent).toMatchObject({ remote: "demo", truncated: true });

    const singleExport = await callActiveFSMCPTool("activefs_export", {
      remote: "demo",
      path: "/hello.txt",
      maxFiles: 1
    }, runtime);
    expect(singleExport.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("resource link")
    });

    expect(runtime.contextFor).toHaveBeenCalled();
    expect(runtime.authorizeTool).toHaveBeenCalled();
  });

  it("returns tool errors for invalid input, missing paths, invalid cursors, and denied policy", async () => {
    const runtime = createRuntime();

    await expect(callActiveFSMCPTool("activefs_read", {}, runtime)).resolves.toMatchObject({
      isError: true
    });
    await expect(callActiveFSMCPTool("activefs_stat", { remote: "missing", path: "/" }, runtime)).resolves.toMatchObject({
      isError: true
    });
    await expect(callActiveFSMCPTool("activefs_list", { remote: "demo", path: "/", cursor: "bad" }, runtime)).resolves.toMatchObject({
      isError: true
    });
    await expect(callActiveFSMCPTool("activefs_stat", { remote: "demo", path: "/missing.txt" }, runtime)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("Path not found") }]
    });
    await expect(callActiveFSMCPTool("activefs_missing" as ActiveFSMCPToolName, {}, runtime)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("Unknown ActiveFS MCP tool") }]
    });

    const denied = createRuntime(false);
    await expect(callActiveFSMCPTool("activefs_read", {
      remote: "demo",
      path: "/hello.txt"
    }, denied)).resolves.toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("not authorized") }]
    });
  });
});

function createRuntime(authorized = true): ActiveFSMCPToolRuntime {
  const filesystem = createActiveFS().mount("/demo", createMemoryTree({
    searchable: true,
    writable: true,
    watchable: true,
    files: {
      "/hello.txt": "hello ActiveFS",
      "/bytes.bin": new Uint8Array([1, 2, 3]),
      "/notes/today.txt": "MCP tools can search ActiveFS content."
    }
  }));
  const remotes = [{ name: "demo", rootPath: "/demo" }];
  const adapter = createMCPAdapter({ filesystem, remotes });
  return {
    filesystem,
    adapter,
    remotes,
    pageSize: 2,
    contextFor: vi.fn(async () => ({})),
    authorizeTool: vi.fn(async () => authorized)
  };
}
