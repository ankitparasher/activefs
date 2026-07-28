import { describe, expect, it } from "vitest";
import { runBasicMemoryExample } from "./index";

describe("basic-memory example", () => {
  it("lists, reads, and searches an in-memory tree", async () => {
    const result = await runBasicMemoryExample();

    expect(result.entries).toEqual(["/hello.md", "/notes"]);
    expect(result.hello).toContain("# Hello ActiveFS");
    expect(result.searchStrategy).toBe("source");
    expect(result.searchMatches).toBe(1);
  });
});
