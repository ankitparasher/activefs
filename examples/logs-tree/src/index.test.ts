import { describe, expect, it } from "vitest";
import { logsFixtureVersion, runLogsTreeExample } from "./index";

describe("logs-tree example", () => {
  it("uses tree-native search without reading every log file", async () => {
    const result = await runLogsTreeExample();

    expect(result.fixtureVersion).toBe(logsFixtureVersion);
    expect(result.apiLogs).toContain("/logs/services/api/2026-06-26.log");
    expect(result.searchStrategy).toBe("source");
    expect(result.readsAfterSearch).toBe(0);
    expect(result.searchMatches).toEqual(["/logs/services/api/2026-06-26.log:2"]);
  });
});
