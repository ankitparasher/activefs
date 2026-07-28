import {
  createActiveFS,
  fsTree,
  text,
  type ActiveFSSearchIncompleteReason,
  type ActiveFSSearchQuery
} from "@activefs/core";

const databaseFiles = {
  "/schema/tables.md": [
    "# Tables",
    "",
    "| table | primary key | rows |",
    "|---|---|---:|",
    "| users | id | 2 |",
    "| projects | id | 2 |",
    ""
  ].join("\n"),
  "/schema/users.json": JSON.stringify(
    {
      table: "users",
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "status", type: "text" }
      ]
    },
    null,
    2
  ) + "\n",
  "/schema/projects.json": JSON.stringify(
    {
      table: "projects",
      columns: [
        { name: "id", type: "integer" },
        { name: "owner_id", type: "integer" },
        { name: "name", type: "text" }
      ]
    },
    null,
    2
  ) + "\n",
  "/tables/users/rows/1.json": JSON.stringify(
    { id: 1, name: "Ada Lovelace", status: "active" },
    null,
    2
  ) + "\n",
  "/tables/users/rows/2.json": JSON.stringify(
    { id: 2, name: "Grace Hopper", status: "inactive" },
    null,
    2
  ) + "\n",
  "/tables/projects/rows/1.json": JSON.stringify(
    { id: 1, owner_id: 1, name: "Compiler Notes" },
    null,
    2
  ) + "\n",
  "/tables/projects/rows/2.json": JSON.stringify(
    { id: 2, owner_id: 1, name: "ActiveFS Demo" },
    null,
    2
  ) + "\n",
  "/queries/active-users.md": [
    "# Query: active-users",
    "",
    "| id | name | status |",
    "|---:|---|---|",
    "| 1 | Ada Lovelace | active |",
    ""
  ].join("\n"),
  "/queries/projects-by-owner/1.md": [
    "# Query: projects-by-owner",
    "",
    "Owner: Ada Lovelace",
    "",
    "- Compiler Notes",
    "- ActiveFS Demo",
    ""
  ].join("\n")
};

export function createDatabaseTree() {
  return fsTree(textFileDeclarations(databaseFiles), {
    name: "database-fixture",
    search: ({ path, query }) => ({
      ...searchTextFiles(databaseFiles, path, query!),
      strategy: "source"
    })
  });
}

export async function runDatabaseTreeExample() {
  const fs = createActiveFS().mount("/db", createDatabaseTree());
  const root = await fs.list({}, "/db");
  const userRows = await fs.list({}, "/db/tables/users/rows");
  const activeUsers = await fs.read({}, "/db/queries/active-users.md");
  const matches = await fs.search({}, "/db", { pattern: "Ada Lovelace" });

  return {
    root: root.map((entry) => entry.path),
    userRows: userRows.map((entry) => entry.path),
    queryTitle: textContent(activeUsers).split("\n")[0],
    matches: matches.matches.map((match) => `${match.path}:${match.line ?? 0}`),
    strategy: matches.strategy
  };
}

function textContent(read: { content: string | Uint8Array }): string {
  return typeof read.content === "string" ? read.content : new TextDecoder().decode(read.content);
}

function textFileDeclarations(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, text(content)])
  );
}

function searchTextFiles(files: Record<string, string>, rootPath: string, query: ActiveFSSearchQuery) {
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  const maxResults = query.maxResults ?? Number.POSITIVE_INFINITY;
  const matches: Array<{ path: string; line: number; column: number; excerpt: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    if (!isPathWithin(rootPath, path)) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column < 0) {
        continue;
      }
      if (matches.length >= maxResults) {
        return {
          matches,
          complete: false,
          incompleteReasons: ["max-results"] as ActiveFSSearchIncompleteReason[]
        };
      }
      matches.push({ path, line: index + 1, column: column + 1, excerpt: line });
    }
  }
  return { matches, complete: true };
}

function isPathWithin(rootPath: string, candidatePath: string) {
  return rootPath === "/" || candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDatabaseTreeExample();
  console.log(`database-tree root: ${result.root.join(", ")}`);
  console.log(`database-tree user rows: ${result.userRows.join(", ")}`);
  console.log(`database-tree query: ${result.queryTitle}`);
  console.log(`database-tree search strategy: ${result.strategy}`);
  console.log(`database matches: ${result.matches.length}`);
}
