import { describe, expect, it } from "vitest";
import {
  ActiveFSError,
  ActiveFSInvalidPathError,
  ActiveFSNotDirectoryError,
  ActiveFSNotFileError,
  ActiveFSNotMountedError,
  ActiveFSTreeError,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSReadOptions,
  type ActiveFSWatchEvent,
  type ActiveFSTree,
  activeFSContentByteLength,
  activeFSContentToBytes,
  createActiveFS,
  createActiveFSClient,
  copyActiveFSBytes,
  bytes,
  dir,
  file,
  fsTree,
  isActiveFSPathWithin,
  json,
  joinActiveFSPath,
  matchesActiveFSWatchRoot,
  normalizeActiveFSPath,
  parentActiveFSPath,
  sliceActiveFSContent,
  text
} from "@activefs/core";
import { createGeneratedTree, createMemoryTree } from "@activefs/testing";

function asText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

function treeReadText(result: unknown): string {
  const content = typeof result === "object" && result !== null && "content" in result
    ? (result as { content: string | Uint8Array }).content
    : result as string | Uint8Array;
  return asText(content);
}

function treeListPaths(result: unknown): string[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result
    .map((entry: { path?: string } | null) => entry?.path)
    .filter((path): path is string => Boolean(path))
    .sort();
}

describe("ActiveFS core path handling", () => {
  it("constructs public error subclasses with stable codes and paths", () => {
    expect(new ActiveFSNotMountedError("/repo")).toMatchObject({ code: "NOT_MOUNTED", path: "/repo" });
    expect(new ActiveFSNotDirectoryError("/repo/file.txt")).toMatchObject({ code: "NOT_DIRECTORY", path: "/repo/file.txt" });
    expect(new ActiveFSNotFileError("/repo")).toMatchObject({ code: "NOT_FILE", path: "/repo" });
    expect(new ActiveFSInvalidPathError()).toMatchObject({ code: "INVALID_PATH" });
    expect(new ActiveFSTreeError("/repo")).toMatchObject({ code: "SOURCE_ERROR", path: "/repo" });
  });

  it("normalizes paths", () => {
    expect(normalizeActiveFSPath("repo//./notes/../file.txt")).toBe("/repo/file.txt");
    expect(normalizeActiveFSPath("/repo/")).toBe("/repo");
    expect(normalizeActiveFSPath("/../../repo")).toBe("/repo");
    expect(normalizeActiveFSPath("repo\\nested\\file.txt")).toBe("/repo/nested/file.txt");
    expect(() => normalizeActiveFSPath(42 as unknown as string)).toThrow("must be a string");
  });

  it("joins paths with ActiveFS normalization rules", () => {
    expect(joinActiveFSPath("/repo/docs", "../readme.md")).toBe("/repo/readme.md");
    expect(joinActiveFSPath("/repo/docs", "/absolute.txt")).toBe("/absolute.txt");
  });

  it("evaluates path ancestry and watch roots consistently", () => {
    expect(parentActiveFSPath("/repo/docs/readme.md")).toBe("/repo/docs");
    expect(parentActiveFSPath("/repo")).toBe("/");
    expect(parentActiveFSPath("/")).toBe("/");
    expect(isActiveFSPathWithin("/repo", "/repo")).toBe(true);
    expect(isActiveFSPathWithin("/repo", "/repo/docs/readme.md")).toBe(true);
    expect(isActiveFSPathWithin("/repo", "/repository/readme.md")).toBe(false);
    expect(isActiveFSPathWithin("/", "/anything")).toBe(true);
    expect(matchesActiveFSWatchRoot("/repo", "/repo/readme.md")).toBe(true);
    expect(matchesActiveFSWatchRoot("/repo", "/repo/docs/readme.md")).toBe(false);
    expect(matchesActiveFSWatchRoot("/repo", "/repo/docs/readme.md", { recursive: true })).toBe(true);
    expect(matchesActiveFSWatchRoot("/", "/repo")).toBe(true);
    expect(matchesActiveFSWatchRoot("/", "/repo/docs/readme.md")).toBe(false);
    expect(matchesActiveFSWatchRoot("/", "/repo/docs/readme.md", { recursive: true })).toBe(true);
  });

  it("normalizes ActiveFS content helpers around byte-oriented reads", () => {
    const source = new Uint8Array([0, 1, 2, 3]);
    const copied = copyActiveFSBytes(source);
    expect(copied).not.toBe(source);
    expect([...copied]).toEqual([0, 1, 2, 3]);
    expect(new TextDecoder().decode(activeFSContentToBytes("hello"))).toBe("hello");
    expect(activeFSContentByteLength("hello")).toBe(5);
    expect(sliceActiveFSContent("hello", { offset: 1, length: 3 })).toBe("ell");
    expect(sliceActiveFSContent("hello", { offset: 1, length: 3, encoding: "base64" })).toBe("ZWxs");
    const slicedBytes = sliceActiveFSContent(source, { offset: 1, length: 2 }) as Uint8Array;
    expect([...slicedBytes]).toEqual([1, 2]);
    expect(sliceActiveFSContent(source, { offset: 1, length: 2, encoding: "utf8" })).toBe("\u0001\u0002");
  });

  it("uses longest-prefix tree resolution", async () => {
    const fs = createActiveFS()
      .mount("/repo", createMemoryTree({ "/file.txt": "repo" }))
      .mount("/repo/generated", createMemoryTree({ "/file.txt": "generated" }));

    const nested = await fs.read({}, "/repo/generated//./file.txt");
    const parent = await fs.read({}, "/repo/generated/../file.txt");

    expect(asText(nested.content)).toBe("generated");
    expect(asText(parent.content)).toBe("repo");
  });

  it("lists virtual mount parents and rejects unmounted operations", async () => {
    const fs = createActiveFS()
      .mount("/sources/left", createMemoryTree({ "/a.txt": "left" }))
      .mount("/sources/right", createMemoryTree({ "/b.txt": "right" }));

    await expect(fs.stat({}, "/sources")).resolves.toMatchObject({
      path: "/sources",
      kind: "directory"
    });
    await expect(fs.list({}, "/sources")).resolves.toEqual([
      expect.objectContaining({ name: "left", path: "/sources/left" }),
      expect.objectContaining({ name: "right", path: "/sources/right" })
    ]);
    await expect(fs.read({}, "/missing.txt")).rejects.toMatchObject({ code: "NOT_MOUNTED" });
    await expect(fs.list({}, "/unknown")).rejects.toMatchObject({ code: "NOT_MOUNTED" });
  });
});

