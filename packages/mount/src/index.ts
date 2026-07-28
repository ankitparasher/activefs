import {
  ActiveFSError,
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSContext,
  type ActiveFSCopyOptions,
  type ActiveFSDeleteOptions,
  type ActiveFSDirEntry,
  type ActiveFSMkdirOptions,
  type ActiveFSPath,
  type ActiveFSReadResult,
  type ActiveFSRenameOptions,
  type ActiveFSStat,
  type ActiveFSTruncateOptions,
  type ActiveFSWriteResult,
  type MaybePromise
} from "@activefs/core";
import {
  createActiveFSRemoteStateLayout,
  ensureActiveFSRemoteStateLayout,
  evaluateActiveFSPolicy,
  loadActiveFSConfig,
  removeActiveFSRemoteConfig,
  upsertActiveFSRemote,
  type ActiveFSActivityPolicy,
  type ActiveFSAdapterCapabilityProfile,
  type ActiveFSCacheMode,
  type ActiveFSPolicyDocument,
  type ActiveFSPolicyOperation,
  type ActiveFSRemoteConfig
} from "@activefs/config";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Read-only adapter wrapper used by WebDAV and other mounted access paths.
 *
 * The adapter exposes an ActiveFS filesystem below a root path without adding
 * search, write, or watch semantics of its own.
 */
export interface ReadOnlyAccessAdapter<Auth = unknown, Meta = unknown> {
  name: string;
  mode: "read-only";
  capabilities: {
    stat: true;
    list: true;
    read: true;
    search: false;
    write: false;
    watch: false;
  };
  filesystem: ActiveFS<Auth, Meta>;
  rootPath: ActiveFSPath;
}

/**
 * Options for creating a read-only access adapter.
 */
export interface ReadOnlyAccessAdapterOptions<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  rootPath?: string;
  name?: string;
}

/**
 * Basic authentication credentials used by the WebDAV adapter server.
 */
export interface WebDAVAuth {
  username: string;
  password: string;
  realm?: string;
}

/**
 * Request metadata passed to a WebDAV context provider.
 */
export interface WebDAVRequestInfo {
  request: IncomingMessage;
  method: string;
  path: ActiveFSPath;
}

/**
 * Structured request log entry emitted after a WebDAV response finishes.
 */
export interface WebDAVRequestLogEntry {
  at: string;
  method: string;
  path: ActiveFSPath;
  statusCode: number;
  durationMs: number;
  remoteAddress?: string;
  userAgent?: string;
}

/**
 * Callback for receiving WebDAV request log entries.
 */
export type WebDAVRequestLogger = (entry: WebDAVRequestLogEntry) => MaybePromise<void>;

/**
 * Callback that supplies opaque ActiveFS context for a WebDAV request.
 */
export type WebDAVContextProvider<Auth = unknown, Meta = unknown> = (
  info: WebDAVRequestInfo
) => MaybePromise<ActiveFSContext<Auth, Meta>>;

/**
 * Options for creating the WebDAV request handler.
 *
 * Local policy gates write-like WebDAV methods before the tree or remote sees
 * them, but server authorization remains authoritative for the final mutation
 * decision.
 */
export interface WebDAVAdapterOptions<Auth = unknown, Meta = unknown>
  extends ReadOnlyAccessAdapterOptions<Auth, Meta> {
  auth?: WebDAVAuth | false;
  context?: ActiveFSContext<Auth, Meta> | WebDAVContextProvider<Auth, Meta>;
  logger?: WebDAVRequestLogger;
  serverHeader?: string;
  readCache?: WebDAVReadCacheOptions | false;
  policy?: ActiveFSPolicyDocument;
  adapterCapabilityProfile?: ActiveFSAdapterCapabilityProfile;
}

/**
 * Activity emitted after the WebDAV adapter serves bytes from its read cache.
 */
export interface WebDAVCacheActivity {
  operation: "read";
  path: ActiveFSPath;
  timestamp: string;
  source: "cache";
  result: "succeeded";
  contentHash: string;
}

/**
 * Callback invoked for verified WebDAV read-cache hits.
 */
export type WebDAVCacheActivityReporter = (
  activity: WebDAVCacheActivity
) => MaybePromise<void>;

/**
 * Bounded in-memory read cache options for WebDAV GET/HEAD handling.
 */
export interface WebDAVReadCacheOptions {
  maxEntries?: number;
  maxBytesPerEntry?: number;
  onActivity?: WebDAVCacheActivityReporter;
}

interface CachedReadBytes {
  bytes: Buffer;
  contentType: string;
  contentHash: string;
}

interface WebDAVReadCache {
  entries: Map<string, CachedReadBytes>;
  maxEntries: number;
  maxBytesPerEntry: number;
  onActivity?: WebDAVCacheActivityReporter;
}

/**
 * Node HTTP handler for WebDAV requests.
 */
export type WebDAVRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

/**
 * Options for starting a loopback WebDAV server.
 */
export interface WebDAVServerOptions<Auth = unknown, Meta = unknown>
  extends WebDAVAdapterOptions<Auth, Meta> {
  hostname?: string;
  port?: number;
}

/**
 * Running WebDAV server handle.
 */
export interface WebDAVServerHandle {
  server: Server;
  url: string;
  auth: WebDAVAuth | false;
  /** Closes the WebDAV server. */
  close(): Promise<void>;
}

/**
 * Host mount backend family selected for rclone mounts.
 */
export type RcloneMountBackend =
  | "macfuse"
  | "winfsp"
  | "linux-fuse"
  | "freebsd-fuse"
  | "unsupported";

/**
 * Dependency validation state for host mount prerequisites.
 */
export type MountDependencyStatus = "ready" | "missing" | "outdated" | "unknown";

/**
 * One host dependency report item for mount prerequisite validation.
 */
export interface MountDependencyReport {
  name: string;
  required: boolean;
  status: MountDependencyStatus;
  version?: string;
  message: string;
  installHint?: string;
}

/**
 * Aggregate host report for attempting rclone mounts.
 */
export interface RcloneMountHostReport {
  platform: NodeJS.Platform;
  backend: RcloneMountBackend;
  canAttemptMount: boolean;
  dependencies: MountDependencyReport[];
}

/**
 * Manual verification command shown for host mount validation.
 */
export interface MountVerificationCommand {
  name: string;
  command: string;
  proves: string;
}

/**
 * Platform-specific guidance for proving mounted-directory behavior.
 */
export interface MountVerificationGuidance {
  platform: NodeJS.Platform;
  backend: RcloneMountBackend;
  prerequisites: string[];
  commands: MountVerificationCommand[];
  notes: string[];
}

/**
 * Output captured from a host command that lists active mounts.
 */
export interface ActiveMountEvidence {
  command: string;
  status: number | null;
  lines: string[];
  error?: string;
}

/**
 * Evidence bundle for current host, configured remotes, and mount guidance.
 */
export interface RcloneMountEvidence {
  collectedAt: string;
  platform: NodeJS.Platform;
  rootDir?: string;
  host: RcloneMountHostReport;
  activeMounts: ActiveMountEvidence;
  remotes: RcloneMountStatus[];
  guidance: MountVerificationGuidance;
}

/**
 * Options for collecting rclone mount evidence.
 */
export interface RcloneMountEvidenceOptions extends RcloneMountHostInspectOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Result of probing a WebDAV endpoint with an OPTIONS request.
 */
export interface WebDAVEndpointCheck {
  protocol: "webdav";
  endpoint: string;
  reachable: boolean;
  checkedAt: string;
  statusCode?: number;
  capabilities: {
    options: boolean;
    dav?: string;
    allow?: string;
  };
  auth?: {
    username?: string;
    hasPassword: boolean;
  };
  diagnostics?: string;
}

/**
 * Result from a synchronous host command runner.
 */
export interface MountCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Synchronous command runner used to test rclone/FUSE tools.
 */
export type MountCommandRunner = (command: string, args: string[]) => MountCommandResult;

/**
 * Dependency injection options for host mount inspection.
 */
export interface RcloneMountHostInspectOptions {
  platform?: NodeJS.Platform;
  commandRunner?: MountCommandRunner;
  fileExists?: (path: string) => boolean;
  readTextFile?: (path: string) => string | undefined;
  env?: Record<string, string | undefined>;
  minimumMacFuseVersion?: string;
}

/**
 * Internal rclone/WebDAV mount target derived from an ActiveFS remote.
 *
 * `url` is the WebDAV adapter URL consumed by rclone. For normal ActiveFS
 * remotes, `sourceUrl` preserves the Source API endpoint that the local
 * runtime reads from.
 */
export interface ActiveFSMountRemote {
  name: string;
  url: string;
  sourceUrl?: string;
  username?: string;
  password?: string;
  vendor?: string;
  hasCredentials?: boolean;
  mountpoint?: string;
  remoteRoot?: ActiveFSPath;
  managedWebDAV?: ManagedWebDAVConfig;
  policy?: ActiveFSPolicyDocument;
  adapterCapabilityProfile?: ActiveFSAdapterCapabilityProfile;
  cacheMode?: ActiveFSCacheMode;
  activityPolicy?: ActiveFSActivityPolicy;
}

/**
 * Managed loopback WebDAV runtime configuration.
 */
export interface ManagedWebDAVConfig {
  enabled: boolean;
  host?: string;
  port?: number;
}

/**
 * Internal mount config projected from unified ActiveFS remote config.
 */
export interface ActiveFSMountConfig {
  version: 1;
  remotes: Record<string, ActiveFSMountRemote>;
}

/**
 * Resolved filesystem layout for one remote mount runtime.
 */
export interface ActiveFSMountLayout {
  rootDir: string;
  stateRoot: string;
  stateDir: string;
  remoteName: string;
  remoteDir: string;
  vfsDir: string;
  cacheDir: string;
  rcloneCacheDir: string;
  runtimeDir: string;
  rcloneConfigPath: string;
  rcloneLogPath: string;
  mountStatusPath: string;
  webdavStatusPath: string;
  freshnessStatusPath: string;
  webdavCredentialsPath: string;
  rcloneRcCredentialsPath: string;
}

/**
 * Recursive directory statistics used by cache reporting.
 */
export interface DirectoryStats {
  path: string;
  fileCount: number;
  byteSize: number;
}

/**
 * Snapshot of cache footprint for one mount remote.
 */
export interface ActiveFSMountCacheSnapshot extends DirectoryStats {
  remote: string;
  sections: {
    meta: DirectoryStats;
    search: DirectoryStats;
    content: DirectoryStats;
    manifests: DirectoryStats;
    rclone: DirectoryStats;
  };
}

/**
 * Result of clearing all or part of a mount cache.
 */
export interface ClearMountCacheResult {
  remote: string;
  cacheDir: string;
  path?: ActiveFSPath;
  clearedBytes: number;
  clearedFiles: number;
}

/**
 * Options for clearing mount cache by ActiveFS path.
 */
export interface ClearMountCacheOptions {
  path?: string;
}

/**
 * Tail output from WebDAV and rclone logs.
 */
export interface MountLogsSnapshot {
  remote: string;
  webdav: string;
  rclone: string;
}

/**
 * Options for limiting mount log output.
 */
export interface TailMountLogsOptions {
  maxLines?: number;
}

/**
 * Options for removing a configured mount remote.
 */
export interface RemoveActiveFSMountRemoteOptions extends MountRuntimeCleanupOptions {
  cleanupRuntime?: boolean;
}

/**
 * Result of removing a mount remote from config.
 */
export interface RemoveActiveFSMountRemoteResult {
  remote: string;
  removed: boolean;
  config: ActiveFSMountConfig;
  cleanup?: MountRuntimeCleanupResult;
}

/**
 * Derived lifecycle state for an rclone-backed mount.
 */
export type RcloneMountState =
  | "configured"
  | "mounting"
  | "mounted"
  | "unmounted"
  | "rclone-down"
  | "webdav-down"
  | "stale"
  | "failed";

/**
 * Derived runtime health for a managed WebDAV server.
 */
export type WebDAVRuntimeState = "unknown" | "up" | "down";

/**
 * Source freshness mode for a mounted remote.
 */
export type MountFreshnessMode =
  | "session"
  | "watch"
  | "poll"
  | "ttl-only"
  | "starting"
  | "stopped"
  | "unavailable";

/**
 * Persisted freshness watcher/session status for one remote.
 */
export interface MountFreshnessStatus {
  remote: string;
  mode: MountFreshnessMode;
  active: boolean;
  updatedAt: string;
  pid?: number;
  sources?: string[];
  lastEventAt?: string;
  message?: string;
  error?: string;
}

/**
 * Persisted managed WebDAV runtime status.
 */
export interface WebDAVRuntimeStatus {
  remote: string;
  state: WebDAVRuntimeState;
  url?: string;
  pid?: number;
  reachable?: boolean;
  updatedAt: string;
  auth?: {
    username?: string;
    hasPassword: boolean;
  };
  error?: string;
}

