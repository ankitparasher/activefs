import { describe, expect, it } from "vitest";
import {
  activeFSMCPRemotePath,
  activeFSMCPResourceUri,
  activeFSMCPRuntimePath,
  parseActiveFSMCPUri
} from "@activefs/mcp";

describe("ActiveFS MCP URI helpers", () => {
  it("parses and formats activefs URIs for root and rooted remotes", () => {
    const remotes = [
      { name: "root", rootPath: "/" },
      { name: "docs", rootPath: "/mounted/docs", title: "Docs" }
    ];

    expect(parseActiveFSMCPUri("activefs://root", remotes)).toMatchObject({
      remote: { name: "root", rootPath: "/" },
      path: "/"
    });
    expect(parseActiveFSMCPUri("activefs://docs/guide%20one.md", remotes)).toMatchObject({
      remote: { name: "docs", rootPath: "/mounted/docs", title: "Docs" },
      path: "/guide one.md"
    });

    expect(activeFSMCPResourceUri("docs remote", "guide one.md")).toBe("activefs://docs%20remote/guide%20one.md");
    expect(activeFSMCPRuntimePath({ rootPath: "/" }, "/a.txt")).toBe("/a.txt");
    expect(activeFSMCPRuntimePath({ rootPath: "/mounted/docs" }, "/")).toBe("/mounted/docs");
    expect(activeFSMCPRuntimePath({ rootPath: "/mounted/docs" }, "/a.txt")).toBe("/mounted/docs/a.txt");
    expect(activeFSMCPRemotePath({ rootPath: "/" }, "/a.txt")).toBe("/a.txt");
    expect(activeFSMCPRemotePath({ rootPath: "/mounted/docs" }, "/mounted/docs")).toBe("/");
    expect(activeFSMCPRemotePath({ rootPath: "/mounted/docs" }, "/mounted/docs/a.txt")).toBe("/a.txt");
    expect(activeFSMCPRemotePath({ rootPath: "/mounted/docs" }, "/outside/a.txt")).toBe("/outside/a.txt");
  });

  it("rejects invalid schemes and unknown remotes", () => {
    expect(() => parseActiveFSMCPUri("not a uri", [])).toThrow("Invalid ActiveFS MCP URI");
    expect(() => parseActiveFSMCPUri("file:///tmp/a.txt", [])).toThrow("Unsupported ActiveFS MCP URI scheme");
    expect(() => parseActiveFSMCPUri("activefs://missing/a.txt", [])).toThrow("Unknown ActiveFS MCP remote");
  });
});