describe("ActiveFS fsTree tree authoring", () => {
  it("serves sparse path maps, nested declarations, and convenience file helpers", async () => {
    let jsonReads = 0;
    const tree = fsTree({
      "/README.md": file({ content: "# Docs\n", type: "text/markdown" }),
      docs: dir({
        "intro.md": text("Intro\n", { type: "text/markdown" }),
        nested: {
          "more.md": text("More\n")
        }
      }, {
        cache: { ttlMs: 10_000 }
      }),
      data: {
        "status.json": json(() => {
          jsonReads += 1;
          return { ok: true };
        })
      },
      bin: {
        "sample.bin": bytes(new Uint8Array([0, 1, 2]))
      }
    });

    const root = await tree.list({}, "/");
    const docs = await tree.info({}, "/docs");
    const readme = await tree.read({}, "/README.md");
    expect(jsonReads).toBe(0);
    const status = await tree.read({}, "/data/status.json", { encoding: "utf8" });
    expect(jsonReads).toBe(1);
    const binary = await tree.read({}, "/bin/sample.bin");
    const search = await tree.search({}, "/", { pattern: "Intro" });

    expect(treeListPaths(root)).toEqual([
      "/README.md",
      "/bin",
      "/data",
      "/docs"
    ]);
    expect(docs).toMatchObject({ kind: "directory", path: "/docs" });
    expect(treeReadText(readme)).toBe("# Docs\n");
    expect(treeReadText(status)).toContain("\"ok\": true");
    expect([...((typeof binary === "object" && binary !== null && "content" in binary ? binary.content : binary) as Uint8Array)]).toEqual([0, 1, 2]);
    expect(search.matches).toEqual([
      expect.objectContaining({ path: "/docs/intro.md" })
    ]);
  });

  it("supports path patterns, params, and path-handle setters", async () => {
    const tree = fsTree({
      "/users/:id.md": file({
        enumerable: false,
        read: ({ params }) => `# ${params.id}\n`
      }),
      "/reports/:id": dir({
        "summary.md": file({
          read: ({ params }) => `report ${params.id}\n`
        })
      })
    });

    tree.path("/notes/:id")
      .file({
        type: "text/markdown",
        enumerable: false,
        writable: true,
        deletable: true
      })
      .setInfo(({ params, path }) => ({
        path,
        name: `${params.id}.md`,
        kind: "file",
        type: "text/markdown"
      }))
      .setRead(({ params }) => `note ${params.id}\n`)
      .setSearch(({ path, query }) => ({
        matches: [{ path, excerpt: query?.pattern, score: 1 }],
        strategy: "source"
      }));
    tree.path("/teams/:id")
      .setList(({ path }) => [
        {
          path: `${path}/README.md`,
          name: "README.md",
          kind: "file",
          type: "text/markdown"
        }
      ]);

    await expect(tree.read({}, "/users/ada.md")).resolves.toBe("# ada\n");
    await expect(tree.read({}, "/reports/q2/summary.md")).resolves.toBe("report q2\n");
    await expect(tree.info({}, "/notes/ada")).resolves.toMatchObject({
      name: "ada.md",
      type: "text/markdown"
    });
    await expect(tree.search({}, "/notes/ada", { pattern: "note" })).resolves.toMatchObject({
      strategy: "source",
      matches: [expect.objectContaining({ path: "/notes/ada" })]
    });
    await expect(tree.list({}, "/teams/core")).resolves.toEqual([
      expect.objectContaining({ path: "/teams/core/README.md" })
    ]);
  });

  it("supports declaration and path-handle fluent setters", async () => {
    const events: string[] = [];
    const hook = ({ path }: { path: ActiveFSPath }) => {
      events.push(path);
    };
    const mutation = ({ path }: { path: ActiveFSPath }) => ({
      modified: path,
      data: { path }
    });
    const searchCommand = ({ path }: { path: ActiveFSPath }) => ({
      matches: [{ path, excerpt: "command search" }],
      complete: true,
      strategy: "source" as const
    });
    const readCommand = ({ path }: { path: ActiveFSPath }) => `command:${path}`;
    const listCommand = ({ path }: { path: ActiveFSPath }) => ([{
      path,
      name: path.split("/").at(-1) ?? "",
      kind: "directory" as const
    }]);

    const document = file()
      .setInfo(({ path }) => ({ path, name: "doc.txt", kind: "file", size: 3 }))
      .setRead(() => "doc")
      .setSearch(({ path, query }) => ({
        matches: [{ path, excerpt: query?.pattern ?? "", score: 1 }],
        strategy: "source"
      }))
      .setWalk(({ path }) => [{ path, name: "doc.txt", kind: "file" }])
      .setWrite(mutation)
      .setRemove(mutation)
      .setTruncate(mutation)
      .setUpdateInfo(mutation)
      .setGrep(searchCommand)
      .setRg(searchCommand)
      .setCat(readCommand)
      .setHead(readCommand)
      .setTail(readCommand)
      .setSed(readCommand)
      .pre("read", hook)
      .post("read", hook)
      .on("modified", () => {
        events.push("file-change");
      });

    const folder = dir()
      .setInfo(({ path }) => ({ path, name: "folder", kind: "directory" }))
      .setList(({ path }) => [{ path: `${path}/child.txt`, name: "child.txt", kind: "file" }])
      .setRead(() => "folder-as-file")
      .setSearch(({ path }) => ({ matches: [{ path, excerpt: "folder", score: 1 }], strategy: "source" }))
      .setWalk(({ path }) => [{ path, name: "folder", kind: "directory" }])
      .setWrite(mutation)
      .setRemove(mutation)
      .setMove(mutation)
      .setCopy(mutation)
      .setMakeDir(mutation)
      .setUpdateInfo(mutation)
      .setGrep(searchCommand)
      .setRg(searchCommand)
      .setFind(listCommand)
      .setLs(listCommand)
      .pre("list", hook)
      .post("list", hook)
      .on("modified", () => {
        events.push("dir-change");
      });

    const tree = fsTree({ "/doc.txt": document, "/folder": folder });

    tree.path("/builder/file.txt")
      .setInfo(({ path }) => ({ path, name: "file.txt", kind: "file" }))
      .setRead(() => "builder")
      .setSearch(({ path }) => ({ matches: [{ path, excerpt: "builder", score: 1 }], strategy: "source" }))
      .setWrite(mutation)
      .setRemove(mutation)
      .setTruncate(mutation)
      .setUpdateInfo(mutation)
      .setGrep(searchCommand)
      .setRg(searchCommand)
      .setCat(readCommand)
      .setHead(readCommand)
      .setTail(readCommand)
      .setSed(readCommand)
      .pre("read", hook)
      .post("read", hook)
      .on("modified", () => {
        events.push("builder-file-change");
      });

    tree.path("/builder/dir")
      .setList(({ path }) => [{ path: `${path}/child.txt`, name: "child.txt", kind: "file" }])
      .setWalk(({ path }) => [{ path, name: "dir", kind: "directory" }])
      .setMove(mutation)
      .setCopy(mutation)
      .setMakeDir(mutation)
      .setFind(listCommand)
      .setLs(listCommand);

    await expect(tree.read({}, "/doc.txt")).resolves.toBe("doc");
    await expect(tree.list({}, "/folder")).resolves.toEqual([
      expect.objectContaining({ path: "/folder/child.txt" })
    ]);
    await expect(tree.read({}, "/builder/file.txt")).resolves.toBe("builder");
    await expect(tree.list({}, "/builder/dir")).resolves.toEqual([
      expect.objectContaining({ path: "/builder/dir/child.txt" })
    ]);
    await expect(tree.search({}, "/doc.txt", { pattern: "doc" })).resolves.toMatchObject({
      strategy: "source"
    });
    await expect(tree.command({}, "cat", "/doc.txt", {})).resolves.toBe("command:/doc.txt");
    await expect(tree.command({}, "find", "/folder", {})).resolves.toEqual([
      expect.objectContaining({ path: "/folder" })
    ]);
    expect(events).toContain("/doc.txt");
  });

  it("accepts meta as tree-authoring metadata sugar", async () => {
    type Meta = { tag: string };
    const meta = (tag: string): Meta => ({ tag });
    const changes: Array<{ meta?: Meta; data?: Meta }> = [];
    const tree = fsTree<unknown, Meta>({
      "/declared.md": file<unknown, Meta>({
        content: "declared\n",
        meta: meta("declared")
      }),
      "/alternate.md": file<unknown, Meta>({
        content: "alternate\n",
        data: meta("alternate")
      }),
      docs: dir<unknown, Meta>({}, {
        meta: meta("directory")
      }),
      "/read-meta.md": file<unknown, Meta>({
        read: () => ({
          content: "read\n",
          meta: meta("read-result"),
          info: {
            path: "/read-meta.md",
            kind: "file",
            meta: meta("read-info")
          }
        })
      }),
      "/search-meta.md": file<unknown, Meta>({
        content: "needle\n",
        search: ({ path }) => ({
          matches: [{ path, excerpt: "needle", meta: meta("search-match") }]
        })
      }),
      "/mutation.md": file<unknown, Meta>({
        content: "old\n",
        writable: true,
        write: () => ({ modified: "/mutation.md", meta: meta("mutation") })
      })
    });
    tree.onChange((event) => {
      changes.push({ meta: event.meta, data: event.data });
    });
    const fs = createActiveFS<unknown, Meta>().mount("/", tree);

    await expect(fs.stat({}, "/declared.md")).resolves.toMatchObject({
      meta: meta("declared")
    });
    await expect(fs.stat({}, "/alternate.md")).resolves.toMatchObject({
      meta: meta("alternate")
    });
    await expect(fs.stat({}, "/docs")).resolves.toMatchObject({
      meta: meta("directory")
    });
    await expect(fs.read({}, "/read-meta.md")).resolves.toMatchObject({
      meta: meta("read-result"),
      stat: expect.objectContaining({ meta: meta("read-info") })
    });
    await expect(fs.search({}, "/search-meta.md", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ meta: meta("search-match") })]
    });
    await expect(fs.write({}, "/mutation.md", "new\n")).resolves.toMatchObject({
      meta: meta("mutation")
    });
    expect(changes.at(-1)).toEqual({
      meta: meta("mutation"),
      data: meta("mutation")
    });
  });

  it("applies handler precedence and optional command handlers before semantic mappings", async () => {
    const tree = fsTree({
      docs: dir({
        "exact.txt": file({
          content: "needle in text\n",
          search: () => ({
            matches: [{ path: "/docs/exact.txt", excerpt: "file" }],
            strategy: "source"
          })
        }),
        "plain.txt": text("needle in plain\n")
      }, {
        search: ({ path }) => ({
          matches: [{ path, excerpt: "directory" }],
          strategy: "source"
        }),
        rg: ({ path }) => ({
          matches: [{ path, excerpt: "directory rg" }],
          complete: true,
          strategy: "source"
        })
      })
    }, {
      search: ({ path }) => ({
        matches: [{ path, excerpt: "tree" }],
        strategy: "source"
      })
    });

    await expect(tree.search({}, "/docs/exact.txt", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ excerpt: "file" })]
    });
    await expect(tree.search({}, "/docs/missing.txt", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ excerpt: "directory" })]
    });
    await expect(tree.search({}, "/other", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ excerpt: "tree" })]
    });
    await expect(tree.command({}, "rg", "/docs", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ excerpt: "directory rg" })]
    });
    await expect(tree.command({}, "grep", "/docs/plain.txt", { pattern: "needle" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/docs/plain.txt" })]
    });
  });

  it("provides real default mappings for head, tail, sed, grep, and Node client sugar", async () => {
    const tree = fsTree({
      "notes.txt": text("alpha\nbeta needle\ngamma needle\n")
    });
    const filesystem = createActiveFS().mount("/repo", tree);
    const client = createActiveFSClient(filesystem);

    await expect(client.head("/repo/notes.txt", { lines: 2 })).resolves.toMatchObject({
      content: "alpha\nbeta needle\n"
    });
    await expect(client.tail("/repo/notes.txt", { lines: 1 })).resolves.toMatchObject({
      content: "gamma needle\n"
    });
    await expect(client.sed("/repo/notes.txt", {
      pattern: "needle",
      replacement: "match",
      global: true
    })).resolves.toMatchObject({
      content: "alpha\nbeta match\ngamma match\n"
    });
    await expect(client.grep("/repo", { pattern: "needle", maxResults: 1 })).resolves.toMatchObject({
      complete: false,
      strategy: "scan",
      incompleteReasons: ["max-results"]
    });
  });

  it("runs writable defaults, granular permissions, hooks, committed events, and watch events", async () => {
    const events: string[] = [];
    const posts: string[] = [];
    const watched: ActiveFSWatchEvent[] = [];
    const tree = fsTree({
      scratch: dir({}, { writable: true }),
      protected: dir({
        "locked.txt": text("locked\n")
      }, {
        writable: true,
        deletable: false
      })
    });

    tree.pre("write", (context) => {
      if (typeof context.content === "string") {
        context.content = context.content.toUpperCase();
      }
    });
    tree.post("write", ({ path }) => {
      posts.push(path);
    });
    tree.onChange((event) => {
      events.push(`${event.type}:${event.path}`);
    });
    const subscription = await tree.watch({}, "/", (event) => watched.push(event), {
      recursive: true
    });

    await tree.write({}, "/scratch/a.txt", "hello");
    await tree.write({}, "/scratch/a.txt", "updated");
    await tree.makeDir({}, "/scratch/nested");
    await tree.copy({}, "/scratch/a.txt", "/scratch/nested/copy.txt");
    await tree.move({}, "/scratch/nested/copy.txt", "/scratch/nested/moved.txt");
    await tree.truncate({}, "/scratch/a.txt", { length: 3 });
    await tree.updateInfo({}, "/scratch/nested/moved.txt", { mtimeMs: 42 });
    await tree.remove({}, "/scratch/nested/moved.txt");

    const read = await tree.read({}, "/scratch/a.txt", { encoding: "utf8" });
    const movedInfo = await tree.info({}, "/scratch/nested/moved.txt");

    await expect(tree.remove({}, "/protected/locked.txt")).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    await subscription.close();

    expect(treeReadText(read)).toBe("UPD");
    expect(movedInfo).toBeNull();
    expect(posts).toEqual(["/scratch/a.txt", "/scratch/a.txt"]);
    expect(events).toEqual(expect.arrayContaining([
      "created:/scratch/a.txt",
      "modified:/scratch/a.txt",
      "created:/scratch/nested",
      "copied:/scratch/nested/copy.txt",
      "moved:/scratch/nested/moved.txt",
      "removed:/scratch/nested/moved.txt"
    ]));
    expect(watched.map((event) => `${event.type}:${event.path}`)).toEqual(expect.arrayContaining([
      "create:/scratch/a.txt",
      "change:/scratch/a.txt",
      "delete:/scratch/nested/moved.txt"
    ]));
  });

  it("separates operation hooks from committed change descriptors", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const tree = fsTree();
    tree.onChange((event) => {
      events.push(`${event.type}:${event.path}`);
    });
    tree.post("write", ({ path }) => {
      writes.push(path);
    });

    tree.set("/server.txt", text("server\n"));
    tree.path("/logs/append")
      .file({ writable: true })
      .setWrite(() => ({ invalidate: null }));
    tree.path("/indexed")
      .file({ writable: true })
      .setWrite(() => ({ invalidate: "/search-index" }));

    await tree.write({}, "/logs/append", "external");
    await tree.write({}, "/indexed", "external");

    expect(writes).toEqual(["/logs/append", "/indexed"]);
    expect(events).toEqual([
      "created:/server.txt",
      "created:/logs/append",
      "created:/indexed",
      "invalidated:/search-index"
    ]);
  });

  it("does not emit committed changes for reads or rejected pre hooks", async () => {
    const events: string[] = [];
    const posts: string[] = [];
    const tree = fsTree({
      "/README.md": text("Hello ActiveFS\n"),
      scratch: dir({}, { writable: true })
    });
    tree.onChange((event) => {
      events.push(`${event.type}:${event.path}`);
    });
    tree.pre("write", ({ path }) => {
      if (path.endsWith("/blocked.txt")) {
        throw new ActiveFSError("FORBIDDEN", `Blocked write: ${path}`, { path });
      }
    });
    tree.post("write", ({ path }) => {
      posts.push(path);
    });

    await tree.info({}, "/README.md");
    await tree.list({}, "/");
    await tree.read({}, "/README.md");
    await tree.search({}, "/", { pattern: "ActiveFS" });
    await expect(tree.write({}, "/scratch/blocked.txt", "no")).rejects.toMatchObject({
      code: "FORBIDDEN"
    });

    expect(events).toEqual([]);
    expect(posts).toEqual([]);
    await expect(tree.info({}, "/scratch/blocked.txt")).resolves.toBeNull();
  });
});

