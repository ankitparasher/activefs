import {
  authHeadersFromProvider,
  createActiveFSRemoteStateLayout,
  loadActiveFSConfig,
  updateActiveFSOperationJournal,
  type ActiveFSActivityPolicy,
  type ActiveFSAuthProviderConfig,
  type ActiveFSConfig,
  type ActiveFSOperationJournalRecord,
  type ActiveFSOperationJournalStatus,
  type ActiveFSPolicyOperation,
  type ActiveFSRemoteConfig
} from "@activefs/config";
import {
  createMountLayout,
  loadActiveFSMountConfig,
  readMountCacheSnapshot,
  readRcloneMountStatus,
  type MountCommandRunner,
  type RcloneMountStatus
} from "@activefs/mount";
import {
  createHttpSourceClient,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeOperationStatus,
  type ActiveFSTreeServiceCapabilities,
  type HttpSourceClientAuth
} from "@activefs/source-http";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ActiveFSStatusSummaryOptions {
  rootDir: string;
  remoteName?: string;
  commandRunner?: MountCommandRunner;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  timeoutMs?: number;
  reconcileOperations?: boolean;
  recentOperationLimit?: number;
}

export interface ActiveFSStatusSummary {
  rootDir: string;
  generatedAt: string;
  remotes: ActiveFSRemoteStatusSummary[];
}

export interface ActiveFSRemoteStatusSummary {
  name: string;
  endpoint: string;
  source: ActiveFSTreeApiStatus;
  insecureHttp?: ActiveFSRemoteConfig["insecureHttp"];
  mountPath?: string;
  mountpoint?: string;
  remoteRoot?: string;
  auth: ActiveFSAuthSummary;
  policy: {
    defaultAccess: string;
    revision?: string;
    digest?: string;
    ruleCount: number;
  };
  adapterCapabilityProfile?: string;
  cache: {
    mode: string;
    fileCount?: number;
    byteSize?: number;
  };
  mount?: RcloneMountStatus;
  session: ActiveFSSessionStatusSummary;
  operations: {
    unresolvedCount: number;
    ids: string[];
    recent: ActiveFSOperationJournalSummary[];
  };
  activity: {
    policy: ActiveFSActivityPolicy;
    backlogCount: number;
    files: string[];
  };
}

export interface ActiveFSTreeApiStatus {
  kind: "source-api";
  endpoint: string;
  reachable: boolean;
  checkedAt: string;
  protocol?: string;
  protocolVersion?: number;
  handshake?: ActiveFSTreeHandshake;
  capabilities?: ActiveFSTreeServiceCapabilities;
  diagnostics?: string;
}

export interface ActiveFSAuthSummary {
  type: ActiveFSAuthProviderConfig["type"];
}

export interface ActiveFSSessionStatusSummary {
  state: string;
  sessionId?: string;
  mode?: string;
  lastEventId?: string;
  lastEventSequence?: string | number | boolean;
  lastAppliedAck?: string | number | boolean;
  lastAckSequence?: string | number | boolean;
  cacheMode?: string;
  activityPolicy?: string;
  lastFailureReason?: string;
  lastResyncAt?: string;
  updatedAt?: string;
}

export interface ActiveFSOperationJournalSummary {
  operationId: string;
  operation?: ActiveFSPolicyOperation;
  path?: string;
  targetPath?: string;
  status: ActiveFSOperationJournalStatus | string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  idempotencyKey?: string;
  lastFailureReason?: string;
  result?: unknown;
}

export interface ActiveFSDiagnosticSnapshot {
  rootDir: string;
  generatedAt: string;
  activeScreen: string;
  remotes: ActiveFSRemoteStatusSummary[];
}

