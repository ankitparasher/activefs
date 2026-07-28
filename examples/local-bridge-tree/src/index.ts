import {
  ActiveFSError,
  createActiveFS,
  fsTree,
  normalizeActiveFSPath,
  type ActiveFSPath,
  type ActiveFSReadResult,
  type ActiveFSSearchMatch,
  type ActiveFSSearchQuery,
  type ActiveFSTree,
  type ActiveFSTreeInfo
} from "@activefs/core";
import { createHttpSourceClient, startActiveFSServer } from "@activefs/source-http";
import { readdir, readFile, stat as statFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export async function runLocalBridgeSourceExample() {
  const fixtureRoot = fileURLToPath(new URL("../fixture", import.meta.url));
  const server = await startActiveFSServer({
    tree: createLocalFolderTree(fixtureRoot)
  });

  try {
    const remote = createHttpSourceClient({ url: server.url, name: "local-bridge" });
    const fs = createActiveFS().mount("/bridge", remote);
    const docs = await fs.list({}, "/bridge/docs");
    const readme = await fs.read({}, "/bridge/README.md");
    const matches = await fs.search({}, "/bridge", { pattern: "bridge" });

    return {
      mount: "/bridge",
      serverUrl: server.url,
      docs: docs.map((entry) => entry.path),
      readme: textContent(readme),
      matches: matches.matches.map((match) => `${match.path}:${match.line ?? 0}`),
      strategy: matches.strategy
    };
  } finally {
    await server.close();
  }
}

export function createLocalFolderTree(root: string): ActiveFSTree {
  const sourceRoot = resolve(root);

  return fsTree({}, {
    name: "local-folder-bridge",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      search: true,
      rangeReadable: true
    },

    async info({ path }) {
      const normalizedPath = normalizeActiveFSPath(path);
      const localPath = toLocalPath(sourceRoot, normalizedPath);
      const localStat = await safeStat(localPath);
      return localStat ? infoForPath(normalizedPath, localStat) : null;
    },

    async list({ path }) {
      const normalizedPath = normalizeActiveFSPath(path);
      const localPath = toLocalPath(sourceRoot, normalizedPath);
      const localStat = await safeStat(localPath);
      if (!localStat) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, {
          path: normalizedPath
        });
      }
      if (!localStat.isDirectory()) {
        throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${normalizedPath}`, {
          path: normalizedPath
        });
      }

      const children = await readdir(localPath, { withFileTypes: true });
      return children
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((child): NonNullable<ActiveFSTreeInfo> => {
          const childPath = normalizeActiveFSPath(
            normalizedPath === "/" ? `/${child.name}` : `${normalizedPath}/${child.name}`
          );
          return {
            name: child.name,
            path: childPath,
            kind: child.isDirectory() ? "directory" : "file",
            type: child.isDirectory() ? undefined : mimeTypeForPath(childPath),
            permissions: child.isDirectory()
              ? { readable: true, searchable: true }
              : { readable: true, searchable: true }
          };
        });
    },

    async read({ path }) {
      const normalizedPath = normalizeActiveFSPath(path);
      const localPath = toLocalPath(sourceRoot, normalizedPath);
      const localStat = await safeStat(localPath);
      if (!localStat) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, {
          path: normalizedPath
        });
      }
      if (!localStat.isFile()) {
        throw new ActiveFSError("NOT_FILE", `Path is not a file: ${normalizedPath}`, {
          path: normalizedPath
        });
      }

      const bytes = await readFile(localPath);
      return {
        content: bytes,
        info: infoForPath(normalizedPath, localStat)
      };
    },

    async search({ path, query }) {
      const searchQuery = query!;
      const normalizedPath = normalizeActiveFSPath(path);
      const files = await collectFiles(sourceRoot, normalizedPath);
      const matches: ActiveFSSearchMatch[] = [];
      const maxResults = searchQuery.maxResults ?? Number.POSITIVE_INFINITY;

      for (const filePath of files) {
        const localPath = toLocalPath(sourceRoot, filePath);
        const content = await readFile(localPath, "utf8");
        for (const match of searchText(filePath, content, searchQuery)) {
          if (matches.length >= maxResults) {
            return { matches, complete: false, strategy: "source", incompleteReasons: ["max-results"] };
          }
          matches.push(match);
        }
      }

      return { matches, complete: true, strategy: "source" };
    }
  });
}

async function collectFiles(root: string, path: ActiveFSPath): Promise<ActiveFSPath[]> {
  const localPath = toLocalPath(root, path);
  const localStat = await safeStat(localPath);
  if (!localStat) {
    return [];
  }
  if (localStat.isFile()) {
    return [path];
  }
  if (!localStat.isDirectory()) {
    return [];
  }

  const children = await readdir(localPath, { withFileTypes: true });
  const nested = await Promise.all(
    children.map((child) => {
      const childPath = normalizeActiveFSPath(path === "/" ? `/${child.name}` : `${path}/${child.name}`);
      return child.isDirectory() ? collectFiles(root, childPath) : [childPath];
    })
  );
  return nested.flat().sort();
}

function toLocalPath(root: string, path: ActiveFSPath): string {
  const normalizedPath = normalizeActiveFSPath(path);
  const segments = normalizedPath.slice(1).split("/").filter(Boolean);
  const localPath = resolve(root, ...segments);
  if (localPath !== root && !localPath.startsWith(`${root}${sep}`)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes tree root: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  return localPath;
}

async function safeStat(localPath: string): Promise<Stats | null> {
  try {
    return await statFile(localPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function infoForPath(path: ActiveFSPath, localStat: Stats): NonNullable<ActiveFSTreeInfo> {
  const isDirectory = localStat.isDirectory();
  return {
    name: path === "/" ? "" : basename(path),
    path,
    kind: isDirectory ? "directory" : "file",
    size: isDirectory ? undefined : localStat.size,
    mtimeMs: localStat.mtimeMs,
    type: isDirectory ? undefined : mimeTypeForPath(path),
    permissions: {
      readable: true,
      searchable: true
    }
  };
}

function searchText(
  path: ActiveFSPath,
  content: string,
  query: ActiveFSSearchQuery
): ActiveFSSearchMatch[] {
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  return content
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      return column === -1
        ? []
        : [{ path, line: index + 1, column: column + 1, excerpt: line.trim() }];
    });
}

function mimeTypeForPath(path: string): string | undefined {
  if (path.endsWith(".md")) {
    return "text/markdown";
  }
  if (path.endsWith(".ts")) {
    return "text/typescript";
  }
  if (path.endsWith(".txt")) {
    return "text/plain";
  }
  return undefined;
}

function textContent(read: ActiveFSReadResult): string {
  return typeof read.content === "string" ? read.content : new TextDecoder().decode(read.content);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLocalBridgeSourceExample();
  console.log(`local-bridge-tree mount: ${result.mount}`);
  console.log(`local-bridge-tree docs: ${result.docs.join(", ")}`);
  console.log(`local-bridge-tree read: ${result.readme.split("\n")[0]}`);
  console.log(`local-bridge-tree search strategy: ${result.strategy}`);
  console.log(`local bridge matches: ${result.matches.length}`);
}
