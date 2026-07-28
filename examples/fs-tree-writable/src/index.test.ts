import { describe, expect, it } from "vitest";
import { runFsTreeWritableExample } from "./index";

describe("fs-tree-writable example", () => {
  it("uses writable defaults with hooks and committed events", async () => {
    const result = await runFsTreeWritableExample();

    expect(result.summary).toBe("Updated summary\n");
    expect(result.created).toBe("New file\n");
    expect(result.audit).toEqual([
      "write:/docs/summary.md",
      "modified:/docs/summary.md",
      "write:/docs/new.md",
      "created:/docs/new.md"
    ]);
  });
});
