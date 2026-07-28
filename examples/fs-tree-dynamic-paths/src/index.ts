import { file, fsTree, type ActiveFSTreeReadResult } from "@activefs/core";

export function createFsTreeDynamicPathsTree() {
  const tree = fsTree({
    "/users/:id/profile.md": file({
      enumerable: false,
      read: ({ params }) => `# ${title(params.id)}\n\nGenerated profile for ${params.id}.\n`
    })
  });

  tree.path("/notes/:id")
    .file({
      type: "text/markdown",
      enumerable: false
    })
    .setInfo(({ params, path }) => ({
      path,
      name: `${params.id}.md`,
      kind: "file",
      type: "text/markdown"
    }))
    .setRead(({ params }) => `# Note ${params.id}\n\nLazy note body.\n`)
    .setSearch(({ path, query }) => ({
      matches: [{ path, excerpt: query?.pattern ?? "note" }],
      complete: true,
      strategy: "source"
    }));

  return tree;
}

export async function runFsTreeDynamicPathsExample() {
  const tree = createFsTreeDynamicPathsTree();
  const profile = await tree.read({}, "/users/ada/profile.md");
  const note = await tree.read({}, "/notes/alpha");
  const noteSearch = await tree.search({}, "/notes/alpha", { pattern: "Lazy" });

  return {
    profile: textContent(profile),
    note: textContent(note),
    noteSearchPaths: noteSearch.matches.map((match) => match.path)
  };
}

function title(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function textContent(result: ActiveFSTreeReadResult): string {
  const content = typeof result === "object" && result !== null && "content" in result
    ? result.content
    : result;
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFsTreeDynamicPathsExample();
  console.log(result.profile);
  console.log(result.note);
  console.log(`fs-tree-dynamic-paths search: ${result.noteSearchPaths.join(", ")}`);
}
