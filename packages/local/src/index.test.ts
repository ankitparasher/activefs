import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActiveFSContext,
  ActiveFSDirEntry,
  ActiveFSReadOptions,
  ActiveFSTree,
  ActiveFSTreeReadResult,
  ActiveFSStat,
  ActiveFSPath,
  ActiveFSWatchEvent
} from "@activefs/core";
import { ActiveFSError, dir, file, fsTree } from "@activefs/core";
import {
  createLocalCache,
  createLocalTree,
  exportTree,
  watchExportTree
} from "@activefs/local";
import { createMemoryTree } from "@activefs/testing";

const tempDirs: string[] = [];
type StateHashMeta = { stateHash: string };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function readText<Meta>(result: ActiveFSTreeReadResult<Meta>): string {
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

function listPaths(result: Awaited<ReturnType<ActiveFSTree["list"]>>): string[] {
  if (!Array.isArray(result)) {
    return Object.keys(result).sort();
  }
  return result
    .map((entry) => entry?.path)
    .filter((path): path is string => Boolean(path))
    .sort();
}

describe("@activefs/local exportTree", () => {
  it("reexportTrees files through atomic temp-and-rename writes", async () => {
    const sourceDir = await makeTempDir();
    const outDir = await makeTempDir();
    await mkdir(join(sourceDir, "nested"), { recursive: true });
    await writeFile(join(sourceDir, "nested", "note.txt"), "first");

    await exportTree(sourceDir, outDir);
    await writeFile(join(sourceDir, "nested", "note.txt"), "second");
    await exportTree(sourceDir, outDir);

    await expect(readFile(join(outDir, "nested", "note.txt"), "utf8")).resolves.toBe("second");
    const outputNames = await readdir(join(outDir, "nested"));
    expect(outputNames.some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("generates a manifest with content and state metadata", async () => {
    const sourceDir = await makeTempDir();
    const outDir = await makeTempDir();
    await mkdir(join(sourceDir, "docs"), { recursive: true });
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    await writeFile(join(sourceDir, "docs", "b.txt"), "beta");

    const manifest = await exportTree(sourceDir, outDir, {
      now: () => new Date("2026-06-17T00:00:00.000Z")
    });
    const diskManifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));

    expect(diskManifest).toEqual(manifest);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["/a.txt", "/docs/b.txt"]);
    expect(manifest.entries[0]).toMatchObject({
      path: "/a.txt",
      contentHash: sha256("alpha"),
      size: 5,
      exportedAt: "2026-06-17T00:00:00.000Z"
    });
    expect(manifest.entries[0]?.stateHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks exports revision-pinned only when file metadata matches the requested revision", async () => {
    const outDir = await makeTempDir();
    const tree = createRevisionedTree("rev-1");

    const manifest = await exportTree(tree, outDir, { treeRevision: "rev-1" });

    expect(manifest).toMatchObject({
      consistency: "revision-pinned",
      treeRevision: "rev-1",
      entries: [
        expect.objectContaining({
          path: "/a.txt",
          revision: "rev-1",
          contentHash: sha256("alpha")
        })
      ]
    });
    await expect(readFile(join(outDir, "a.txt"), "utf8")).resolves.toBe("alpha");

    await expect(exportTree(tree, await makeTempDir(), { treeRevision: "rev-2" }))
      .rejects.toMatchObject({
        code: "SOURCE_ERROR",
        message: "Exported file is not at requested tree revision: /a.txt"
      });
  });

  it("does not ingest its own output directory on repeated runs", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const outDir = join(sourceDir, ".activefs", "context");

    await exportTree(sourceDir, outDir);
    const manifest = await exportTree(sourceDir, outDir);

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["/a.txt"]);
  });

  it("removes files that disappear from the source", async () => {
    const sourceDir = await makeTempDir();
    const outDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    await writeFile(join(sourceDir, "b.txt"), "beta");

    await exportTree(sourceDir, outDir);
    await unlink(join(sourceDir, "b.txt"));
    const manifest = await exportTree(sourceDir, outDir);

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["/a.txt"]);
    await expect(exists(join(outDir, "b.txt"))).resolves.toBe(false);
  });

  it("exports a single local file input with the file name as the manifest path", async () => {
    const sourceDir = await makeTempDir();
    const outDir = await makeTempDir();
    const filePath = join(sourceDir, "single.txt");
    await writeFile(filePath, "single file");

    const manifest = await exportTree(filePath, outDir);

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["/single.txt"]);
    await expect(readFile(join(outDir, "single.txt"), "utf8")).resolves.toBe("single file");
  });

  it("rejects inconsistent tree read metadata", async () => {
    const outDir = await makeTempDir();
    const tree = createInconsistentReadTree();

    await expect(exportTree(tree, outDir)).rejects.toMatchObject({
      code: "SOURCE_ERROR"
    });
  });

  it("keeps exported metadata consistent when a local file changes during exportTree", async () => {
    const sourceDir = await makeTempDir();
    const outDir = await makeTempDir();
    const filePath = join(sourceDir, "changing.txt");
    await writeFile(filePath, "initial");
    let stopped = false;
    const churn = (async () => {
      let index = 0;
      while (!stopped) {
        await writeFile(filePath, `${index}:${"x".repeat(1000 + (index % 7))}`);
        index += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
      }
    })();

    try {
      const manifest = await exportTree(sourceDir, outDir);
      const content = await readFile(join(outDir, "changing.txt"));
      expect(manifest.entries).toHaveLength(1);
      expect(manifest.entries[0]).toMatchObject({
        path: "/changing.txt",
        contentHash: sha256(content),
        size: content.byteLength
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_ERROR" });
    } finally {
      stopped = true;
      await churn;
    }
  });
});

