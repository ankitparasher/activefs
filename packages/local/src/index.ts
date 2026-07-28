import { watch as watchFs, type FSWatcher, type Stats } from "node:fs";
import {
  cp,
  lstat as lstatFs,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir as rmdirFs,
  stat as statFs,
  truncate as truncateFs,
  utimes,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  join,
  isAbsolute,
  relative,
  resolve,
  sep
} from "node:path";
import type {
  ActiveFSContext,
  ActiveFSDirEntry,
  ActiveFS,
  ActiveFSPath,
  ActiveFSReadOptions,
  ActiveFSReadResult,
  ActiveFSSearchQuery,
  ActiveFSMountTree,
  ActiveFSTree,
  ActiveFSTreeInfo,
  ActiveFSTreeMutationResult,
  ActiveFSTreeReadResult,
  ActiveFSTreeSearchResult,
  ActiveFSStat,
  ActiveFSCopyOptions,
  ActiveFSDeleteOptions,
  ActiveFSMkdirOptions,
  ActiveFSMetadataUpdateOptions,
  ActiveFSRenameOptions,
  ActiveFSTruncateOptions,
  ActiveFSWatchSubscription,
  ActiveFSWriteOptions,
  ActiveFSWriteResult,
  MaybePromise
} from "@activefs/core";
import {
  ActiveFSError,
  activeFSContentToBytes,
  copyActiveFSBytes,
  createActiveFS,
  isActiveFSPathWithin,
  normalizeActiveFSPath,
  parentActiveFSPath,
  runDefaultActiveFSTreeCommand,
  sliceActiveFSContent
} from "@activefs/core";

/**
 * Normalized operation names emitted when a local cache entry is served.
 */
export type LocalCacheActivityOperation = "read" | "list" | "stat" | "search";

/**
 * Activity emitted after a verified local cache hit.
 */
export interface LocalCacheActivity {
  operation: LocalCacheActivityOperation;
  path: ActiveFSPath;
  timestamp: string;
  source: "cache";
  result: "succeeded";
  stateHash?: string;
  contentHash?: string;
}

/**
 * Callback invoked when a local cache entry is served after integrity checks.
 */
export type LocalCacheActivityReporter = (
  activity: LocalCacheActivity
) => MaybePromise<void>;

/**
 * Options for creating a `LocalCache`.
 */
export interface LocalCacheOptions {
  onActivity?: LocalCacheActivityReporter;
}

/**
 * Options for exposing a local directory as an ActiveFS tree.
 *
 * The local tree resolves paths under `root` and rejects symlink escapes from
 * that root. Mutation methods are only installed when `readonly` is false.
 */
export interface LocalTreeOptions {
  root: string;
  readonly?: boolean;
  cache?: LocalCache | boolean;
  watch?: boolean;
  onCacheActivity?: LocalCacheActivityReporter;
}

/**
 * Metadata attached to local-tree entries.
 */
export interface LocalTreeMeta {
  realPath: string;
  stateHash: string;
}

/**
 * ActiveFS tree backed by a local filesystem root.
 *
 * `root` is the resolved host path. `clearCache` is available even when caching
 * is disabled so callers can safely invalidate by path without inspecting
 * cache configuration.
 */
export interface LocalActiveFSTree<Auth = unknown>
  extends ActiveFSTree<Auth, LocalTreeMeta> {
  root: string;
  cache?: LocalCache;
  /** Clears all cached local entries or entries under one ActiveFS path. */
  clearCache(path?: string): void;
}

/**
 * Snapshot of local read and directory cache activity.
 */
export interface LocalCacheStats {
  statHits: number;
  statMisses: number;
  readHits: number;
  readMisses: number;
  directoryHits: number;
  directoryMisses: number;
}

interface CachedRead {
  content: Uint8Array;
  contentHash: string;
  stat: ActiveFSStat<LocalTreeMeta>;
}

/**
 * In-memory cache for local-tree reads and directory listings.
 *
 * Cache keys include the ActiveFS path and tree/provider state hash, so stale file
 * content is not reused after the local state changes. Values are copied on
 * read/write to avoid caller mutation.
 */
export class LocalCache {
  private readonly statsByPath = new Map<string, ActiveFSStat<LocalTreeMeta>>();
  private readonly reads = new Map<string, CachedRead>();
  private readonly directories = new Map<string, ActiveFSDirEntry<LocalTreeMeta>[]>();
  private stats: LocalCacheStats = {
    statHits: 0,
    statMisses: 0,
    readHits: 0,
    readMisses: 0,
    directoryHits: 0,
    directoryMisses: 0
  };

  constructor(private readonly options: LocalCacheOptions = {}) {}

  /**
   * Reads a cached stat entry for a path and state hash.
   *
   * @returns A defensive copy, or `undefined` on a miss.
   */
  getStat(path: ActiveFSPath, stateHash: string): ActiveFSStat<LocalTreeMeta> | undefined {
    const cached = this.statsByPath.get(cacheKey(path, stateHash));
    if (!cached) {
      this.stats.statMisses += 1;
      return undefined;
    }
    this.stats.statHits += 1;
    return copyStat(cached);
  }

  /**
   * Stores a defensive copy of a stat result.
   */
  setStat(path: ActiveFSPath, stateHash: string, value: ActiveFSStat<LocalTreeMeta>): void {
    this.statsByPath.set(cacheKey(path, stateHash), copyStat(value));
  }

  /**
   * Reads a cached file entry for a path and state hash.
   *
   * @returns A defensive copy, or `undefined` on a miss.
   */
  getRead(path: ActiveFSPath, stateHash: string): CachedRead | undefined {
    const key = cacheKey(path, stateHash);
    const cached = this.reads.get(key);
    if (!cached) {
      this.stats.readMisses += 1;
      return undefined;
    }
    const actualHash = sha256(cached.content);
    if (actualHash !== cached.contentHash) {
      this.reads.delete(key);
      throw new ActiveFSError("SOURCE_ERROR", `Cached read digest mismatch: ${path}`, {
        path,
        cause: { expected: cached.contentHash, actual: actualHash }
      });
    }
    this.stats.readHits += 1;
    return {
      content: copyActiveFSBytes(cached.content),
      contentHash: cached.contentHash,
      stat: { ...cached.stat, meta: cached.stat.meta ? { ...cached.stat.meta } : undefined }
    };
  }

  /**
   * Stores a defensive copy of a file read result.
   */
  setRead(path: ActiveFSPath, stateHash: string, value: CachedRead): void {
    this.reads.set(cacheKey(path, stateHash), {
      content: copyActiveFSBytes(value.content),
      contentHash: value.contentHash ?? sha256(value.content),
      stat: { ...value.stat, meta: value.stat.meta ? { ...value.stat.meta } : undefined }
    });
  }

  /**
   * Reads a cached directory listing for a path and state hash.
   *
   * @returns Defensive copies of cached entries, or `undefined` on a miss.
   */
  getDirectory(
    path: ActiveFSPath,
    stateHash: string
  ): ActiveFSDirEntry<LocalTreeMeta>[] | undefined {
    const cached = this.directories.get(cacheKey(path, stateHash));
    if (!cached) {
      this.stats.directoryMisses += 1;
      return undefined;
    }
    this.stats.directoryHits += 1;
    return cached.map((entry) => ({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined }));
  }

