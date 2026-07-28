import { describe, expect, it } from "vitest";
import { runFsTreeBasicExample } from "./index";

describe("fs-tree-basic example", () => {
  it("serves a sparse and nested fsTree declaration", async () => {
    const result = await runFsTreeBasicExample();

    expect(result.entries).toEqual(["/README.md", "/data", "/docs"]);
    expect(result.intro).toContain("Intro from a nested declaration");
    expect(result.status).toContain("\"ok\": true");
    expect(result.searchPaths).toEqual(["/docs/intro.md", "/docs/nested/more.md"]);
  });
});
