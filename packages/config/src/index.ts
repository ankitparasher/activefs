import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import {
  ActiveFSError,
  normalizeActiveFSPath,
  type ActiveFSPath,
  type ActiveFSTreeCommand
} from "@activefs/core";

/**
 * Default hidden directory that stores ActiveFS workspace state.
 */
export const ACTIVEFS_STATE_DIRECTORY = ".activefs";
/**
 * Unified configuration filename stored under `.activefs/`.
 */
export const ACTIVEFS_CONFIG_FILE = "config.json";
/**
 * Current unified config schema version.
 */
export const ACTIVEFS_CONFIG_SCHEMA_VERSION = 1;
/**
 * Persisted cache trust mode for a remote.
 */
export type ActiveFSCacheMode = "off" | "realtime/coherent" | "untrusted/resyncing";
/**
 * Adapter semantics advertised for a configured remote.
 */
export type ActiveFSAdapterCapabilityProfile = "full-filesystem-semantics" | "bounded-filesystem-semantics";
/**
 * Policy for reporting cache-served activity back to a remote.
 */
export type ActiveFSActivityPolicy = "required" | "best-effort" | "off";
/**
 * Coarse access mode used by local policy helpers.
 */
export type ActiveFSPolicyAccess = "readonly" | "writable";
/**
 * Filesystem-shaped operations understood by local policy and journals.
 */
export type ActiveFSPolicyOperation =
  | "stat"
  | "list"
  | "read"
  | "search"
  | "create"
  | "write"
  | "truncate"
  | "delete"
  | "mkdir"
  | "rmdir"
  | "rename"
  | "copy"
  | "updateMetadata";

/**
 * Serializable auth provider descriptor.
 *
 * Descriptors reference environment variables, command argv, cookies, or a
 * private token file. Raw token values should not be stored in `config.json`.
 */
export type ActiveFSAuthProviderConfig =
  | { type: "none" }
  | { type: "bearer-env"; env: string; scheme?: string }
  | { type: "static-header"; header: string; env: string }
  | { type: "token-command"; argv: string[]; scheme?: string; timeoutMs?: number }
  | { type: "headers-command"; argv: string[]; timeoutMs?: number }
  | { type: "cookie-provider"; argv: string[]; timeoutMs?: number }
  | { type: "private-bearer-token"; scheme?: string };

/**
 * Path matcher used by a local policy rule.
 */
export interface ActiveFSPolicyMatcher {
  type: "exact" | "prefix" | "glob";
  path: string;
}

/**
 * Ordered local policy rule.
 *
 * First matching rule wins. Policy is a local adapter guard; the remote tree
 * still owns final authorization and mutation decisions.
 */
export interface ActiveFSPolicyRule {
  match: ActiveFSPolicyMatcher;
  access?: ActiveFSPolicyAccess;
  allow?: ActiveFSPolicyOperation[];
  deny?: ActiveFSPolicyOperation[];
  reason?: string;
}

/**
 * Local policy document persisted with remote state.
 */
export interface ActiveFSPolicyDocument {
  schemaVersion: 1;
  defaultAccess?: ActiveFSPolicyAccess;
  rules: ActiveFSPolicyRule[];
  revision?: string;
  digest?: string;
}

/**
 * Result of evaluating one operation against a local policy document.
 */
export interface ActiveFSPolicyDecision {
  allowed: boolean;
  operation: ActiveFSPolicyOperation;
  path: ActiveFSPath;
  access: ActiveFSPolicyAccess;
  ruleIndex?: number;
  reason?: string;
}

/** Safe discovery/config hints cached for local setup and offline status. */
export interface ActiveFSSourceDiscoveryHints {
  checkedAt: string;
  displayName?: string;
  suggestedMountPath?: ActiveFSPath;
  capabilities?: {
    statable: boolean;
    listable: boolean;
    readable: boolean;
    writable: boolean;
    searchable: boolean;
    watchable: boolean;
    rangeReadable: boolean;
    commands: ActiveFSTreeCommand[];
  };
  cache?: {
    contentTtlMs?: number;
    directoryTtlMs?: number;
  };
  auth?: {
    required?: boolean;
    schemes?: string[];
    message?: string;
  };
  revisions?: {
    config?: string;
    policy?: string;
  };
}

/**
 * Persisted configuration for one ActiveFS remote.
 *
 * Auth descriptors, local policy, cache mode, and activity policy are stored as
 * metadata. Credentials that are sensitive belong in private per-remote secret
 * files or external providers.
 */
