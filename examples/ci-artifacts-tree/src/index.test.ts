import { describe, expect, it } from "vitest";
import { runCiArtifactsTreeExample } from "./index";

describe("ci-artifacts-tree example", () => {
  it("exposes CI run summaries, logs, reports, screenshots, and artifacts", async () => {
    const result = await runCiArtifactsTreeExample();

    expect(result.latest).toEqual([
      "/ci/runs/latest/artifacts",
      "/ci/runs/latest/logs",
      "/ci/runs/latest/reports",
      "/ci/runs/latest/screenshots",
      "/ci/runs/latest/summary.md"
    ]);
    expect(result.logs).toEqual([
      "/ci/runs/latest/logs/build.log",
      "/ci/runs/latest/logs/test.log"
    ]);
    expect(result.summaryTitle).toBe("# CI Run 418");
    expect(result.matches.sort()).toEqual([
      "/ci/runs/latest/logs/test.log:3",
      "/ci/runs/latest/reports/coverage.md:1",
      "/ci/runs/latest/summary.md:6"
    ]);
  });
});
