import { describe, expect, it } from "vitest";
import { runFsTreeDynamicPathsExample } from "./index";

describe("fs-tree-dynamic-paths example", () => {
  it("serves pattern params and path-handle handlers", async () => {
    const result = await runFsTreeDynamicPathsExample();

    expect(result.profile).toContain("# Ada");
    expect(result.note).toContain("# Note alpha");
    expect(result.noteSearchPaths).toEqual(["/notes/alpha"]);
  });
});
