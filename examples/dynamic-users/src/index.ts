import {
  ActiveFSError,
  activeFSContentByteLength,
  dir,
  fsTree,
  type ActiveFSPath,
  type ActiveFSTree,
  type ActiveFSTreeInfo,
  type ActiveFSTreeReadResult
} from "@activefs/core";

export function createDynamicUsersTree(): ActiveFSTree {
  const tree = fsTree({
    users: dir({}, {
      enumerable: false,
      list: () => [fileInfo("ada")]
    })
  }, {
    name: "dynamic-users"
  });

  tree.path("/users/:id.md")
    .file({ enumerable: false, type: "text/markdown" })
    .setInfo(({ params, path }) => fileInfo(params.id, path))
    .setRead(({ params, path }) => readUser(params.id, path));

  return tree;
}

export async function runDynamicUsersExample() {
  const tree = createDynamicUsersTree();
  const direct = await tree.read({}, "/users/ada.md");
  const recursive = await tree.search({}, "/", { pattern: "Ada", includeNonEnumerable: true });
  return {
    direct: asText(direct),
    recursiveMatches: recursive.matches.length,
    recursivePaths: recursive.matches.map((match) => match.path)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runDynamicUsersExample();
  console.log(result.direct);
  console.log(`recursive matches: ${result.recursiveMatches}`);
}

function readUser(userId: string, path: ActiveFSPath): ActiveFSTreeReadResult {
  if (!/^[a-z0-9-]+$/i.test(userId)) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  return {
    content: renderUser(userId),
    info: fileInfo(userId, path)
  };
}

function renderUser(userId: string): string {
  return `# ${titleCase(userId)}\n\nThis profile is generated for /users/${userId}.md.\n`;
}

function fileInfo(userId: string, path: ActiveFSPath = `/users/${userId}.md`): NonNullable<ActiveFSTreeInfo> {
  return {
    name: `${userId}.md`,
    path,
    kind: "file",
    enumerable: false,
    type: "text/markdown",
    size: activeFSContentByteLength(renderUser(userId))
  };
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function asText(result: ActiveFSTreeReadResult): string {
  const content = typeof result === "object" && result !== null && "content" in result
    ? result.content
    : result;
  if (typeof content === "string") {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new TextDecoder().decode(content);
  }
  return new TextDecoder().decode(content);
}
