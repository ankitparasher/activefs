import type {
  ActiveFSContext,
  ActiveFSDirEntry,
  ActiveFSPath,
  ActiveFSReadOptions,
  ActiveFSReadResult,
  ActiveFSSearchMatch,
  ActiveFSSearchQuery,
  ActiveFSSearchResult,
  ActiveFSTreeInfo,
  ActiveFSTreeListResult,
  ActiveFSTreeMutationResult,
  ActiveFSTreeReadResult,
  ActiveFSTreeSearchResult,
  ActiveFSTree,
  ActiveFSStat,
  ActiveFSWatchEvent,
  ActiveFSWatchOptions,
  ActiveFSWatchSubscription,
  ActiveFSCopyOptions,
  ActiveFSDeleteOptions,
  ActiveFSMkdirOptions,
  ActiveFSMetadataUpdateOptions,
  ActiveFSRenameOptions,
  ActiveFSTruncateOptions,
  ActiveFSWriteOptions,
  ActiveFSWriteResult
} from "@activefs/core";
import {
  ActiveFSError,
  activeFSContentByteLength,
  activeFSContentToBytes,
  copyActiveFSBytes,
  isActiveFSPathWithin,
  matchesActiveFSWatchRoot,
  normalizeActiveFSPath,
  parentActiveFSPath,
  runDefaultActiveFSTreeCommand,
  sliceActiveFSContent
} from "@activefs/core";

type MaybePromise<T> = T | Promise<T>;
type TreeContent = string | Uint8Array;

/**
 * Options for creating an in-memory ActiveFS tree for tests and examples.
 *
 * The tree is intentionally generic: auth/meta context is ignored by default,
 * and mutation/watch capabilities are enabled only when requested.
 */
export interface MemoryTreeOptions {
  name?: string;
  files?: Record<string, TreeContent>;
  searchable?: boolean;
  writable?: boolean;
  watchable?: boolean;
}

/**
 * Shorthand accepted by `createMemoryTree`.
 */
export type MemoryTreeInput = Record<string, TreeContent> | MemoryTreeOptions;

/**
 * Creates an in-memory tree for tests and examples.
 *
 * @param input File map or options object.
 * @returns An `ActiveFSTree` with optional search, mutation, range-read, and
 * watch behavior.
 * @throws `ActiveFSError` for invalid operations such as reading missing paths,
 * writing without overwrite permission, or deleting non-empty directories.
 */