/**
 * Redacted rclone RC status persisted for diagnostics.
 */
export interface RcloneRcStatus {
  addr: string;
  username: string;
  hasPassword: boolean;
}

/**
 * Private rclone RC credentials used for cache refresh.
 */
export interface RcloneRcCredentials {
  addr: string;
  username: string;
  password: string;
}

/**
 * Persisted and derived rclone mount status for one remote.
 */
export interface RcloneMountStatus {
  remote: string;
  state: RcloneMountState;
  rootDir: string;
  vfsDir: string;
  configPath: string;
  logFile: string;
  rcloneBinary?: string;
  pid?: number;
  mounted: boolean;
  updatedAt: string;
  webdav?: WebDAVRuntimeStatus;
  freshness?: MountFreshnessStatus;
  rc?: RcloneRcStatus;
  staleReason?: string;
  lastRefresh?: {
    path: ActiveFSPath;
    recursive: boolean;
    ok: boolean;
    updatedAt: string;
    message?: string;
  };
  message?: string;
  error?: string;
}

/**
 * Temporary rclone config handle.
 */
export interface RcloneWebDAVConfigHandle {
  remoteName: string;
  configPath: string;
  cacheDir: string;
  logFile: string;
  /** Removes the temporary config workspace. */
  cleanup(): Promise<void>;
}

/**
 * Captured child process state while waiting for a mount to become active.
 */
export interface RcloneMountChildState {
  error?: Error;
  exited?: boolean;
  code?: number | null;
}

/**
 * Minimal child process contract needed by mount helpers.
 */
export interface RcloneMountChild {
  pid?: number;
  /** Subscribes once to child process startup errors. */
  once(event: "error", listener: (error: Error) => void): unknown;
  /** Subscribes once to child process exit. */
  once(event: "exit", listener: (code: number | null) => void): unknown;
  /** Sends a termination signal to the child process. */
  kill(signal?: NodeJS.Signals): unknown;
  /** Detaches the child from keeping the parent event loop alive. */
  unref(): void;
}

/**
 * Process spawner used by `mountRcloneWebDAV`.
 */
export type RcloneMountProcessSpawner = (
  command: string,
  args: string[],
  options: { detached?: boolean; stdio: "ignore" | "inherit" }
) => RcloneMountChild;

/**
 * Callback that waits for a mountpoint to become active.
 */
export type RcloneMountActiveWaiter = (
  mountPoint: string,
  childState: RcloneMountChildState,
  timeoutMs: number
) => Promise<boolean>;

/**
 * Options for starting an rclone WebDAV mount.
 */
export interface RcloneMountOptions {
  remote: ActiveFSMountRemote;
  layout: ActiveFSMountLayout;
  rcloneBinary?: string;
  commandRunner?: MountCommandRunner;
  processSpawner?: RcloneMountProcessSpawner;
  waitForMountActive?: RcloneMountActiveWaiter;
  platform?: NodeJS.Platform;
  readOnly?: boolean;
  foreground?: boolean;
  daemon?: boolean;
  debug?: boolean;
  enableRc?: boolean;
  vfsCacheMode?: RcloneVfsCacheMode;
  mountReadyTimeoutMs?: number;
  rcAddr?: string;
  rc?: RcloneRcCredentials;
  extraArgs?: string[];
  currentUid?: number;
  currentGid?: number;
}

/**
 * rclone VFS cache mode passed to mounted WebDAV adapters.
 */
export type RcloneVfsCacheMode = "off" | "minimal" | "writes" | "full";

/**
 * Result of starting an rclone WebDAV mount.
 */
export interface RcloneMountStartResult {
  command: string;
  args: string[];
  status: RcloneMountStatus;
  child?: RcloneMountChild;
  stdout?: string;
  stderr?: string;
}

/**
 * Options for unmounting an rclone mount.
 */
export interface RcloneUnmountOptions {
  platform?: NodeJS.Platform;
  commandRunner?: MountCommandRunner;
  status?: RcloneMountStatus;
}

/**
 * Options for deriving current mount status.
 */
export interface RcloneMountStatusOptions {
  platform?: NodeJS.Platform;
  commandRunner?: MountCommandRunner;
  remote?: ActiveFSMountRemote;
  checkWebDAV?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Options for refreshing rclone VFS cache through RC.
 */
export interface RcloneRefreshOptions extends RcloneMountStatusOptions {
  path: string;
  recursive?: boolean;
  rcloneBinary?: string;
}

/**
 * Result of attempting an rclone VFS refresh.
 */
export interface RcloneRefreshResult {
  ok: boolean;
  status: RcloneMountStatus;
  stdout: string;
  stderr: string;
  error?: string;
}

/**
 * Options for stopping managed runtime processes.
 */
export interface ManagedWebDAVRuntimeOptions {
  processExists?: (pid: number) => boolean;
  terminateProcess?: (pid: number) => boolean;
}

/**
 * Cleanup action recorded while reconciling runtime state.
 */
export interface MountRuntimeCleanupAction {
  kind:
    | "webdav-marked-down"
    | "freshness-marked-down"
    | "freshness-stopped"
    | "rc-credentials-removed"
    | "mount-status-reset"
    | "noop";
  ok: boolean;
  path?: string;
  message: string;
}

/**
 * Result of cleaning stale mount runtime state.
 */
export interface MountRuntimeCleanupResult {
  remote: string;
  status: RcloneMountStatus;
  webdav?: WebDAVRuntimeStatus;
  actions: MountRuntimeCleanupAction[];
}

/**
 * Options for reconciling mount, WebDAV, and freshness runtime state.
 */
export interface MountRuntimeCleanupOptions
  extends RcloneMountStatusOptions, ManagedWebDAVRuntimeOptions {}

const READ_ALLOW = "OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY";
const UNSUPPORTED_WEBDAV_METHODS = new Set(["LOCK", "UNLOCK", "PROPPATCH", "PATCH", "POST"]);
const DEFAULT_MINIMUM_MACFUSE_VERSION = "5.0.0";
const MACFUSE_ROOT = "/Library/Filesystems/macfuse.fs";

/**
 * Creates a read-only access adapter over an ActiveFS filesystem.
 *
 * @returns Adapter metadata and normalized root path.
 */
export function createReadOnlyAccessAdapter<Auth = unknown, Meta = unknown>(
  options: ReadOnlyAccessAdapterOptions<Auth, Meta>
): ReadOnlyAccessAdapter<Auth, Meta> {
  return {
    name: options.name ?? "activefs-read-only",
    mode: "read-only",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      search: false,
      write: false,
      watch: false
    },
    filesystem: options.filesystem,
    rootPath: normalizeActiveFSPath(options.rootPath ?? "/")
  };
}

/**
 * Creates a WebDAV request handler over ActiveFS.
 *
 * @param options Runtime, auth, context provider, logging, cache, and local
 * policy settings.
 * @returns Node HTTP handler for OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL,
 * DELETE, MOVE, and COPY.
 * @remarks Write-like methods are locally policy-gated and then routed through
 * ActiveFS tree methods. Unsupported methods return WebDAV-style errors.
 */
export function createWebDAVRequestHandler<Auth = unknown, Meta = unknown>(
  options: WebDAVAdapterOptions<Auth, Meta>
): WebDAVRequestHandler {
  const adapter = createReadOnlyAccessAdapter(options);
  const auth = options.auth ?? false;
  const serverHeader = options.serverHeader ?? "ActiveFS WebDAV";
  const readCache = options.readCache === false ? undefined : createWebDAVReadCache(options.readCache);

  return async (request, response) => {
    const startedAt = Date.now();
    const method = (request.method ?? "GET").toUpperCase();
    const path = pathFromRequest(request, adapter.rootPath);
    let logged = false;
    const logRequest = (): void => {
      if (logged || !options.logger) {
        return;
      }
      logged = true;
      void Promise.resolve(
        options.logger({
          at: new Date().toISOString(),
          method,
          path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt,
          remoteAddress: request.socket.remoteAddress,
          userAgent: request.headers["user-agent"]
        })
      ).catch(() => undefined);
    };
    response.once("finish", logRequest);
    setCommonHeaders(response, serverHeader);

    if (!isAuthorized(request, auth)) {
      response.writeHead(401, {
        "WWW-Authenticate": `Basic realm="${escapeHeaderValue(auth ? auth.realm ?? "ActiveFS" : "ActiveFS")}"`
      });
      response.end("Unauthorized");
      return;
    }

    try {
      const context = await contextForRequest(options.context, { request, method, path });

      if (method === "OPTIONS") {
        response.writeHead(204, {
          Allow: READ_ALLOW,
          DAV: "1"
        });
        response.end();
        return;
      }

      if (method === "PROPFIND") {
        await handlePropfind(adapter, context, request, response, path);
        return;
      }

      if (method === "GET" || method === "HEAD") {
        await handleRead(adapter, context, request, response, path, method === "HEAD", readCache);
        return;
      }

      if (method === "PUT") {
        await handlePut(adapter, context, request, response, path, options.policy);
        return;
      }

      if (method === "MKCOL") {
        await assertPolicyAllowed(options.policy, "mkdir", path);
        await handleMkcol(adapter, context, response, path);
        return;
      }

      if (method === "DELETE") {
        await assertPolicyAllowed(options.policy, "delete", path);
        await handleDelete(adapter, context, response, path);
        return;
      }

      if (method === "MOVE") {
        const destination = destinationPathFromRequest(request, adapter.rootPath);
        await assertPolicyAllowed(options.policy, "rename", path);
        await assertPolicyAllowed(options.policy, "write", destination);
        await handleMove(adapter, context, request, response, path, destination);
        return;
      }

      if (method === "COPY") {
        const destination = destinationPathFromRequest(request, adapter.rootPath);
        await assertPolicyAllowed(options.policy, "copy", path);
        await assertPolicyAllowed(options.policy, "write", destination);
        await handleCopy(adapter, context, request, response, path, destination);
        return;
      }

      if (UNSUPPORTED_WEBDAV_METHODS.has(method)) {
        response.writeHead(501, {
          Allow: READ_ALLOW,
          "Content-Type": "text/plain; charset=utf-8"
        });
        response.end(`${method} is not implemented by the ActiveFS WebDAV adapter.`);
        return;
      }

      response.writeHead(501, {
        Allow: READ_ALLOW,
        "Content-Type": "text/plain; charset=utf-8"
      });
      response.end(`Unsupported method: ${method}`);
    } catch (error) {
      writeError(response, error);
    }
  };
}

/**
 * Starts a loopback WebDAV server.
 *
 * @returns Server URL, generated/default auth, and close handle.
 * @throws Node listen errors or an error when the server does not bind a TCP
 * address.
 */
export async function startWebDAVServer<Auth = unknown, Meta = unknown>(
  options: WebDAVServerOptions<Auth, Meta>
): Promise<WebDAVServerHandle> {
  const auth = options.auth === undefined
    ? { username: "activefs", password: randomUUID(), realm: "ActiveFS" }
    : options.auth;
  const handler = createWebDAVRequestHandler({ ...options, auth });
  const server = createServer(handler);
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("WebDAV server did not bind to a TCP address.");
  }

  return {
    server,
    auth,
    url: `http://${hostname}:${address.port}/`,
    close: () => closeServer(server)
  };
}

/**
 * Resolves the runtime layout for one mount remote.
 *
 * @throws Error when the remote name is not filesystem-safe.
 */
export function createMountLayout(
  rootDir: string,
  remoteName: string,
  options: { mountpoint?: string } = {}
): ActiveFSMountLayout {
  validateRemoteName(remoteName);
  const stateLayout = createActiveFSRemoteStateLayout(rootDir, remoteName);
  const remoteDir = stateLayout.remoteDir;
  const cacheDir = join(remoteDir, "cache");
  const runtimeDir = join(remoteDir, "runtime");

  return {
    rootDir: stateLayout.stateDir,
    stateRoot: stateLayout.stateRoot,
    stateDir: stateLayout.stateDir,
    remoteName,
    remoteDir,
    vfsDir: options.mountpoint ? resolve(options.mountpoint) : join(remoteDir, "vfs"),
    cacheDir,
    rcloneCacheDir: join(cacheDir, "rclone"),
    runtimeDir,
    rcloneConfigPath: join(runtimeDir, "rclone.conf"),
    rcloneLogPath: join(runtimeDir, "rclone.log"),
    mountStatusPath: join(runtimeDir, "mount.json"),
    webdavStatusPath: join(runtimeDir, "webdav.json"),
    freshnessStatusPath: join(runtimeDir, "freshness.json"),
    webdavCredentialsPath: join(runtimeDir, "webdav-credentials.json"),
    rcloneRcCredentialsPath: join(runtimeDir, "rclone-rc-credentials.json")
  };
}