  /**
   * Stores defensive copies of a directory listing.
   */
  setDirectory(
    path: ActiveFSPath,
    stateHash: string,
    entries: ActiveFSDirEntry<LocalTreeMeta>[]
  ): void {
    this.directories.set(
      cacheKey(path, stateHash),
      entries.map((entry) => ({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined }))
    );
  }

  /**
   * Clears all cached reads/directories and resets cache statistics.
   */
  clear(): void {
    this.statsByPath.clear();
    this.reads.clear();
    this.directories.clear();
    this.resetStats();
  }

  private resetStats(): void {
    this.stats = {
      statHits: 0,
      statMisses: 0,
      readHits: 0,
      readMisses: 0,
      directoryHits: 0,
      directoryMisses: 0
    };
  }

  /**
   * Clears cached reads and directories whose keys belong to a path prefix.
   */
  clearPath(path: ActiveFSPath): void {
    for (const key of this.statsByPath.keys()) {
      if (cacheKeyMatchesPath(key, path)) {
        this.statsByPath.delete(key);
      }
    }
    for (const key of this.reads.keys()) {
      if (cacheKeyMatchesPath(key, path)) {
        this.reads.delete(key);
      }
    }
    for (const key of this.directories.keys()) {
      if (cacheKeyMatchesPath(key, path)) {
        this.directories.delete(key);
      }
    }
  }

  /**
   * Returns current cache counters without exposing mutable internal state.
   */
  snapshotStats(): LocalCacheStats {
    return { ...this.stats };
  }

  /**
   * Emits a normalized cache-hit activity event through the configured reporter.
   */
  async reportActivity(activity: Omit<LocalCacheActivity, "timestamp" | "source" | "result">): Promise<void> {
    await this.options.onActivity?.({
      ...activity,
      timestamp: new Date().toISOString(),
      source: "cache",
      result: "succeeded"
    });
  }
}

/**
 * Creates an empty local cache instance.
 */
export function createLocalCache(options: LocalCacheOptions = {}): LocalCache {
  return new LocalCache(options);
}

/**
 * Creates an ActiveFS tree backed by a local filesystem directory.
 *
 * @param options Local root, readonly mode, cache policy, and watch setting.
 * @returns An ActiveFS tree with local filesystem-backed handlers.
 * @throws `ActiveFSError` for path escapes, missing files, directory/file type
 * mismatches, readonly mutations, and unsupported filesystem operations.
 */
export function createLocalTree<Auth = unknown>(
  options: LocalTreeOptions
): LocalActiveFSTree<Auth> {
  const root = resolve(options.root);
  const cache =
    options.cache === false
      ? undefined
      : options.cache instanceof LocalCache
        ? options.cache
        : createLocalCache({ onActivity: options.onCacheActivity });

  const tree: LocalActiveFSTree<Auth> = {
    name: "local",
    root,
    cache,
    capabilities: {
      stat: true,
      list: true,
      read: true,
      rangeReadable: true,
      create: options.readonly !== true,
      write: options.readonly !== true,
      truncate: options.readonly !== true,
      delete: options.readonly !== true,
      mkdir: options.readonly !== true,
      rmdir: options.readonly !== true,
      rename: options.readonly !== true,
      copy: options.readonly !== true,
      updateMetadata: options.readonly !== true,
      watch: options.watch !== false
    },
    clearCache: (path) => path ? cache?.clearPath(normalizeActiveFSPath(path)) : cache?.clear(),
    set: unsupportedLocalTreeDeclarationMutation,
    path: unsupportedLocalTreePathHandle,
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
    info: async (_context, path) => statToTreeInfo(await statLocalPath(root, path, cache)),
    list: async (_context, path) =>
      (await listLocalPath(root, path, cache)).map((entry) => statToTreeInfo(entry)!),
    read: async (_context, path, readOptions) =>
      readResultToTreeRead(await readLocalPath(root, path, readOptions, cache)),
    search: async (context, path, query) =>
      searchLocalTree(root, path, query, cache, context),
    walk: async (_context, path, walkOptions) =>
      walkLocalTree(root, path, cache, walkOptions),
    write: async (_context, path, content, writeOptions) => {
      assertLocalTreeWritable(path, options);
      return writeResultToTreeMutation(path, await writeLocalPath(root, path, content, writeOptions, cache));
    },
    remove: async (_context, path, deleteOptions) => {
      assertLocalTreeWritable(path, options);
      const result = await deleteLocalPath(root, path, deleteOptions, cache);
      return { removed: result.path };
    },
    makeDir: async (_context, path, mkdirOptions) => {
      assertLocalTreeWritable(path, options);
      return mkdirResultToTreeMutation(path, await mkdirLocalPath(root, path, mkdirOptions, cache));
    },
    move: async (_context, fromPath, toPath, renameOptions) => {
      assertLocalTreeWritable(fromPath, options);
      const result = await renameLocalPath(root, fromPath, toPath, renameOptions, cache);
      return {
        moved: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined
      };
    },
    copy: async (_context, fromPath, toPath, copyOptions) => {
      assertLocalTreeWritable(fromPath, options);
      const result = await copyLocalPath(root, fromPath, toPath, copyOptions, cache);
      return {
        copied: { from: result.from, to: result.to },
        info: result.stat ? statToTreeInfo(result.stat) : undefined
      };
    },
    truncate: async (_context, path, truncateOptions) => {
      assertLocalTreeWritable(path, options);
      const result = await truncateLocalPath(root, path, truncateOptions, cache);
      return {
        modified: path,
        info: result.stat ? statToTreeInfo(result.stat) : undefined
      };
    },
    updateInfo: async (_context, path, metadataOptions) => {
      assertLocalTreeWritable(path, options);
      const result = await updateLocalMetadata(root, path, metadataOptions, cache);
      return {
        modified: path,
        info: result.stat ? statToTreeInfo(result.stat) : undefined,
        data: result.meta
      };
    },
    watch: async (_context, path, onEvent, watchOptions) => {
      if (options.watch === false) {
        throw new ActiveFSError("UNSUPPORTED", "Local tree watch is disabled", { path });
      }
      return watchLocalPath(
        root,
        path,
        (event) => {
          if (watchOptions?.signal?.aborted) {
            return;
          }
          cache?.clear();
          onEvent(event);
        },
        watchOptions?.signal
      );
    },
    command: async (context, command, path, input) =>
      runDefaultActiveFSTreeCommand(tree, context, command, path, input)
  };

  return tree;
}

function unsupportedLocalTreeDeclarationMutation(): never {
  throw new ActiveFSError("UNSUPPORTED", "Local trees do not support declaration mutation; use fsTree() for authoring");
}

function unsupportedLocalTreePathHandle(): never {
  throw new ActiveFSError("UNSUPPORTED", "Local trees do not expose declaration path handles; use fsTree() for authoring");
}

function assertLocalTreeWritable(path: ActiveFSPath, options: LocalTreeOptions): void {
  if (options.readonly) {
    throw new ActiveFSError("UNSUPPORTED", `Local tree is read-only: ${path}`, { path });
  }
}

