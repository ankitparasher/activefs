import { describe, expect, it } from "vitest";
import { runRemoteTreeClientExample } from "./index";
import { startRemoteTreeExampleServer } from "../../remote-tree-server/src/index";

describe("remote-tree-client example", () => {
  it("mounts a Source API server and runs list/read/search over HTTP", async () => {
    const server = await startRemoteTreeExampleServer(0);
    try {
      const result = await runRemoteTreeClientExample(server.url);

      expect(result.mount).toBe("/remote");
      expect(result.capabilities.readable).toBe(true);
      expect(result.entries).toContain("file      /remote/README.txt");
      expect(result.readme).toBe("Hello from a remote ActiveFS tree.\n");
      expect(result.matches).toEqual([
        "/remote/notes/source-api.txt:1:Source API exposes a generic HTTP tree service."
      ]);
    } finally {
      await server.close();
    }
  });
});