export function createMemoryTree<Auth = unknown, Meta = unknown>(
  input: MemoryTreeInput = {}
): ActiveFSTree<Auth, Meta> {
  const options = isMemoryTreeOptions(input) ? input : { files: input };
  const files = normalizeFiles(options.files ?? {});
  const directories = directorySet(files);
  const metadata = new Map<ActiveFSPath, { mtimeMs?: number }>();
  const watchers = new Set<(event: ActiveFSWatchEvent<Meta>) => void>();

  const tree: ActiveFSTree<Auth, Meta> = {
    name: options.name ?? "memory",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      search: options.searchable,
      create: options.writable,
      write: options.writable,
      truncate: options.writable,
      delete: options.writable,
      mkdir: options.writable,
      rmdir: options.writable,
      rename: options.writable,
      copy: options.writable,
      updateMetadata: options.writable,
      watch: options.watchable,
      rangeReadable: true
    },
    set: unsupportedDeclarationMutation,
    path: unsupportedPathHandle,
    pre() {
      return this;
    },
    post() {
      return this;
    },
    on() {
      return this;
    },
    onChange() {
      return this;
    },
    info: async (_context, path) => statToTreeInfo(statPath(files, directories, path, metadata)),
    list: async (_context, path) =>
      listPath<Meta>(files, directories, path, metadata).map((entry) => statToTreeInfoNonNull<Meta>(entry)),
    read: async (_context, path, readOptions) => readResultToTreeReadResult(readPath(files, path, readOptions, metadata)),
    search: async (context, path, query) => {
      if (!options.searchable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree search is disabled", { path });
      }
      return activeFSSearchToTreeSearch(searchFiles(files, path, query, context));
    },
    walk: async (_context, path, walkOptions) =>
      walkMemoryTree(files, directories, path, metadata, walkOptions),
    write: async (_context, path, content, writeOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree writes are disabled", { path });
      }
      const result = writePath(files, directories, path, content, writeOptions, metadata);
      const event: ActiveFSWatchEvent<Meta> = {
        type: result.created ? "create" : "change",
        path: result.stat?.path ?? normalizeActiveFSPath(path),
        stat: result.stat,
        meta: result.meta
      };
      for (const watcher of watchers) {
        watcher(event);
      }
      return writeResultToTreeMutation(path, result);
    },
    remove: async (_context, path, deleteOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree removals are disabled", { path });
      }
      const result = deletePath(files, directories, path, deleteOptions);
      emitWatchEvent(watchers, { type: "delete", path: result.path });
      return { removed: result.path };
    },
    makeDir: async (_context, path, mkdirOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree directory creation is disabled", { path });
      }
      const result = mkdirPath(files, directories, path, mkdirOptions);
      emitWatchEvent(watchers, {
        type: result.created ? "create" : "change",
        path: result.stat.path,
        stat: result.stat,
        meta: result.meta
      });
      return {
        [result.created ? "created" : "modified"]: result.stat.path,
        info: statToTreeInfo(result.stat),
        meta: result.meta,
        data: result.meta
      };
    },
    move: async (_context, fromPath, toPath, renameOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree moves are disabled", { path: fromPath });
      }
      const result = renamePath<Meta>(files, directories, fromPath, toPath, renameOptions, metadata);
      emitWatchEvent(watchers, { type: "delete", path: normalizeActiveFSPath(fromPath) });
      emitWatchEvent(watchers, { type: "create", path: result.to, stat: result.stat });
      return {
        moved: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined
      };
    },
    copy: async (_context, fromPath, toPath, copyOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree copies are disabled", { path: fromPath });
      }
      const result = copyPath<Meta>(files, directories, fromPath, toPath, copyOptions, metadata);
      emitWatchEvent(watchers, { type: "create", path: result.to, stat: result.stat });
      return {
        copied: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined
      };
    },
    truncate: async (_context, path, truncateOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree truncation is disabled", { path });
      }
      const result = truncatePath<Meta>(files, path, truncateOptions, metadata);
      emitWatchEvent(watchers, { type: "change", path: result.stat.path, stat: result.stat });
      return { modified: result.stat.path, info: statToTreeInfo(result.stat) };
    },
    updateInfo: async (_context, path, metadataOptions) => {
      if (!options.writable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree metadata updates are disabled", { path });
      }
      const normalizedPath = normalizeActiveFSPath(path);
      const previous = metadata.get(normalizedPath) ?? {};
      metadata.set(normalizedPath, { ...previous, mtimeMs: metadataOptions.mtimeMs });
      const stat = statPath<Meta>(files, directories, normalizedPath, metadata);
      if (!stat) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
      }
      return {
        modified: normalizedPath,
        info: statToTreeInfo({
          ...stat,
          mtimeMs: metadataOptions.mtimeMs ?? stat.mtimeMs,
          meta: metadataOptions.meta
        }),
        meta: metadataOptions.meta,
        data: metadataOptions.meta
      };
    },
    watch: async (_context, path, onEvent, watchOptions) => {
      if (!options.watchable) {
        throw new ActiveFSError("UNSUPPORTED", "Memory tree watch is disabled", { path });
      }
      return watchMemoryPath(path, onEvent, watchers, watchOptions);
    },
    command: async (context, command, path, input) =>
      runDefaultActiveFSTreeCommand(tree, context, command, path, input)
  };

  return tree;
}

/**
 * Factory for generated tree content.
 *
 * The callback receives opaque caller context and the requested path, allowing
 * tests to prove context pass-through without encoding identity semantics in
 * ActiveFS itself.
 */
export type GeneratedContentFactory<Auth = unknown, Meta = unknown> = (
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath
) => MaybePromise<TreeContent>;

/**
 * Content descriptor accepted by generated trees.
 */
export type GeneratedContent<Auth = unknown, Meta = unknown> =
  | TreeContent
  | GeneratedContentFactory<Auth, Meta>;

/**
 * Generated file descriptor.
 */
export interface GeneratedFile<Auth = unknown, Meta = unknown> {
  content: GeneratedContent<Auth, Meta>;
  mimeType?: string;
  enumerable?: boolean;
}

/**
 * Options for creating a generated ActiveFS tree.
 *
 * `files` are enumerable by default. `dynamicFiles` are readable by direct path
 * but non-enumerable unless callers explicitly request non-enumerable search.
 */
export interface GeneratedTreeOptions<Auth = unknown, Meta = unknown> {
  name?: string;
  files?: Record<string, GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>>;
  dynamicFiles?: Record<string, GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>>;
  searchable?: boolean;
}

/**
 * Creates a read-only generated tree.
 *
 * @param input File map or generated-tree options.
 * @returns An `ActiveFSTree` that resolves static and dynamic generated
 * content.
 * @throws `ActiveFSError` when callers read directories or missing paths.
 */
