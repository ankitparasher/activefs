import { describe, expect, it } from "vitest";
import type { ActiveFSContext, ActiveFSTree, ActiveFSTreeInfo, ActiveFSTreeListResult, ActiveFSTreeReadResult } from "@activefs/core";
import { createActiveFS, dir, fsTree, text } from "@activefs/core";
import { createGeneratedTree, createMemoryTree } from "@activefs/testing";
import { runActiveFSTreeConformance } from "@activefs/testing/conformance";

function asText(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

function treeText<Meta>(result: ActiveFSTreeReadResult<Meta>): string {
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

function treeBytes<Meta>(result: ActiveFSTreeReadResult<Meta>): Uint8Array {
  const content = typeof result === "object" && result !== null && "content" in result
    ? result.content
    : result;
  return content instanceof Uint8Array
    ? content
    : content instanceof ArrayBuffer
      ? new Uint8Array(content)
      : new TextEncoder().encode(content);
}

function treeList<Meta>(result: ActiveFSTreeListResult<unknown, Meta>): NonNullable<ActiveFSTreeInfo<Meta>>[] {
  return Array.isArray(result)
    ? result.filter((entry): entry is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(entry))
    : Object.entries(result).map(([name, declaration]) => ({
      name,
      path: `/${name}`,
      kind: "treeNodeKind" in declaration && declaration.treeNodeKind === "file" ? "file" : "directory"
    }));
}

describe("createMemoryTree", () => {
  it("supports list/info/read", async () => {
    const tree = createMemoryTree({
      "/hello.txt": "Hello ActiveFS",
      "/notes/today.txt": "Write tests"
    });

    const root = await tree.list({}, "/");
    const notes = await tree.info({}, "/notes");
    const hello = await tree.info({}, "/hello.txt");
    const read = await tree.read({}, "/hello.txt");

    expect(treeList(root).map((entry) => entry.name).sort()).toEqual(["hello.txt", "notes"]);
    expect(notes?.kind).toBe("directory");
    expect(hello?.kind).toBe("file");
    expect(treeText(read)).toBe("Hello ActiveFS");
  });

  it("can provide tree-side search", async () => {
    const fs = createActiveFS().mount(
      "/memory",
      createMemoryTree({
        files: {
          "/hello.txt": "Hello ActiveFS"
        },
        searchable: true
      })
    );

    const result = await fs.search({}, "/memory", { pattern: "ActiveFS" });

    expect(result.matches).toEqual([
      {
        path: "/memory/hello.txt",
        line: 1,
        column: 7,
        excerpt: "Hello ActiveFS"
      }
    ]);
  });

  it("defaults to case-insensitive search and keeps an exact limit complete", async () => {
    const tree = createMemoryTree({
      searchable: true,
      files: {
        "/upper.txt": "Needle once"
      }
    });

    await expect(tree.search({}, "/", { pattern: "needle", maxResults: 1 })).resolves.toMatchObject({
      complete: true,
      matches: [expect.objectContaining({ path: "/upper.txt" })]
    });
    await expect(tree.search({}, "/", {
      pattern: "needle",
      caseSensitive: true
    })).resolves.toMatchObject({
      complete: true,
      matches: []
    });
  });

  it("supports mutation edge cases, range reads, metadata, and non-recursive watch filtering", async () => {
    const tree = createMemoryTree({
      files: {
        "/docs/a.txt": "Alpha ActiveFS",
        "/docs/nested/b.txt": "Beta ActiveFS",
        "/bytes.bin": new Uint8Array([0, 1, 2, 3])
      },
      searchable: true,
      writable: true,
      watchable: true
    });
    const events: string[] = [];
    const subscription = await tree.watch!({}, "/docs", (event) => events.push(`${event.type}:${event.path}`));

    await expect(tree.list({}, "/docs/a.txt")).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(tree.write!({}, "/", "root")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(tree.write!({}, "/docs/a.txt", "no", { overwrite: false })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(tree.write!({}, "/missing.txt", "no", { create: false })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await expect(tree.makeDir({}, "/docs/a.txt")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(tree.makeDir({}, "/missing/child")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tree.remove({}, "/")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(tree.remove({}, "/docs")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(tree.remove({}, "/missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tree.copy!({}, "/docs", "/copy")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(tree.copy!({}, "/missing", "/copy")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tree.truncate!({}, "/docs/a.txt", { length: -1 })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(tree.updateInfo({}, "/missing.txt", { mtimeMs: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    await tree.write!({}, "/docs/new.txt", "new", { meta: { tree: "test" } });
    await tree.copy!({}, "/docs", "/copy", { recursive: true });
    await tree.move({}, "/copy", "/renamed");
    await tree.truncate!({}, "/docs/a.txt", { length: 20 });
    await tree.updateInfo({}, "/docs/a.txt", { mtimeMs: 42, meta: { touched: true } });
    const binary = await tree.read({}, "/bytes.bin", { offset: 1, length: 2, encoding: "base64" });
    const padded = await tree.read({}, "/docs/a.txt", { encoding: "utf8" });
    const metadata = await tree.info({}, "/docs/a.txt");
    const search = await tree.search!({}, "/", { pattern: "activefs", caseSensitive: false, maxResults: 1 });

    await subscription.close();

    expect(treeText(binary)).toBe("AQI=");
    expect(treeText(padded)).toHaveLength(20);
    expect(metadata).toMatchObject({ mtimeMs: 42 });
    expect(search.complete).toBe(false);
    expect(search.matches).toHaveLength(1);
    expect(events).toEqual(["create:/docs/new.txt", "change:/docs/a.txt"]);
    await expect(tree.info({}, "/renamed/nested/b.txt")).resolves.toMatchObject({ kind: "file" });
  });
});

describe("createGeneratedTree", () => {
  it("supports function content, range encodings, hidden directories, and bounded search", async () => {
    const tree = createGeneratedTree<unknown, { requestId: string }>({
      searchable: true,
      files: {
        "/visible.txt": {
          mimeType: "text/plain",
          content: (context, path) => `${context.meta?.requestId}:${path}:Visible ActiveFS`
        },
        "/bytes.bin": new Uint8Array([4, 5, 6, 7])
      },
      dynamicFiles: {
        "/private/secret.txt": {
          content: "Hidden ActiveFS",
          enumerable: false
        }
      }
    });

    const root = await tree.list({}, "/");
    const visible = await tree.read({ meta: { requestId: "req-1" } }, "/visible.txt", {
      offset: 6,
      length: 11,
      encoding: "utf8"
    });
    const bytes = await tree.read({}, "/bytes.bin", { offset: 1, length: 2 });
    const privateStat = await tree.info({}, "/private");
    const hiddenSearch = await tree.search!({}, "/", {
      pattern: "ActiveFS",
      includeNonEnumerable: true
    });
    const boundedSearch = await tree.search!({}, "/", {
      pattern: "ActiveFS",
      includeNonEnumerable: true,
      maxResults: 1
    });

    expect(treeList(root).map((entry) => `${entry.kind}:${entry.path}:${entry.enumerable}`)).toEqual([
      "file:/bytes.bin:true",
      "directory:/private:false",
      "file:/visible.txt:true"
    ]);
    expect(treeText(visible)).toBe("/visible.tx");
    expect([...treeBytes(bytes)]).toEqual([5, 6]);
    expect(privateStat).toMatchObject({ kind: "directory", enumerable: false });
    expect(hiddenSearch.complete).toBe(true);
    expect(hiddenSearch.matches.map((match) => match.path)).toEqual(["/visible.txt", "/private/secret.txt"]);
    expect(boundedSearch.complete).toBe(false);
    expect(boundedSearch.matches.map((match) => match.path)).toEqual(["/visible.txt"]);
    await expect(tree.list({}, "/visible.txt")).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(tree.read({}, "/missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

runActiveFSTreeConformance("memory searchable", createContextRecordingMemoryTree, {
  filePath: "/hello.txt",
  expectedContent: "Hello ActiveFS",
  searchPattern: "ActiveFS",
  missingPath: "/missing.txt",
  write: {
    path: "/written.txt",
    content: "written ActiveFS"
  },
  context: {
    path: "/hello.txt",
    value: {
      auth: { subject: "ada" },
      meta: { requestId: "req-1" }
    },
    assertSeen: (tree) => {
      expect((tree as ContextRecordingMemoryTree).seenContexts).toEqual([
        {
          auth: { subject: "ada" },
          meta: { requestId: "req-1" }
        }
      ]);
    }
  }
});

runActiveFSTreeConformance("memory read-only", () => createMemoryTree({
  files: {
    "/hello.txt": "Hello ActiveFS",
    "/nested/note.txt": "Nested ActiveFS"
  },
  searchable: true
}), {
  filePath: "/hello.txt",
  expectedContent: "Hello ActiveFS",
  searchPattern: "ActiveFS",
  missingPath: "/missing.txt"
});

runActiveFSTreeConformance("generated", () => createGeneratedTree({
  searchable: true,
  files: {
    "/visible.txt": "Visible ActiveFS"
  },
  dynamicFiles: {
    "/dynamic/secret.txt": {
      content: "Hidden ActiveFS",
      enumerable: false
    }
  }
}), {
  filePath: "/visible.txt",
  expectedContent: "Visible ActiveFS",
  searchPattern: "ActiveFS",
  missingPath: "/missing.txt"
});

runActiveFSTreeConformance("fsTree", createContextRecordingTree, {
  filePath: "/hello.txt",
  expectedContent: "Hello ActiveFS",
  searchPattern: "ActiveFS",
  missingPath: "/missing.txt",
  write: {
    path: "/scratch/written.txt",
    content: "written ActiveFS"
  },
  context: {
    path: "/hello.txt",
    value: {
      auth: { subject: "ada" },
      meta: { requestId: "req-1" }
    },
    assertSeen: (tree) => {
      expect((tree as ContextRecordingTree).seenContexts).toEqual([
        {
          auth: { subject: "ada" },
          meta: { requestId: "req-1" }
        }
      ]);
    }
  }
});

interface ContextRecordingMemoryTree extends ActiveFSTree {
  seenContexts: ActiveFSContext[];
}

interface ContextRecordingTree extends ActiveFSTree {
  seenContexts: ActiveFSContext[];
}

function createContextRecordingMemoryTree(): ContextRecordingMemoryTree {
  const inner = createMemoryTree({
    files: {
      "/hello.txt": "Hello ActiveFS"
    },
    searchable: true,
    writable: true,
    watchable: true
  });
  const seenContexts: ActiveFSContext[] = [];
  const tree = inner as ContextRecordingMemoryTree;
  const read = inner.read.bind(inner);
  tree.seenContexts = seenContexts;
  tree.read = async (context, path, options) => {
    seenContexts.push(context);
    return read(context, path, options);
  };
  return tree;
}

function createContextRecordingTree(): ContextRecordingTree {
  const tree = fsTree({
    "/hello.txt": text("Hello ActiveFS"),
    scratch: dir({}, { writable: true })
  });
  const seenContexts: ActiveFSContext[] = [];
  tree.path("/hello.txt").setRead((context) => {
    seenContexts.push(context.ctx);
    return "Hello ActiveFS";
  });
  return Object.assign(tree, { seenContexts });
}