/**
 * Creates the directories required for mount runtime, cache, logs, and config.
 *
 * Windows directory mounts are created by rclone/WinFsp, so callers starting a
 * Windows mount can leave the mountpoint absent while preparing the rest of the
 * layout.
 */
export async function ensureMountLayout(
  layout: ActiveFSMountLayout,
  options: { createMountpoint?: boolean } = {}
): Promise<void> {
  const directories = [
    ensureActiveFSRemoteStateLayout(createActiveFSRemoteStateLayout(layout.stateDir, layout.remoteName)),
    mkdir(join(layout.cacheDir, "meta"), { recursive: true }),
    mkdir(join(layout.cacheDir, "search"), { recursive: true }),
    mkdir(join(layout.cacheDir, "content"), { recursive: true }),
    mkdir(join(layout.cacheDir, "manifests"), { recursive: true }),
    mkdir(layout.rcloneCacheDir, { recursive: true }),
    mkdir(layout.runtimeDir, { recursive: true })
  ];
  directories.push(mkdir(
    options.createMountpoint === false ? dirname(layout.vfsDir) : layout.vfsDir,
    { recursive: true }
  ));
  await Promise.all(directories);
}

/**
 * Loads mount targets projected from unified ActiveFS config.
 */
export async function loadActiveFSMountConfig(rootDir: string): Promise<ActiveFSMountConfig> {
  const config = await loadActiveFSConfig(rootDir);
  return {
    version: 1,
    remotes: Object.fromEntries(
      Object.values(config.remotes)
        .map((remote) => [remote.name, mountRemoteFromUnified(remote)])
    )
  };
}

/**
 * Saves mount remotes into unified ActiveFS config after redacting passwords.
 */
export async function saveActiveFSMountConfig(
  rootDir: string,
  config: ActiveFSMountConfig
): Promise<void> {
  for (const remote of Object.values(redactMountConfig(config).remotes)) {
    await upsertActiveFSRemote(rootDir, unifiedRemoteFromMount(remote));
  }
}

/**
 * Removes a mountable ActiveFS remote from unified config.
 *
 * @returns Removal status plus optional runtime cleanup result.
 */
export async function removeActiveFSMountRemote(
  rootDir: string,
  remoteName: string,
  options: RemoveActiveFSMountRemoteOptions = {}
): Promise<RemoveActiveFSMountRemoteResult> {
  validateRemoteName(remoteName);
  const { removed, config: unified } = await removeActiveFSRemoteConfig(rootDir, remoteName);
  const config: ActiveFSMountConfig = {
    version: 1,
    remotes: Object.fromEntries(
      Object.values(unified.remotes)
        .map((remote) => [remote.name, mountRemoteFromUnified(remote)])
    )
  };
  const cleanup = options.cleanupRuntime
    ? await cleanupMountRuntime(createMountLayout(rootDir, remoteName), options)
    : undefined;
  return {
    remote: remoteName,
    removed,
    config,
    cleanup
  };
}

/**
 * Reads cache usage for a mount remote.
 */
export async function readMountCacheSnapshot(
  layout: ActiveFSMountLayout
): Promise<ActiveFSMountCacheSnapshot> {
  const sections = {
    meta: await directoryStats(join(layout.cacheDir, "meta")),
    search: await directoryStats(join(layout.cacheDir, "search")),
    content: await directoryStats(join(layout.cacheDir, "content")),
    manifests: await directoryStats(join(layout.cacheDir, "manifests")),
    rclone: await directoryStats(layout.rcloneCacheDir)
  };
  const fileCount = Object.values(sections).reduce((total, section) => total + section.fileCount, 0);
  const byteSize = Object.values(sections).reduce((total, section) => total + section.byteSize, 0);
  return {
    remote: layout.remoteName,
    path: layout.cacheDir,
    fileCount,
    byteSize,
    sections
  };
}

/**
 * Clears all mount cache state or only entries associated with one ActiveFS path.
 *
 * @returns Approximate cleared file and byte counts based on before/after scans.
 */
export async function clearMountCache(
  layout: ActiveFSMountLayout,
  options: ClearMountCacheOptions = {}
): Promise<ClearMountCacheResult> {
  const before = await readMountCacheSnapshot(layout);
  const normalizedPath = options.path ? normalizeActiveFSPath(options.path) : undefined;
  if (normalizedPath) {
    const key = activeFSMountCachePathKey(normalizedPath);
    await Promise.all([
      rm(join(layout.cacheDir, "meta", key), { recursive: true, force: true }),
      rm(join(layout.cacheDir, "search", key), { recursive: true, force: true }),
      rm(join(layout.cacheDir, "content", key), { recursive: true, force: true }),
      rm(join(layout.cacheDir, "manifests", key), { recursive: true, force: true })
    ]);
  } else {
    await rm(layout.cacheDir, { recursive: true, force: true });
  }
  await ensureMountLayout(layout);
  const after = await readMountCacheSnapshot(layout);
  return {
    remote: layout.remoteName,
    cacheDir: layout.cacheDir,
    path: normalizedPath,
    clearedBytes: Math.max(0, before.byteSize - after.byteSize),
    clearedFiles: Math.max(0, before.fileCount - after.fileCount)
  };
}

/**
 * Encodes an ActiveFS path into the cache-key format used by mount cache dirs.
 */
export function activeFSMountCachePathKey(path: string): string {
  return Buffer.from(normalizeActiveFSPath(path)).toString("base64url");
}

/**
 * Reads the tail of WebDAV and rclone runtime logs.
 */
export async function tailMountLogs(
  layout: ActiveFSMountLayout,
  options: TailMountLogsOptions = {}
): Promise<MountLogsSnapshot> {
  return {
    remote: layout.remoteName,
    webdav: await tailText(join(layout.runtimeDir, "webdav.log"), options.maxLines),
    rclone: await tailText(layout.rcloneLogPath, options.maxLines)
  };
}

/**
 * Detects whether an rclone binary can run.
 *
 * @returns Command name/path when `rclone version` succeeds; otherwise `null`.
 */
export function detectRcloneBinary(options: {
  rcloneBinary?: string;
  commandRunner?: MountCommandRunner;
} = {}): string | null {
  const command = options.rcloneBinary ?? "rclone";
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const result = commandRunner(command, ["version"]);
  return result.status === 0 ? command : null;
}

/**
 * Writes an rclone WebDAV config file for one remote.
 *
 * @remarks Passwords are passed through `rclone obscure` when possible. The
 * caller controls the destination path and file permissions.
 */
export async function writeRcloneWebDAVConfig(
  remote: ActiveFSMountRemote,
  configPath: string,
  options: { rcloneBinary?: string; commandRunner?: MountCommandRunner } = {}
): Promise<void> {
  validateRemoteName(remote.name);
  await mkdir(dirname(configPath), { recursive: true });

  const lines = [
    `[${remote.name}]`,
    "type = webdav",
    `url = ${remote.url}`,
    `vendor = ${remote.vendor ?? "other"}`
  ];

  if (remote.username) {
    lines.push(`user = ${remote.username}`);
  }
  if (remote.password) {
    lines.push(`pass = ${obscureRclonePassword(remote.password, options)}`);
  }

  lines.push("");
  await writeFile(configPath, lines.join("\n"));
}

/**
 * Creates a temporary rclone WebDAV config and cache directory.
 *
 * @returns Handle with cleanup method that removes the temporary workspace.
 */
export async function createTemporaryRcloneWebDAVConfig(
  remote: ActiveFSMountRemote,
  options: { rcloneBinary?: string; commandRunner?: MountCommandRunner } = {}
): Promise<RcloneWebDAVConfigHandle> {
  const workDir = await mkdtemp(join(tmpdir(), "activefs-rclone-"));
  const cacheDir = join(workDir, "cache");
  const logFile = join(workDir, "rclone.log");
  const configPath = join(workDir, "rclone.conf");
  await mkdir(cacheDir, { recursive: true });
  await writeRcloneWebDAVConfig(remote, configPath, options);

  return {
    remoteName: remote.name,
    configPath,
    cacheDir,
    logFile,
    cleanup: () => rm(workDir, { recursive: true, force: true })
  };
}

/**
 * Builds the `rclone mount` command and arguments for a layout.
 */
export function createRcloneMountCommand(options: RcloneMountOptions): {
  command: string;
  args: string[];
} {
  const command = options.rcloneBinary ?? "rclone";
  const platform = options.platform ?? process.platform;
  const args = [
    "mount",
    `${options.remote.name}:`,
    options.layout.vfsDir,
    "--config",
    options.layout.rcloneConfigPath,
    "--vfs-cache-mode",
    options.vfsCacheMode ?? "off",
    "--dir-cache-time",
    "10m",
    "--cache-dir",
    options.layout.rcloneCacheDir,
    "--log-file",
    options.layout.rcloneLogPath,
    "--log-level",
    options.debug ? "DEBUG" : "INFO"
  ];

  if (options.readOnly === true) {
    args.push("--read-only");
  }
  if (platform === "darwin" && !hasRcloneOption(options.extraArgs, "--volname")) {
    args.push("--volname", rcloneMountVolumeName(options.layout.vfsDir, options.remote.name));
  }
  const currentUid = options.currentUid ?? currentProcessUid();
  const currentGid = options.currentGid ?? currentProcessGid();
  if (platform === "darwin" && currentUid === 0) {
    if (!hasRcloneOption(options.extraArgs, "--allow-root")) {
      args.push("--allow-root");
    }
    if (!hasRcloneOption(options.extraArgs, "--uid")) {
      args.push("--uid", "0");
    }
    if (!hasRcloneOption(options.extraArgs, "--gid")) {
      args.push("--gid", String(currentGid ?? 0));
    }
  }
  if (options.rc) {
    args.push(
      "--rc",
      "--rc-addr",
      options.rc.addr,
      "--rc-user",
      options.rc.username,
      "--rc-pass",
      options.rc.password
    );
  }
  if (options.extraArgs) {
    args.push(...options.extraArgs);
  }

  return { command, args };
}

function hasRcloneOption(args: string[] | undefined, option: string): boolean {
  return args?.some((arg) => arg === option || arg.startsWith(`${option}=`)) ?? false;
}

function currentProcessUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function currentProcessGid(): number | undefined {
  return typeof process.getgid === "function" ? process.getgid() : undefined;
}

function rcloneMountVolumeName(vfsDir: string, fallback: string): string {
  return basename(resolve(vfsDir)) || fallback;
}

/**
 * Starts an rclone WebDAV mount and persists runtime status.
 *
 * @returns Command, args, status, and child process when spawned.
 * @throws Error when rclone is unavailable or layout/config preparation fails.
 */
export async function mountRcloneWebDAV(
  options: RcloneMountOptions
): Promise<RcloneMountStartResult> {
  const platform = options.platform ?? process.platform;
  await ensureMountLayout(options.layout, {
    createMountpoint: platform !== "win32"
  });
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const processSpawner = options.processSpawner ?? defaultMountProcessSpawner;
  const waitForActive = options.waitForMountActive ??
    ((mountPoint, childState, timeoutMs) =>
      waitForMountActive(mountPoint, childState, timeoutMs, {
        commandRunner,
        platform: options.platform ?? process.platform
      }));
  const rcloneBinary = detectRcloneBinary({
    rcloneBinary: options.rcloneBinary,
    commandRunner
  });
  if (!rcloneBinary) {
    throw new Error(
      `rclone is not available: ${options.rcloneBinary ?? "rclone"}. Install rclone, make sure it is on PATH, or pass --rclone /path/to/rclone. Run activefs doctor --mounts for platform-specific mount prerequisites.`
    );
  }

  if (platform === "win32") {
    await prepareWindowsDirectoryMountpoint(options.layout.vfsDir);
  }

  const remote = await hydrateRemoteCredentials(options.layout, options.remote);
  const rc = options.enableRc === false ? undefined : await prepareRcloneRc(options.layout, options.rcAddr);
  await writeRcloneWebDAVConfig(remote, options.layout.rcloneConfigPath, { rcloneBinary });
  const command = createRcloneMountCommand({ ...options, remote, rcloneBinary, rc });
  await writeMountStatus(options.layout, {
    remote: remote.name,
    state: "mounting",
    mounted: false,
    rcloneBinary,
    rc: rc ? redactRcloneRcCredentials(rc) : undefined,
    webdav: await checkAndPersistWebDAVStatus(options.layout, remote),
    message: "Starting rclone mount."
  });

  if (options.foreground) {
    const child = processSpawner(command.command, command.args, { stdio: "inherit" });
    await writeMountStatus(options.layout, {
      remote: remote.name,
      state: "mounted",
      mounted: true,
      rcloneBinary,
      pid: child.pid,
      rc: rc ? redactRcloneRcCredentials(rc) : undefined,
      webdav: await checkAndPersistWebDAVStatus(options.layout, remote),
      message: "Foreground rclone mount is running."
    });
    child.once("exit", (code) => {
      void writeMountStatus(options.layout, {
        remote: remote.name,
        state: code === 0 ? "unmounted" : "failed",
        mounted: false,
        rcloneBinary,
        message: code === 0 ? "Foreground rclone mount exited." : `Foreground rclone mount exited with ${code}.`
      });
    });
    return {
      ...command,
      child,
      status: await readRcloneMountStatus(options.layout, {
        commandRunner,
        platform: options.platform,
        checkWebDAV: false
      })
    };
  }

  const childState: RcloneMountChildState = {};
  const child = processSpawner(command.command, command.args, {
    detached: true,
    stdio: "ignore"
  });
  child.once("error", (error) => {
    childState.error = error;
  });
  child.once("exit", (code) => {
    childState.exited = true;
    childState.code = code;
  });

  const mounted = await waitForActive(options.layout.vfsDir, childState, options.mountReadyTimeoutMs ?? 15_000);
  if (!mounted) {
    if (!childState.exited) {
      child.kill("SIGTERM");
    }
    const error = childState.error?.message ??
      (childState.exited ? `rclone mount exited with ${childState.code}.` : "Timed out waiting for rclone mount.");
    const status = await writeMountStatus(options.layout, {
      remote: remote.name,
      state: "failed",
      mounted: false,
      rcloneBinary,
      rc: rc ? redactRcloneRcCredentials(rc) : undefined,
      webdav: await checkAndPersistWebDAVStatus(options.layout, remote),
      error
    });
    return {
      ...command,
      child,
      status
    };
  }

  child.unref();
  const status = await writeMountStatus(options.layout, {
    remote: remote.name,
    state: "mounted",
    mounted: true,
    rcloneBinary,
    pid: child.pid,
    rc: rc ? redactRcloneRcCredentials(rc) : undefined,
    webdav: await checkAndPersistWebDAVStatus(options.layout, remote),
    message: "rclone mount started."
  });
  return {
    ...command,
    status,
    child
  };
}