function statToTreeInfo(stat: ActiveFSStat<LocalTreeMeta> | ActiveFSDirEntry<LocalTreeMeta> | null): ActiveFSTreeInfo<LocalTreeMeta> {
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
    etag: "etag" in stat ? stat.etag : undefined,
    revision: "revision" in stat ? stat.revision : undefined,
    enumerable: stat.enumerable,
    permissions: {
      readable: stat.capabilities?.readable ?? stat.capabilities?.read,
      writable: stat.capabilities?.writable ?? stat.capabilities?.write,
      searchable: stat.capabilities?.searchable ?? stat.capabilities?.search,
      deletable: stat.capabilities?.delete,
      renamable: stat.capabilities?.rename,
      copyable: stat.capabilities?.copy
    },
    data: stat.meta
  };
}

function readResultToTreeRead(result: ActiveFSReadResult<LocalTreeMeta>): ActiveFSTreeReadResult<LocalTreeMeta> {
  return {
    content: result.content,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    data: result.meta
  };
}

function writeResultToTreeMutation<Auth>(
  path: ActiveFSPath,
  result: ActiveFSWriteResult<LocalTreeMeta>
): ActiveFSTreeMutationResult<Auth, LocalTreeMeta> {
  const resultPath = result.stat?.path ?? path;
  return {
    [result.created ? "created" : "modified"]: resultPath,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    revision: result.revision,
    data: result.meta
  };
}

function mkdirResultToTreeMutation<Auth>(
  path: ActiveFSPath,
  result: { stat: ActiveFSStat<LocalTreeMeta>; created: boolean; meta?: LocalTreeMeta }
): ActiveFSTreeMutationResult<Auth, LocalTreeMeta> {
  const resultPath = result.stat?.path ?? path;
  return {
    [result.created ? "created" : "modified"]: resultPath,
    info: result.stat ? statToTreeInfo(result.stat) : undefined,
    data: result.meta
  };
}

async function walkLocalTree(
  root: string,
  path: ActiveFSPath,
  cache: LocalCache | undefined,
  options: { includeNonEnumerable?: boolean } = {}
): Promise<NonNullable<ActiveFSTreeInfo<LocalTreeMeta>>[]> {
  const info = statToTreeInfo(await statLocalPath(root, path, cache));
  if (!info) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  const results: NonNullable<ActiveFSTreeInfo<LocalTreeMeta>>[] = [info];
  if (info.kind !== "directory") {
    return results;
  }
  for (const entry of await listLocalPath(root, path, cache)) {
    if (entry.enumerable === false && !options.includeNonEnumerable) {
      continue;
    }
    results.push(...await walkLocalTree(root, entry.path, cache, options));
  }
  return results;
}

async function searchLocalTree(
  root: string,
  path: ActiveFSPath,
  query: ActiveFSSearchQuery,
  cache: LocalCache | undefined,
  context: ActiveFSContext
): Promise<ActiveFSTreeSearchResult<LocalTreeMeta>> {
  const matches: ActiveFSTreeSearchResult<LocalTreeMeta>["matches"] = [];
  const maxResults = Math.max(
    0,
    query.maxResults ?? context.maxSearchResults ?? Number.POSITIVE_INFINITY
  );
  let incompleteReason: "max-results" | "timeout" | undefined;

  const visit = async (candidate: ActiveFSPath): Promise<void> => {
    assertLocalSearchNotCancelled(context);
    if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) {
      incompleteReason = "timeout";
      return;
    }

    const info = statToTreeInfo(await statLocalPath(root, candidate, cache));
    if (!info) {
      throw new ActiveFSError("NOT_FOUND", `Path not found: ${candidate}`, { path: candidate });
    }
    if (info.kind === "directory") {
      for (const entry of await listLocalPath(root, candidate, cache)) {
        if (incompleteReason) {
          return;
        }
        if (entry.enumerable !== false || query.includeNonEnumerable) {
          await visit(entry.path);
        }
      }
      return;
    }

    const filePath = normalizeActiveFSPath(info.path ?? candidate);
    const read = await readLocalPath(root, filePath, { encoding: "utf8" }, cache);
    const content = typeof read.content === "string"
      ? read.content
      : new TextDecoder().decode(read.content);
    for (const match of matchText(filePath, content, query, info.data)) {
      if (matches.length >= maxResults) {
        incompleteReason = "max-results";
        return;
      }
      matches.push(match);
    }
  };

  await visit(path);
  return {
    matches,
    complete: incompleteReason === undefined,
    strategy: "source",
    incompleteReasons: incompleteReason ? [incompleteReason] : undefined
  };
}

function matchText(
  path: ActiveFSPath,
  content: string,
  query: ActiveFSSearchQuery,
  data: LocalTreeMeta | undefined
): ActiveFSTreeSearchResult<LocalTreeMeta>["matches"] {
  const caseSensitive = query.caseSensitive === true;
  const needle = caseSensitive ? query.pattern : query.pattern.toLowerCase();
  const matches: ActiveFSTreeSearchResult<LocalTreeMeta>["matches"] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column >= 0) {
      matches.push({
        path,
        line: index + 1,
        column: column + 1,
        excerpt: line,
        data
      });
    }
  });
  return matches;
}

function assertLocalSearchNotCancelled(context: ActiveFSContext): void {
  if (context.signal?.aborted) {
    throw context.signal.reason instanceof Error
      ? context.signal.reason
      : new ActiveFSError("TRANSIENT", "Search was cancelled");
  }
}

/**
 * One file record written to an export manifest.
 */
export interface ExportedFileEntry {
  path: ActiveFSPath;
  contentHash: string;
  stateHash: string;
  revision?: string;
  size: number;
  exportedAt: string;
}

/**
 * Manifest produced by `exportTree`.
 */
export interface ExportTreeManifest {
  version: 1;
  sourcePath: string;
  exportedAt: string;
  consistency: "live" | "revision-pinned";
  treeRevision?: string;
  entries: ExportedFileEntry[];
}

/**
 * Options for exporting an ActiveFS tree or local path to disk.
 */
export interface ExportTreeOptions<Auth = unknown, Meta = unknown> {
  context?: ActiveFSContext<Auth, Meta>;
  rootPath?: string;
  includeNonEnumerable?: boolean;
  treeRevision?: string;
  now?: () => Date;
}

/**
 * Options for continuously exporting a source when it changes.
 */
