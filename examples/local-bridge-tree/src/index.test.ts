import { createActiveFS } from "@activefs/core";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createLocalFolderTree } from "./index";

describe("local-bridge-tree example", () => {
  it("maps a local fixture folder to list/read/search operations", async () => {
    const fixtureRoot = fileURLToPath(new URL("../fixture", import.meta.url));
    const fs = createActiveFS().mount("/bridge", createLocalFolderTree(fixtureRoot));

    await expect(fs.list({}, "/bridge/docs")).resolves.toEqual([
      expect.objectContaining({
        path: "/bridge/docs/setup.md",
        kind: "file"
      })
    ]);

    const readme = await fs.read({}, "/bridge/README.md");
    expect(textContent(readme.content)).toContain("Local Bridge Fixture");

    const matches = await fs.search({}, "/bridge", { pattern: "bridge" });
    expect(matches).toMatchObject({ strategy: "source" });
    expect(matches.matches.map((match) => match.path)).toContain("/bridge/docs/setup.md");
  });
});

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}