export async function createActiveFSStatusSummary(
  options: ActiveFSStatusSummaryOptions
): Promise<ActiveFSStatusSummary> {
  const rootDir = resolve(options.rootDir);
  const config = await loadActiveFSConfig(rootDir);
  const mountConfig = await loadActiveFSMountConfig(rootDir);
  const remotes = selectedStatusRemotes(config, options.remoteName);
  const summaries: ActiveFSRemoteStatusSummary[] = [];
  const timeoutMs = options.timeoutMs ?? 750;
  const recentOperationLimit = options.recentOperationLimit ?? 8;

  for (const remote of remotes) {
    const mountRemote = mountConfig.remotes[remote.name];
    const mountLayout = mountRemote ? createMountLayout(rootDir, mountRemote.name) : undefined;
    const remoteStateLayout = createActiveFSRemoteStateLayout(rootDir, remote.name);
    const source = await checkActiveFSTreeEndpoint({
      endpoint: remote.url,
      name: remote.name,
      rootDir,
      auth: remote.auth,
      allowInsecureHttp: Boolean(remote.insecureHttp?.allowed),
      fetch: options.fetch,
      timeoutMs
    });
    const mount = mountRemote && mountLayout
      ? await readRcloneMountStatus(mountLayout, {
        remote: mountRemote,
        commandRunner: options.commandRunner,
        platform: options.platform,
        fetch: options.fetch,
        timeoutMs
      }).catch((error) => mountStatusFromError(mountLayout, mountRemote.name, error))
      : undefined;
    const cache = mountLayout
      ? await readMountCacheSnapshot(mountLayout).catch(() => undefined)
      : undefined;
    const session = summarizeSessionRecord(await readJsonIfExists(remoteStateLayout.sessionPath));

    if (options.reconcileOperations !== false) {
      await reconcileOperationJournal({
        rootDir,
        remote,
        fetch: options.fetch,
        timeoutMs,
        journalDir: remoteStateLayout.journalDir
      });
    }

    const operations = await listOperationSummaries(remoteStateLayout.journalDir, recentOperationLimit);
    const activityFiles = await listStateFileNames(remoteStateLayout.activityDir);
    summaries.push({
      name: remote.name,
      endpoint: remote.url,
      source,
      insecureHttp: remote.insecureHttp,
      mountPath: remote.mountPath,
      mountpoint: remote.mountpoint,
      remoteRoot: remote.remoteRoot,
      auth: summarizeAuth(remote.auth),
      policy: {
        defaultAccess: remote.policy?.defaultAccess ?? "readonly",
        revision: remote.policy?.revision,
        digest: remote.policy?.digest,
        ruleCount: remote.policy?.rules.length ?? 0
      },
      adapterCapabilityProfile: remote.adapterCapabilityProfile,
      cache: {
        mode: remote.cacheMode ?? "off",
        fileCount: cache?.fileCount,
        byteSize: cache?.byteSize
      },
      mount,
      session,
      operations: {
        unresolvedCount: operations.unresolvedIds.length,
        ids: operations.unresolvedIds,
        recent: operations.recent
      },
      activity: {
        policy: remote.activityPolicy ?? "best-effort",
        backlogCount: activityFiles.length,
        files: activityFiles
      }
    });
  }

  return {
    rootDir,
    generatedAt: new Date().toISOString(),
    remotes: summaries
  };
}