export function createGeneratedTree<Auth = unknown, Meta = unknown>(
  input: Record<string, GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>> | GeneratedTreeOptions<Auth, Meta>
): ActiveFSTree<Auth, Meta> {
  const options = isGeneratedTreeOptions(input) ? input : { files: input };
  const visibleFiles = normalizeGeneratedFiles(options.files ?? {}, true);
  const dynamicFiles = normalizeGeneratedFiles(options.dynamicFiles ?? {}, false);

  const tree: ActiveFSTree<Auth, Meta> = {
    name: options.name ?? "generated",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      search: options.searchable,
      rangeReadable: true
    },
    set: unsupportedDeclarationMutation,
    path: unsupportedPathHandle,
    pre() {
      return this;
    },
    post() {
      return this;
    },
    on() {
      return this;
    },
    onChange() {
      return this;
    },
    info: async (context, path) =>
      statToTreeInfo(await statGeneratedPath(context, visibleFiles, dynamicFiles, path)),
    list: async (_context, path) =>
      listGeneratedPath<Auth, Meta>(visibleFiles, dynamicFiles, path).map((entry) => statToTreeInfoNonNull<Meta>(entry)),
    read: async (context, path, readOptions) =>
      readResultToTreeReadResult(await readGeneratedPath(context, visibleFiles, dynamicFiles, path, readOptions)),
    search: async (context, path, query) => {
      if (!options.searchable) {
        throw new ActiveFSError("UNSUPPORTED", "Generated tree search is disabled", { path });
      }
      return activeFSSearchToTreeSearch(await searchGeneratedFiles(context, visibleFiles, dynamicFiles, path, query));
    },
    walk: async (context, path, walkOptions) =>
      walkGeneratedTree(context, visibleFiles, dynamicFiles, path, walkOptions),
    write: unsupportedMutation,
    remove: unsupportedMutation,
    makeDir: unsupportedMutation,
    move: unsupportedMove,
    copy: unsupportedMove,
    truncate: unsupportedMutation,
    updateInfo: unsupportedMutation,
    watch: unsupportedWatch,
    command: async (context, command, path, input) =>
      runDefaultActiveFSTreeCommand(tree, context, command, path, input)
  };

  return tree;
}

interface GeneratedFileRecord<Auth, Meta> {
  content: GeneratedContent<Auth, Meta>;
  mimeType?: string;
  enumerable: boolean;
}

function isMemoryTreeOptions(input: MemoryTreeInput): input is MemoryTreeOptions {
  return "files" in input ||
    "searchable" in input ||
    "writable" in input ||
    "watchable" in input ||
    "name" in input;
}

function isGeneratedTreeOptions<Auth, Meta>(
  input: Record<string, GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>> | GeneratedTreeOptions<Auth, Meta>
): input is GeneratedTreeOptions<Auth, Meta> {
  return "files" in input || "dynamicFiles" in input || "searchable" in input || "name" in input;
}

function normalizeFiles(files: Record<string, TreeContent>): Map<ActiveFSPath, TreeContent> {
  return new Map(
    Object.entries(files).map(([path, content]) => [normalizeActiveFSPath(path), content])
  );
}

function normalizeGeneratedFiles<Auth, Meta>(
  files: Record<string, GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>>,
  defaultEnumerable: boolean
): Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>> {
  return new Map(
    Object.entries(files).map(([path, value]) => {
      const file = isGeneratedFile(value)
        ? value
        : { content: value, enumerable: defaultEnumerable };
      return [
        normalizeActiveFSPath(path),
        {
          content: file.content,
          mimeType: file.mimeType,
          enumerable: file.enumerable ?? defaultEnumerable
        }
      ];
    })
  );
}

function isGeneratedFile<Auth, Meta>(
  value: GeneratedContent<Auth, Meta> | GeneratedFile<Auth, Meta>
): value is GeneratedFile<Auth, Meta> {
  return typeof value === "object" && !(value instanceof Uint8Array) && "content" in value;
}

function unsupportedDeclarationMutation(): never {
  throw new ActiveFSError("UNSUPPORTED", "Memory and generated trees do not support declaration mutation; use fsTree() for authoring");
}

function unsupportedPathHandle(): never {
  throw new ActiveFSError("UNSUPPORTED", "Memory and generated trees do not expose declaration path handles; use fsTree() for authoring");
}

async function unsupportedMutation<Auth, Meta>(
  _context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath
): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
  throw new ActiveFSError("UNSUPPORTED", "Generated tree is read-only", { path });
}

async function unsupportedMove<Auth, Meta>(
  _context: ActiveFSContext<Auth, Meta>,
  fromPath: ActiveFSPath
): Promise<ActiveFSTreeMutationResult<Auth, Meta>> {
  throw new ActiveFSError("UNSUPPORTED", "Generated tree is read-only", { path: fromPath });
}

