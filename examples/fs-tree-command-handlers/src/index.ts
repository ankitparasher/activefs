import { bytes, dir, fsTree, text, type ActiveFSTreeSearchResult } from "@activefs/core";

export function createFsTreeCommandHandlersTree() {
  return fsTree({
    docs: dir({
      "text.txt": text("needle in a normal text file\n")
    }, {
      rg: ({ path }) => ({
        matches: [{ path, excerpt: "directory index hit" }],
        complete: true,
        strategy: "source"
      })
    }),
    images: dir({
      "diagram.png": bytes(new Uint8Array([137, 80, 78, 71]), { type: "image/png" })
        .setSearch(({ path, query }) => ({
          matches: query?.pattern.toLowerCase().includes("architecture")
            ? [{ path, excerpt: "OCR label: architecture diagram" }]
            : [],
          complete: true,
          strategy: "source"
        }))
        .setGrep(({ path }) => ({
          matches: [{ path, excerpt: "visual label grep hit" }],
          complete: true,
          strategy: "source"
        }))
    })
  });
}

export async function runFsTreeCommandHandlersExample() {
  const tree = createFsTreeCommandHandlersTree();
  const textSearch = await tree.search({}, "/docs", { pattern: "needle" });
  const imageSearch = await tree.search({}, "/images/diagram.png", { pattern: "architecture" });
  const directoryRg = await tree.command({}, "rg", "/docs", { pattern: "needle" }) as ActiveFSTreeSearchResult;
  const imageGrep = await tree.command({}, "grep", "/images/diagram.png", { pattern: "architecture" }) as ActiveFSTreeSearchResult;

  return {
    textSearchPaths: textSearch.matches.map((match) => match.path),
    imageSearchExcerpts: imageSearch.matches.map((match) => match.excerpt),
    directoryRgExcerpts: directoryRg.matches.map((match) => match.excerpt),
    imageGrepExcerpts: imageGrep.matches.map((match) => match.excerpt)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFsTreeCommandHandlersExample();
  console.log(`fs-tree-command-handlers text: ${result.textSearchPaths.join(", ")}`);
  console.log(`fs-tree-command-handlers image: ${result.imageSearchExcerpts.join(", ")}`);
  console.log(`fs-tree-command-handlers rg: ${result.directoryRgExcerpts.join(", ")}`);
  console.log(`fs-tree-command-handlers grep: ${result.imageGrepExcerpts.join(", ")}`);
}