export interface ActiveFSRemoteConfig {
  name: string;
  url: string;
  insecureHttp?: {
    allowed: true;
    devOnly: true;
    loopback: boolean;
    reason: "loopback-development" | "allow-insecure-http";
  };
  mountPath?: ActiveFSPath;
  mountpoint?: string;
  remoteRoot?: ActiveFSPath;
  vendor?: string;
  username?: string;
  hasCredentials?: boolean;
  managedWebDAV?: {
    enabled: boolean;
    host?: string;
    port?: number;
  };
  auth?: ActiveFSAuthProviderConfig;
  policy?: ActiveFSPolicyDocument;
  adapterCapabilityProfile?: ActiveFSAdapterCapabilityProfile;
  cacheMode?: ActiveFSCacheMode;
  activityPolicy?: ActiveFSActivityPolicy;
  watchable?: boolean;
  sourceHints?: ActiveFSSourceDiscoveryHints;
}

/**
 * Persisted lifecycle state for a mutation journal entry.
 */
export type ActiveFSOperationJournalStatus =
  | "pending"
  | "committed"
  | "rejected"
  | "conflict"
  | "transient"
  | "unsupported"
  | "unknown";

/**
 * Durable record for an in-flight, committed, rejected, or ambiguous mutation.
 */
export interface ActiveFSOperationJournalRecord {
  schemaVersion: 1;
  operationId: string;
  /** Concrete status URL returned by the remote mutation response. */
  operationStatusEndpoint?: string;
  remoteName: string;
  operation: ActiveFSPolicyOperation;
  path: ActiveFSPath;
  targetPath?: ActiveFSPath;
  status: ActiveFSOperationJournalStatus;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  idempotencyKey?: string;
  lastFailureReason?: string;
  result?: unknown;
}

/**
 * Durable cache-activity record queued when activity reporting cannot complete.
 */
export interface ActiveFSActivityBacklogRecord {
  schemaVersion: 1;
  activityId: string;
  remoteName: string;
  policy: ActiveFSActivityPolicy;
  sessionId?: string;
  operation: string;
  path: ActiveFSPath;
  timestamp: string;
  source: "cache" | "server" | "local";
  result: "succeeded" | "failed" | "unknown";
  revision?: string;
  attempts: number;
  lastError?: string;
  payload?: unknown;
}

/**
 * Durable Source API session and cache-coherence state for a remote.
 */
export interface ActiveFSSessionStateRecord {
  schemaVersion: 1;
  remoteName: string;
  state: "none" | "coherent" | "untrusted" | "resync-required" | "revoked" | "failed" | "stopped";
  sessionId?: string;
  mode?: "session" | "watch" | "poll";
  lastEventId?: string;
  lastEventSequence?: number;
  lastAckSequence?: number;
  cacheMode: ActiveFSCacheMode;
  activityPolicy: ActiveFSActivityPolicy;
  lastFailureReason?: string;
  lastResyncAt?: string;
  updatedAt: string;
}

/**
 * Reverse mapping from visible mountpoint to hidden ActiveFS state.
 */
export interface ActiveFSMountpointAssociation {
  remote: string;
  stateRoot: string;
  mountpoint: string;
}

/**
 * Unified ActiveFS workspace configuration.
 */
export interface ActiveFSConfig {
  schemaVersion: 1;
  stateRoot?: string;
  remotes: Record<string, ActiveFSRemoteConfig>;
  mountpoints?: Record<string, ActiveFSMountpointAssociation>;
}

/**
 * Resolved filesystem paths for a workspace state root.
 */
export interface ActiveFSStatePaths {
  stateRoot: string;
  stateDir: string;
  configPath: string;
}

/**
 * Resolved per-remote hidden-state layout.
 */
export interface ActiveFSRemoteStateLayout extends ActiveFSStatePaths {
  remoteName: string;
  remoteDir: string;
  metadataPath: string;
  policyPath: string;
  runtimeDir: string;
  sessionPath: string;
  cacheDir: string;
  journalDir: string;
  activityDir: string;
  authSecretPath: string;
}

/**
 * Resolves a user-provided root or `.activefs` path into canonical state paths.
 *
 * @param input Workspace root or the `.activefs` directory itself.
 * @returns State root, state directory, and config file path.
 */