async function unsupportedWatch<Meta>(
  _context: ActiveFSContext,
  path: ActiveFSPath,
  _onEvent: (event: ActiveFSWatchEvent<Meta>) => void
): Promise<ActiveFSWatchSubscription> {
  throw new ActiveFSError("UNSUPPORTED", "Generated tree watch is disabled", { path });
}

function statToTreeInfo<Meta>(stat: ActiveFSStat<Meta> | ActiveFSDirEntry<Meta> | null): ActiveFSTreeInfo<Meta> {
  if (!stat) {
    return null;
  }
  return {
    path: stat.path,
    name: stat.name,
    kind: stat.kind,
    type: stat.mimeType,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    enumerable: stat.enumerable,
    etag: "etag" in stat ? stat.etag : undefined,
    revision: "revision" in stat ? stat.revision : undefined,
    permissions: {
      readable: stat.capabilities?.readable ?? stat.capabilities?.read,
      writable: stat.capabilities?.writable ?? stat.capabilities?.write,
      searchable: stat.capabilities?.searchable ?? stat.capabilities?.search,
      deletable: stat.capabilities?.delete,
      renamable: stat.capabilities?.rename,
      copyable: stat.capabilities?.copy
    },
    meta: stat.meta,
    data: stat.meta
  };
}

function statToTreeInfoNonNull<Meta>(stat: ActiveFSStat<Meta> | ActiveFSDirEntry<Meta>): NonNullable<ActiveFSTreeInfo<Meta>> {
  return statToTreeInfo(stat)!;
}

function readResultToTreeReadResult<Meta>(result: ActiveFSReadResult<Meta>): ActiveFSTreeReadResult<Meta> {
  return {
    content: result.content,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    meta: result.meta,
    data: result.meta
  };
}

function activeFSSearchToTreeSearch<Meta>(result: ActiveFSSearchResult<Meta>): ActiveFSTreeSearchResult<Meta> {
  return {
    matches: result.matches.map((match) => ({
      path: match.path,
      line: match.line,
      column: match.column,
      excerpt: match.excerpt,
      meta: match.meta,
      data: match.meta
    })),
    complete: result.complete,
    strategy: result.strategy,
    incompleteReasons: result.incompleteReasons
  };
}

function writeResultToTreeMutation<Auth, Meta>(
  path: ActiveFSPath,
  result: ActiveFSWriteResult<Meta>
): ActiveFSTreeMutationResult<Auth, Meta> {
  const normalizedPath = result.stat?.path ?? normalizeActiveFSPath(path);
  return {
    [result.created ? "created" : "modified"]: normalizedPath,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    revision: result.revision,
    meta: result.meta,
    data: result.meta
  };
}

async function walkMemoryTree<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  metadata: Map<ActiveFSPath, { mtimeMs?: number }>,
  options: { includeNonEnumerable?: boolean } = {}
): Promise<NonNullable<ActiveFSTreeInfo<Meta>>[]> {
  const normalizedPath = normalizeActiveFSPath(path);
  const info = statToTreeInfo(statPath<Meta>(files, directories, normalizedPath, metadata));
  if (!info) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, { path: normalizedPath });
  }
  const results: NonNullable<ActiveFSTreeInfo<Meta>>[] = [info];
  if (info.kind !== "directory") {
    return results;
  }
  for (const entry of listPath<Meta>(files, directories, normalizedPath, metadata)) {
    if (entry.enumerable === false && !options.includeNonEnumerable) {
      continue;
    }
    results.push(...await walkMemoryTree<Meta>(files, directories, entry.path, metadata, options));
  }
  return results;
}

async function walkGeneratedTree<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>,
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath,
  options: { includeNonEnumerable?: boolean } = {}
): Promise<NonNullable<ActiveFSTreeInfo<Meta>>[]> {
  const normalizedPath = normalizeActiveFSPath(path);
  const info = statToTreeInfo(await statGeneratedPath(context, visibleFiles, dynamicFiles, normalizedPath));
  if (!info) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, { path: normalizedPath });
  }
  const results: NonNullable<ActiveFSTreeInfo<Meta>>[] = [info];
  if (info.kind !== "directory") {
    return results;
  }
  for (const entry of listGeneratedPath(visibleFiles, dynamicFiles, normalizedPath)) {
    if (entry.enumerable === false && !options.includeNonEnumerable) {
      continue;
    }
    results.push(...await walkGeneratedTree(context, visibleFiles, dynamicFiles, entry.path, options));
  }
  return results;
}

function statPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): ActiveFSStat<Meta> | null {
  const normalizedPath = normalizeActiveFSPath(path);
  if (files.has(normalizedPath)) {
    const content = files.get(normalizedPath)!;
    return {
      ...fileStat<Meta>(normalizedPath, activeFSContentByteLength(content)),
      ...metadata?.get(normalizedPath)
    };
  }
  if (directories.has(normalizedPath)) {
    return {
      ...directoryStat<Meta>(normalizedPath),
      ...metadata?.get(normalizedPath)
    };
  }
  return null;
}

function listPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): ActiveFSDirEntry<Meta>[] {
  const normalizedPath = normalizeActiveFSPath(path);
  if (!directories.has(normalizedPath)) {
    throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  return listEntries(files, directories, normalizedPath, metadata);
}

function readPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  path: ActiveFSPath,
  options?: ActiveFSReadOptions,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): ActiveFSReadResult<Meta> {
  const content = files.get(path);
  if (content === undefined) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  return {
    content: sliceActiveFSContent(content, options),
    stat: {
      ...fileStat<Meta>(path, activeFSContentByteLength(content)),
      ...metadata?.get(path)
    }
  };
}

function writePath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  content: TreeContent,
  options?: ActiveFSWriteOptions<Meta>,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): ActiveFSWriteResult<Meta> {
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === "/") {
    throw new ActiveFSError("INVALID_PATH", "Cannot write a file at the tree root", {
      path: normalizedPath
    });
  }
  const exists = files.has(normalizedPath);
  if (exists && options?.overwrite === false) {
    throw new ActiveFSError("INVALID_REQUEST", `Path already exists: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  if (!exists && options?.create === false) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  ensureParentDirectories(directories, normalizedPath);
  files.set(normalizedPath, copyContent(content));
  metadata?.delete(normalizedPath);
  return {
    stat: fileStat(normalizedPath, activeFSContentByteLength(content), options?.contentType),
    created: !exists,
    meta: options?.meta
  };
}

function deletePath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  options?: ActiveFSDeleteOptions
): { path: ActiveFSPath; deleted: boolean } {
  const normalizedPath = normalizeActiveFSPath(path);
  if (files.delete(normalizedPath)) {
    return { path: normalizedPath, deleted: true };
  }
  if (directories.has(normalizedPath)) {
    return rmdirPath(files, directories, normalizedPath, options);
  }
  throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, { path: normalizedPath });
}

function mkdirPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  options?: ActiveFSMkdirOptions<Meta>
): { stat: ActiveFSStat<Meta>; created: boolean; meta?: Meta } {
  const normalizedPath = normalizeActiveFSPath(path);
  if (files.has(normalizedPath)) {
    throw new ActiveFSError("INVALID_REQUEST", `Path is a file: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  const existed = directories.has(normalizedPath);
  if (!options?.recursive) {
    const parent = parentActiveFSPath(normalizedPath);
    if (!directories.has(parent)) {
      throw new ActiveFSError("NOT_FOUND", `Parent path not found: ${parent}`, { path: parent });
    }
  }
  let current = normalizedPath;
  const pending: ActiveFSPath[] = [];
  while (!directories.has(current)) {
    pending.push(current);
    current = parentActiveFSPath(current);
  }
  for (const directory of pending.reverse()) {
    directories.add(directory);
  }
  return { stat: directoryStat(normalizedPath), created: !existed, meta: options?.meta };
}

function rmdirPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  options?: ActiveFSDeleteOptions
): { path: ActiveFSPath; deleted: boolean } {
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === "/") {
    throw new ActiveFSError("INVALID_PATH", "Cannot remove the tree root", { path: normalizedPath });
  }
  if (!directories.has(normalizedPath)) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, { path: normalizedPath });
  }
  const hasChildren = [...files.keys()].some((filePath) => isActiveFSPathWithin(normalizedPath, filePath)) ||
    [...directories].some((directory) => directory !== normalizedPath && isActiveFSPathWithin(normalizedPath, directory));
  if (hasChildren && !options?.recursive) {
    throw new ActiveFSError("INVALID_REQUEST", `Directory is not empty: ${normalizedPath}`, {
      path: normalizedPath
    });
  }
  for (const filePath of [...files.keys()]) {
    if (isActiveFSPathWithin(normalizedPath, filePath)) {
      files.delete(filePath);
    }
  }
  for (const directory of [...directories]) {
    if (directory !== "/" && isActiveFSPathWithin(normalizedPath, directory)) {
      directories.delete(directory);
    }
  }
  return { path: normalizedPath, deleted: true };
}