export interface WatchExportTreeOptions<Auth = unknown, Meta = unknown>
  extends ExportTreeOptions<Auth, Meta> {
  debounceMs?: number;
  onError?: (error: unknown) => void;
  pollingIntervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Handle returned by `watchExportTree`.
 */
export interface ExportTreeWatcher {
  /** Stops watchers/timers and waits for any in-flight export run to finish. */
  close(): Promise<void>;
}

type ExportTreeInput<Auth, Meta> = string | ActiveFSMountTree<Auth, Meta>;

type ExportTreeReadable<Auth, Meta> = Pick<
  ActiveFS<Auth, Meta>,
  "stat" | "list" | "read" | "watch"
>;

interface ResolvedExportTreeInput<Auth, Meta> {
  tree: ExportTreeReadable<Auth, Meta>;
  rootPath: ActiveFSPath;
  sourcePath: string;
  rootFilePath?: ActiveFSPath;
  excludedPaths: ActiveFSPath[];
}

interface CollectedFile<Meta> {
  manifestPath: ActiveFSPath;
  sourcePath: ActiveFSPath;
  content: Uint8Array;
  stat: ActiveFSStat<Meta>;
}

/**
 * Exports a tree to a real directory and writes an atomic manifest.
 *
 * @param input Local path or ActiveFS tree to export.
 * @param outDir Destination directory.
 * @param options Context, root path, non-enumerable inclusion, and clock.
 * @returns Manifest describing exported files.
 * @throws Source and filesystem errors, including inconsistent read metadata or
 * attempts to export into the tree without exclusion.
 */
export async function exportTree<Auth = unknown, Meta = unknown>(
  input: ExportTreeInput<Auth, Meta>,
  outDir: string,
  options: ExportTreeOptions<Auth, Meta> = {}
): Promise<ExportTreeManifest> {
  const resolvedInput = await resolveExportTreeInput(input, outDir, options);
  return exportTreeResolvedInput(resolvedInput, outDir, options);
}

/**
 * Keeps an exported directory in sync with tree invalidation events, or with
 * export-only polling when the tree has no watch support.
 *
 * This API is for maintaining a copied export tree. Its polling mode is not a
 * mounted-filesystem freshness or cache-coherence mechanism.
 *
 * @returns Watcher whose `close` method stops future exports and waits for any
 * current run.
 * @remarks The function writes files and manifests under `outDir`; errors are
 * passed to `onError` when supplied or rethrown asynchronously otherwise.
 */
export async function watchExportTree<Auth = unknown, Meta = unknown>(
  input: ExportTreeInput<Auth, Meta>,
  outDir: string,
  options: WatchExportTreeOptions<Auth, Meta> = {}
): Promise<ExportTreeWatcher> {
  const resolvedInput = await resolveExportTreeInput(input, outDir, options);
  let closed = false;
  let running = false;
  let rerunRequested = false;
  let activeRun: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let subscription: ActiveFSWatchSubscription | undefined;

  const runExportTree = async (): Promise<void> => {
    running = true;
    try {
      do {
        rerunRequested = false;
        if (!closed) {
          await exportTreeResolvedInput(resolvedInput, outDir, options);
        }
      } while (rerunRequested && !closed);
    } finally {
      running = false;
    }
  };

  const handleError = (error: unknown): void => {
    if (options.onError) {
      options.onError(error);
      return;
    }
    queueMicrotask(() => {
      throw error;
    });
  };

  const startExportTree = (): Promise<void> => {
    if (running) {
      rerunRequested = true;
      return activeRun ?? Promise.resolve();
    }
    const currentRun = runExportTree();
    activeRun = currentRun;
    currentRun
      .finally(() => {
        if (activeRun === currentRun) {
          activeRun = undefined;
        }
      })
      .catch(() => undefined);
    return currentRun;
  };

  const runExportTreeSafely = (): void => {
    void startExportTree().catch(handleError);
  };

  const startPolling = (): void => {
    interval = setInterval(runExportTreeSafely, options.pollingIntervalMs ?? 1000);
  };

  await startExportTree();

  const requestRerun = (event?: { path: ActiveFSPath }): void => {
    if (closed) {
      return;
    }
    if (event && isExcludedActivePath(event.path, resolvedInput.excludedPaths)) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runExportTreeSafely();
    }, options.debounceMs ?? 50);
  };

  if (resolvedInput.tree.watch) {
    try {
      subscription = await resolvedInput.tree.watch(
        (options.context ?? {}) as ActiveFSContext<Auth, Meta>,
        resolvedInput.rootPath,
        requestRerun,
        {
          recursive: true,
          includeNonEnumerable: options.includeNonEnumerable,
          signal: options.signal
        }
      );
    } catch (error) {
      if (!isUnsupported(error)) {
        throw error;
      }
      startPolling();
    }
  } else {
    startPolling();
  }

  const watcher: ExportTreeWatcher = {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (interval) {
        clearInterval(interval);
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      await subscription?.close();
      await activeRun?.catch(() => undefined);
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      await watcher.close();
    } else {
      options.signal.addEventListener("abort", () => void watcher.close(), { once: true });
    }
  }

  return watcher;
}

/**
 * Writes a file atomically through a temporary sibling path and rename.
 *
 * @throws Filesystem errors from creating the parent directory, writing the
 * temporary file, or renaming it into place.
 */
export async function atomicWriteFile(
  targetPath: string,
  content: string | Uint8Array
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporaryPath, content);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

interface ResolvedLocalPath {
  activePath: ActiveFSPath;
  lexicalPath: string;
  realPath: string;
  rootRealPath: string;
  stats: Stats;
}

interface WatchSnapshotEntry {
  activePath: ActiveFSPath;
  fingerprint: string;
  isDirectory: boolean;
  lexicalPath: string;
}

const WATCH_POLL_INTERVAL_MS = 100;

