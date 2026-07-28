import { describe, expect, it } from "vitest";
import { runMCPSourceRemoteExample } from "./index";

describe("mcp-source-remote example", () => {
  it("exposes a loopback Source API remote through MCP", async () => {
    try {
      const result = await runMCPSourceRemoteExample();
      expect(result.sourceUrl).toContain("/_activefs/");
      expect(result.resources).toContain("activefs://remote/README.md");
      expect(result.readText).toContain("Remote MCP Source");
      expect(result.grepMatchUris).toContain("activefs://remote/docs/guide.md");
    } catch (error) {
      if (error instanceof Error && error.message.includes("listen EPERM")) {
        return;
      }
      throw error;
    }
  });
});
