import { dir, file, fsTree, json, text, type ActiveFSTreeInfo, type ActiveFSTreeReadResult } from "@activefs/core";

export function createFsTreeBasicTree() {
  return fsTree({
    "/README.md": file({ content: "# fsTree Basic\n", type: "text/markdown" }),
    docs: dir({
      "intro.md": text("Intro from a nested declaration.\n", { type: "text/markdown" }),
      nested: {
        "more.md": text("More nested content.\n")
      }
    }),
    data: {
      "status.json": json(() => ({ ok: true }))
    }
  });
}

export async function runFsTreeBasicExample() {
  const tree = createFsTreeBasicTree();
  const entries = await tree.list({}, "/");
  const intro = await tree.read({}, "/docs/intro.md");
  const status = await tree.read({}, "/data/status.json", { encoding: "utf8" });
  const search = await tree.search({}, "/", { pattern: "nested" });

  return {
    entries: treeInfoPaths(entries),
    intro: textContent(intro),
    status: textContent(status),
    searchPaths: search.matches.map((match) => match.path).sort()
  };
}

function textContent(result: ActiveFSTreeReadResult): string {
  const content = typeof result === "object" && result !== null && "content" in result
    ? result.content
    : result;
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

function treeInfoPaths(result: Record<string, unknown> | ActiveFSTreeInfo[]): string[] {
  return Array.isArray(result)
    ? result.map((entry) => entry?.path).filter((path): path is string => Boolean(path)).sort()
    : Object.keys(result).map((name) => name.startsWith("/") ? name : `/${name}`).sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFsTreeBasicExample();
  console.log(`fs-tree-basic entries: ${result.entries.join(", ")}`);
  console.log(result.intro);
  console.log(`fs-tree-basic search: ${result.searchPaths.join(", ")}`);
}