export async function checkActiveFSTreeEndpoint(options: {
  endpoint: string;
  name: string;
  rootDir?: string;
  auth?: ActiveFSAuthProviderConfig;
  allowInsecureHttp?: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<ActiveFSTreeApiStatus> {
  const checkedAt = new Date().toISOString();
  const client = createHttpSourceClient({
    url: options.endpoint,
    name: options.name,
    allowInsecureHttp: options.allowInsecureHttp,
    fetch: timeoutFetch(options.fetch, options.timeoutMs ?? 750),
    auth: sourceAuthProvider(options.rootDir, options.name, options.auth)
  });
  try {
    const handshake = await client.fetchHandshake();
    return {
      kind: "source-api",
      endpoint: client.discoveryUrl,
      reachable: true,
      checkedAt,
      protocol: handshake.protocol,
      protocolVersion: handshake.protocolVersion,
      handshake,
      capabilities: handshake.capabilities
    };
  } catch (handshakeError) {
    return {
      kind: "source-api",
      endpoint: client.discoveryUrl,
      reachable: false,
      checkedAt,
      diagnostics: errorMessage(handshakeError)
    };
  }
}

export async function writeActiveFSDiagnosticSnapshot(
  path: string,
  summary: ActiveFSStatusSummary,
  activeScreen: string
): Promise<ActiveFSDiagnosticSnapshot> {
  const snapshot: ActiveFSDiagnosticSnapshot = {
    rootDir: summary.rootDir,
    generatedAt: new Date().toISOString(),
    activeScreen,
    remotes: summary.remotes
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

export function formatSessionStatus(session: ActiveFSSessionStatusSummary): string {
  const parts = [
    `state=${String(session.state ?? "unknown")}`,
    session.sessionId ? `id=${session.sessionId}` : undefined,
    session.mode ? `mode=${session.mode}` : undefined,
    session.cacheMode ? `cache=${session.cacheMode}` : undefined,
    session.lastEventId ? `lastEvent=${session.lastEventId}` : undefined,
    session.lastEventSequence ? `lastEventSequence=${String(session.lastEventSequence)}` : undefined,
    session.lastAppliedAck ? `lastAppliedAck=${String(session.lastAppliedAck)}` : undefined,
    session.lastAckSequence ? `lastAckSequence=${String(session.lastAckSequence)}` : undefined,
    session.lastFailureReason ? `lastFailure=${session.lastFailureReason}` : undefined,
    session.lastResyncAt ? `lastResync=${session.lastResyncAt}` : undefined
  ].filter(Boolean);
  return parts.join(", ");
}

function selectedStatusRemotes(config: ActiveFSConfig, selection: string | undefined): ActiveFSRemoteConfig[] {
  if (selection && !config.remotes[selection]) {
    throw new Error(`Unknown ActiveFS remote: ${selection}. For a local demo, run activefs remote add repo --demo --port 3999.`);
  }
  return Object.values(selection ? { [selection]: config.remotes[selection]! } : config.remotes)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeAuth(provider: ActiveFSAuthProviderConfig | undefined): ActiveFSAuthSummary {
  return { type: provider?.type ?? "none" };
}

function sourceAuthProvider(
  rootDir: string | undefined,
  remoteName: string,
  provider: ActiveFSAuthProviderConfig | undefined
): HttpSourceClientAuth | undefined {
  if (!rootDir || !provider || provider.type === "none") {
    return undefined;
  }
  return () => authHeadersFromProvider(provider, {
    layout: createActiveFSRemoteStateLayout(rootDir, remoteName)
  });
}

async function reconcileOperationJournal(request: {
  rootDir: string;
  remote: ActiveFSRemoteConfig;
  fetch?: typeof fetch;
  timeoutMs: number;
  journalDir: string;
}): Promise<void> {
  const records = await listOperationRecords(request.journalDir);
  const unresolved = records.filter((record) =>
    record.status === "pending" || record.status === "unknown" || record.status === "transient"
  );
  if (unresolved.length === 0) {
    return;
  }
  const source = createHttpSourceClient({
    url: request.remote.url,
    name: request.remote.name,
    allowInsecureHttp: Boolean(request.remote.insecureHttp?.allowed),
    auth: sourceAuthProvider(request.rootDir, request.remote.name, request.remote.auth),
    fetch: timeoutFetch(request.fetch, request.timeoutMs)
  });
  const layout = createActiveFSRemoteStateLayout(request.rootDir, request.remote.name);
  for (const record of unresolved) {
    try {
      if (!record.operationStatusEndpoint) {
        continue;
      }
      const status = await source.fetchOperationStatus({
        operationId: record.operationId,
        operationStatusEndpoint: record.operationStatusEndpoint
      });
      await updateActiveFSOperationJournal(layout, record.operationId, operationJournalPatchFromTreeStatus(status));
    } catch {
      // Operation-status lookup is diagnostic only. Keep unresolved records visible.
    }
  }
}

async function listOperationSummaries(
  path: string,
  limit: number
): Promise<{ unresolvedIds: string[]; recent: ActiveFSOperationJournalSummary[] }> {
  const records = await listOperationRecords(path);
  const unresolvedIds = records
    .filter((record) => record.status === "pending" || record.status === "unknown" || record.status === "transient")
    .map((record) => record.operationId)
    .sort();
  const recent = records
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
    .slice(0, limit)
    .map(summarizeOperationRecord);
  return { unresolvedIds, recent };
}

async function listOperationRecords(path: string): Promise<ActiveFSOperationJournalRecord[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const records: ActiveFSOperationJournalRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const record = await readJsonIfExists(join(path, entry.name));
      if (isOperationRecord(record)) {
        records.push(record);
      }
    }
    return records;
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

function summarizeOperationRecord(record: ActiveFSOperationJournalRecord): ActiveFSOperationJournalSummary {
  return {
    operationId: record.operationId,
    operation: record.operation,
    path: record.path,
    targetPath: record.targetPath,
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    idempotencyKey: record.idempotencyKey,
    lastFailureReason: record.lastFailureReason,
    result: scrubDiagnosticValue(record.result)
  };
}

function operationJournalPatchFromTreeStatus(status: ActiveFSTreeOperationStatus): {
  status: ActiveFSOperationJournalStatus;
  completedAt?: string;
  result?: unknown;
  lastFailureReason?: string;
} {
  if (status.status === "running") {
    return { status: "pending" };
  }
  if (status.status === "succeeded") {
    return {
      status: "committed",
      completedAt: status.completedAt ?? new Date().toISOString(),
      result: scrubDiagnosticValue(status.result)
    };
  }
  return {
    status: operationJournalFailureStatusFromTree(status),
    completedAt: status.completedAt ?? new Date().toISOString(),
    lastFailureReason: status.error?.message
  };
}

function operationJournalFailureStatusFromTree(status: ActiveFSTreeOperationStatus): ActiveFSOperationJournalStatus {
  const code = status.error?.code;
  if (code === "CONFLICT" || code === "PRECONDITION_FAILED") {
    return "conflict";
  }
  if (code === "UNSUPPORTED_OPERATION") {
    return "unsupported";
  }
  if (code === "TRANSIENT_TRANSPORT" || code === "SOURCE_UNAVAILABLE" || code === "TIMEOUT" || code === "INTERNAL_ERROR") {
    return "transient";
  }
  if (code === "PERMISSION_DENIED" || code === "INVALID_PATH") {
    return "rejected";
  }
  return "unknown";
}

function scrubDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubDiagnosticValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !secretLikeKey(key))
      .map(([key, nested]) => [key, scrubDiagnosticValue(nested)])
  );
}

function secretLikeKey(key: string): boolean {
  return [
    "authorization",
    "content",
    "contentBase64",
    "cookie",
    "password",
    "secret",
    "token"
  ].includes(key.toLowerCase());
}

async function listStateFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

function summarizeSessionRecord(record: unknown): ActiveFSSessionStatusSummary {
  if (!isRecord(record)) {
    return { state: "none" };
  }
  return {
    state: String(scalarField(record, "state") ?? "recorded"),
    sessionId: shortenIdentifier(scalarField(record, "sessionId")),
    mode: stringField(record, "mode"),
    lastEventId: stringField(record, "lastEventId"),
    lastEventSequence: scalarField(record, "lastEventSequence"),
    lastAppliedAck: scalarField(record, "lastAppliedAck"),
    lastAckSequence: scalarField(record, "lastAckSequence"),
    cacheMode: stringField(record, "cacheMode"),
    activityPolicy: stringField(record, "activityPolicy"),
    lastFailureReason: stringField(record, "lastFailureReason"),
    lastResyncAt: stringField(record, "lastResyncAt"),
    updatedAt: stringField(record, "updatedAt")
  };
}

function scalarField(record: Record<string, unknown>, field: string): string | number | boolean | undefined {
  const value = record[field];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = scalarField(record, field);
  return typeof value === "string" ? value : undefined;
}

function shortenIdentifier(value: string | number | boolean | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length <= 16) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function timeoutFetch(fetcher: typeof fetch | undefined, timeoutMs: number): typeof fetch {
  const implementation = fetcher ?? fetch;
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await implementation(input, {
        ...init,
        signal: init?.signal ?? controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

function mountStatusFromError(
  layout: ReturnType<typeof createMountLayout>,
  remote: string,
  error: unknown
): RcloneMountStatus {
  return {
    remote,
    state: "failed",
    rootDir: layout.rootDir,
    vfsDir: layout.vfsDir,
    configPath: layout.rcloneConfigPath,
    logFile: layout.rcloneLogPath,
    mounted: false,
    updatedAt: new Date().toISOString(),
    error: errorMessage(error)
  };
}

function isOperationRecord(value: unknown): value is ActiveFSOperationJournalRecord {
  return isRecord(value) &&
    typeof value.operationId === "string" &&
    typeof value.status === "string" &&
    typeof value.path === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