describe("@activefs/local cache", () => {
  it("tracks read and directory cache hits and misses by path plus state hash", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const cache = createLocalCache();
    const tree = createLocalTree({ root: sourceDir, cache });

    await tree.read({}, "/a.txt");
    await tree.read({}, "/a.txt");
    await tree.list({}, "/");
    await tree.list({}, "/");

    expect(cache.snapshotStats()).toEqual({
      statHits: 1,
      statMisses: 2,
      readHits: 1,
      readMisses: 1,
      directoryHits: 1,
      directoryMisses: 1
    });

    await writeFile(join(sourceDir, "a.txt"), "alpha changed");
    await tree.read({}, "/a.txt");
    expect(cache.snapshotStats().readMisses).toBe(2);

    tree.clearCache();
    expect(cache.snapshotStats()).toEqual({
      statHits: 0,
      statMisses: 0,
      readHits: 0,
      readMisses: 0,
      directoryHits: 0,
      directoryMisses: 0
    });
  });

  it("clears only a requested cached path when possible", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    await writeFile(join(sourceDir, "b.txt"), "beta");
    const cache = createLocalCache();
    const tree = createLocalTree({ root: sourceDir, cache });

    await tree.read({}, "/a.txt");
    await tree.read({}, "/a.txt");
    await tree.read({}, "/b.txt");
    await tree.read({}, "/b.txt");
    expect(cache.snapshotStats().readHits).toBe(2);

    tree.clearCache("/a.txt");
    await tree.read({}, "/a.txt");
    await tree.read({}, "/b.txt");

    expect(cache.snapshotStats()).toMatchObject({
      readHits: 3,
      readMisses: 3
    });
  });

  it("reports cache-served stat, read, and list activity", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const activities: string[] = [];
    const cache = createLocalCache({
      onActivity: (activity) => {
        activities.push(`${activity.operation}:${activity.path}:${activity.source}:${activity.result}`);
      }
    });
    const tree = createLocalTree({ root: sourceDir, cache });

    await tree.info({}, "/a.txt");
    await tree.info({}, "/a.txt");
    await tree.read({}, "/a.txt");
    await tree.read({}, "/a.txt");
    await tree.list({}, "/");
    await tree.list({}, "/");

    expect(activities).toEqual(expect.arrayContaining([
      "stat:/a.txt:cache:succeeded",
      "read:/a.txt:cache:succeeded",
      "list:/:cache:succeeded"
    ]));
  });

  it("fails closed when a cached read digest does not match cached bytes", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const cache = createLocalCache();
    const tree = createLocalTree({ root: sourceDir, cache });

    await tree.read({}, "/a.txt");
    const reads = (cache as unknown as { reads: Map<string, { content: Uint8Array }> }).reads;
    const cached = [...reads.values()][0];
    cached!.content[0] = "z".charCodeAt(0);

    await expect(tree.read({}, "/a.txt")).rejects.toMatchObject({
      code: "SOURCE_ERROR",
      message: "Cached read digest mismatch: /a.txt"
    });
  });
});