async function statLocalPath(
  root: string,
  path: ActiveFSPath,
  cache?: LocalCache
): Promise<ActiveFSStat<LocalTreeMeta> | null> {
  try {
    const stat = statFromResolved(await resolveExistingLocalPath(root, path));
    const stateHash = stat.meta?.stateHash ?? stateHashFromStat(stat);
    const cached = cache?.getStat(path, stateHash);
    if (cached) {
      await cache!.reportActivity({ operation: "stat", path, stateHash });
      return cached;
    }
    cache?.setStat(path, stateHash, stat);
    return stat;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function listLocalPath(
  root: string,
  path: ActiveFSPath,
  cache: LocalCache | undefined
): Promise<ActiveFSDirEntry<LocalTreeMeta>[]> {
  const directoryStat = await statLocalPath(root, path, cache);
  if (!directoryStat) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }
  if (directoryStat.kind !== "directory") {
    throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${path}`, { path });
  }

  const stateHash = directoryStat.meta?.stateHash ?? stateHashFromStat(directoryStat);
  const cached = cache?.getDirectory(path, stateHash);
  if (cached) {
    await cache!.reportActivity({ operation: "list", path, stateHash });
    return cached;
  }

  const resolvedDirectory = await resolveExistingLocalPath(root, path);
  const entries = await readdir(resolvedDirectory.lexicalPath, { withFileTypes: true });
  const results: ActiveFSDirEntry<LocalTreeMeta>[] = [];
  for (const entry of entries) {
    const childPath = normalizeActiveFSPath(`${path}/${entry.name}`);
    try {
      const childStat = await statLocalPath(root, childPath, cache);
      if (!childStat) {
        continue;
      }
      results.push(childStat);
    } catch (error) {
      if (!isNotFound(error) && !isInvalidPath(error)) {
        throw error;
      }
    }
  }

  results.sort(compareEntries);
  cache?.setDirectory(path, stateHash, results);
  return results;
}

async function readLocalPath(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSReadOptions | undefined,
  cache: LocalCache | undefined
): Promise<ActiveFSReadResult<LocalTreeMeta>> {
  const raw = await readStableLocalPath(root, path, cache);

  return {
    content: sliceActiveFSContent(raw.content, options),
    stat: raw.stat
  };
}

async function writeLocalPath(
  root: string,
  path: ActiveFSPath,
  content: string | Uint8Array,
  options: ActiveFSWriteOptions<LocalTreeMeta> | undefined,
  cache: LocalCache | undefined
): Promise<ActiveFSWriteResult<LocalTreeMeta>> {
  const target = await resolveLocalWritePath(root, path);
  const existed = await exists(target.lexicalPath);
  if (existed && options?.overwrite === false) {
    throw new ActiveFSError("INVALID_REQUEST", `Path already exists: ${path}`, { path });
  }
  if (!existed && options?.create === false) {
    throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
  }

  await atomicWriteFile(target.lexicalPath, content);
  cache?.clearPath(target.activePath);
  cache?.clearPath(parentActiveFSPath(target.activePath));
  const stat = await statLocalPath(root, target.activePath, cache);
  if (!stat || stat.kind !== "file") {
    throw new ActiveFSError("SOURCE_ERROR", `Write did not produce a file: ${target.activePath}`, {
      path: target.activePath
    });
  }
  return {
    stat: {
      ...stat,
      mimeType: options?.contentType ?? stat.mimeType,
      meta: options?.meta ?? stat.meta
    },
    created: !existed,
    meta: options?.meta
  };
}

async function deleteLocalPath(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSDeleteOptions | undefined,
  cache: LocalCache | undefined
): Promise<{ path: ActiveFSPath; deleted: boolean }> {
  const existing = await resolveExistingLocalPath(root, path).catch((error: unknown) => {
    if (isNotFound(error)) {
      throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
    }
    throw error;
  });
  if (existing.stats.isDirectory() && !options?.recursive) {
    const entries = await readdir(existing.lexicalPath);
    if (entries.length > 0) {
      throw new ActiveFSError("INVALID_REQUEST", `Directory is not empty: ${existing.activePath}`, {
        path: existing.activePath
      });
    }
    await rmdirFs(existing.lexicalPath);
  } else {
    await rm(existing.lexicalPath, { recursive: Boolean(options?.recursive), force: false }).catch((error: unknown) => {
      if (isDirectoryNotEmpty(error)) {
        throw new ActiveFSError("INVALID_REQUEST", `Directory is not empty: ${existing.activePath}`, {
          path: existing.activePath
        });
      }
      throw error;
    });
  }
  cache?.clearPath(existing.activePath);
  cache?.clearPath(parentActiveFSPath(existing.activePath));
  return { path: existing.activePath, deleted: true };
}

async function mkdirLocalPath(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSMkdirOptions<LocalTreeMeta> | undefined,
  cache: LocalCache | undefined
): Promise<{ stat: ActiveFSStat<LocalTreeMeta>; created: boolean; meta?: LocalTreeMeta }> {
  const target = options?.recursive
    ? await resolveLocalWritePath(root, path)
    : await resolveLocalMutationPath(root, path, { requireParent: true });
  const existed = await exists(target.lexicalPath);
  await mkdir(target.lexicalPath, { recursive: Boolean(options?.recursive) });
  cache?.clearPath(target.activePath);
  cache?.clearPath(parentActiveFSPath(target.activePath));
  const stat = await statLocalPath(root, target.activePath, cache);
  if (!stat || stat.kind !== "directory") {
    throw new ActiveFSError("SOURCE_ERROR", `mkdir did not produce a directory: ${target.activePath}`, {
      path: target.activePath
    });
  }
  return { stat, created: !existed, meta: options?.meta };
}

async function rmdirLocalPath(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSDeleteOptions | undefined,
  cache: LocalCache | undefined
): Promise<{ path: ActiveFSPath; deleted: boolean }> {
  const existing = await resolveExistingLocalPath(root, path).catch((error: unknown) => {
    if (isNotFound(error)) {
      throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
    }
    throw error;
  });
  if (!existing.stats.isDirectory()) {
    throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${path}`, { path });
  }
  try {
    if (options?.recursive) {
      await rm(existing.lexicalPath, { recursive: true, force: false });
    } else {
      await rmdirFs(existing.lexicalPath);
    }
  } catch (error) {
    if (isDirectoryNotEmpty(error)) {
      throw new ActiveFSError("INVALID_REQUEST", `Directory is not empty: ${existing.activePath}`, {
        path: existing.activePath,
        cause: error
      });
    }
    throw error;
  }
  cache?.clearPath(existing.activePath);
  cache?.clearPath(parentActiveFSPath(existing.activePath));
  return { path: existing.activePath, deleted: true };
}

async function renameLocalPath(
  root: string,
  fromPath: ActiveFSPath,
  toPath: ActiveFSPath,
  options: ActiveFSRenameOptions | undefined,
  cache: LocalCache | undefined
): Promise<{ from: ActiveFSPath; to: ActiveFSPath; stat?: ActiveFSStat<LocalTreeMeta> }> {
  const from = await resolveExistingLocalPath(root, fromPath);
  const to = await resolveLocalMutationPath(root, toPath, { requireParent: true });
  if (options?.overwrite === false && await exists(to.lexicalPath)) {
    throw new ActiveFSError("INVALID_REQUEST", `Path already exists: ${to.activePath}`, {
      path: to.activePath
    });
  }
  await rename(from.lexicalPath, to.lexicalPath);
  cache?.clearPath(from.activePath);
  cache?.clearPath(to.activePath);
  cache?.clearPath(parentActiveFSPath(from.activePath));
  cache?.clearPath(parentActiveFSPath(to.activePath));
  return { from: from.activePath, to: to.activePath, stat: await statLocalPath(root, to.activePath, cache) ?? undefined };
}

async function copyLocalPath(
  root: string,
  fromPath: ActiveFSPath,
  toPath: ActiveFSPath,
  options: ActiveFSCopyOptions | undefined,
  cache: LocalCache | undefined
): Promise<{ from: ActiveFSPath; to: ActiveFSPath; stat?: ActiveFSStat<LocalTreeMeta> }> {
  const from = await resolveExistingLocalPath(root, fromPath);
  const to = await resolveLocalMutationPath(root, toPath, { requireParent: true });
  if (options?.overwrite === false && await exists(to.lexicalPath)) {
    throw new ActiveFSError("INVALID_REQUEST", `Path already exists: ${to.activePath}`, {
      path: to.activePath
    });
  }
  await cp(from.lexicalPath, to.lexicalPath, {
    recursive: Boolean(options?.recursive),
    force: options?.overwrite !== false,
    errorOnExist: options?.overwrite === false
  });
  cache?.clearPath(to.activePath);
  cache?.clearPath(parentActiveFSPath(to.activePath));
  return { from: from.activePath, to: to.activePath, stat: await statLocalPath(root, to.activePath, cache) ?? undefined };
}

