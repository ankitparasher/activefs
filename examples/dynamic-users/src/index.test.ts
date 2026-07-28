import { describe, expect, it } from "vitest";
import { createDynamicUsersTree, runDynamicUsersExample } from "./index";

describe("dynamic-users example", () => {
  it("reads exact dynamic user paths and hides them from default enumeration", async () => {
    const tree = createDynamicUsersTree();

    await expect(tree.list({}, "/")).resolves.toEqual([
      expect.objectContaining({
        path: "/users",
        enumerable: false
      })
    ]);
    await expect(tree.search({}, "/", { pattern: "Ada" })).resolves.toMatchObject({
      matches: []
    });

    const result = await runDynamicUsersExample();
    expect(result.direct).toContain("# Ada");
    expect(result.recursiveMatches).toBe(2);
    expect(result.recursivePaths).toEqual(["/users/ada.md", "/users/ada.md"]);
  });
});