function renamePath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  fromPath: ActiveFSPath,
  toPath: ActiveFSPath,
  options?: ActiveFSRenameOptions,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): { from: ActiveFSPath; to: ActiveFSPath; stat?: ActiveFSStat<Meta> } {
  const from = normalizeActiveFSPath(fromPath);
  const to = normalizeActiveFSPath(toPath);
  copyPath(files, directories, from, to, { overwrite: options?.overwrite, recursive: true }, metadata);
  const fromWasDirectory = directories.has(from);
  if (fromWasDirectory) {
    rmdirPath(files, directories, from, { recursive: true });
  } else {
    files.delete(from);
  }
  return {
    from,
    to,
    stat: statPath(files, directories, to, metadata) ?? undefined
  };
}

function copyPath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  fromPath: ActiveFSPath,
  toPath: ActiveFSPath,
  options?: ActiveFSCopyOptions,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): { from: ActiveFSPath; to: ActiveFSPath; stat?: ActiveFSStat<Meta> } {
  const from = normalizeActiveFSPath(fromPath);
  const to = normalizeActiveFSPath(toPath);
  if (files.has(to) && options?.overwrite === false) {
    throw new ActiveFSError("INVALID_REQUEST", `Path already exists: ${to}`, { path: to });
  }
  if (files.has(from)) {
    ensureParentDirectories(directories, to);
    files.set(to, copyContent(files.get(from)!));
    if (metadata?.has(from)) {
      metadata.set(to, { ...metadata.get(from)! });
    }
    return { from, to, stat: statPath(files, directories, to, metadata) ?? undefined };
  }
  if (!directories.has(from)) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${from}`, { path: from });
  }
  if (!options?.recursive) {
    throw new ActiveFSError("INVALID_REQUEST", `Recursive copy is required for directory: ${from}`, {
      path: from
    });
  }
  ensureParentDirectories(directories, to);
  directories.add(to);
  for (const directory of [...directories]) {
    if (directory !== from && isActiveFSPathWithin(from, directory)) {
      directories.add(normalizeActiveFSPath(`${to}/${directory.slice(from.length + 1)}`));
    }
  }
  for (const [filePath, content] of [...files]) {
    if (isActiveFSPathWithin(from, filePath)) {
      const copiedPath = normalizeActiveFSPath(`${to}/${filePath.slice(from.length + 1)}`);
      files.set(copiedPath, copyContent(content));
      if (metadata?.has(filePath)) {
        metadata.set(copiedPath, { ...metadata.get(filePath)! });
      }
    }
  }
  return { from, to, stat: statPath(files, directories, to, metadata) ?? undefined };
}

function truncatePath<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  path: ActiveFSPath,
  options?: ActiveFSTruncateOptions,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): { stat: ActiveFSStat<Meta> } {
  const normalizedPath = normalizeActiveFSPath(path);
  const content = files.get(normalizedPath);
  if (content === undefined) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizedPath}`, { path: normalizedPath });
  }
  const length = options?.length ?? 0;
  if (length < 0) {
    throw new ActiveFSError("INVALID_REQUEST", "truncate length must be non-negative", {
      path: normalizedPath
    });
  }
  const bytes = activeFSContentToBytes(content);
  const truncated = bytes.byteLength > length
    ? bytes.slice(0, length)
    : new Uint8Array([...bytes, ...new Uint8Array(length - bytes.byteLength)]);
  files.set(normalizedPath, typeof content === "string" ? new TextDecoder().decode(truncated) : truncated);
  return {
    stat: {
      ...fileStat<Meta>(normalizedPath, length),
      ...metadata?.get(normalizedPath)
    }
  };
}

function watchMemoryPath<Meta>(
  rootPath: ActiveFSPath,
  onEvent: (event: ActiveFSWatchEvent<Meta>) => void,
  watchers: Set<(event: ActiveFSWatchEvent<Meta>) => void>,
  options?: ActiveFSWatchOptions
): ActiveFSWatchSubscription {
  const normalizedRoot = normalizeActiveFSPath(rootPath);
  const watcher = (event: ActiveFSWatchEvent<Meta>): void => {
    if (!matchesActiveFSWatchRoot(normalizedRoot, event.path, { recursive: options?.recursive })) {
      return;
    }
    onEvent(event);
  };
  watchers.add(watcher);

  const close = (): void => {
    watchers.delete(watcher);
  };
  if (options?.signal) {
    if (options.signal.aborted) {
      close();
    } else {
      options.signal.addEventListener("abort", close, { once: true });
    }
  }
  return { close };
}

async function statGeneratedPath<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>,
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath
): Promise<ActiveFSStat<Meta> | null> {
  const file = visibleFiles.get(path) ?? dynamicFiles.get(path);
  if (file) {
    const content = await resolveGeneratedContent(context, path, file.content);
    return {
      ...fileStat<Meta>(path, activeFSContentByteLength(content), file.mimeType),
      enumerable: file.enumerable
    };
  }

  const dirs = generatedDirectoryMap(visibleFiles, dynamicFiles);
  const directory = dirs.get(path);
  return directory
    ? {
        ...directoryStat<Meta>(path),
        enumerable: directory.enumerable
      }
    : null;
}