async function truncateLocalPath(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSTruncateOptions | undefined,
  cache: LocalCache | undefined
): Promise<{ stat?: ActiveFSStat<LocalTreeMeta> }> {
  const target = await resolveExistingLocalPath(root, path);
  if (!target.stats.isFile()) {
    throw new ActiveFSError("NOT_FILE", `Path is not a file: ${path}`, { path });
  }
  await truncateFs(target.lexicalPath, options?.length ?? 0);
  cache?.clearPath(target.activePath);
  return { stat: await statLocalPath(root, target.activePath, cache) ?? undefined };
}

async function updateLocalMetadata(
  root: string,
  path: ActiveFSPath,
  options: ActiveFSMetadataUpdateOptions<LocalTreeMeta>,
  cache: LocalCache | undefined
): Promise<{ stat?: ActiveFSStat<LocalTreeMeta>; meta?: LocalTreeMeta }> {
  const target = await resolveExistingLocalPath(root, path);
  const atime = options.atimeMs === undefined ? target.stats.atime : new Date(options.atimeMs);
  const mtime = options.mtimeMs === undefined ? target.stats.mtime : new Date(options.mtimeMs);
  await utimes(target.lexicalPath, atime, mtime);
  cache?.clearPath(target.activePath);
  return { stat: await statLocalPath(root, target.activePath, cache) ?? undefined, meta: options.meta };
}

function statFromResolved(resolved: ResolvedLocalPath): ActiveFSStat<LocalTreeMeta> {
  const { activePath: path, realPath, rootRealPath, stats } = resolved;
  const kind = stats.isDirectory() ? "directory" : "file";
  return {
    name: path === "/" ? "" : basename(path),
    path,
    kind,
    capabilities: {
      stat: true,
      list: kind === "directory",
      read: kind === "file",
      rangeReadable: kind === "file",
      watch: true
    },
    size: kind === "file" ? stats.size : undefined,
    mtimeMs: stats.mtimeMs,
    enumerable: true,
    meta: {
      realPath,
      stateHash: createFsStateHash(rootRealPath, path, stats)
    }
  };
}

async function readStableLocalPath(
  root: string,
  path: ActiveFSPath,
  cache: LocalCache | undefined
): Promise<CachedRead> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = await resolveExistingLocalPath(root, path).catch((error: unknown) => {
      if (isNotFound(error)) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
      }
      throw error;
    });
    const beforeStat = statFromResolved(before);
    if (beforeStat.kind !== "file") {
      throw new ActiveFSError("NOT_FILE", `Path is not a file: ${path}`, { path });
    }

    const stateHash = beforeStat.meta?.stateHash ?? stateHashFromStat(beforeStat);
    const cached = cache?.getRead(path, stateHash);
    if (cached) {
      await cache!.reportActivity({
        operation: "read",
        path,
        stateHash,
        contentHash: cached.contentHash
      });
      return cached;
    }

    const content = new Uint8Array(await readFile(before.lexicalPath));
    const after = await resolveExistingLocalPath(root, path).catch((error: unknown) => {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    });
    if (!after) {
      continue;
    }
    const afterStat = statFromResolved(after);
    const afterStateHash = afterStat.meta?.stateHash ?? stateHashFromStat(afterStat);
    if (
      afterStat.kind === "file" &&
      afterStateHash === stateHash &&
      (afterStat.size ?? content.byteLength) === content.byteLength
    ) {
      const raw = { content, contentHash: sha256(content), stat: afterStat };
      cache?.setRead(path, afterStateHash, raw);
      return raw;
    }
  }

  throw new ActiveFSError("SOURCE_ERROR", `File changed while reading: ${path}`, { path });
}

async function resolveExistingLocalPath(root: string, path: ActiveFSPath): Promise<ResolvedLocalPath> {
  const normalizedPath = normalizeActiveFSPath(path);
  const rootLexicalPath = resolve(root);
  const lexicalPath =
    normalizedPath === "/" ? rootLexicalPath : resolve(rootLexicalPath, normalizedPath.slice(1));
  if (!isPathWithinOrEqual(rootLexicalPath, lexicalPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root: ${path}`, { path });
  }

  await lstatFs(lexicalPath);
  const [rootRealPath, realPath] = await Promise.all([
    realpath(rootLexicalPath),
    realpath(lexicalPath)
  ]);
  if (!isPathWithinOrEqual(rootRealPath, realPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root through symlink: ${path}`, {
      path
    });
  }

  return {
    activePath: normalizedPath,
    lexicalPath,
    realPath,
    rootRealPath,
    stats: await statFs(lexicalPath)
  };
}

async function resolveLocalMutationPath(
  root: string,
  path: ActiveFSPath,
  options: { requireParent: boolean }
): Promise<{ activePath: ActiveFSPath; lexicalPath: string }> {
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === "/") {
    throw new ActiveFSError("INVALID_PATH", "Cannot mutate the tree root", {
      path: normalizedPath
    });
  }
  const rootLexicalPath = resolve(root);
  const lexicalPath = resolve(rootLexicalPath, normalizedPath.slice(1));
  if (!isPathWithinOrEqual(rootLexicalPath, lexicalPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root: ${path}`, { path });
  }
  const [rootRealPath, parentRealPath] = await Promise.all([
    realpath(rootLexicalPath),
    realpath(dirname(lexicalPath)).catch((error: unknown) => {
      if (options.requireParent && isNotFound(error)) {
        throw new ActiveFSError("NOT_FOUND", `Parent path not found: ${parentActiveFSPath(normalizedPath)}`, {
          path: parentActiveFSPath(normalizedPath)
        });
      }
      throw error;
    })
  ]);
  if (!isPathWithinOrEqual(rootRealPath, parentRealPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root through symlink: ${path}`, {
      path
    });
  }
  return { activePath: normalizedPath, lexicalPath };
}