describe("ActiveFS core search", () => {
  it("uses the same default matching and exact limit semantics for tree scans", async () => {
    const tree = fsTree({
      "notes.txt": text("Needle one\nneedle two\nneedle three\n")
    });
    const filesystem = createActiveFS().mount("/docs", tree);

    const defaultSearch = await filesystem.search({}, "/docs", { pattern: "needle" });
    const caseSensitiveSearch = await filesystem.search({}, "/docs", {
      pattern: "needle",
      caseSensitive: true
    });
    const exactLimit = await createActiveFS()
      .mount("/one", fsTree({ "only.txt": text("needle once\n") }))
      .search({}, "/one", { pattern: "needle", maxResults: 1 });

    expect(defaultSearch.matches.map((match) => match.line)).toEqual([1, 2, 3]);
    expect(caseSensitiveSearch.matches.map((match) => match.line)).toEqual([2, 3]);
    expect(exactLimit).toMatchObject({ complete: true, strategy: "scan" });
    expect(exactLimit.matches).toHaveLength(1);
  });

  it("honors context search limits, deadlines, and cancellation during scans", async () => {
    const filesystem = createActiveFS().mount("/docs", fsTree({
      "notes.txt": text("needle one\nneedle two\n")
    }));
    const controller = new AbortController();
    controller.abort(new Error("stop search"));

    await expect(filesystem.search(
      { maxSearchResults: 1 },
      "/docs",
      { pattern: "needle" }
    )).resolves.toMatchObject({
      complete: false,
      incompleteReasons: ["max-results"],
      matches: [expect.objectContaining({ line: 1 })]
    });
    await expect(filesystem.search(
      { deadlineMs: Date.now() - 1 },
      "/docs",
      { pattern: "needle" }
    )).resolves.toMatchObject({
      complete: false,
      incompleteReasons: ["timeout"],
      matches: []
    });
    await expect(filesystem.search(
      { signal: controller.signal },
      "/docs",
      { pattern: "needle" }
    )).rejects.toThrow("stop search");
  });

  it("uses tree.search when available", async () => {
    let calls = 0;
    const tree = fsTree({}, {
      search: async () => {
        calls += 1;
        return {
          matches: [{ path: "/hit.txt", line: 1, column: 1, excerpt: "needle" }]
        };
      }
    });

    const fs = createActiveFS().mount("/fast", tree);
    const result = await fs.search({}, "/fast", { pattern: "needle" });

    expect(calls).toBe(1);
    expect(result.matches).toEqual([
      { path: "/fast/hit.txt", line: 1, column: 1, excerpt: "needle" }
    ]);
  });

  it("scans through list/read when tree.search is unavailable", async () => {
    const tree = createMemoryTree({
      "/a.txt": "needle in a",
      "/nested/b.txt": "needle in b"
    });
    let listCalls = 0;
    let readCalls = 0;
    const wrapped: ActiveFSTree = {
      ...tree,
      list: async (context: ActiveFSContext, path: ActiveFSPath) => {
        listCalls += 1;
        return tree.list(context, path);
      },
      read: async (context: ActiveFSContext, path: ActiveFSPath, options?: ActiveFSReadOptions) => {
        readCalls += 1;
        return tree.read(context, path, options);
      }
    };

    const fs = createActiveFS().mount("/docs", wrapped);
    const result = await fs.search({}, "/docs", { pattern: "needle" });

    expect(listCalls).toBeGreaterThan(0);
    expect(readCalls).toBe(2);
    expect(result.matches.map((match) => match.path).sort()).toEqual([
      "/docs/a.txt",
      "/docs/nested/b.txt"
    ]);
  });

  it("does not recursively enumerate non-enumerable generated entries by default", async () => {
    const fs = createActiveFS().mount(
      "/generated",
      createGeneratedTree({
        files: {
          "/visible.txt": "visible needle"
        },
        dynamicFiles: {
          "/dynamic/secret.txt": "secret needle"
        }
      })
    );

    const defaultSearch = await fs.search({}, "/generated", { pattern: "needle" });
    const explicitSearch = await fs.search({}, "/generated", {
      pattern: "needle",
      includeNonEnumerable: true
    });
    const directRead = await fs.read({}, "/generated/dynamic/secret.txt");

    expect(defaultSearch.matches.map((match) => match.path)).toEqual(["/generated/visible.txt"]);
    expect(explicitSearch.matches.map((match) => match.path).sort()).toEqual([
      "/generated/dynamic/secret.txt",
      "/generated/visible.txt"
    ]);
    expect(asText(directRead.content)).toBe("secret needle");
  });

  it("keeps non-enumerable generated entries out of tree search by default", async () => {
    const fs = createActiveFS().mount(
      "/generated",
      createGeneratedTree({
        searchable: true,
        files: {
          "/visible.txt": "visible needle"
        },
        dynamicFiles: {
          "/users/ada.md": "dynamic needle"
        }
      })
    );

    const defaultSearch = await fs.search({}, "/generated", { pattern: "needle" });
    const explicitSearch = await fs.search({}, "/generated", {
      pattern: "needle",
      includeNonEnumerable: true
    });

    expect(defaultSearch.matches.map((match) => match.path)).toEqual(["/generated/visible.txt"]);
    expect(explicitSearch.matches.map((match) => match.path).sort()).toEqual([
      "/generated/users/ada.md",
      "/generated/visible.txt"
    ]);
  });

  it("scans exposed files when tree search reports unsupported", async () => {
    const tree = createMemoryTree({
      "/scan.txt": "needle"
    });
    const fs = createActiveFS().mount("/repo", {
      ...tree,
      search: async () => {
        throw new ActiveFSError("UNSUPPORTED", "search disabled");
      }
    } as ActiveFSTree);

    await expect(fs.search({}, "/repo", { pattern: "needle" })).resolves.toMatchObject({
      strategy: "scan",
      matches: [expect.objectContaining({ path: "/repo/scan.txt" })]
    });
  });

  it("returns readable scan matches and labels paths that become unreadable", async () => {
    const tree = createMemoryTree({
      "/good.txt": "needle from readable file",
      "/secret.txt": "needle from denied file"
    });
    const wrapped: ActiveFSTree = {
      ...tree,
      read: async (context, path, options) => {
        if (path === "/secret.txt") {
          throw new ActiveFSError("FORBIDDEN", "read denied", { path });
        }
        return tree.read(context, path, options);
      }
    };
    const filesystem = createActiveFS().mount("/repo", wrapped);

    await expect(filesystem.search({}, "/repo", { pattern: "needle" })).resolves.toMatchObject({
      complete: false,
      strategy: "scan",
      incompleteReasons: ["unreadable-path"],
      matches: [expect.objectContaining({ path: "/repo/good.txt" })]
    });
  });

  it("reports mixed when one namespace combines source search and scanning", async () => {
    const filesystem = createActiveFS()
      .mount("/indexed", createMemoryTree({
        searchable: true,
        files: { "/source.txt": "needle from source search" }
      }))
      .mount("/plain", createMemoryTree({
        files: { "/scan.txt": "needle from ActiveFS scan" }
      }));

    await expect(filesystem.search({}, "/", { pattern: "needle" })).resolves.toMatchObject({
      strategy: "mixed",
      complete: true,
      matches: [
        expect.objectContaining({ path: "/indexed/source.txt" }),
        expect.objectContaining({ path: "/plain/scan.txt" })
      ]
    });
  });

  it("composes search and command results across a root mount and nested mount", async () => {
    let nestedGrepCalls = 0;
    let nestedRgCalls = 0;
    const root = fsTree({
      "root.txt": text("needle from root\n"),
      child: dir({
        "shadowed.txt": text("needle from shadowed root path\n")
      })
    });
    const nested = fsTree({
      "child.txt": text("needle from nested mount\n")
    }, {
      search: ({ path }) => ({
        matches: [{ path: path === "/" ? "/child.txt" : path, excerpt: "nested search" }],
        strategy: "source"
      }),
      grep: ({ path }) => {
        nestedGrepCalls += 1;
        return {
          matches: [{ path: path === "/" ? "/child.txt" : path, excerpt: "nested grep" }],
          complete: true,
          strategy: "source"
        };
      },
      rg: ({ path }) => {
        nestedRgCalls += 1;
        return {
          matches: [{ path: path === "/" ? "/child.txt" : path, excerpt: "nested rg" }],
          complete: true,
          strategy: "source"
        };
      }
    });
    const filesystem = createActiveFS()
      .mount("/", root)
      .mount("/child", nested);

    const listed = await filesystem.command({}, "ls", "/", {});
    const searched = await filesystem.search({}, "/", { pattern: "needle" });
    const grepped = await filesystem.command({}, "grep", "/", { pattern: "needle" });
    const rg = await filesystem.command({}, "rg", "/", { pattern: "needle" });
    const found = await filesystem.command({}, "find", "/", {});

    expect(listed.map((entry) => entry.path)).toEqual(["/child", "/root.txt"]);
    expect(searched).toMatchObject({ strategy: "mixed", complete: true });
    expect(searched.matches.map((match) => match.path).sort()).toEqual([
      "/child/child.txt",
      "/root.txt"
    ]);
    expect(grepped).toMatchObject({ strategy: "mixed", complete: true });
    expect(grepped.matches.map((match) => match.path).sort()).toEqual([
      "/child/child.txt",
      "/root.txt"
    ]);
    expect(nestedGrepCalls).toBe(1);
    expect(rg).toMatchObject({ strategy: "mixed", complete: true });
    expect(rg.matches.map((match) => match.path).sort()).toEqual([
      "/child/child.txt",
      "/root.txt"
    ]);
    expect(nestedRgCalls).toBe(1);
    expect(found.map((entry) => entry.path).sort()).toEqual([
      "/",
      "/child",
      "/child/child.txt",
      "/root.txt"
    ]);
  });
});

