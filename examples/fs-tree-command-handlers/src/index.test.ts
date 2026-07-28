import { describe, expect, it } from "vitest";
import { runFsTreeCommandHandlersExample } from "./index";

describe("fs-tree-command-handlers example", () => {
  it("uses ActiveFS scans, source search overrides, and optional command handlers", async () => {
    const result = await runFsTreeCommandHandlersExample();

    expect(result.textSearchPaths).toEqual(["/docs/text.txt"]);
    expect(result.imageSearchExcerpts).toEqual(["OCR label: architecture diagram"]);
    expect(result.directoryRgExcerpts).toEqual(["directory index hit"]);
    expect(result.imageGrepExcerpts).toEqual(["visual label grep hit"]);
  });
});
