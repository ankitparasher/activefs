import { describe, expect, it } from "vitest";
import { createMultiTreeRemote, exampleConfig } from "./index";

describe("multi-tree-remote example", () => {
  it("composes configured ActiveFS remotes as virtual mount prefixes", async () => {
    const fs = createMultiTreeRemote(exampleConfig);
    const entries = await fs.list({}, "/");

    expect(entries.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
      "directory /docs",
      "directory /logs",
      "directory /metrics"
    ]);
  });
});