describe("@activefs/local tree safety", () => {
  it("uses case-insensitive search by default and keeps an exact limit complete", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "upper.txt"), "Needle once\n");
    const tree = createLocalTree({ root: sourceDir });

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

  it("writes files when not readonly and rejects writes for readonly sources", async () => {
    const sourceDir = await makeTempDir();
    const tree = createLocalTree({ root: sourceDir });

    const result = await tree.write!({}, "/nested/new.txt", "local write", {
      contentType: "text/plain"
    });
    const read = await tree.read({}, "/nested/new.txt", { encoding: "utf8" });

    expect(result).toMatchObject({
      created: "/nested/new.txt",
      info: { path: "/nested/new.txt", kind: "file", type: "text/plain" }
    });
    expect(readText(read)).toBe("local write");
    await expect(createLocalTree({ root: sourceDir, readonly: true }).write({}, "/blocked.txt", "no")).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });
  });

  it("routes local filesystem mutations and rejects expected mutation failures", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "existing.txt"), "abcdef");
    const tree = createLocalTree({ root: sourceDir });

    await tree.makeDir({}, "/docs");
    await tree.write!({}, "/docs/a.txt", "alpha");
    await tree.copy!({}, "/docs/a.txt", "/docs/b.txt");
    await tree.move({}, "/docs/b.txt", "/docs/c.txt");
    await tree.truncate!({}, "/existing.txt", { length: 3 });
    const metadata = await tree.updateInfo({}, "/docs/c.txt", { mtimeMs: 42 });
    await tree.remove({}, "/docs/a.txt");

    const entries = await tree.list({}, "/docs");
    const truncated = await tree.read({}, "/existing.txt", { encoding: "utf8" });

    expect(listPaths(entries)).toEqual(["/docs/c.txt"]);
    expect(readText(truncated)).toBe("abc");
    expect(metadata).toMatchObject({
      info: { path: "/docs/c.txt", mtimeMs: 42 }
    });

    await tree.remove({}, "/docs", { recursive: true });
    await expect(tree.info({}, "/docs")).resolves.toBeNull();
    await expect(tree.remove({}, "/missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await tree.makeDir({}, "/nonempty");
    await tree.write!({}, "/nonempty/file.txt", "content");
    await expect(tree.remove({}, "/nonempty")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await tree.remove({}, "/nonempty/file.txt");
    await tree.remove({}, "/nonempty");
    await expect(tree.info({}, "/nonempty")).resolves.toBeNull();
  });

  it("rejects local read, list, and mutation edge cases", async () => {
    const sourceDir = await makeTempDir();
    await mkdir(join(sourceDir, "dir"), { recursive: true });
    await writeFile(join(sourceDir, "file.txt"), "file");
    await writeFile(join(sourceDir, "other.txt"), "other");
    const tree = createLocalTree({ root: sourceDir });

    await expect(tree.read({}, "/dir")).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(tree.list({}, "/file.txt")).rejects.toMatchObject({ code: "NOT_DIRECTORY" });
    await expect(tree.write!({}, "/", "root")).rejects.toMatchObject({ code: "INVALID_PATH" });
    await expect(tree.write!({}, "/file.txt", "new", { overwrite: false })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(tree.write!({}, "/missing.txt", "new", { create: false })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    await expect(tree.makeDir({}, "/missing/child")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(tree.move({}, "/file.txt", "/other.txt", { overwrite: false })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await expect(tree.copy!({}, "/file.txt", "/other.txt", { overwrite: false })).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });
    await tree.remove({}, "/file.txt");
    await expect(tree.info({}, "/file.txt")).resolves.toBeNull();
    await expect(tree.truncate!({}, "/dir")).rejects.toMatchObject({ code: "NOT_FILE" });
    await expect(tree.updateInfo({}, "/missing.txt", { mtimeMs: 1 })).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(tree.remove({}, "/missing.txt")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await tree.makeDir({}, "/nested/deep", { recursive: true });
    await tree.write!({}, "/nested/deep/a.txt", "a");
    await tree.copy!({}, "/nested", "/copy", { recursive: true });
    await tree.move({}, "/copy", "/moved");
    await expect(tree.info({}, "/moved/deep/a.txt")).resolves.toMatchObject({ kind: "file" });
    await tree.remove({}, "/moved", { recursive: true });
    await expect(tree.info({}, "/moved")).resolves.toBeNull();
  });

  it("reads regular files and safe in-root symlinks", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "target.txt"), "inside");
    await symlink(join(sourceDir, "target.txt"), join(sourceDir, "internal.txt"));
    const tree = createLocalTree({ root: sourceDir });

    const regular = await tree.read({}, "/target.txt", { encoding: "utf8" });
    const linked = await tree.read({}, "/internal.txt", { encoding: "utf8" });

    expect(readText(regular)).toBe("inside");
    expect(readText(linked)).toBe("inside");
  });

  it("rejects symlinks that escape the tree root", async () => {
    const sourceDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    await writeFile(join(outsideDir, "secret.txt"), "outside");
    await symlink(join(outsideDir, "secret.txt"), join(sourceDir, "external.txt"));
    const tree = createLocalTree({ root: sourceDir });

    await expect(tree.read({}, "/external.txt")).rejects.toMatchObject({
      code: "INVALID_PATH"
    });
    await expect(tree.info({}, "/external.txt")).rejects.toMatchObject({
      code: "INVALID_PATH"
    });
  });

  it("clears the local cache when tree.watch observes invalidation", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const cache = createLocalCache();
    const tree = createLocalTree({ root: sourceDir, cache });
    await tree.read({}, "/a.txt");
    await tree.read({}, "/a.txt");
    expect(cache.snapshotStats().readHits).toBe(1);

    const subscription = await tree.watch!({}, "/", () => undefined);
    await writeFile(join(sourceDir, "a.txt"), "changed");
    await waitFor(() => cache.snapshotStats().readHits === 0);
    await subscription.close();
  });
});