async function prepareWindowsDirectoryMountpoint(mountpoint: string): Promise<void> {
  try {
    const mountpointStat = await stat(mountpoint);
    if (!mountpointStat.isDirectory()) {
      throw new Error(`Windows mountpoint must be a directory path: ${mountpoint}`);
    }
    const entries = await readdir(mountpoint);
    if (entries.length > 0) {
      throw new Error(
        `Windows directory mountpoint must not exist or must be empty before mounting: ${mountpoint}`
      );
    }
    await rmdir(mountpoint);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

/**
 * Reads current mount status and derives health from host mount state and
 * optional WebDAV endpoint checks.
 */
export async function readRcloneMountStatus(
  layout: ActiveFSMountLayout,
  options: RcloneMountStatusOptions = {}
): Promise<RcloneMountStatus> {
  let stored: Partial<RcloneMountStatus> = {};
  try {
    stored = JSON.parse(await readFile(layout.mountStatusPath, "utf8")) as Partial<RcloneMountStatus>;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }

  const mounted = isMountActive(layout.vfsDir, {
    commandRunner: options.commandRunner ?? defaultCommandRunner,
    platform: options.platform ?? process.platform
  });
  const remote = options.remote
    ? await hydrateRemoteCredentials(layout, options.remote)
    : undefined;
  const webdav = options.checkWebDAV === false
    ? stored.webdav ?? await readWebDAVRuntimeStatus(layout)
    : await checkAndPersistWebDAVStatus(layout, remote, options);
  const freshness = await readMountFreshnessStatus(layout);
  const state = deriveMountState(stored.state, mounted, webdav);
  return normalizeMountStatus(layout, {
    ...stored,
    state,
    mounted,
    webdav,
    freshness: freshness ?? stored.freshness
  });
}

/**
 * Attempts to unmount an active rclone mount using platform-specific commands.
 *
 * @returns Updated persisted mount status.
 */
export async function unmountRcloneMount(
  layout: ActiveFSMountLayout,
  options: RcloneUnmountOptions = {}
): Promise<RcloneMountStatus> {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const status = options.status ?? await readRcloneMountStatus(layout, {
    commandRunner,
    platform: options.platform,
    checkWebDAV: false
  });
  if (!status.mounted) {
    return writeMountStatus(layout, {
      remote: layout.remoteName,
      state: "unmounted",
      mounted: false,
      webdav: status.webdav,
      rc: status.rc,
      message: "Mount point is not active."
    });
  }

  const commands = unmountCommands(layout.vfsDir, options.platform ?? process.platform, status);
  const failures: string[] = [];
  for (const [command, args] of commands) {
    const result = commandRunner(command, args);
    if (result.status === 0) {
      return writeMountStatus(layout, {
        remote: layout.remoteName,
        state: "unmounted",
        mounted: false,
        webdav: status.webdav,
        rc: status.rc,
        message: `Unmounted with ${command}.`
      });
    }
    failures.push(`${command}: ${result.stderr || result.stdout || result.error?.message || result.status}`);
  }

  return writeMountStatus(layout, {
    remote: layout.remoteName,
    state: "failed",
    mounted: true,
    webdav: status.webdav,
    rc: status.rc,
    error: `Unable to unmount ${layout.vfsDir}: ${failures.join("; ")}`
  });
}

/**
 * Unmounts an existing mount, then starts it again.
 */
export async function remountRcloneWebDAV(
  options: RcloneMountOptions & RcloneUnmountOptions
): Promise<RcloneMountStartResult> {
  await unmountRcloneMount(options.layout, options);
  return mountRcloneWebDAV(options);
}

/**
 * Refreshes rclone VFS cache through the private RC endpoint.
 *
 * @returns Refresh result and updated persisted status. Missing mount or RC
 * credentials produce `ok: false` rather than throwing.
 */
export async function refreshRcloneMount(
  layout: ActiveFSMountLayout,
  options: RcloneRefreshOptions
): Promise<RcloneRefreshResult> {
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const status = await readRcloneMountStatus(layout, {
    ...options,
    commandRunner
  });
  const rc = await readRcloneRcCredentials(layout);
  const path = normalizeActiveFSPath(options.path);
  const refreshedAt = new Date().toISOString();

  if (!status.mounted) {
    const message = `Cannot refresh ${path}; mount is ${status.state}.`;
    const updated = await writeMountStatus(layout, {
      ...status,
      state: "stale",
      mounted: status.mounted,
      staleReason: message,
      lastRefresh: {
        path,
        recursive: Boolean(options.recursive),
        ok: false,
        updatedAt: refreshedAt,
        message
      }
    });
    return { ok: false, status: updated, stdout: "", stderr: "", error: message };
  }

  if (!rc) {
    const message = "Cannot refresh mount; rclone RC credentials are not available.";
    const updated = await writeMountStatus(layout, {
      ...status,
      state: "stale",
      staleReason: message,
      lastRefresh: {
        path,
        recursive: Boolean(options.recursive),
        ok: false,
        updatedAt: refreshedAt,
        message
      }
    });
    return { ok: false, status: updated, stdout: "", stderr: "", error: message };
  }

  const result = commandRunner(options.rcloneBinary ?? status.rcloneBinary ?? "rclone", [
    "rc",
    "--rc-addr",
    rc.addr,
    "--rc-user",
    rc.username,
    "--rc-pass",
    rc.password,
    "vfs/refresh",
    `dir=${rcloneRefreshDir(path)}`,
    `recursive=${options.recursive ? "true" : "false"}`
  ]);
  const ok = result.status === 0;
  const message = ok
    ? `Refreshed ${path}.`
    : result.stderr || result.stdout || result.error?.message || "rclone RC refresh failed.";
  const updated = await writeMountStatus(layout, {
    ...status,
    state: ok ? status.state : "stale",
    staleReason: ok ? undefined : message,
    lastRefresh: {
      path,
      recursive: Boolean(options.recursive),
      ok,
      updatedAt: refreshedAt,
      message
    }
  });

  return {
    ok,
    status: updated,
    stdout: result.stdout,
    stderr: result.stderr,
    error: ok ? undefined : message
  };
}

/**
 * Marks a managed WebDAV runtime down and requests process termination when a
 * recorded pid is still running.
 */
export async function stopManagedWebDAVRuntime(
  layout: ActiveFSMountLayout,
  options: ManagedWebDAVRuntimeOptions = {}
): Promise<WebDAVRuntimeStatus> {
  const previous = await readWebDAVRuntimeStatus(layout);
  const processExists = options.processExists ?? defaultProcessExists;
  const terminateProcess = options.terminateProcess ?? defaultTerminateProcess;
  let message = "No WebDAV runtime pid was recorded.";

  if (previous?.pid) {
    if (processExists(previous.pid)) {
      message = terminateProcess(previous.pid)
        ? "WebDAV server stop requested."
        : "WebDAV server could not be stopped.";
    } else {
      message = "WebDAV process is not running.";
    }
  }

  return writeWebDAVRuntimeStatus(layout, {
    remote: previous?.remote ?? layout.remoteName,
    state: "down",
    url: previous?.url,
    pid: previous?.pid,
    reachable: false,
    auth: previous?.auth,
    error: message
  });
}

/**
 * Reconciles stale mount runtime files after crashes or interrupted runs.
 *
 * @returns Actions taken plus current status.
 */
export async function cleanupMountRuntime(
  layout: ActiveFSMountLayout,
  options: MountRuntimeCleanupOptions = {}
): Promise<MountRuntimeCleanupResult> {
  const actions: MountRuntimeCleanupAction[] = [];
  const processExists = options.processExists ?? defaultProcessExists;
  const status = await readRcloneMountStatus(layout, options);
  let webdav = status.webdav;
  let freshness = status.freshness;

  if (webdav?.state === "up" && webdav.pid && !processExists(webdav.pid)) {
    webdav = await writeWebDAVRuntimeStatus(layout, {
      ...webdav,
      state: "down",
      reachable: false,
      error: "WebDAV runtime pid is not running."
    });
    actions.push({
      kind: "webdav-marked-down",
      ok: true,
      path: layout.webdavStatusPath,
      message: "Marked stopped WebDAV runtime as down."
    });
  }

  if (freshness?.active && freshness.pid && !processExists(freshness.pid)) {
    freshness = await writeMountFreshnessStatus(layout, {
      ...freshness,
      mode: "stopped",
      active: false,
      error: "Freshness watcher pid is not running."
    });
    actions.push({
      kind: "freshness-marked-down",
      ok: true,
      path: layout.freshnessStatusPath,
      message: "Marked stopped freshness watcher as down."
    });
  }

  let cleanedStatus = status;
  if (!status.mounted) {
    if (freshness?.active) {
      freshness = await stopMountFreshnessRuntime(layout, options);
      actions.push({
        kind: "freshness-stopped",
        ok: freshness.active === false,
        path: layout.freshnessStatusPath,
        message: "Stopped freshness watcher because the mountpoint is not active."
      });
    }

    let removedRcCredentials = false;
    if (existsSync(layout.rcloneRcCredentialsPath)) {
      await rm(layout.rcloneRcCredentialsPath, { force: true });
      removedRcCredentials = true;
      actions.push({
        kind: "rc-credentials-removed",
        ok: true,
        path: layout.rcloneRcCredentialsPath,
        message: "Removed stale rclone RC credentials."
      });
    }

    const shouldResetMountStatus = ["mounting", "mounted", "rclone-down", "webdav-down", "stale"].includes(status.state);
    if (shouldResetMountStatus || removedRcCredentials || webdav !== status.webdav || freshness !== status.freshness) {
      cleanedStatus = await writeMountStatus(layout, {
        ...status,
        state: shouldResetMountStatus ? "unmounted" : status.state,
        mounted: false,
        rc: removedRcCredentials ? undefined : status.rc,
        webdav,
        freshness,
        staleReason: shouldResetMountStatus ? undefined : status.staleReason,
        message: shouldResetMountStatus ? "Cleaned stale mount runtime." : status.message
      });
      if (shouldResetMountStatus) {
        actions.push({
          kind: "mount-status-reset",
          ok: true,
          path: layout.mountStatusPath,
          message: "Reset orphaned mount status to unmounted."
        });
      }
    }
  }

  if (actions.length === 0) {
    actions.push({
      kind: "noop",
      ok: true,
      message: "No stale mount runtime state found."
    });
  }

  return {
    remote: layout.remoteName,
    status: cleanedStatus,
    webdav,
    actions
  };
}

/**
 * Collects host mount dependency evidence and configured remote statuses.
 */
export async function collectRcloneMountEvidence(
  rootDir = ".activefs",
  options: RcloneMountEvidenceOptions = {}
): Promise<RcloneMountEvidence> {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const resolvedRoot = resolve(rootDir);
  const host = inspectRcloneMountHost({
    ...options,
    platform,
    commandRunner
  });
  const config = await loadActiveFSMountConfig(resolvedRoot);
  const remotes: RcloneMountStatus[] = [];

  for (const remote of Object.values(config.remotes)) {
    remotes.push(await readRcloneMountStatus(createMountLayout(resolvedRoot, remote.name, {
      mountpoint: remote.mountpoint
    }), {
      remote,
      platform,
      commandRunner,
      fetch: options.fetch,
      timeoutMs: options.timeoutMs
    }));
  }

  return {
    collectedAt: new Date().toISOString(),
    platform,
    rootDir: resolvedRoot,
    host,
    activeMounts: collectActiveMountEvidence(platform, commandRunner),
    remotes,
    guidance: mountVerificationGuidance(platform, resolvedRoot, remotes[0]?.remote ?? "local")
  };
}

/**
 * Builds platform-specific manual verification guidance for real mounts.
 */
export function mountVerificationGuidance(
  platform: NodeJS.Platform = process.platform,
  rootDir = ".activefs",
  remoteName = "local"
): MountVerificationGuidance {
  const backend = backendForPlatform(platform);
  const root = rootDir;
  const mountRoot = platform === "win32"
    ? `${root}\\${remoteName}\\vfs`
    : `${root}/${remoteName}/vfs`;
  const helloPath = platform === "win32"
    ? `${mountRoot}\\hello.md`
    : `${mountRoot}/hello.md`;
  const commands: MountVerificationCommand[] = [
    {
      name: "doctor",
      command: `activefs doctor --mounts --state-root ${root} --json`,
      proves: "host mount prerequisites and configured ActiveFS runtime state"
    },
    {
      name: "mount",
      command: `activefs mount ${remoteName} --state-root ${root}`,
      proves: "rclone can create a read-only mounted VFS directory"
    },
    {
      name: "status",
      command: `activefs mount status ${remoteName} --state-root ${root} --json`,
      proves: "ActiveFS sees the mount and WebDAV endpoint as healthy"
    }
  ];

  if (platform === "win32") {
    commands.push(
      {
        name: "PowerShell read",
        command: `powershell -NoProfile -Command "Get-Content '${helloPath}' -Raw"`,
        proves: "Windows tools can read mounted WebDAV/rclone files"
      },
      {
        name: "directory walk",
        command: `powershell -NoProfile -Command "Get-ChildItem '${mountRoot}' -Recurse"`,
        proves: "WinFsp-backed directory traversal works"
      }
    );
  } else {
    commands.push(
      {
        name: "cat",
        command: `cat ${helloPath}`,
        proves: "standard file reads work through the mounted directory"
      },
      {
        name: "rg",
        command: `rg ActiveFS ${mountRoot}`,
        proves: "recursive search tools can traverse and read the mounted tree"
      },
      {
        name: "find",
        command: `find ${mountRoot} -maxdepth 3 -type f -print`,
        proves: "filesystem directory walking works through the mounted tree"
      }
    );
  }

  return {
    platform,
    backend,
    prerequisites: prerequisitesForBackend(backend),
    commands,
    notes: notesForBackend(backend)
  };
}

function validateRemoteName(remoteName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName)) {
    throw new Error(`Invalid ActiveFS remote name: ${remoteName}`);
  }
}

