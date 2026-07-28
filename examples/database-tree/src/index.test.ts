import { describe, expect, it } from "vitest";
import { runDatabaseTreeExample } from "./index";

describe("database-tree example", () => {
  it("exposes schema, row files, and generated query results", async () => {
    const result = await runDatabaseTreeExample();

    expect(result.root).toEqual(["/db/queries", "/db/schema", "/db/tables"]);
    expect(result.userRows).toEqual([
      "/db/tables/users/rows/1.json",
      "/db/tables/users/rows/2.json"
    ]);
    expect(result.queryTitle).toBe("# Query: active-users");
    expect(result.matches.sort()).toEqual([
      "/db/queries/active-users.md:5",
      "/db/queries/projects-by-owner/1.md:3",
      "/db/tables/users/rows/1.json:3"
    ].sort());
  });
});