export function resolveActiveFSState(input = "."): ActiveFSStatePaths {
  const resolved = resolve(input);
  const stateDir = basename(resolved) === ACTIVEFS_STATE_DIRECTORY
    ? resolved
    : join(resolved, ACTIVEFS_STATE_DIRECTORY);
  const stateRoot = basename(resolved) === ACTIVEFS_STATE_DIRECTORY
    ? dirname(resolved)
    : resolved;
  return {
    stateRoot,
    stateDir,
    configPath: join(stateDir, ACTIVEFS_CONFIG_FILE)
  };
}

/**
 * Walks upward from a path until an ActiveFS state directory is found.
 *
 * @returns Resolved state paths, or `null` when no state root exists.
 */
export async function discoverActiveFSState(startPath = "."): Promise<ActiveFSStatePaths | null> {
  let current = resolve(startPath);
  while (true) {
    const candidate = resolveActiveFSState(current);
    if (await fileExists(candidate.configPath) || await fileExists(candidate.stateDir)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Loads unified config from `.activefs/config.json`.
 *
 * @throws Filesystem or JSON parse errors for unreadable/corrupt config.
 */
export async function loadActiveFSConfig(input = ".activefs"): Promise<ActiveFSConfig> {
  const state = resolveActiveFSState(input);
  const existing = await readJsonFile<ActiveFSConfig>(state.configPath).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (existing) {
    return normalizeConfig(existing, state.stateRoot);
  }
  return {
    schemaVersion: 1,
    stateRoot: state.stateRoot,
    remotes: {}
  };
}

/**
 * Normalizes and writes `.activefs/config.json`.
 *
 * @returns The normalized config that was persisted.
 * @throws Filesystem errors when the state directory or config file cannot be written.
 */
export async function saveActiveFSConfig(
  input: string,
  config: ActiveFSConfig
): Promise<ActiveFSConfig> {
  const state = resolveActiveFSState(input);
  const normalized = normalizeConfig(config, state.stateRoot);
  await mkdir(state.stateDir, { recursive: true });
  await writeFile(state.configPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

/**
 * Inserts or replaces a remote and records mountpoint ownership when present.
 *
 * @returns The updated normalized config.
 */
export async function upsertActiveFSRemote(
  input: string,
  remote: ActiveFSRemoteConfig
): Promise<ActiveFSConfig> {
  const state = resolveActiveFSState(input);
  const config = await loadActiveFSConfig(input);
  const normalized = normalizeRemote(remote);
  config.remotes[normalized.name] = normalized;
  if (normalized.mountpoint) {
    config.mountpoints ??= {};
    const mountpoint = resolve(normalized.mountpoint);
    config.mountpoints[mountpoint] = {
      remote: normalized.name,
      stateRoot: state.stateRoot,
      mountpoint
    };
  }
  return saveActiveFSConfig(input, config);
}

/**
 * Removes a remote and any mountpoint associations that reference it.
 *
 * @returns Whether a remote was removed plus the updated config.
 */
export async function removeActiveFSRemoteConfig(
  input: string,
  remoteName: string
): Promise<{ removed: boolean; config: ActiveFSConfig }> {
  const config = await loadActiveFSConfig(input);
  const removed = Boolean(config.remotes[remoteName]);
  delete config.remotes[remoteName];
  if (config.mountpoints) {
    for (const [mountpoint, association] of Object.entries(config.mountpoints)) {
      if (association.remote === remoteName) {
        delete config.mountpoints[mountpoint];
      }
    }
  }
  return { removed, config: await saveActiveFSConfig(input, config) };
}

/**
 * Builds the hidden-state path layout for one remote.
 *
 * @throws Error when the remote name is not filesystem-safe.
 */
export function createActiveFSRemoteStateLayout(
  input: string,
  remoteName: string
): ActiveFSRemoteStateLayout {
  validateRemoteName(remoteName);
  const state = resolveActiveFSState(input);
  const remoteDir = join(state.stateDir, "remotes", remoteName);
  const runtimeDir = join(remoteDir, "runtime");
  return {
    ...state,
    remoteName,
    remoteDir,
    metadataPath: join(remoteDir, "metadata.json"),
    policyPath: join(remoteDir, "policy.json"),
    runtimeDir,
    sessionPath: join(runtimeDir, "session.json"),
    cacheDir: join(remoteDir, "cache"),
    journalDir: join(remoteDir, "journal"),
    activityDir: join(remoteDir, "activity"),
    authSecretPath: join(remoteDir, "auth-secret.json")
  };
}

/**
 * Creates the per-remote hidden-state directories used by cache, runtime,
 * journal, activity, policy, and metadata files.
 */
export async function ensureActiveFSRemoteStateLayout(
  layout: ActiveFSRemoteStateLayout
): Promise<void> {
  await Promise.all([
    mkdir(layout.remoteDir, { recursive: true }),
    mkdir(layout.runtimeDir, { recursive: true }),
    mkdir(layout.cacheDir, { recursive: true }),
    mkdir(layout.journalDir, { recursive: true }),
    mkdir(layout.activityDir, { recursive: true })
  ]);
}

/**
 * Evaluates a local policy document for a filesystem-shaped operation.
 *
 * @remarks Missing policy defaults to readonly. This helper does not replace
 * remote authorization; trees remain authoritative.
 */
export function evaluateActiveFSPolicy(
  policy: ActiveFSPolicyDocument | undefined,
  operation: ActiveFSPolicyOperation,
  path: string
): ActiveFSPolicyDecision {
  const normalizedPath = normalizePolicyPath(path);
  const defaultAccess = policy?.defaultAccess ?? "readonly";
  const defaultAllowed = accessAllowsOperation(defaultAccess, operation);
  if (!policy) {
    return {
      allowed: defaultAllowed,
      operation,
      path: normalizedPath,
      access: defaultAccess,
      reason: defaultAllowed ? undefined : "No policy is configured; default is readonly."
    };
  }

  for (let index = 0; index < policy.rules.length; index += 1) {
    const rule = policy.rules[index]!;
    if (!matcherMatches(rule.match, normalizedPath)) {
      continue;
    }
    const access = rule.access ?? defaultAccess;
    const denied = rule.deny?.includes(operation) ?? false;
    const explicitlyAllowed = rule.allow ? rule.allow.includes(operation) : accessAllowsOperation(access, operation);
    return {
      allowed: !denied && explicitlyAllowed,
      operation,
      path: normalizedPath,
      access,
      ruleIndex: index,
      reason: rule.reason
    };
  }

  return {
    allowed: defaultAllowed,
    operation,
    path: normalizedPath,
    access: defaultAccess,
    reason: defaultAllowed ? undefined : "No policy rule matched; default is readonly."
  };
}

/**
 * Normalizes a policy path while rejecting inputs that cannot safely round-trip
 * through policy matchers.
 *
 * @throws `ActiveFSError` when the path contains NUL bytes or backslashes.
 */
export function normalizePolicyPath(path: string): ActiveFSPath {
  if (path.includes("\0")) {
    throw new ActiveFSError("INVALID_PATH", "Policy path must not contain NUL bytes");
  }
  if (path.includes("\\")) {
    throw new ActiveFSError("INVALID_PATH", "Policy path must use / separators");
  }
  return normalizeActiveFSPath(path);
}

/**
 * Parses a credential command descriptor into argv without shell expansion.
 *
 * @throws Error for empty commands or invalid JSON argv arrays.
 */
export function parseCommandArgv(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string") && parsed.length > 0) {
      return parsed;
    }
    throw new Error("Command JSON must be a non-empty string array.");
  }
  const argv = trimmed.split(/\s+/).filter(Boolean);
  if (argv.length === 0) {
    throw new Error("Credential command must not be empty.");
  }
  return argv;
}

/**
 * Resolves an auth provider into HTTP headers for one request.
 *
 * @returns Header object with credentials only when the provider can resolve
 * them.
 * @throws Credential command, JSON parse, and filesystem errors from the
 * selected provider.
 */
export async function authHeadersFromProvider(
  provider: ActiveFSAuthProviderConfig | undefined,
  options: {
    env?: Record<string, string | undefined>;
    layout?: ActiveFSRemoteStateLayout;
    runCommand?: (argv: string[], timeoutMs: number, maxBytes: number) => Promise<string>;
  } = {}
): Promise<Record<string, string>> {
  if (!provider || provider.type === "none") {
    return {};
  }
  const env = options.env ?? process.env;
  if (provider.type === "bearer-env") {
    const token = env[provider.env];
    return token ? { authorization: `${provider.scheme ?? "Bearer"} ${token}` } : {};
  }
  if (provider.type === "static-header") {
    const value = env[provider.env];
    return value ? { [provider.header]: value } : {};
  }
  if (provider.type === "private-bearer-token") {
    if (!options.layout) {
      return {};
    }
    const secret = await readJsonFile<{ token?: string }>(options.layout.authSecretPath).catch(() => undefined);
    return secret?.token ? { authorization: `${provider.scheme ?? "Bearer"} ${secret.token}` } : {};
  }
  if (provider.type === "token-command") {
    const token = await runCredentialCommand(provider.argv, provider.timeoutMs, options.runCommand);
    return token ? { authorization: `${provider.scheme ?? "Bearer"} ${token}` } : {};
  }
  if (provider.type === "headers-command") {
    const output = await runCredentialCommand(provider.argv, provider.timeoutMs, options.runCommand);
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      throw new Error("headers-command must print a JSON object.");
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
  }
  if (provider.type === "cookie-provider") {
    const cookie = await runCredentialCommand(provider.argv, provider.timeoutMs, options.runCommand);
    return cookie ? { cookie } : {};
  }
  return {};
}

/**
 * Writes a private bearer token into the per-remote secret file.
 *
 * @remarks The file is written through a private temp file and rename path with
 * restrictive permissions.
 */
export async function writePrivateBearerToken(
  layout: ActiveFSRemoteStateLayout,
  token: string
): Promise<void> {
  await writePrivateJson(layout.authSecretPath, {
    token,
    updatedAt: new Date().toISOString()
  });
}

/**
 * Removes the per-remote private auth secret file when present.
 */
export async function clearPrivateAuthSecret(layout: ActiveFSRemoteStateLayout): Promise<void> {
  await rm(layout.authSecretPath, { force: true });
}

function normalizeConfig(config: Partial<ActiveFSConfig>, stateRoot: string): ActiveFSConfig {
  if (config.schemaVersion !== 1 && config.schemaVersion !== undefined) {
    throw new Error(`Unsupported ActiveFS config schemaVersion: ${config.schemaVersion}`);
  }
  return {
    schemaVersion: 1,
    stateRoot: config.stateRoot ?? stateRoot,
    remotes: Object.fromEntries(
      Object.values(config.remotes ?? {}).map((remote) => {
        const normalized = normalizeRemote(remote);
        return [normalized.name, normalized];
      })
    ),
    mountpoints: config.mountpoints
  };
}

function normalizeRemote(remote: ActiveFSRemoteConfig): ActiveFSRemoteConfig {
  validateRemoteName(remote.name);
  const { protocol: _discardedProtocol, ...currentRemote } = remote as ActiveFSRemoteConfig & { protocol?: unknown };
  return {
    ...currentRemote,
    mountPath: currentRemote.mountPath ? normalizeActiveFSPath(currentRemote.mountPath) : undefined,
    remoteRoot: currentRemote.remoteRoot ? normalizeActiveFSPath(currentRemote.remoteRoot) : undefined,
    sourceHints: currentRemote.sourceHints ? {
      ...currentRemote.sourceHints,
      suggestedMountPath: currentRemote.sourceHints.suggestedMountPath
        ? normalizeActiveFSPath(currentRemote.sourceHints.suggestedMountPath)
        : undefined
    } : undefined,
    cacheMode: currentRemote.cacheMode ?? "off",
    activityPolicy: currentRemote.activityPolicy ?? "best-effort",
    adapterCapabilityProfile: currentRemote.adapterCapabilityProfile ?? "full-filesystem-semantics"
  };
}

/**
 * Records a mutation in the per-remote operation journal.
 *
 * @returns The normalized record that was written.
 */
export async function recordActiveFSOperationJournal(
  layout: ActiveFSRemoteStateLayout,
  record: Omit<ActiveFSOperationJournalRecord, "schemaVersion" | "remoteName" | "updatedAt"> & {
    updatedAt?: string;
  }
): Promise<ActiveFSOperationJournalRecord> {
  const now = new Date().toISOString();
  const normalized: ActiveFSOperationJournalRecord = {
    schemaVersion: 1,
    remoteName: layout.remoteName,
    ...record,
    path: normalizeActiveFSPath(record.path),
    targetPath: record.targetPath ? normalizeActiveFSPath(record.targetPath) : undefined,
    updatedAt: record.updatedAt ?? now
  };
  await writePrivateJson(join(layout.journalDir, `${stateRecordFileSegment(record.operationId)}.json`), normalized);
  return normalized;
}

/**
 * Patches an existing mutation journal record.
 *
 * @throws Filesystem or JSON parse errors when the record does not exist or is
 * corrupt.
 */
export async function updateActiveFSOperationJournal(
  layout: ActiveFSRemoteStateLayout,
  operationId: string,
  patch: Partial<Omit<ActiveFSOperationJournalRecord, "schemaVersion" | "remoteName" | "operationId" | "startedAt">>
): Promise<ActiveFSOperationJournalRecord> {
  const path = join(layout.journalDir, `${stateRecordFileSegment(operationId)}.json`);
  const existing = await readJsonFile<ActiveFSOperationJournalRecord>(path);
  const next: ActiveFSOperationJournalRecord = {
    ...existing,
    ...patch,
    path: patch.path ? normalizeActiveFSPath(patch.path) : existing.path,
    targetPath: patch.targetPath ? normalizeActiveFSPath(patch.targetPath) : patch.targetPath === undefined ? existing.targetPath : undefined,
    updatedAt: patch.updatedAt ?? new Date().toISOString()
  };
  await writePrivateJson(path, next);
  return next;
}

/**
 * Records cache-served activity that still needs to be reported or audited.
 *
 * @returns The normalized backlog record that was written.
 */
export async function recordActiveFSActivityBacklog(
  layout: ActiveFSRemoteStateLayout,
  record: Omit<ActiveFSActivityBacklogRecord, "schemaVersion" | "remoteName" | "activityId" | "attempts"> & {
    activityId?: string;
    attempts?: number;
  }
): Promise<ActiveFSActivityBacklogRecord> {
  const activityId = record.activityId ?? randomUUID();
  const normalized: ActiveFSActivityBacklogRecord = {
    schemaVersion: 1,
    remoteName: layout.remoteName,
    activityId,
    attempts: record.attempts ?? 1,
    ...record,
    path: normalizeActiveFSPath(record.path)
  };
  await writePrivateJson(join(layout.activityDir, `${stateRecordFileSegment(activityId)}.json`), normalized);
  return normalized;
}

/**
 * Removes a queued activity-backlog record.
 */
export async function removeActiveFSActivityBacklogRecord(
  layout: ActiveFSRemoteStateLayout,
  activityId: string
): Promise<void> {
  await rm(join(layout.activityDir, `${stateRecordFileSegment(activityId)}.json`), { force: true });
}

/**
 * Writes the latest per-remote session/cache-coherence state.
 *
 * @returns The normalized session state that was persisted.
 */
export async function writeActiveFSSessionState(
  layout: ActiveFSRemoteStateLayout,
  record: Omit<ActiveFSSessionStateRecord, "schemaVersion" | "remoteName" | "updatedAt"> & {
    updatedAt?: string;
  }
): Promise<ActiveFSSessionStateRecord> {
  const normalized: ActiveFSSessionStateRecord = {
    schemaVersion: 1,
    remoteName: layout.remoteName,
    ...record,
    updatedAt: record.updatedAt ?? new Date().toISOString()
  };
  await writePrivateJson(layout.sessionPath, normalized);
  return normalized;
}

function matcherMatches(matcher: ActiveFSPolicyMatcher, path: ActiveFSPath): boolean {
  const matcherPath = normalizePolicyPath(matcher.path);
  if (matcher.type === "exact") {
    return path === matcherPath;
  }
  if (matcher.type === "prefix") {
    return path === matcherPath || path.startsWith(`${matcherPath === "/" ? "" : matcherPath}/`);
  }
  return globToRegExp(matcherPath).test(path);
}

function accessAllowsOperation(access: ActiveFSPolicyAccess, operation: ActiveFSPolicyOperation): boolean {
  if (access === "writable") {
    return true;
  }
  return operation === "stat" || operation === "list" || operation === "read" || operation === "search";
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += escapeRegExp(char);
  }
  pattern += "$";
  return new RegExp(pattern);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function stateRecordFileSegment(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}

async function runCredentialCommand(
  argv: string[],
  timeoutMs = 5000,
  runCommand?: (argv: string[], timeoutMs: number, maxBytes: number) => Promise<string>
): Promise<string> {
  const maxBytes = 16 * 1024;
  if (runCommand) {
    return (await runCommand(argv, timeoutMs, maxBytes)).trim();
  }
  return new Promise<string>((resolvePromise, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error("Credential command argv must not be empty."));
      return;
    }
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Credential command timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > maxBytes) {
        child.kill("SIGTERM");
        reject(new Error("Credential command output exceeded 16KiB."));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `Credential command exited with ${code}.`));
    });
  });
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(
    () => true,
    (error: unknown) => {
      if (isNodeError(error, "ENOENT") || isNodeError(error, "EISDIR")) {
        return isNodeError(error, "EISDIR");
      }
      return false;
    }
  );
}

function validateRemoteName(remoteName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName)) {
    throw new Error(`Invalid ActiveFS remote name: ${remoteName}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code;
}