function redactMountConfig(config: ActiveFSMountConfig): ActiveFSMountConfig {
  return {
    version: 1,
    remotes: Object.fromEntries(
      Object.entries(config.remotes).map(([name, remote]) => [name, redactRemote(remote)])
    )
  };
}

function mountRemoteFromUnified(remote: ActiveFSRemoteConfig): ActiveFSMountRemote {
  const managedWebDAV: ManagedWebDAVConfig = {
    enabled: true,
    host: remote.managedWebDAV?.host,
    port: remote.managedWebDAV?.port
  };
  return {
    name: remote.name,
    url: managedWebDAVUrl(managedWebDAV),
    sourceUrl: remote.url,
    username: remote.username,
    hasCredentials: remote.hasCredentials,
    vendor: remote.vendor ?? "other",
    mountpoint: remote.mountpoint,
    remoteRoot: remote.remoteRoot,
    managedWebDAV,
    policy: remote.policy,
    adapterCapabilityProfile: remote.adapterCapabilityProfile,
    cacheMode: remote.cacheMode,
    activityPolicy: remote.activityPolicy
  };
}

function managedWebDAVUrl(config: ManagedWebDAVConfig): string {
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? 0;
  const hostForUrl = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostForUrl}:${port}/`;
}

function unifiedRemoteFromMount(remote: ActiveFSMountRemote): ActiveFSRemoteConfig {
  return {
    name: remote.name,
    url: remote.sourceUrl ?? remote.url,
    username: remote.username,
    hasCredentials: remote.hasCredentials,
    vendor: remote.vendor ?? "other",
    mountpoint: remote.mountpoint,
    remoteRoot: remote.remoteRoot,
    managedWebDAV: remote.managedWebDAV,
    policy: remote.policy,
    adapterCapabilityProfile: remote.adapterCapabilityProfile ?? "bounded-filesystem-semantics",
    cacheMode: remote.cacheMode ?? "off",
    activityPolicy: remote.activityPolicy ?? "best-effort"
  };
}

function redactRemote(remote: ActiveFSMountRemote): ActiveFSMountRemote {
  const redacted: ActiveFSMountRemote = {
    name: remote.name,
    url: remote.url,
    sourceUrl: remote.sourceUrl,
    vendor: remote.vendor ?? "other"
  };
  if (remote.username) {
    redacted.username = remote.username;
  }
  if (remote.password || remote.hasCredentials) {
    redacted.hasCredentials = true;
  }
  if (remote.managedWebDAV) {
    redacted.managedWebDAV = { ...remote.managedWebDAV };
  }
  if (remote.mountpoint) {
    redacted.mountpoint = remote.mountpoint;
  }
  if (remote.remoteRoot) {
    redacted.remoteRoot = remote.remoteRoot;
  }
  if (remote.policy) {
    redacted.policy = remote.policy;
  }
  if (remote.adapterCapabilityProfile) {
    redacted.adapterCapabilityProfile = remote.adapterCapabilityProfile;
  }
  if (remote.cacheMode) {
    redacted.cacheMode = remote.cacheMode;
  }
  if (remote.activityPolicy) {
    redacted.activityPolicy = remote.activityPolicy;
  }
  return redacted;
}

function credentialSummary(remote: ActiveFSMountRemote): WebDAVRuntimeStatus["auth"] {
  return {
    username: remote.username,
    hasPassword: Boolean(remote.password || remote.hasCredentials)
  };
}

async function writeWebDAVCredentials(
  layout: ActiveFSMountLayout,
  remote: ActiveFSMountRemote
): Promise<void> {
  if (!remote.username && !remote.password) {
    return;
  }
  await writePrivateJson(layout.webdavCredentialsPath, {
    remote: remote.name,
    username: remote.username,
    password: remote.password,
    updatedAt: new Date().toISOString()
  });
}

async function readWebDAVCredentials(
  layout: ActiveFSMountLayout
): Promise<Pick<ActiveFSMountRemote, "username" | "password"> | null> {
  try {
    const parsed = await readJsonFile<{ username?: unknown; password?: unknown }>(layout.webdavCredentialsPath);
    return {
      username: stringValue(parsed.username),
      password: stringValue(parsed.password)
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

async function hydrateRemoteCredentials(
  layout: ActiveFSMountLayout,
  remote: ActiveFSMountRemote
): Promise<ActiveFSMountRemote> {
  if (remote.password) {
    return remote;
  }
  const credentials = await readWebDAVCredentials(layout);
  if (!credentials) {
    return remote;
  }
  return {
    ...remote,
    username: remote.username ?? credentials.username,
    password: credentials.password
  };
}

/**
 * Hydrates a redacted remote with private WebDAV credentials from runtime state.
 */
export async function hydrateActiveFSMountRemoteCredentials(
  layout: ActiveFSMountLayout,
  remote: ActiveFSMountRemote
): Promise<ActiveFSMountRemote> {
  return hydrateRemoteCredentials(layout, remote);
}

/**
 * Writes managed WebDAV runtime status with credential redaction.
 */
export async function writeWebDAVRuntimeStatus(
  layout: ActiveFSMountLayout,
  status: Omit<WebDAVRuntimeStatus, "updatedAt"> & { updatedAt?: string }
): Promise<WebDAVRuntimeStatus> {
  const normalized: WebDAVRuntimeStatus = {
    ...status,
    updatedAt: status.updatedAt ?? new Date().toISOString(),
    auth: status.auth
      ? {
          username: status.auth.username,
          hasPassword: status.auth.hasPassword
        }
      : undefined
  };
  await writePrivateJson(layout.webdavStatusPath, normalized);
  return normalized;
}

/**
 * Reads managed WebDAV runtime status.
 *
 * @returns Status, or `undefined` when no status file exists.
 */
export async function readWebDAVRuntimeStatus(layout: ActiveFSMountLayout): Promise<WebDAVRuntimeStatus | undefined> {
  try {
    return await readJsonFile<WebDAVRuntimeStatus>(layout.webdavStatusPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Writes mount freshness/session status.
 */
export async function writeMountFreshnessStatus(
  layout: ActiveFSMountLayout,
  status: Omit<MountFreshnessStatus, "updatedAt"> & { updatedAt?: string }
): Promise<MountFreshnessStatus> {
  const normalized: MountFreshnessStatus = {
    ...status,
    updatedAt: status.updatedAt ?? new Date().toISOString()
  };
  await writePrivateJson(layout.freshnessStatusPath, normalized);
  return normalized;
}

/**
 * Reads mount freshness/session status.
 *
 * @returns Status, or `undefined` when no status file exists.
 */
export async function readMountFreshnessStatus(
  layout: ActiveFSMountLayout
): Promise<MountFreshnessStatus | undefined> {
  try {
    return await readJsonFile<MountFreshnessStatus>(layout.freshnessStatusPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Marks the freshness watcher stopped and requests process termination when a
 * recorded pid is still running.
 */
export async function stopMountFreshnessRuntime(
  layout: ActiveFSMountLayout,
  options: ManagedWebDAVRuntimeOptions = {}
): Promise<MountFreshnessStatus> {
  const previous = await readMountFreshnessStatus(layout);
  const processExists = options.processExists ?? defaultProcessExists;
  const terminateProcess = options.terminateProcess ?? defaultTerminateProcess;
  let message = "No freshness watcher pid was recorded.";

  if (previous?.pid) {
    if (processExists(previous.pid)) {
      message = terminateProcess(previous.pid)
        ? "Freshness watcher stop requested."
        : "Freshness watcher could not be stopped.";
    } else {
      message = "Freshness watcher process is not running.";
    }
  }

  return writeMountFreshnessStatus(layout, {
    remote: previous?.remote ?? layout.remoteName,
    mode: "stopped",
    active: false,
    pid: previous?.pid,
    sources: previous?.sources,
    message
  });
}

/**
 * Probes and persists the managed WebDAV runtime status for a layout.
 */
export async function checkWebDAVRuntimeStatus(
  layout: ActiveFSMountLayout,
  remote?: ActiveFSMountRemote,
  options: Pick<RcloneMountStatusOptions, "fetch" | "timeoutMs"> = {}
): Promise<WebDAVRuntimeStatus | undefined> {
  return checkAndPersistWebDAVStatus(layout, remote, options);
}

/**
 * Probes a WebDAV endpoint with an OPTIONS request.
 *
 * @returns Reachability, capabilities, auth summary, and diagnostics.
 */
export async function checkWebDAVEndpoint(
  remote: ActiveFSMountRemote,
  options: Pick<RcloneMountStatusOptions, "fetch" | "timeoutMs"> = {}
): Promise<WebDAVEndpointCheck> {
  const target = remote;
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  const checkedAt = new Date().toISOString();
  try {
    const headers: Record<string, string> = {};
    const authorization = basicAuthHeader(target);
    if (authorization) {
      headers.Authorization = authorization;
    }
    const response = await fetcher(target.url, {
      method: "OPTIONS",
      headers,
      signal: controller.signal
    });
    const reachable = response.status >= 200 && response.status < 500;
    return {
      protocol: "webdav",
      endpoint: target.url,
      reachable,
      checkedAt,
      statusCode: response.status,
      capabilities: {
        options: true,
        dav: response.headers.get("dav") ?? undefined,
        allow: response.headers.get("allow") ?? undefined
      },
      auth: credentialSummary(target),
      diagnostics: reachable ? undefined : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      protocol: "webdav",
      endpoint: target.url,
      reachable: false,
      checkedAt,
      capabilities: {
        options: false
      },
      auth: credentialSummary(target),
      diagnostics: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkAndPersistWebDAVStatus(
  layout: ActiveFSMountLayout,
  remote?: ActiveFSMountRemote,
  options: Pick<RcloneMountStatusOptions, "fetch" | "timeoutMs"> = {}
): Promise<WebDAVRuntimeStatus | undefined> {
  const previous = await readWebDAVRuntimeStatus(layout);
  const target = await webDAVStatusTarget(layout, remote, previous);

  if (!target?.url) {
    return previous;
  }

  const health = await checkWebDAVReachability(target, options);
  return writeWebDAVRuntimeStatus(layout, {
    remote: target.name,
    state: health.reachable ? "up" : "down",
    url: target.url,
    pid: previous?.pid,
    reachable: health.reachable,
    auth: credentialSummary(target),
    error: health.error
  });
}

async function webDAVStatusTarget(
  layout: ActiveFSMountLayout,
  remote: ActiveFSMountRemote | undefined,
  previous: WebDAVRuntimeStatus | undefined
): Promise<ActiveFSMountRemote | undefined> {
  const dynamicManagedWebDAV = remote?.managedWebDAV?.enabled && (remote.managedWebDAV.port ?? 0) === 0;
  if (remote && (!dynamicManagedWebDAV || !previous?.url || previous.url.endsWith(":0/"))) {
    return hydrateRemoteCredentials(layout, remote);
  }
  if (remote && previous?.url) {
    return hydrateRemoteCredentials(layout, {
      ...remote,
      url: previous.url
    });
  }
  if (previous?.url) {
    return hydrateRemoteCredentials(layout, {
      name: layout.remoteName,
      url: previous.url,
      username: previous.auth?.username,
      hasCredentials: previous.auth?.hasPassword
    });
  }
  return undefined;
}

async function checkWebDAVReachability(
  remote: ActiveFSMountRemote,
  options: Pick<RcloneMountStatusOptions, "fetch" | "timeoutMs">
): Promise<{ reachable: boolean; error?: string }> {
  const fetcher = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1500);
  try {
    const headers: Record<string, string> = {};
    const authorization = basicAuthHeader(remote);
    if (authorization) {
      headers.Authorization = authorization;
    }
    const response = await fetcher(remote.url, {
      method: "OPTIONS",
      headers,
      signal: controller.signal
    });
    return {
      reachable: response.status >= 200 && response.status < 500,
      error: response.status >= 500 ? `HTTP ${response.status}` : undefined
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function basicAuthHeader(remote: ActiveFSMountRemote): string | undefined {
  if (!remote.username || !remote.password) {
    return undefined;
  }
  return `Basic ${Buffer.from(`${remote.username}:${remote.password}`).toString("base64")}`;
}

async function prepareRcloneRc(
  layout: ActiveFSMountLayout,
  requestedAddr: string | undefined
): Promise<RcloneRcCredentials> {
  const credentials = {
    addr: requestedAddr ?? `127.0.0.1:${await allocateLoopbackPort()}`,
    username: "activefs-rc",
    password: randomUUID()
  };
  await writePrivateJson(layout.rcloneRcCredentialsPath, {
    ...credentials,
    updatedAt: new Date().toISOString()
  });
  return credentials;
}

async function readRcloneRcCredentials(layout: ActiveFSMountLayout): Promise<RcloneRcCredentials | undefined> {
  try {
    const parsed = await readJsonFile<{ addr?: unknown; username?: unknown; password?: unknown }>(
      layout.rcloneRcCredentialsPath
    );
    const addr = stringValue(parsed.addr);
    const username = stringValue(parsed.username);
    const password = stringValue(parsed.password);
    return addr && username && password
      ? { addr, username, password }
      : undefined;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function redactRcloneRcCredentials(credentials: RcloneRcCredentials): RcloneRcStatus {
  return {
    addr: credentials.addr,
    username: credentials.username,
    hasPassword: true
  };
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a loopback port for rclone RC.");
  }
  return address.port;
}

function deriveMountState(
  storedState: RcloneMountState | undefined,
  mounted: boolean,
  webdav: WebDAVRuntimeStatus | undefined
): RcloneMountState {
  if (storedState === "failed" && !mounted) {
    return "failed";
  }
  if (mounted && webdav?.state === "down") {
    return "webdav-down";
  }
  if (mounted) {
    return "mounted";
  }
  if (storedState === "mounted" || storedState === "mounting") {
    return webdav?.state === "down" ? "webdav-down" : "rclone-down";
  }
  if (storedState === "stale") {
    return "stale";
  }
  if (storedState === "configured") {
    return "configured";
  }
  return storedState ?? "unmounted";
}

function rcloneRefreshDir(path: ActiveFSPath): string {
  return path === "/" ? "" : path.slice(1);
}

async function directoryStats(path: string): Promise<DirectoryStats> {
  const current = await stat(path).catch(() => null);
  if (!current) {
    return { path, fileCount: 0, byteSize: 0 };
  }
  if (!current.isDirectory()) {
    return { path, fileCount: 1, byteSize: current.size };
  }

  let fileCount = 0;
  let byteSize = 0;
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    if (entry.isDirectory()) {
      const child = await directoryStats(childPath);
      fileCount += child.fileCount;
      byteSize += child.byteSize;
      continue;
    }
    if (entry.isFile()) {
      const child = await stat(childPath).catch(() => null);
      if (child) {
        fileCount += 1;
        byteSize += child.size;
      }
    }
  }
  return { path, fileCount, byteSize };
}

async function tailText(path: string, maxLines = 80): Promise<string> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .join("\n");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${path.split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function obscureRclonePassword(
  password: string,
  options: { rcloneBinary?: string; commandRunner?: MountCommandRunner }
): string {
  const command = detectRcloneBinary(options);
  if (!command) {
    throw new Error("rclone is required to obscure WebDAV passwords.");
  }
  const result = (options.commandRunner ?? defaultCommandRunner)(command, ["obscure", password]);
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "rclone obscure failed.");
  }
  return result.stdout.trim();
}

async function writeMountStatus(
  layout: ActiveFSMountLayout,
  status: Partial<RcloneMountStatus>
): Promise<RcloneMountStatus> {
  await mkdir(layout.runtimeDir, { recursive: true });
  const normalized = normalizeMountStatus(layout, status);
  await writeFile(layout.mountStatusPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function normalizeMountStatus(
  layout: ActiveFSMountLayout,
  status: Partial<RcloneMountStatus>
): RcloneMountStatus {
  return {
    remote: status.remote ?? layout.remoteName,
    state: status.state ?? "unmounted",
    rootDir: layout.rootDir,
    vfsDir: layout.vfsDir,
    configPath: layout.rcloneConfigPath,
    logFile: layout.rcloneLogPath,
    rcloneBinary: status.rcloneBinary,
    pid: status.pid,
    mounted: status.mounted ?? false,
    updatedAt: new Date().toISOString(),
    webdav: status.webdav,
    freshness: status.freshness,
    rc: status.rc,
    staleReason: status.staleReason,
    lastRefresh: status.lastRefresh,
    message: status.message,
    error: status.error
  };
}

function isMountActive(
  mountPoint: string,
  options: { commandRunner: MountCommandRunner; platform: NodeJS.Platform }
): boolean {
  if (options.platform === "win32") {
    const result = options.commandRunner("mountvol", [mountPoint, "/L"]);
    return result.status === 0;
  }

  const result = options.commandRunner("mount", []);
  if (result.status !== 0) {
    return false;
  }
  const aliases = mountPointAliases(mountPoint, options.platform);
  return result.stdout
    .split(/\r?\n/)
    .some((line) =>
      aliases.some((candidate) => line.includes(` on ${candidate} `) || line.includes(` ${candidate} `))
    );
}

function mountPointAliases(mountPoint: string, platform: NodeJS.Platform): string[] {
  const aliases = new Set([resolve(mountPoint)]);
  if (platform === "darwin") {
    for (const candidate of [...aliases]) {
      if (candidate === "/tmp" || candidate.startsWith("/tmp/")) {
        aliases.add(`/private${candidate}`);
      }
      if (candidate === "/var" || candidate.startsWith("/var/")) {
        aliases.add(`/private${candidate}`);
      }
      if (candidate === "/private/tmp" || candidate.startsWith("/private/tmp/")) {
        aliases.add(candidate.replace(/^\/private\/tmp(?=\/|$)/, "/tmp"));
      }
      if (candidate === "/private/var" || candidate.startsWith("/private/var/")) {
        aliases.add(candidate.replace(/^\/private\/var(?=\/|$)/, "/var"));
      }
    }
  }
  return [...aliases];
}

function defaultMountProcessSpawner(
  command: string,
  args: string[],
  options: { detached?: boolean; stdio: "ignore" | "inherit" }
): RcloneMountChild {
  return spawn(command, args, options);
}

async function waitForMountActive(
  mountPoint: string,
  childState: RcloneMountChildState,
  timeoutMs: number,
  options: { commandRunner: MountCommandRunner; platform: NodeJS.Platform }
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (childState.error || childState.exited) {
      return false;
    }
    if (isMountActive(mountPoint, {
      commandRunner: options.commandRunner,
      platform: options.platform
    })) {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  return isMountActive(mountPoint, {
    commandRunner: options.commandRunner,
    platform: options.platform
  });
}

function unmountCommands(
  mountPoint: string,
  platform: NodeJS.Platform,
  status?: RcloneMountStatus
): Array<[string, string[]]> {
  if (platform === "darwin") {
    return mountPointAliases(mountPoint, platform).flatMap((candidate) => [
      ["umount", [candidate]] as [string, string[]],
      ["diskutil", ["unmount", candidate]] as [string, string[]]
    ]);
  }
  if (platform === "linux") {
    return [
      ["fusermount3", ["-u", mountPoint]],
      ["fusermount", ["-u", mountPoint]],
      ["umount", [mountPoint]]
    ];
  }
  if (platform === "win32") {
    return status?.pid
      ? [["taskkill", ["/PID", String(status.pid), "/T", "/F"]]]
      : [["mountvol", [mountPoint, "/D"]]];
  }
  return [["umount", [mountPoint]]];
}

function collectActiveMountEvidence(
  platform: NodeJS.Platform,
  commandRunner: MountCommandRunner
): ActiveMountEvidence {
  const command = platform === "win32" ? "mountvol" : "mount";
  const result = commandRunner(command, []);
  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /activefs|rclone/i.test(line));

  return {
    command,
    status: result.status,
    lines,
    error: result.error?.message
  };
}

function prerequisitesForBackend(backend: RcloneMountBackend): string[] {
  if (backend === "macfuse") {
    return [
      "rclone is installed and visible on PATH",
      "macFUSE 5.x or newer is installed",
      "the current user can mount macFUSE filesystems"
    ];
  }
  if (backend === "linux-fuse") {
    return [
      "rclone is installed and visible on PATH",
      "/dev/fuse is available",
      "fusermount3 or fusermount is installed",
      "containerized runs pass through /dev/fuse and required capabilities"
    ];
  }
  if (backend === "winfsp") {
    return [
      "rclone is installed and visible on PATH",
      "WinFsp is installed",
      "the mount runs in a user session that can create WinFsp mounts"
    ];
  }
  if (backend === "freebsd-fuse") {
    return [
      "rclone is installed and visible on PATH",
      "fusefs support is installed and loaded",
      "mount_fusefs is available"
    ];
  }
  return [
    "rclone is installed and visible on PATH",
    "a platform-specific rclone mount backend is available"
  ];
}

function notesForBackend(backend: RcloneMountBackend): string[] {
  if (backend === "macfuse") {
    return [
      "Use doctor output to capture the macFUSE bundle version before mount tests.",
      "If macOS prompts for system extension approval, approve macFUSE and rerun the doctor check."
    ];
  }
  if (backend === "linux-fuse") {
    return [
      "A green repo test does not prove the host FUSE device is present.",
      "Container smoke tests must explicitly pass through /dev/fuse."
    ];
  }
  if (backend === "winfsp") {
    return [
      "Use a normal desktop/user session for manual WinFsp validation.",
      "If mountvol cannot see the mount, collect WinFsp and rclone logs with the doctor JSON output."
    ];
  }
  return [
    "Use activefs export when the host cannot satisfy the rclone mount backend prerequisites."
  ];
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function defaultTerminateProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Inspects rclone and platform FUSE dependencies for the current or supplied host.
 */
export function inspectRcloneMountHost(
  options: RcloneMountHostInspectOptions = {}
): RcloneMountHostReport {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile = options.readTextFile ?? defaultReadTextFile;
  const env = options.env ?? process.env;
  const minimumMacFuseVersion = options.minimumMacFuseVersion ?? DEFAULT_MINIMUM_MACFUSE_VERSION;
  const backend = backendForPlatform(platform);
  const dependencies: MountDependencyReport[] = [inspectRclone(commandRunner)];

  if (backend === "macfuse") {
    dependencies.push(inspectMacFuse({ fileExists, readTextFile, minimumMacFuseVersion }));
  } else if (backend === "winfsp") {
    dependencies.push(inspectWinFsp({ commandRunner, env, fileExists }));
  } else if (backend === "linux-fuse") {
    dependencies.push(inspectLinuxFuse({ commandRunner, fileExists }));
  } else if (backend === "freebsd-fuse") {
    dependencies.push(inspectFreeBsdFuse(commandRunner));
  } else {
    dependencies.push({
      name: "mount backend",
      required: true,
      status: "missing",
      message: `ActiveFS does not have an rclone mount backend policy for ${platform}.`,
      installHint: "Use activefs export or add a platform-specific mount backend."
    });
  }

  return {
    platform,
    backend,
    canAttemptMount: dependencies.every((dependency) => dependency.status === "ready"),
    dependencies
  };
}

/**
 * Formats a host mount report for CLI output.
 */
export function formatRcloneMountHostReport(report: RcloneMountHostReport): string {
  const lines = [
    `platform: ${report.platform}`,
    `rclone mount backend: ${report.backend}`,
    `can attempt mount: ${report.canAttemptMount ? "yes" : "no"}`
  ];

  for (const dependency of report.dependencies) {
    const version = dependency.version ? ` ${dependency.version}` : "";
    lines.push(`${dependency.name}: ${dependency.status}${version} - ${dependency.message}`);
    if (dependency.installHint && dependency.status !== "ready") {
      lines.push(`  fix: ${dependency.installHint}`);
    }
  }

  return lines.join("\n");
}

function backendForPlatform(platform: NodeJS.Platform): RcloneMountBackend {
  if (platform === "darwin") {
    return "macfuse";
  }
  if (platform === "win32") {
    return "winfsp";
  }
  if (platform === "linux") {
    return "linux-fuse";
  }
  if (platform === "freebsd") {
    return "freebsd-fuse";
  }
  return "unsupported";
}

function inspectRclone(commandRunner: MountCommandRunner): MountDependencyReport {
  const result = commandRunner("rclone", ["version"]);
  if (result.status !== 0) {
    return {
      name: "rclone",
      required: true,
      status: "missing",
      message: "rclone is not available on PATH.",
      installHint: "Install rclone and make sure the activefs process can find it on PATH."
    };
  }

  const version = firstNonEmptyLine(result.stdout) ?? firstNonEmptyLine(result.stderr);
  return {
    name: "rclone",
    required: true,
    status: "ready",
    version,
    message: version ? "rclone is available." : "rclone is available but did not print a version."
  };
}

function inspectMacFuse(options: {
  fileExists: (path: string) => boolean;
  readTextFile: (path: string) => string | undefined;
  minimumMacFuseVersion: string;
}): MountDependencyReport {
  const versionPath = `${MACFUSE_ROOT}/Contents/version.plist`;
  const infoPath = `${MACFUSE_ROOT}/Contents/Info.plist`;
  const helperPath = `${MACFUSE_ROOT}/Contents/Resources/mount_macfuse`;

  if (!options.fileExists(MACFUSE_ROOT) || !options.fileExists(helperPath)) {
    return {
      name: "macFUSE",
      required: true,
      status: "missing",
      message: "macFUSE is not installed.",
      installHint: "Install macFUSE 5.x or newer from https://macfuse.github.io/."
    };
  }

  const plist = options.readTextFile(versionPath) ?? options.readTextFile(infoPath);
  const version = plist ? plistValue(plist, "CFBundleShortVersionString") : undefined;
  if (!version) {
    return {
      name: "macFUSE",
      required: true,
      status: "unknown",
      message: "macFUSE is installed, but its version could not be read from the bundle plist.",
      installHint: "Reinstall the latest macFUSE package, then retry the mount preflight."
    };
  }

  if (compareVersions(version, options.minimumMacFuseVersion) < 0) {
    return {
      name: "macFUSE",
      required: true,
      status: "outdated",
      version,
      message: `macFUSE ${version} is older than the supported minimum ${options.minimumMacFuseVersion}.`,
      installHint: "Upgrade macFUSE before attempting a mounted ActiveFS view."
    };
  }

  return {
    name: "macFUSE",
    required: true,
    status: "ready",
    version,
    message: "macFUSE is installed and new enough for ActiveFS rclone mounts."
  };
}

function inspectWinFsp(options: {
  commandRunner: MountCommandRunner;
  env: Record<string, string | undefined>;
  fileExists: (path: string) => boolean;
}): MountDependencyReport {
  const candidates = [
    options.env["ProgramFiles(x86)"] ? `${options.env["ProgramFiles(x86)"]}\\WinFsp\\bin\\winfsp-x64.dll` : undefined,
    options.env.ProgramFiles ? `${options.env.ProgramFiles}\\WinFsp\\bin\\winfsp-x64.dll` : undefined,
    options.env.ProgramW6432 ? `${options.env.ProgramW6432}\\WinFsp\\bin\\winfsp-x64.dll` : undefined
  ].filter((path): path is string => Boolean(path));

  if (candidates.some((path) => options.fileExists(path))) {
    return {
      name: "WinFsp",
      required: true,
      status: "ready",
      message: "WinFsp is installed."
    };
  }

  const where = options.commandRunner("where", ["winfsp-x64.dll"]);
  if (where.status === 0) {
    return {
      name: "WinFsp",
      required: true,
      status: "ready",
      message: "WinFsp was found on PATH."
    };
  }

  return {
    name: "WinFsp",
    required: true,
    status: "missing",
    message: "WinFsp is required for rclone mounts on Windows.",
    installHint: "Install WinFsp, or use activefs export until a native Windows adapter is available."
  };
}

function inspectLinuxFuse(options: {
  commandRunner: MountCommandRunner;
  fileExists: (path: string) => boolean;
}): MountDependencyReport {
  if (!options.fileExists("/dev/fuse")) {
    return {
      name: "FUSE",
      required: true,
      status: "missing",
      message: "/dev/fuse is not available.",
      installHint: "Install/enable FUSE support. In containers, pass through /dev/fuse and required capabilities."
    };
  }

  const fusermount3 = options.commandRunner("fusermount3", ["--version"]);
  const fusermount = fusermount3.status === 0 ? fusermount3 : options.commandRunner("fusermount", ["--version"]);
  const version = firstNonEmptyLine(fusermount.stdout) ?? firstNonEmptyLine(fusermount.stderr);

  return {
    name: "FUSE",
    required: true,
    status: "ready",
    version,
    message: version ? "FUSE device and mount helper are available." : "FUSE device is available."
  };
}

function inspectFreeBsdFuse(commandRunner: MountCommandRunner): MountDependencyReport {
  const result = commandRunner("mount_fusefs", ["--help"]);
  if (result.status === 0 || result.status === 1) {
    return {
      name: "FUSE",
      required: true,
      status: "ready",
      message: "FreeBSD fusefs mount helper is available."
    };
  }

  return {
    name: "FUSE",
    required: true,
    status: "missing",
    message: "FreeBSD fusefs mount helper is not available.",
    installHint: "Install and load fusefs support before attempting an ActiveFS rclone mount."
  };
}

function defaultCommandRunner(command: string, args: string[]): MountCommandResult {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function defaultReadTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function plistValue(plist: string, key: string): string | undefined {
  const pattern = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]+)</string>`);
  return pattern.exec(plist)?.[1];
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  return 0;
}

