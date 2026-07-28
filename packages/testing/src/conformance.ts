import {
  joinActiveFSPath,
  normalizeActiveFSPath,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSTree,
  type ActiveFSTreeInfo,
  type ActiveFSTreeListResult,
  type ActiveFSTreeReadResult,
  type ActiveFSWatchEvent
} from "@activefs/core";
import { describe, expect, it } from "vitest";

/**
 * Behavior contract exercised by `runActiveFSTreeConformance`.
 *
 * The suite validates the tree-first authoring contract directly, without
 * requiring a filesystem mount.
 */
export interface ActiveFSTreeConformanceOptions<Auth = unknown, Meta = unknown> {
  rootPath?: string;
  filePath: string;
  expectedContent: string;
  searchPattern: string;
  missingPath?: string;
  write?: {
    path: string;
    content: string | Uint8Array;
    expectedContent?: string;
  };
  context?: {
    path?: string;
    value: ActiveFSContext<Auth, Meta>;
    assertSeen(tree: ActiveFSTree<Auth, Meta>): void | Promise<void>;
  };
}

/**
 * Registers a Vitest conformance suite for any tree-first `ActiveFSTree`.
 *
 * @param name Suite label.
 * @param createTree Factory used to create an isolated tree per test.
 * @param options Expected paths, content, optional write behavior, and optional
 * context forwarding assertion.
 * @remarks This function has the side effect of registering Vitest `describe`
 * and `it` blocks when called.
 */
export function runActiveFSTreeConformance<Auth = unknown, Meta = unknown>(
  name: string,
  createTree: () => ActiveFSTree<Auth, Meta>,
  options: ActiveFSTreeConformanceOptions<Auth, Meta>
): void {
  const rootPath = normalizeActiveFSPath(options.rootPath ?? "/");
  const filePath = normalizeActiveFSPath(options.filePath);
  const missingPath = normalizeActiveFSPath(options.missingPath ?? "/missing.txt");

  describe(`${name} ActiveFS tree conformance`, () => {
    it("lists the tree root", async () => {
      const tree = createTree();
      const info = await tree.info({}, rootPath);
      const entries = await tree.list({}, rootPath);

      expect(info?.kind).toBe("directory");
      expect(treeListPaths(entries, rootPath).length).toBeGreaterThan(0);
    });

    it("infos and reads a file", async () => {
      const tree = createTree();
      const info = await tree.info({}, filePath);
      const read = await tree.read({}, filePath);

      expect(info?.kind).toBe("file");
      expect(treeText(read)).toContain(options.expectedContent);
    });

    it("searches through the tree contract", async () => {
      const tree = createTree();
      const result = await tree.search({}, rootPath, { pattern: options.searchPattern });

      expect(result.matches.some((match) => normalizeActiveFSPath(match.path) === filePath)).toBe(true);
    });

    it("maps missing paths to ActiveFSError failures", async () => {
      const tree = createTree();
      await expect(tree.read({}, missingPath)).rejects.toMatchObject({
        code: "NOT_FOUND"
      });
    });

    it("forwards opaque auth/meta context to tree methods", async () => {
      if (!options.context) {
        return;
      }
      const tree = createTree();
      await tree.read(
        options.context.value,
        normalizeActiveFSPath(options.context.path ?? options.filePath)
      );
      await options.context.assertSeen(tree);
    });

    it("writes through writable tree policy", async () => {
      if (!options.write) {
        return;
      }
      const tree = createTree();
      const writePath = normalizeActiveFSPath(options.write.path);
      await tree.write({}, writePath, options.write.content, { overwrite: true });
      const read = await tree.read({}, writePath);
      expect(treeText(read)).toBe(options.write.expectedContent ?? text(options.write.content));
    });

    it("streams watch events from committed tree changes", async () => {
      if (!options.write) {
        return;
      }
      const tree = createTree();
      const writePath = normalizeActiveFSPath(options.write.path);
      const events: ActiveFSWatchEvent[] = [];
      const subscription = await tree.watch({}, rootPath, (event) => events.push(event), {
        recursive: true
      });
      await tree.write({}, writePath, options.write.content, {
        overwrite: true
      });
      await waitFor(() => events.length > 0);
      await subscription.close();
      expect(events.some((event) => event.path === writePath)).toBe(true);
    });
  });
}

function text(content: string | Uint8Array): string {
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

function treeListPaths<Auth, Meta>(
  result: ActiveFSTreeListResult<Auth, Meta>,
  basePath: ActiveFSPath
): ActiveFSPath[] {
  if (Array.isArray(result)) {
    return result
      .filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info?.path))
      .map((info) => normalizeActiveFSPath(info.path!));
  }
  return Object.keys(result).map((name) => joinActiveFSPath(basePath, name));
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
