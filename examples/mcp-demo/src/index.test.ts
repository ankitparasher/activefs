import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { runMCPDemoClient } from "./index";

describe("mcp-demo example", () => {
  it("starts the real stdio MCP server and calls resources/tools/prompts", async () => {
    if (!existsSync("packages/mcp/dist/cli.js")) {
      await expect(runMCPDemoClient()).rejects.toThrow("Run pnpm build");
      return;
    }

    const result = await runMCPDemoClient();

    expect(result.resources).toContain("activefs://demo/hello.md");
    expect(result.readText).toContain("Hello ActiveFS MCP");
    expect(result.grepMatchUris).toContain("activefs://demo/hello.md");
    expect(result.prompts).toContain("activefs_search_then_read");
  });
});
