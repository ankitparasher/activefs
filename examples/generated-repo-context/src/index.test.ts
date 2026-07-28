import { describe, expect, it } from "vitest";
import { createGeneratedRepoContextFilesystem, runGeneratedRepoContextExample } from "./index";

describe("generated-repo-context example", () => {
  it("serves stable generated context plus dynamic build information", async () => {
    const fixedNow = () => new Date("2026-06-26T00:00:00.000Z");
    const fs = createGeneratedRepoContextFilesystem(fixedNow);

    await expect(fs.list({}, "/repo")).resolves.toEqual([
      expect.objectContaining({ path: "/repo/context.md" }),
      expect.objectContaining({ path: "/repo/dynamic" })
    ]);

    const result = await runGeneratedRepoContextExample(fixedNow);
    expect(result.context).toContain("# Repository Context");
    expect(result.buildInfo).toBe("Generated timestamp: 2026-06-26T00:00:00.000Z\n");
  });
});
