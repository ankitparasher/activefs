import { dir, fsTree, text, type ActiveFSTreeReadResult } from "@activefs/core";

export function createFsTreeWritableTree() {
  const audit: string[] = [];
  const tree = fsTree({
    docs: dir({
      "summary.md": text("Summary\n", { type: "text/markdown" })
    }, {
      writable: true
    })
  });

  tree.pre("write", (context) => {
    if (typeof context.content === "string") {
      context.content = context.content.trimEnd() + "\n";
    }
  });
  tree.post("write", ({ path }) => {
    audit.push(`write:${path}`);
  });
  tree.on("modified", ({ path }) => {
    audit.push(`modified:${path}`);
  });
  tree.on("created", ({ path }) => {
    audit.push(`created:${path}`);
  });

  return { tree, audit };
}

export async function runFsTreeWritableExample() {
  const { tree, audit } = createFsTreeWritableTree();
  await tree.write({}, "/docs/summary.md", "Updated summary");
  await tree.write({}, "/docs/new.md", "New file");
  const summary = await tree.read({}, "/docs/summary.md", { encoding: "utf8" });
  const created = await tree.read({}, "/docs/new.md", { encoding: "utf8" });

  return {
    summary: textContent(summary),
    created: textContent(created),
    audit
  };
}

function textContent(result: ActiveFSTreeReadResult): string {
  const content = typeof result === "object" && result !== null && "content" in result
    ? result.content
    : result;
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFsTreeWritableExample();
  console.log(result.summary);
  console.log(result.created);
  console.log(`fs-tree-writable audit: ${result.audit.join(", ")}`);
}
