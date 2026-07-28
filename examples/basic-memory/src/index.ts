import { createActiveFS, fsTree, text } from "@activefs/core";

const searchableTextPath = "/notes/search.txt";
const searchableText = "Search runs through the same mounted ActiveFS tree.";

export function createBasicMemoryTree() {
  return fsTree({
    "/hello.md": text("# Hello ActiveFS\n\nHello from an fsTree-backed ActiveFS tree.\n", {
      type: "text/markdown"
    }),
    notes: {
      "search.txt": text(`${searchableText}\n`)
    }
  }, {
    search: ({ path, query }) => {
      const searchQuery = query!;
      return {
        matches: isPathWithin(path, searchableTextPath) &&
          matches(searchableText, searchQuery.pattern, searchQuery.caseSensitive)
          ? [{
              path: searchableTextPath,
              line: 1,
              column: 1,
              excerpt: searchableText
            }]
          : [],
        complete: true,
        strategy: "source"
      };
    }
  });
}

export function createBasicMemoryFilesystem() {
  return createActiveFS().mount("/", createBasicMemoryTree());
}

export async function runBasicMemoryExample() {
  const fs = createBasicMemoryFilesystem();
  const entries = await fs.list({}, "/");
  const hello = await fs.read({}, "/hello.md");
  const matches = await fs.search({}, "/", { pattern: "Search" });

  return {
    entries: entries.map((entry) => entry.path),
    hello: textContent(hello.content),
    searchMatches: matches.matches.length,
    searchStrategy: matches.strategy
  };
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

function matches(text: string, pattern: string, caseSensitive?: boolean) {
  return caseSensitive ? text.includes(pattern) : text.toLowerCase().includes(pattern.toLowerCase());
}

function isPathWithin(rootPath: string, candidatePath: string) {
  return rootPath === "/" || candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runBasicMemoryExample();
  console.log(result.entries.join("\n"));
  console.log(result.hello);
  console.log(`search matches: ${result.searchMatches}`);
}