describe("@activefs/local watchExportTree", () => {
  it("uses tree.watch to invalidate and rewrite exported files", async () => {
    const outDir = await makeTempDir();
    let content = "first";
    let version = 1;
    let onEvent: ((event: ActiveFSWatchEvent<StateHashMeta>) => void) | undefined;
    let closed = false;
    const tree = createWatchableSingleFileTree(
      () => content,
      () => version,
      (callback) => {
        onEvent = callback;
        return {
          close: () => {
            closed = true;
          }
        };
      }
    );

    const watcher = await watchExportTree(tree, outDir, { pollingIntervalMs: 20 });
    await expect(readFile(join(outDir, "note.txt"), "utf8")).resolves.toBe("first");

    content = "second";
    version += 1;
    onEvent?.({ type: "change", path: "/note.txt" });

    await waitFor(async () => (await readFile(join(outDir, "note.txt"), "utf8")) === "second");
    await watcher.close();
    expect(closed).toBe(true);
  });

  it("uses export-only polling when tree.watch is unavailable", async () => {
    const outDir = await makeTempDir();
    let content = "first";
    let version = 1;
    const tree = createSingleFileTree(() => content, () => version);

    const watcher = await watchExportTree(tree, outDir, { pollingIntervalMs: 20 });
    await expect(readFile(join(outDir, "note.txt"), "utf8")).resolves.toBe("first");

    content = "second";
    version += 1;

    await waitFor(async () => (await readFile(join(outDir, "note.txt"), "utf8")) === "second");
    await watcher.close();
  });

  it("waits for in-flight watch reruns before closing", async () => {
    const outDir = await makeTempDir();
    let content = "first";
    let version = 1;
    let onEvent: ((event: ActiveFSWatchEvent<StateHashMeta>) => void) | undefined;
    let resolveSecondReadStarted!: () => void;
    let releaseSecondRead: (() => void) | undefined;
    let secondReadBlocked = false;
    const secondReadStarted = new Promise<void>((resolvePromise) => {
      resolveSecondReadStarted = resolvePromise;
    });
    const baseTree = createSingleFileTree(() => content, () => version);
    const originalRead = baseTree.read.bind(baseTree);
    const tree = baseTree;
    tree.capabilities = { ...baseTree.capabilities, watch: true };
    tree.read = async (
      context: ActiveFSContext<unknown, StateHashMeta>,
      path: ActiveFSPath,
      readOptions?: ActiveFSReadOptions
    ) => {
      if (content === "second" && !secondReadBlocked) {
        secondReadBlocked = true;
        resolveSecondReadStarted();
        await new Promise<void>((resolvePromise) => {
          releaseSecondRead = resolvePromise;
        });
      }
      return originalRead(context, path, readOptions);
    };
    tree.watch = async (
      _context: ActiveFSContext<unknown, StateHashMeta>,
      _path: ActiveFSPath,
      callback: (event: ActiveFSWatchEvent<StateHashMeta>) => void
    ) => {
      onEvent = callback;
      return { close: () => undefined };
    };

    const watcher = await watchExportTree(tree, outDir, { debounceMs: 0 });
    await expect(readFile(join(outDir, "note.txt"), "utf8")).resolves.toBe("first");

    content = "second";
    version += 1;
    onEvent?.({ type: "change", path: "/note.txt" });
    await secondReadStarted;

    let closed = false;
    const closePromise = watcher.close().then(() => {
      closed = true;
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    expect(closed).toBe(false);

    releaseSecondRead?.();
    await closePromise;
    expect(closed).toBe(true);
    await expect(readFile(join(outDir, "note.txt"), "utf8")).resolves.toBe("second");
  });

  it("does not recurse into its own output when watching a local path", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "a.txt"), "alpha");
    const outDir = join(sourceDir, ".activefs", "context");
    const errors: unknown[] = [];

    const watcher = await watchExportTree(sourceDir, outDir, {
      debounceMs: 10,
      onError: (error) => errors.push(error)
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    await watcher.close();

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(errors).toEqual([]);
    expect(manifest.entries.map((entry: { path: string }) => entry.path)).toEqual(["/a.txt"]);
  });

  it("closes immediately when started with an already-aborted signal", async () => {
    const outDir = await makeTempDir();
    let closed = false;
    const controller = new AbortController();
    controller.abort();
    const tree = createWatchableSingleFileTree(
      () => "first",
      () => 1,
      () => ({
        close: () => {
          closed = true;
        }
      })
    );

    const watcher = await watchExportTree(tree, outDir, { signal: controller.signal });
    await watcher.close();

    expect(closed).toBe(true);
  });

  it("reports asynchronous export errors through onError", async () => {
    const outDir = await makeTempDir();
    let content = "first";
    let fail = false;
    let onEvent: ((event: ActiveFSWatchEvent<StateHashMeta>) => void) | undefined;
    const errors: unknown[] = [];
    const baseTree = createWatchableSingleFileTree(
      () => content,
      () => fail ? 2 : 1,
      (callback) => {
        onEvent = callback;
        return { close: () => undefined };
      }
    );
    const originalRead = baseTree.read.bind(baseTree);
    const tree = baseTree;
    tree.read = async (
      context: ActiveFSContext<unknown, StateHashMeta>,
      path: ActiveFSPath,
      options?: ActiveFSReadOptions
    ) => {
      if (fail) {
        throw new Error("export failed");
      }
      return originalRead(context, path, options);
    };

    const watcher = await watchExportTree(tree, outDir, {
      debounceMs: 0,
      onError: (error) => errors.push(error)
    });
    content = "second";
    fail = true;
    onEvent?.({ type: "change", path: "/note.txt" });

    await waitFor(() => errors.length === 1);
    await watcher.close();
    expect(errors[0]).toMatchObject({ message: "export failed" });
  });

  it("stops local filesystem watchers when the abort signal fires", async () => {
    const sourceDir = await makeTempDir();
    await writeFile(join(sourceDir, "note.txt"), "first");
    const tree = createLocalTree({ root: sourceDir });
    const controller = new AbortController();
    const events: ActiveFSWatchEvent[] = [];

    const subscription = await tree.watch!({}, "/", (event) => events.push(event), {
      signal: controller.signal
    });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    events.length = 0;
    controller.abort();
    await writeFile(join(sourceDir, "note.txt"), "second");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    await subscription.close();

    expect(events).toEqual([]);
  });
});

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "activefs-local-"));
  tempDirs.push(path);
  return path;
}

