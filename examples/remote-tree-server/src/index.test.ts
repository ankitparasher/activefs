import { describe, expect, it } from "vitest";
import { createRemoteTreeExampleTree } from "./index";

describe("remote-tree-server example", () => {
  it("wraps a searchable tree for Source API serving", async () => {
    const tree = createRemoteTreeExampleTree();

    const rootEntries = await tree.list({}, "/");
    expect(Array.isArray(rootEntries) ? rootEntries.map((entry) => entry?.path).sort() : []).toEqual([
      "/README.txt",
      "/bin",
      "/notes"
    ]);
    await expect(tree.read({}, "/README.txt")).resolves.toBe("Hello from a remote ActiveFS tree.\n");
    await expect(tree.search({}, "/", { pattern: "Source API" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/notes/source-api.txt" })]
    });
  });
});
