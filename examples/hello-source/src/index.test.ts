import { describe, expect, it, vi } from "vitest";
import type { ActiveFSTreeReadResult } from "@activefs/core";
import { createHttpSourceClient } from "@activefs/source-http";
import {
  createHelloSourceTree,
  runHelloSourceExample,
  startHelloSourceServer
} from "./index";

describe("hello-source example", () => {
  it("declares a tiny searchable Source API tree", async () => {
    const tree = createHelloSourceTree();

    await expect(tree.list({}, "/")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/README.txt", kind: "file" }),
      expect.objectContaining({ path: "/notes", kind: "directory" }),
      expect.objectContaining({ path: "/data", kind: "directory" }),
      expect.objectContaining({ path: "/bin", kind: "directory" })
    ]));
    await expect(tree.read({}, "/README.txt")).resolves.toBe("Hello from an ActiveFS Source API tree.\n");
    await expect(tree.search({}, "/", { pattern: "generated" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/notes/source-api.txt" })]
    });
  });

  it("computes current status JSON on every read", async () => {
    vi.useFakeTimers();
    try {
      const tree = createHelloSourceTree();

      vi.setSystemTime(new Date("2026-07-21T08:00:00.000Z"));
      const firstRead = parseJsonContent(await tree.read({}, "/data/status.json"));

      vi.setSystemTime(new Date("2026-07-21T08:00:05.000Z"));
      const secondRead = parseJsonContent(await tree.read({}, "/data/status.json"));

      expect(firstRead).toEqual({
        schemaVersion: 1,
        source: "hello-source",
        status: "ready",
        checkedAt: "2026-07-21T08:00:00.000Z"
      });
      expect(secondRead).toEqual({
        ...firstRead,
        checkedAt: "2026-07-21T08:00:05.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the tree over Source API", async () => {
    const server = await startHelloSourceServer(0);
    try {
      const client = createHttpSourceClient({ url: server.url, name: "hello" });

      await expect(client.list({}, "/")).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "/README.txt", kind: "file" })
      ]));
      await expect(client.read({}, "/notes/change-me.txt")).resolves.toMatchObject({
        content: "Edit examples/hello-source/src/index.ts, rebuild, and restart the server.\n"
      });
    } finally {
      await server.close();
    }
  });

  it("has a smoke-friendly --once flow", async () => {
    await expect(runHelloSourceExample()).resolves.toMatchObject({
      entries: ["/README.txt", "/bin", "/data", "/notes"],
      readme: "Hello from an ActiveFS Source API tree.\n",
      matches: ["/notes/source-api.txt:1"]
    });
  });
});

function parseJsonContent(result: ActiveFSTreeReadResult): Record<string, unknown> {
  const content = typeof result === "object" && "content" in result
    ? result.content
    : result;
  const text = typeof content === "string"
    ? content
    : new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
  return JSON.parse(text) as Record<string, unknown>;
}