function createWatchableSingleFileTree(
  content: () => string,
  version: () => number,
  registerWatch: (
    callback: (event: ActiveFSWatchEvent<StateHashMeta>) => void
  ) => { close(): void | Promise<void> }
): ActiveFSTree<unknown, StateHashMeta> {
  const tree = createSingleFileTree(content, version);
  tree.capabilities = { ...tree.capabilities, watch: true, watchable: true };
  tree.watch = async (_context, _path, callback) => registerWatch(callback);
  return tree;
}

function createSingleFileTree(content: () => string, version: () => number): ActiveFSTree<unknown, StateHashMeta> {
  const tree = fsTree({
    "/note.txt": file({
      info: () => ({
        name: "note.txt",
        path: "/note.txt",
        kind: "file",
        size: content().length,
        enumerable: true,
        data: { stateHash: `file-${version()}` }
      }),
      read: () => ({
        content: content(),
        info: {
          name: "note.txt",
          path: "/note.txt",
          kind: "file",
          size: content().length,
          enumerable: true,
          data: { stateHash: `file-${version()}` }
        }
      })
    })
  }, {
    info: ({ path }) => path === "/"
      ? {
          name: "",
          path: "/",
          kind: "directory",
          enumerable: true,
          data: { stateHash: `dir-${version()}` }
        }
      : null
  });
  tree.capabilities = { ...tree.capabilities, watch: false, watchable: false };
  tree.watch = async (_context, path) => {
    throw new ActiveFSError("UNSUPPORTED", "Watch is not available for this test tree", { path });
  };
  return tree;
}