function listGeneratedPath<Auth, Meta>(
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath
): ActiveFSDirEntry<Meta>[] {
  const dirs = generatedDirectoryMap(visibleFiles, dynamicFiles);
  if (!dirs.has(path)) {
    throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${path}`, { path });
  }

  const children = new Map<string, ActiveFSDirEntry<Meta>>();
  addGeneratedChildren(children, visibleFiles, path);
  addGeneratedChildren(children, dynamicFiles, path);
  return [...children.values()].sort(compareEntries);
}

async function readGeneratedPath<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>,
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath,
  options?: ActiveFSReadOptions
): Promise<ActiveFSReadResult<Meta>> {
  const file = visibleFiles.get(path) ?? dynamicFiles.get(path);
  if (!file) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  const content = await resolveGeneratedContent(context, path, file.content);
  return {
    content: sliceActiveFSContent(content, options),
    stat: {
      ...fileStat<Meta>(path, activeFSContentByteLength(content), file.mimeType),
      enumerable: file.enumerable
    }
  };
}

async function searchGeneratedFiles<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>,
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath,
  query: ActiveFSSearchQuery
): Promise<ActiveFSSearchResult<Meta>> {
  const matches: ActiveFSSearchMatch<Meta>[] = [];
  const maxResults = Math.max(
    0,
    query.maxResults ?? context.maxSearchResults ?? Number.POSITIVE_INFINITY
  );
  for (const [filePath, file] of [...visibleFiles, ...dynamicFiles]) {
    assertTestingSearchNotCancelled(context);
    if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
      return {
        matches,
        complete: false,
        strategy: "source",
        incompleteReasons: ["timeout"]
      };
    }
    if ((!file.enumerable && !query.includeNonEnumerable) || !isActiveFSPathWithin(path, filePath)) {
      continue;
    }
    const content = await resolveGeneratedContent(context, filePath, file.content);
    for (const match of matchContent<Meta>(filePath, content, query)) {
      if (matches.length >= maxResults) {
        return {
          matches,
          complete: false,
          strategy: "source",
          incompleteReasons: ["max-results"]
        };
      }
      matches.push(match);
    }
  }
  return { matches, complete: true, strategy: "source" };
}

function searchFiles<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  path: ActiveFSPath,
  query: ActiveFSSearchQuery,
  context: ActiveFSContext = {}
): ActiveFSSearchResult<Meta> {
  const matches: ActiveFSSearchMatch<Meta>[] = [];
  const maxResults = Math.max(
    0,
    query.maxResults ?? context.maxSearchResults ?? Number.POSITIVE_INFINITY
  );
  for (const [filePath, content] of files) {
    assertTestingSearchNotCancelled(context);
    if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
      return {
        matches,
        complete: false,
        strategy: "source",
        incompleteReasons: ["timeout"]
      };
    }
    if (!isActiveFSPathWithin(path, filePath)) {
      continue;
    }
    for (const match of matchContent<Meta>(filePath, content, query)) {
      if (matches.length >= maxResults) {
        return {
          matches,
          complete: false,
          strategy: "source",
          incompleteReasons: ["max-results"]
        };
      }
      matches.push(match);
    }
  }

  return { matches, complete: true, strategy: "source" };
}

function listEntries<Meta>(
  files: Map<ActiveFSPath, TreeContent>,
  directories: Set<ActiveFSPath>,
  path: ActiveFSPath,
  metadata?: Map<ActiveFSPath, { mtimeMs?: number }>
): ActiveFSDirEntry<Meta>[] {
  const children = new Map<string, ActiveFSDirEntry<Meta>>();
  for (const directory of directories) {
    if (directory === path || directory === "/") {
      continue;
    }
    if (parentActiveFSPath(directory) === path) {
      children.set(basename(directory), {
        ...directoryStat(directory),
        ...metadata?.get(directory)
      });
    }
  }
  for (const [filePath, content] of files) {
    if (parentActiveFSPath(filePath) === path) {
      children.set(basename(filePath), {
        ...fileStat(filePath, activeFSContentByteLength(content)),
        ...metadata?.get(filePath)
      });
    }
  }
  return [...children.values()].sort(compareEntries);
}

function addGeneratedChildren<Auth, Meta>(
  children: Map<string, ActiveFSDirEntry<Meta>>,
  files: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  path: ActiveFSPath
): void {
  for (const [filePath, file] of files) {
    const childPath = immediateChild(path, filePath);
    if (!childPath) {
      continue;
    }
    const isFile = childPath === filePath;
    children.set(basename(childPath), {
      name: basename(childPath),
      path: childPath,
      kind: isFile ? "file" : "directory",
      capabilities: isFile
        ? { stat: true, read: true, rangeReadable: true }
        : { stat: true, list: true },
      mimeType: isFile ? file.mimeType : undefined,
      enumerable: file.enumerable
    });
  }
}

function generatedDirectoryMap<Auth, Meta>(
  visibleFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>,
  dynamicFiles: Map<ActiveFSPath, GeneratedFileRecord<Auth, Meta>>
): Map<ActiveFSPath, { enumerable: boolean }> {
  const directories = new Map<ActiveFSPath, { enumerable: boolean }>();
  directories.set("/", { enumerable: true });

  for (const [filePath, file] of [...visibleFiles, ...dynamicFiles]) {
    let current = parentActiveFSPath(filePath);
    while (true) {
      const previous = directories.get(current);
      directories.set(current, { enumerable: (previous?.enumerable ?? false) || file.enumerable });
      if (current === "/") {
        break;
      }
      current = parentActiveFSPath(current);
    }
  }

  return directories;
}

function ensureParentDirectories(directories: Set<ActiveFSPath>, path: ActiveFSPath): void {
  let current = parentActiveFSPath(path);
  const pending: ActiveFSPath[] = [];
  while (!directories.has(current)) {
    pending.push(current);
    if (current === "/") {
      break;
    }
    current = parentActiveFSPath(current);
  }
  for (const directory of pending.reverse()) {
    directories.add(directory);
  }
}

function emitWatchEvent<Meta>(
  watchers: Set<(event: ActiveFSWatchEvent<Meta>) => void>,
  event: ActiveFSWatchEvent<Meta>
): void {
  for (const watcher of watchers) {
    watcher(event);
  }
}

async function resolveGeneratedContent<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath,
  content: GeneratedContent<Auth, Meta>
): Promise<TreeContent> {
  return typeof content === "function" ? content(context, path) : content;
}

function directorySet(files: Map<ActiveFSPath, TreeContent>): Set<ActiveFSPath> {
  const directories = new Set<ActiveFSPath>(["/"]);
  for (const filePath of files.keys()) {
    let current = parentActiveFSPath(filePath);
    while (true) {
      directories.add(current);
      if (current === "/") {
        break;
      }
      current = parentActiveFSPath(current);
    }
  }
  return directories;
}

function fileStat<Meta>(path: ActiveFSPath, size: number, mimeType?: string): ActiveFSStat<Meta> {
  return {
    name: basename(path),
    path,
    kind: "file",
    capabilities: { stat: true, read: true, rangeReadable: true },
    size,
    mimeType,
    enumerable: true
  };
}

function directoryStat<Meta>(path: ActiveFSPath): ActiveFSStat<Meta> {
  return {
    name: path === "/" ? "" : basename(path),
    path,
    kind: "directory",
    capabilities: { stat: true, list: true },
    enumerable: true
  };
}

function basename(path: ActiveFSPath): string {
  if (path === "/") {
    return "";
  }
  return path.slice(path.lastIndexOf("/") + 1);
}

function immediateChild(parent: ActiveFSPath, child: ActiveFSPath): ActiveFSPath | null {
  if (!isActiveFSPathWithin(parent, child) || parent === child) {
    return null;
  }
  const rest = parent === "/" ? child.slice(1) : child.slice(parent.length + 1);
  const segment = rest.split("/")[0];
  return parent === "/" ? `/${segment}` : `${parent}/${segment}` as ActiveFSPath;
}

function copyContent(content: TreeContent): TreeContent {
  return typeof content === "string" ? content : copyActiveFSBytes(content);
}

function matchContent<Meta>(
  path: ActiveFSPath,
  content: TreeContent,
  query: ActiveFSSearchQuery
): ActiveFSSearchMatch<Meta>[] {
  const text = typeof content === "string" ? content : new TextDecoder().decode(content);
  const caseSensitive = query.caseSensitive === true;
  const needle = caseSensitive ? query.pattern : query.pattern.toLowerCase();
  const matches: ActiveFSSearchMatch<Meta>[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column >= 0) {
      matches.push({
        path,
        line: index + 1,
        column: column + 1,
        excerpt: line
      });
    }
  });

  return matches;
}

function assertTestingSearchNotCancelled(context: ActiveFSContext): void {
  if (context.signal?.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new ActiveFSError("TRANSIENT", "Search was cancelled");
  }
}

function compareEntries(left: ActiveFSDirEntry, right: ActiveFSDirEntry): number {
  return left.name.localeCompare(right.name);
}