describe("ActiveFS core write and watch routing", () => {
  it("exposes an fs-promises-like logical client over the core operation engine", async () => {
    const tree = createMemoryTree({
      files: { "/existing.txt": "abcdef" },
      writable: true,
      watchable: true
    });
    const fs = createActiveFS().mount("/repo", tree);
    const operations: string[] = [];
    const activity: string[] = [];
    const client = createActiveFSClient(fs, {
      context: { meta: { requestId: "client-1" } },
      onOperation: (event) => {
        operations.push(`${event.operation}:${event.path}:${event.result}`);
      },
      onActivity: (event) => {
        activity.push(event.targetPath ? `${event.path}->${event.targetPath}` : event.path);
      }
    });

    await client.mkdir("/repo/notes");
    await client.writeFile("/repo/notes/a.txt", "hello client");
    await client.copyFile("/repo/notes/a.txt", "/repo/notes/b.txt");
    await client.rename("/repo/notes/b.txt", "/repo/notes/c.txt");
    await client.truncate("/repo/existing.txt", 2);
    await client.utimes("/repo/notes/c.txt", 10, 20);

    const entries = await client.readdir("/repo/notes");
    const content = await client.readFile("/repo/notes/a.txt", { encoding: "utf8" });
    const stat = await client.stat("/repo/notes/c.txt");
    const search = await client.search("/repo", { pattern: "hello" });
    const subscription = await client.watch("/repo", () => undefined);
    await subscription.close();

    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "/repo/notes/a.txt",
      "/repo/notes/c.txt"
    ]);
    expect(content).toBe("hello client");
    expect(stat).toMatchObject({ path: "/repo/notes/c.txt", mtimeMs: 20 });
    expect(search.matches.map((match) => match.path).sort()).toEqual([
      "/repo/notes/a.txt",
      "/repo/notes/c.txt"
    ]);
    expect(operations).toEqual(expect.arrayContaining([
      "mkdir:/repo/notes:ok",
      "writeFile:/repo/notes/a.txt:ok",
      "copyFile:/repo/notes/a.txt:ok",
      "rename:/repo/notes/b.txt:ok",
      "truncate:/repo/existing.txt:ok",
      "utimes:/repo/notes/c.txt:ok",
      "readdir:/repo/notes:ok",
      "readFile:/repo/notes/a.txt:ok",
      "stat:/repo/notes/c.txt:ok",
      "search:/repo:ok"
    ]));
    expect(activity).toContain("/repo/notes/b.txt->/repo/notes/c.txt");

    await client.rm("/repo/notes/a.txt");
    await client.rmdir("/repo/notes", { recursive: true });
    await expect(client.stat("/repo/notes/a.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("routes writes to the mounted tree path and maps returned stat paths", async () => {
    const tree = createMemoryTree({
      files: { "/existing.txt": "old" },
      writable: true
    });
    const fs = createActiveFS().mount("/repo", tree);

    const result = await fs.write({}, "/repo/nested/new.txt", "new content", {
      contentType: "text/plain",
      meta: { requestId: "write-1" }
    });
    const read = await fs.read({}, "/repo/nested/new.txt", { encoding: "utf8" });

    expect(result).toMatchObject({
      created: true,
      stat: {
        path: "/repo/nested/new.txt",
        kind: "file",
        mimeType: "text/plain"
      },
      meta: { requestId: "write-1" }
    });
    expect(asText(read.content)).toBe("new content");
  });

  it("maps tree watch events to mounted paths", async () => {
    const tree = createMemoryTree({
      files: { "/a.txt": "alpha" },
      writable: true,
      watchable: true
    });
    const fs = createActiveFS().mount("/repo", tree);
    const events: ActiveFSWatchEvent[] = [];

    const subscription = await fs.watch({}, "/repo", (event) => events.push(event), {
      recursive: true
    });
    await fs.write({}, "/repo/a.txt", "changed");
    await subscription.close();

    expect(events).toEqual([
      expect.objectContaining({
        type: "change",
        path: "/repo/a.txt",
        stat: expect.objectContaining({ path: "/repo/a.txt" })
      })
    ]);
  });

  it("watches descendant mounts from a virtual parent", async () => {
    const left = createMemoryTree({
      files: { "/a.txt": "alpha" },
      writable: true,
      watchable: true
    });
    const right = createMemoryTree({
      files: { "/b.txt": "beta" },
      writable: true,
      watchable: true
    });
    const fs = createActiveFS()
      .mount("/sources/left", left)
      .mount("/sources/right", right);
    const events: ActiveFSWatchEvent[] = [];

    const subscription = await fs.watch({}, "/sources", (event) => events.push(event), {
      recursive: true
    });
    await fs.write({}, "/sources/right/b.txt", "changed");
    await subscription.close();

    expect(events.map((event) => event.path)).toEqual(["/sources/right/b.txt"]);
  });

  it("routes normal filesystem mutations through the mounted tree path", async () => {
    const tree = createMemoryTree({
      files: { "/existing.txt": "abcdef" },
      writable: true
    });
    const fs = createActiveFS().mount("/repo", tree);

    await fs.mkdir({}, "/repo/newdir");
    await fs.write({}, "/repo/newdir/file.txt", "hello");
    await fs.copy({}, "/repo/newdir/file.txt", "/repo/newdir/copy.txt");
    await fs.rename({}, "/repo/newdir/copy.txt", "/repo/newdir/renamed.txt");
    await fs.truncate({}, "/repo/existing.txt", { length: 3 });
    await fs.updateMetadata({}, "/repo/newdir/renamed.txt", { mtimeMs: 42 });

    const entries = await fs.list({}, "/repo/newdir");
    const truncated = await fs.read({}, "/repo/existing.txt", { encoding: "utf8" });
    const renamed = await fs.stat({}, "/repo/newdir/renamed.txt");

    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "/repo/newdir/file.txt",
      "/repo/newdir/renamed.txt"
    ]);
    expect(asText(truncated.content)).toBe("abc");
    expect(renamed).toMatchObject({ path: "/repo/newdir/renamed.txt", mtimeMs: 42 });

    await fs.delete({}, "/repo/newdir/file.txt");
    await fs.rmdir({}, "/repo/newdir", { recursive: true });

    await expect(fs.stat({}, "/repo/newdir/file.txt")).resolves.toBeNull();
  });

  it("rejects renames across different mounted trees", async () => {
    const fs = createActiveFS()
      .mount("/left", createMemoryTree({ files: { "/a.txt": "a" }, writable: true }))
      .mount("/right", createMemoryTree({ writable: true }));

    await expect(fs.rename({}, "/left/a.txt", "/right/a.txt")).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });
  });

  it("rejects unsupported optional operations and emits client error hooks", async () => {
    const fs = createActiveFS().mount("/readonly", createMemoryTree({ "/a.txt": "a" }));
    const events: string[] = [];
    const client = createActiveFSClient(fs, {
      onOperation: (event) => {
        events.push(`${event.operation}:${event.path}:${event.result}`);
      }
    });

    await expect(fs.write({}, "/readonly/a.txt", "b")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(fs.watch({}, "/readonly", () => undefined)).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.stat("/readonly/missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(events).toContain("stat:/readonly/missing.txt:error");
  });
});