function parseVersion(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function handlePropfind<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: IncomingMessage,
  response: ServerResponse,
  path: ActiveFSPath
): Promise<void> {
  const depth = request.headers.depth ?? "infinity";
  if (Array.isArray(depth)) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Multiple Depth headers are not supported.");
    return;
  }

  const stat = await adapter.filesystem.stat(context, path);
  if (!stat) {
    response.writeHead(404);
    response.end();
    return;
  }

  const entries: ActiveFSStat<Meta>[] = [stat];
  if (stat.kind === "directory" && depth !== "0") {
    const children = await adapter.filesystem.list(context, path);
    if (depth === "1") {
      entries.push(...children.map((entry) => entryToStat(entry)));
    } else {
      entries.push(...await collectRecursive(adapter, context, children));
    }
  }

  const body = renderMultiStatus(entries, adapter.rootPath);
  response.writeHead(207, {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function handleRead<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: IncomingMessage,
  response: ServerResponse,
  path: ActiveFSPath,
  headOnly: boolean,
  readCache: WebDAVReadCache | undefined
): Promise<void> {
  const stat = await adapter.filesystem.stat(context, path);
  if (!stat) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (stat.kind !== "file") {
    response.writeHead(405, {
      Allow: READ_ALLOW,
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("Path is not a file.");
    return;
  }

  const etag = etagForStat(stat);
  const headers: Record<string, string | number> = {
    "Content-Type": stat.mimeType ?? "application/octet-stream",
    ETag: etag,
    "Last-Modified": httpDate(stat.mtimeMs)
  };
  if (stat.size !== undefined) {
    headers["Accept-Ranges"] = "bytes";
  }

  if (headOnly) {
    if (stat.size !== undefined) {
      headers["Content-Length"] = stat.size;
    }
    response.writeHead(200, headers);
    response.end();
    return;
  }

  const cacheKey = `${path}\0${etag}`;
  let cached = readCache?.entries.get(cacheKey);
  let cacheHit = false;
  if (cached) {
    verifyWebDAVCachedRead(readCache, cacheKey, path, cached);
    cacheHit = true;
  }

  const range = parseSingleByteRange(request.headers.range, stat.size);
  if (range?.unsatisfiable) {
    response.writeHead(416, {
      ...headers,
      "Content-Range": `bytes */${range.size}`
    });
    response.end();
    return;
  }

  if (range) {
    const contentType = cached?.contentType ?? stat.mimeType ?? "application/octet-stream";
    const bytes = cached
      ? cached.bytes.subarray(range.start, range.end + 1)
      : await readRange(adapter, context, path, stat, range);
    if (cached && cacheHit) {
      await reportWebDAVCacheActivity(readCache, path, cached.contentHash);
    }
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = bytes.byteLength;
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${range.size}`;
    response.writeHead(206, headers);
    response.end(bytes);
    return;
  }

  if (!cached) {
    const result = await adapter.filesystem.read(context, path);
    const content = contentBuffer(result);
    cached = {
      bytes: content,
      contentType: result.stat?.mimeType ?? stat.mimeType ?? "application/octet-stream",
      contentHash: sha256Hex(content)
    };
    setCachedRead(readCache, cacheKey, cached);
  }

  if (cacheHit) {
    await reportWebDAVCacheActivity(readCache, path, cached.contentHash);
  }
  headers["Content-Type"] = cached.contentType;
  headers["Content-Length"] = cached.bytes.byteLength;
  response.writeHead(200, headers);
  response.end(cached.bytes);
}

async function handlePut<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: IncomingMessage,
  response: ServerResponse,
  path: ActiveFSPath,
  policy: ActiveFSPolicyDocument | undefined
): Promise<void> {
  const existing = await adapter.filesystem.stat(context, path);
  const existed = Boolean(existing);
  const content = await readRequestBytes(request);
  const canUseZeroLengthTruncate =
    existing?.kind === "file" &&
    content.byteLength === 0 &&
    isPolicyAllowed(policy, "truncate", path);
  const writeAllowed = isPolicyAllowed(policy, "write", path);

  if (canUseZeroLengthTruncate && !writeAllowed && await tryHandleZeroLengthTruncate(adapter, context, response, path)) {
    return;
  }

  await assertPolicyAllowed(policy, "write", path);
  const options = writeOptionsFromHeaders(request);
  let result: ActiveFSWriteResult<Meta>;
  try {
    result = await adapter.filesystem.write(context, path, content, options);
  } catch (error) {
    if (canUseZeroLengthTruncate && isUnsupportedError(error) && await tryHandleZeroLengthTruncate(adapter, context, response, path)) {
      return;
    }
    throw error;
  }
  const headers = result.stat ? { ETag: etagForStat(result.stat) } : undefined;
  response.writeHead(existed || result.created === false ? 204 : 201, headers);
  response.end();
}

async function tryHandleZeroLengthTruncate<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  response: ServerResponse,
  path: ActiveFSPath
): Promise<boolean> {
  try {
    const result = await adapter.filesystem.truncate(context, path, { length: 0 });
    const headers = result.stat ? { ETag: etagForStat(result.stat) } : undefined;
    response.writeHead(204, headers);
    response.end();
    return true;
  } catch (error) {
    if (!isUnsupportedError(error)) {
      throw error;
    }
    return false;
  }
}

async function handleMkcol<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  response: ServerResponse,
  path: ActiveFSPath
): Promise<void> {
  const result = await adapter.filesystem.mkdir(context, path);
  const headers = result.stat ? { ETag: etagForStat(result.stat) } : undefined;
  response.writeHead(result.created === false ? 200 : 201, headers);
  response.end();
}

async function handleDelete<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  response: ServerResponse,
  path: ActiveFSPath
): Promise<void> {
  const stat = await adapter.filesystem.stat(context, path);
  if (!stat) {
    response.writeHead(404);
    response.end();
    return;
  }
  if (stat.kind === "directory") {
    await adapter.filesystem.rmdir(context, path, { recursive: true });
  } else {
    await adapter.filesystem.delete(context, path);
  }
  response.writeHead(204);
  response.end();
}

async function handleMove<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: IncomingMessage,
  response: ServerResponse,
  path: ActiveFSPath,
  destination: ActiveFSPath
): Promise<void> {
  const overwrite = overwriteFromHeader(request);
  const result = await adapter.filesystem.rename(context, path, destination, { overwrite });
  const headers = result.stat ? { ETag: etagForStat(result.stat) } : undefined;
  response.writeHead(201, headers);
  response.end();
}

async function handleCopy<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: IncomingMessage,
  response: ServerResponse,
  path: ActiveFSPath,
  destination: ActiveFSPath
): Promise<void> {
  const overwrite = overwriteFromHeader(request);
  const result = await adapter.filesystem.copy(context, path, destination, {
    overwrite,
    recursive: true
  });
  const headers = result.stat ? { ETag: etagForStat(result.stat) } : undefined;
  response.writeHead(201, headers);
  response.end();
}

async function assertPolicyAllowed(
  policy: ActiveFSPolicyDocument | undefined,
  operation: ActiveFSPolicyOperation,
  path: ActiveFSPath
): Promise<void> {
  const decision = evaluateActiveFSPolicy(policy, operation, path);
  if (!decision.allowed) {
    throw new ActiveFSError(
      "FORBIDDEN",
      decision.reason ?? `Policy denied ${operation} for ${decision.path}`,
      { path: decision.path }
    );
  }
}

function isPolicyAllowed(
  policy: ActiveFSPolicyDocument | undefined,
  operation: ActiveFSPolicyOperation,
  path: ActiveFSPath
): boolean {
  return evaluateActiveFSPolicy(policy, operation, path).allowed;
}

function isUnsupportedError(error: unknown): boolean {
  return error instanceof ActiveFSError && error.code === "UNSUPPORTED";
}

type ParsedSingleByteRange =
  | { start: number; end: number; length: number; size: number; unsatisfiable?: false }
  | { unsatisfiable: true; size: number };

function parseSingleByteRange(
  rangeHeader: string | string[] | undefined,
  size: number | undefined
): ParsedSingleByteRange | undefined {
  if (!rangeHeader || size === undefined || Array.isArray(rangeHeader)) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (match[1] === "" && match[2] === "")) {
    return { unsatisfiable: true, size };
  }

  if (size <= 0) {
    return { unsatisfiable: true, size };
  }

  if (match[1] === "") {
    const suffixLength = Number.parseInt(match[2]!, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { unsatisfiable: true, size };
    }
    const start = Math.max(size - suffixLength, 0);
    const end = size - 1;
    return { start, end, length: end - start + 1, size };
  }

  const start = Number.parseInt(match[1]!, 10);
  const explicitEnd = match[2] === "" ? size - 1 : Number.parseInt(match[2]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(explicitEnd) || start >= size || start > explicitEnd) {
    return { unsatisfiable: true, size };
  }

  const end = Math.min(explicitEnd, size - 1);
  return { start, end, length: end - start + 1, size };
}

async function readRange<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath,
  stat: ActiveFSStat<Meta>,
  range: Extract<ParsedSingleByteRange, { unsatisfiable?: false }>
): Promise<Buffer> {
  const result = await adapter.filesystem.read(context, path, {
    offset: range.start,
    length: range.length
  });
  const bytes = contentBuffer(result);
  if (bytes.byteLength === range.length) {
    return bytes;
  }
  if (stat.size !== undefined && bytes.byteLength === stat.size) {
    return bytes.subarray(range.start, range.end + 1);
  }
  return bytes.subarray(0, range.length);
}

async function collectRecursive<Auth, Meta>(
  adapter: ReadOnlyAccessAdapter<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  entries: ActiveFSDirEntry<Meta>[]
): Promise<ActiveFSStat<Meta>[]> {
  const collected: ActiveFSStat<Meta>[] = [];
  for (const entry of entries) {
    const stat = entryToStat(entry);
    collected.push(stat);
    if (entry.kind === "directory") {
      const children = await adapter.filesystem.list(context, entry.path);
      collected.push(...await collectRecursive(adapter, context, children));
    }
  }
  return collected;
}

function entryToStat<Meta>(entry: ActiveFSDirEntry<Meta>): ActiveFSStat<Meta> {
  return { ...entry };
}

async function contextForRequest<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta> | WebDAVContextProvider<Auth, Meta> | undefined,
  info: WebDAVRequestInfo
): Promise<ActiveFSContext<Auth, Meta>> {
  if (typeof context === "function") {
    return context(info);
  }
  return context ?? {};
}

function pathFromRequest(request: IncomingMessage, rootPath: ActiveFSPath): ActiveFSPath {
  const url = new URL(request.url ?? "/", "http://activefs.local");
  const requestPath = decodePathname(url.pathname);
  if (rootPath === "/") {
    return normalizeActiveFSPath(requestPath);
  }
  return normalizeActiveFSPath(`${rootPath}/${requestPath.slice(1)}`);
}

function destinationPathFromRequest(request: IncomingMessage, rootPath: ActiveFSPath): ActiveFSPath {
  const header = request.headers.destination;
  if (!header || Array.isArray(header)) {
    throw new ActiveFSError("INVALID_REQUEST", "WebDAV Destination header is required.");
  }
  const parsed = new URL(header, "http://activefs.local");
  const fakeRequest = {
    ...request,
    url: parsed.pathname
  } as IncomingMessage;
  return pathFromRequest(fakeRequest, rootPath);
}

async function readRequestBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function writeOptionsFromHeaders<Meta>(request: IncomingMessage): {
  overwrite?: boolean;
  contentType?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
} {
  return {
    overwrite: overwriteFromHeader(request),
    contentType: headerString(request.headers["content-type"]),
    ifMatch: headerString(request.headers["if-match"]),
    ifNoneMatch: headerString(request.headers["if-none-match"])
  };
}

function overwriteFromHeader(request: IncomingMessage): boolean | undefined {
  const value = headerString(request.headers.overwrite);
  if (!value) {
    return undefined;
  }
  return value.toUpperCase() !== "F";
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodePathname(pathname: string): string {
  return pathname
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
}

function renderMultiStatus<Meta>(entries: ActiveFSStat<Meta>[], rootPath: ActiveFSPath): string {
  const responses = entries.map((entry) => renderResponse(entry, rootPath)).join("");
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

function renderResponse<Meta>(entry: ActiveFSStat<Meta>, rootPath: ActiveFSPath): string {
  const collection = entry.kind === "directory" ? "<D:collection/>" : "";
  const length = entry.kind === "file" && entry.size !== undefined
    ? `<D:getcontentlength>${entry.size}</D:getcontentlength>`
    : "";
  const contentType = entry.mimeType
    ? `<D:getcontenttype>${escapeXml(entry.mimeType)}</D:getcontenttype>`
    : "";

  return [
    "<D:response>",
    `<D:href>${escapeXml(hrefForPath(entry.path, rootPath, entry.kind))}</D:href>`,
    "<D:propstat><D:prop>",
    `<D:displayname>${escapeXml(entry.name)}</D:displayname>`,
    `<D:resourcetype>${collection}</D:resourcetype>`,
    length,
    contentType,
    `<D:getlastmodified>${httpDate(entry.mtimeMs)}</D:getlastmodified>`,
    `<D:getetag>${escapeXml(etagForStat(entry))}</D:getetag>`,
    "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>",
    "</D:response>"
  ].join("");
}

function hrefForPath(path: ActiveFSPath, rootPath: ActiveFSPath, kind: "file" | "directory"): string {
  let relative: string;
  if (rootPath === "/") {
    relative = path;
  } else if (path === rootPath) {
    relative = "/";
  } else {
    relative = path.slice(rootPath.length);
  }

  const encoded = relative
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (kind === "directory" && !encoded.endsWith("/")) {
    return `${encoded}/`;
  }
  return encoded || "/";
}

function contentBuffer<Meta>(result: ActiveFSReadResult<Meta>): Buffer {
  return typeof result.content === "string"
    ? Buffer.from(result.content)
    : Buffer.from(result.content);
}

function createWebDAVReadCache(options: WebDAVReadCacheOptions = {}): WebDAVReadCache {
  return {
    entries: new Map(),
    maxEntries: options.maxEntries ?? 128,
    maxBytesPerEntry: options.maxBytesPerEntry ?? 32 * 1024 * 1024,
    onActivity: options.onActivity
  };
}

function setCachedRead(
  cache: WebDAVReadCache | undefined,
  key: string,
  value: CachedReadBytes
): void {
  if (!cache || value.bytes.byteLength > cache.maxBytesPerEntry) {
    return;
  }
  cache.entries.set(key, {
    ...value,
    contentHash: value.contentHash || sha256Hex(value.bytes)
  });
  while (cache.entries.size > cache.maxEntries) {
    const oldestKey = cache.entries.keys().next().value as string | undefined;
    if (!oldestKey) {
      return;
    }
    cache.entries.delete(oldestKey);
  }
}

function verifyWebDAVCachedRead(
  cache: WebDAVReadCache | undefined,
  key: string,
  path: ActiveFSPath,
  value: CachedReadBytes
): void {
  const actual = sha256Hex(value.bytes);
  if (actual === value.contentHash) {
    return;
  }
  cache?.entries.delete(key);
  throw new ActiveFSError("SOURCE_ERROR", `Cached WebDAV read digest mismatch: ${path}`, {
    path,
    cause: { expected: value.contentHash, actual }
  });
}

async function reportWebDAVCacheActivity(
  cache: WebDAVReadCache | undefined,
  path: ActiveFSPath,
  contentHash: string
): Promise<void> {
  await cache?.onActivity?.({
    operation: "read",
    path,
    timestamp: new Date().toISOString(),
    source: "cache",
    result: "succeeded",
    contentHash
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isAuthorized(request: IncomingMessage, auth: WebDAVAuth | false): boolean {
  if (!auth) {
    return true;
  }
  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return false;
  }
  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return decoded === `${auth.username}:${auth.password}`;
}

function writeError(response: ServerResponse, error: unknown): void {
  if (error instanceof ActiveFSError) {
    const status = statusForActiveFSError(error);
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`${error.code}: ${error.message}`);
    return;
  }

  response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(error instanceof Error ? error.message : String(error));
}

function statusForActiveFSError(error: ActiveFSError): number {
  switch (error.code) {
    case "NOT_FOUND":
    case "NOT_MOUNTED":
      return 404;
    case "NOT_DIRECTORY":
    case "NOT_FILE":
      return 405;
    case "INVALID_PATH":
    case "INVALID_REQUEST":
      return 400;
    case "UNAUTHORIZED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "UNSUPPORTED":
      return 405;
    case "SOURCE_ERROR":
      return 502;
    default:
      return 500;
  }
}

function setCommonHeaders(response: ServerResponse, serverHeader: string): void {
  response.setHeader("Server", serverHeader);
  response.setHeader("MS-Author-Via", "DAV");
  response.setHeader("DAV", "1");
}

function etagForStat<Meta>(stat: ActiveFSStat<Meta>): string {
  const metadata = statMetadata(stat);
  if (metadata.etag) {
    return normalizeEtag(metadata.etag, false);
  }
  if (metadata.contentHash) {
    return normalizeEtag(metadata.contentHash, false);
  }
  if (metadata.stateHash) {
    return normalizeEtag(metadata.stateHash, true);
  }
  if (metadata.version) {
    return normalizeEtag(metadata.version, true);
  }
  const parts = [stat.path, stat.size ?? "unknown", stat.mtimeMs ?? 0, stat.kind];
  return normalizeEtag(Buffer.from(parts.join(":")).toString("base64url"), true);
}

function statMetadata<Meta>(stat: ActiveFSStat<Meta>): {
  etag?: string;
  contentHash?: string;
  stateHash?: string;
  version?: string;
} {
  const statRecord = stat as ActiveFSStat<Meta> & {
    etag?: unknown;
    contentHash?: unknown;
    stateHash?: unknown;
    version?: unknown;
  };
  const metaRecord = stat.meta && typeof stat.meta === "object"
    ? stat.meta as {
        etag?: unknown;
        contentHash?: unknown;
        stateHash?: unknown;
        version?: unknown;
      }
    : {};

  return {
    etag: stringValue(statRecord.etag ?? metaRecord.etag),
    contentHash: stringValue(statRecord.contentHash ?? metaRecord.contentHash),
    stateHash: stringValue(statRecord.stateHash ?? metaRecord.stateHash),
    version: stringValue(statRecord.version ?? metaRecord.version)
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeEtag(value: string, weak: boolean): string {
  if (/^(W\/)?"[^"]+"$/.test(value)) {
    return value;
  }
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  return `${weak ? "W/" : ""}"${escaped}"`;
}

function httpDate(ms: number | undefined): string {
  return new Date(ms ?? 0).toUTCString();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