function createInconsistentReadTree(): ActiveFSTree<unknown, StateHashMeta> {
  return fsTree({
    "/bad.txt": file({
      info: () => ({
        name: "bad.txt",
        path: "/bad.txt",
        kind: "file",
        size: 1,
        enumerable: true,
        data: { stateHash: "file" }
      }),
      read: () => ({
        content: "too long",
        info: {
          name: "bad.txt",
          path: "/bad.txt",
          kind: "file",
          size: 1,
          enumerable: true,
          data: { stateHash: "file" }
        }
      })
    })
  }, {
    info: ({ path }) => path === "/"
      ? {
          name: "",
          path: "/",
          kind: "directory",
          enumerable: true,
          data: { stateHash: "dir" }
        }
      : null
  });
}

function createRevisionedTree(revision: string): ActiveFSTree<unknown, StateHashMeta> {
  const fileInfo = {
    name: "a.txt",
    path: "/a.txt",
    kind: "file" as const,
    size: "alpha".length,
    enumerable: true,
    revision,
    data: { stateHash: `file:${revision}` }
  };
  return fsTree({
    "/a.txt": file({
      info: () => fileInfo,
      read: () => ({ content: "alpha", info: fileInfo })
    })
  }, {
    info: ({ path }) => path === "/"
      ? {
          name: "",
          path: "/",
          kind: "directory",
          enumerable: true,
          revision,
          data: { stateHash: `dir:${revision}` }
        }
      : null
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