async function resolveLocalWritePath(
  root: string,
  path: ActiveFSPath
): Promise<{ activePath: ActiveFSPath; lexicalPath: string }> {
  const normalizedPath = normalizeActiveFSPath(path);
  if (normalizedPath === "/") {
    throw new ActiveFSError("INVALID_PATH", "Cannot write a file at the tree root", {
      path: normalizedPath
    });
  }
  const rootLexicalPath = resolve(root);
  const lexicalPath = resolve(rootLexicalPath, normalizedPath.slice(1));
  if (!isPathWithinOrEqual(rootLexicalPath, lexicalPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root: ${path}`, { path });
  }

  await mkdir(dirname(lexicalPath), { recursive: true });
  const [rootRealPath, parentRealPath] = await Promise.all([
    realpath(rootLexicalPath),
    realpath(dirname(lexicalPath))
  ]);
  if (!isPathWithinOrEqual(rootRealPath, parentRealPath)) {
    throw new ActiveFSError("INVALID_PATH", `Path escapes local root through symlink: ${path}`, {
      path
    });
  }
  return { activePath: normalizedPath, lexicalPath };
}

async function watchLocalPath<Auth>(
  root: string,
  path: ActiveFSPath,
  onEvent: (event: { type: "invalidate"; path: ActiveFSPath }) => void,
  signal?: AbortSignal
): Promise<ActiveFSWatchSubscription> {
  if (signal?.aborted) {
    return { close: async () => undefined };
  }
  const target = await resolveExistingLocalPath(root, path);
  const rootRealPath = target.rootRealPath;
  const watchers = new Map<string, FSWatcher>();
  const watchedRootPath = target.stats.isDirectory() ? target.lexicalPath : dirname(target.lexicalPath);
  let snapshot = await collectWatchSnapshot(rootRealPath, watchedRootPath);
  let pollRunning = false;
  let closed = false;
  const isClosed = (): boolean => closed || signal?.aborted === true;

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(pollInterval);
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
  };

  const addWatcher = async (directoryPath: string): Promise<void> => {
    if (isClosed() || watchers.has(directoryPath)) {
      return;
    }
    const directoryRealPath = await realpath(directoryPath).catch(() => null);
    if (!directoryRealPath || !isPathWithinOrEqual(rootRealPath, directoryRealPath)) {
      return;
    }
    try {
      const watcher = watchFs(directoryPath, (_eventType, filename) => {
        if (isClosed()) {
          return;
        }
        const childRealPath = filename
          ? resolve(directoryPath, String(filename))
          : directoryPath;
        const activePath = activePathFromRealPath(root, childRealPath);
        if (activePath) {
          onEvent({ type: "invalidate", path: activePath });
          void statFs(childRealPath)
            .then((stats) => {
              if (stats.isDirectory()) {
                return addWatcher(childRealPath);
              }
              return undefined;
            })
            .catch(() => undefined);
        } else {
          onEvent({ type: "invalidate", path });
        }
      });
      watcher.on("error", () => {
        if (!isClosed()) {
          onEvent({ type: "invalidate", path });
        }
      });
      watchers.set(directoryPath, watcher);
    } catch {
      return;
    }

    const stats = await statFs(directoryPath).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }
    const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await addWatcher(join(directoryPath, entry.name));
      }
    }
  };

  await addWatcher(watchedRootPath);
  snapshot = await collectWatchSnapshot(rootRealPath, watchedRootPath);

  const pollForChanges = async (): Promise<void> => {
    if (isClosed() || pollRunning) {
      return;
    }
    pollRunning = true;
    try {
      const nextSnapshot = await collectWatchSnapshot(rootRealPath, watchedRootPath);
      if (isClosed()) {
        return;
      }
      const changedPaths = diffWatchSnapshots(snapshot, nextSnapshot);
      snapshot = nextSnapshot;
      for (const entry of nextSnapshot.values()) {
        if (isClosed()) {
          return;
        }
        if (entry.isDirectory) {
          await addWatcher(entry.lexicalPath);
        }
      }
      for (const changedPath of changedPaths) {
        if (isClosed()) {
          return;
        }
        onEvent({ type: "invalidate", path: changedPath });
      }
    } finally {
      pollRunning = false;
    }
  };

  const pollInterval = setInterval(() => {
    void pollForChanges().catch(() => undefined);
  }, WATCH_POLL_INTERVAL_MS);

  if (signal) {
    if (signal.aborted) {
      await close();
    } else {
      signal.addEventListener("abort", () => void close(), { once: true });
    }
  }

  return { close };
}

async function collectWatchSnapshot(
  rootRealPath: string,
  directoryPath: string
): Promise<Map<string, WatchSnapshotEntry>> {
  const entries = new Map<string, WatchSnapshotEntry>();

  const visit = async (lexicalPath: string): Promise<void> => {
    const [stats, realPath] = await Promise.all([
      statFs(lexicalPath).catch(() => null),
      realpath(lexicalPath).catch(() => null)
    ]);
    if (!stats || !realPath || !isPathWithinOrEqual(rootRealPath, realPath)) {
      return;
    }
    if (entries.has(realPath)) {
      return;
    }
    const activePath = activePathFromRealPath(rootRealPath, realPath);
    if (!activePath) {
      return;
    }
    entries.set(realPath, {
      activePath,
      fingerprint: watchFingerprint(stats),
      isDirectory: stats.isDirectory(),
      lexicalPath
    });
    if (!stats.isDirectory()) {
      return;
    }
    const children = await readdir(lexicalPath, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      await visit(join(lexicalPath, child.name));
    }
  };

  await visit(directoryPath);
  return entries;
}

function diffWatchSnapshots(
  previous: Map<string, WatchSnapshotEntry>,
  next: Map<string, WatchSnapshotEntry>
): ActiveFSPath[] {
  const changed = new Set<ActiveFSPath>();
  for (const [realPath, nextEntry] of next) {
    const previousEntry = previous.get(realPath);
    if (!previousEntry || previousEntry.fingerprint !== nextEntry.fingerprint) {
      changed.add(nextEntry.activePath);
    }
  }
  for (const [realPath, previousEntry] of previous) {
    if (!next.has(realPath)) {
      changed.add(previousEntry.activePath);
    }
  }
  return [...changed];
}

function watchFingerprint(stats: Stats): string {
  return [
    stats.isDirectory() ? "directory" : "file",
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
    stats.mode,
    stats.ino,
    stats.dev
  ].join(":");
}

async function resolveExportTreeInput<Auth, Meta>(
  input: ExportTreeInput<Auth, Meta>,
  outDir: string,
  options: ExportTreeOptions<Auth, Meta>
): Promise<ResolvedExportTreeInput<Auth, Meta>> {
  if (typeof input !== "string") {
    const tree = createActiveFS<Auth, Meta>().mount("/", input);
    return {
      tree,
      rootPath: normalizeActiveFSPath(options.rootPath ?? "/"),
      sourcePath: options.rootPath ?? "/",
      excludedPaths: []
    };
  }

  const sourceRoot = resolve(input);
  const tree = createActiveFS<Auth, Meta>().mount(
    "/",
    createLocalTree<Auth>({ root: sourceRoot }) as unknown as ActiveFSTree<Auth, Meta>
  );
  const rootStat = await statFs(sourceRoot);
  const excludedPaths = rootStat.isDirectory()
    ? exportTreeOutputExcludes(sourceRoot, outDir)
    : [];
  return {
    tree,
    rootPath: "/",
    sourcePath: sourceRoot,
    rootFilePath: rootStat.isFile() ? normalizeActiveFSPath(`/${basename(sourceRoot)}`) : undefined,
    excludedPaths
  };
}

async function exportTreeResolvedInput<Auth, Meta>(
  resolvedInput: ResolvedExportTreeInput<Auth, Meta>,
  outDir: string,
  options: ExportTreeOptions<Auth, Meta>
): Promise<ExportTreeManifest> {
  const outputRoot = resolve(outDir);
  const exportedAt = (options.now?.() ?? new Date()).toISOString();
  const context = (options.context ?? {}) as ActiveFSContext<Auth, Meta>;
  const previousManifest = await readExistingManifest(outputRoot);
  const files = await collectExportableFiles(
    resolvedInput.tree,
    context,
    resolvedInput.rootPath,
    {
      includeNonEnumerable: options.includeNonEnumerable,
      rootFilePath: resolvedInput.rootFilePath,
      excludedPaths: resolvedInput.excludedPaths
    }
  );

  await mkdir(outputRoot, { recursive: true });

  const entries: ExportedFileEntry[] = [];
  for (const file of files) {
    if (options.treeRevision && file.stat.revision !== options.treeRevision) {
      throw new ActiveFSError(
        "SOURCE_ERROR",
        `Exported file is not at requested tree revision: ${file.sourcePath}`,
        {
          path: file.sourcePath,
          cause: { expected: options.treeRevision, actual: file.stat.revision }
        }
      );
    }
    const destination = exportedFilePath(outputRoot, file.manifestPath);
    await atomicWriteFile(destination, file.content);
    entries.push({
      path: file.manifestPath,
      contentHash: sha256(file.content),
      stateHash: stateHashFromStat(file.stat),
      revision: file.stat.revision,
      size: file.stat.size ?? file.content.byteLength,
      exportedAt
    });
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));
  await removeStaleExportedFiles(outputRoot, previousManifest, entries);

  const manifest: ExportTreeManifest = {
    version: 1,
    sourcePath: resolvedInput.sourcePath,
    exportedAt,
    consistency: options.treeRevision ? "revision-pinned" : "live",
    entries
  };
  if (options.treeRevision) {
    manifest.treeRevision = options.treeRevision;
  }
  await atomicWriteFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function collectExportableFiles<Auth, Meta>(
  tree: ExportTreeReadable<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath,
  options: {
    includeNonEnumerable?: boolean;
    rootFilePath?: ActiveFSPath;
    excludedPaths?: ActiveFSPath[];
  }
): Promise<CollectedFile<Meta>[]> {
  const rootStat = await tree.stat(context, path);
  if (!rootStat) {
    return [];
  }

  const files: CollectedFile<Meta>[] = [];
  const visit = async (currentPath: ActiveFSPath, stat: ActiveFSStat<Meta>): Promise<void> => {
    if (isExcludedActivePath(currentPath, options.excludedPaths ?? [])) {
      return;
    }
    if (stat.enumerable === false && currentPath !== path && !options.includeNonEnumerable) {
      return;
    }

    if (stat.kind === "file") {
      const readResult = await tree.read(context, currentPath);
      const content = activeFSContentToBytes(readResult.content);
      const readStat = readResult.stat ?? stat;
      if (readStat.size !== undefined && readStat.size !== content.byteLength) {
        throw new ActiveFSError(
          "SOURCE_ERROR",
          `Read content size does not match stat size: ${currentPath}`,
          { path: currentPath }
        );
      }
      files.push({
        manifestPath:
          currentPath === path && options.rootFilePath ? options.rootFilePath : currentPath,
        sourcePath: currentPath,
        content,
        stat: {
          ...readStat,
          size: readStat.size ?? content.byteLength
        }
      });
      return;
    }

    const entries = await tree.list(context, currentPath);
    for (const entry of entries.sort(compareEntries)) {
      if (isExcludedActivePath(entry.path, options.excludedPaths ?? [])) {
        continue;
      }
      if (entry.enumerable === false && !options.includeNonEnumerable) {
        continue;
      }
      const entryStat = await tree.stat(context, entry.path);
      if (entryStat) {
        await visit(entry.path, entryStat);
      }
    }
  };

  await visit(path, rootStat);
  return files;
}

async function readExistingManifest(outDir: string): Promise<ExportTreeManifest | null> {
  try {
    const raw = await readFile(join(outDir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as ExportTreeManifest;
    return Array.isArray(parsed.entries) ? parsed : null;
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    return null;
  }
}

async function removeStaleExportedFiles(
  outDir: string,
  previousManifest: ExportTreeManifest | null,
  currentEntries: ExportedFileEntry[]
): Promise<void> {
  if (!previousManifest) {
    return;
  }
  const currentPaths = new Set(currentEntries.map((entry) => entry.path));
  for (const entry of previousManifest.entries) {
    if (!currentPaths.has(entry.path)) {
      await rm(exportedFilePath(outDir, entry.path), { force: true });
    }
  }
}

function exportedFilePath(outDir: string, path: ActiveFSPath): string {
  const normalizedPath = normalizeActiveFSPath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  return join(outDir, ...segments);
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await statFs(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function stateHashFromStat<Meta>(stat: ActiveFSStat<Meta>): string {
  const meta = stat.meta as { stateHash?: string } | undefined;
  if (meta?.stateHash) {
    return meta.stateHash;
  }
  return stableHash({
    path: stat.path,
    kind: stat.kind,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  });
}

function createFsStateHash(root: string, path: ActiveFSPath, stats: Stats): string {
  return stableHash({
    root,
    path,
    kind: stats.isDirectory() ? "directory" : "file",
    size: stats.isFile() ? stats.size : undefined,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    mode: stats.mode,
    ino: stats.ino,
    dev: stats.dev
  });
}

function stableHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function copyStat(stat: ActiveFSStat<LocalTreeMeta>): ActiveFSStat<LocalTreeMeta> {
  return { ...stat, meta: stat.meta ? { ...stat.meta } : undefined };
}

function activePathFromRealPath(root: string, realPath: string): ActiveFSPath | null {
  const normalized = resolve(realPath);
  if (!isPathWithinOrEqual(root, normalized)) {
    return null;
  }
  const relativePath = relative(root, normalized);
  return relativePath === "" ? "/" : normalizeActiveFSPath(`/${relativePath.split(sep).join("/")}`);
}

function exportTreeOutputExcludes(sourceRoot: string, outDir: string): ActiveFSPath[] {
  const sourceRootPath = resolve(sourceRoot);
  const outputRootPath = resolve(outDir);
  if (!isPathWithinOrEqual(sourceRootPath, outputRootPath)) {
    return [];
  }
  if (sourceRootPath === outputRootPath) {
    throw new ActiveFSError(
      "INVALID_PATH",
      "ExportTree output directory cannot be the source directory"
    );
  }
  return [pathToActivePath(relative(sourceRootPath, outputRootPath))];
}

function isExcludedActivePath(path: ActiveFSPath, excludedPaths: ActiveFSPath[]): boolean {
  return excludedPaths.some((excludedPath) => isActiveFSPathWithin(excludedPath, path));
}

function pathToActivePath(path: string): ActiveFSPath {
  return normalizeActiveFSPath(`/${path.split(sep).join("/")}`);
}

function isPathWithinOrEqual(basePath: string, candidatePath: string): boolean {
  const relativePath = relative(basePath, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function cacheKey(path: ActiveFSPath, stateHash: string): string {
  return `${path}\0${stateHash}`;
}

function cacheKeyMatchesPath(key: string, path: ActiveFSPath): boolean {
  if (path === "/") {
    return true;
  }
  const cachedPath = key.slice(0, key.indexOf("\0"));
  return isActiveFSPathWithin(path, cachedPath);
}

function compareEntries(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isInvalidPath(error: unknown): boolean {
  return error instanceof ActiveFSError && error.code === "INVALID_PATH";
}

function isUnsupported(error: unknown): boolean {
  return error instanceof ActiveFSError && error.code === "UNSUPPORTED";
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "ENOTEMPTY" ||
      (error as { code?: string }).code === "EEXIST" ||
      (error as { code?: string }).code === "EISDIR" ||
      (error as { code?: string }).code === "ERR_FS_EISDIR")
  );
}
