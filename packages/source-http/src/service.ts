import {
  ActiveFSError,
  activeFSContentToBytes,
  joinActiveFSPath,
  normalizeActiveFSPath,
  type ActiveFSCommandInput,
  type ActiveFSContext,
  type ActiveFSCopyOptions,
  type ActiveFSDeleteOptions,
  type ActiveFSDirEntry,
  type ActiveFSMkdirOptions,
  type ActiveFSMetadataUpdateOptions,
  type ActiveFSPath,
  type ActiveFSReadOptions,
  type ActiveFSReadResult,
  type ActiveFSRenameOptions,
  type ActiveFSSearchQuery,
  type ActiveFSSearchResult,
  type ActiveFSStat,
  type ActiveFSTree,
  type ActiveFSTreeCommand,
  type ActiveFSTreeCommandResultMap,
  type ActiveFSTreeInfo,
  type ActiveFSTreeListResult,
  type ActiveFSTreeMutationResult,
  type ActiveFSTreeNodeDeclaration,
  type ActiveFSTreeReadResult,
  type ActiveFSTreeSearchResult,
  type ActiveFSTruncateOptions,
  type ActiveFSWatchOptions,
  type ActiveFSWatchSubscription,
  type ActiveFSWriteOptions
} from "@activefs/core";
import {
  ACTIVEFS_SOURCE_PROTOCOL_VERSION,
  activeFSSourceCapabilities,
  mergeActiveFSSourceHandshake,
  normalizeSourceMountPath,
  type ActiveFSErrorPayload,
  type ActiveFSErrorResponse,
  type ActiveFSSessionEvent,
  type ActiveFSSourceConfigDocument,
  type ActiveFSSourceOperation,
  type ActiveFSSourceOperationParams,
  type ActiveFSSourceResolvedContext,
  type ActiveFSSourceService,
  type ActiveFSSourceServiceOptions,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeOperationStatus,
  type ActiveFSTreeProtocolErrorCode,
  type ActiveFSTreeSession
} from "./protocol.js";

interface ProtocolBody<Auth = unknown, Meta = unknown> {
  path: string;
  ctx?: ActiveFSContext<Auth, Meta>;
}

interface ReadProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  options?: ActiveFSReadOptions;
  responseFormat?: "json" | "octet-stream";
}

interface SearchProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  query: ActiveFSSearchQuery;
}

interface CommandProtocolBody<
  Auth = unknown,
  Meta = unknown,
  Command extends ActiveFSTreeCommand = ActiveFSTreeCommand
> extends ProtocolBody<Auth, Meta> {
  command: Command;
  input: ActiveFSCommandInput<Command>;
}

interface WriteProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  content?: string;
  contentBase64?: string;
  options?: ActiveFSWriteOptions<Meta>;
  digest?: {
    algorithm: "sha-256";
    value: string;
  };
}

interface DeleteProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  options?: ActiveFSDeleteOptions;
}

interface MkdirProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  options?: ActiveFSMkdirOptions<Meta>;
}

interface RenameProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  toPath: string;
  options?: ActiveFSRenameOptions;
}

interface CopyProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  toPath: string;
  options?: ActiveFSCopyOptions;
}

interface TruncateProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  options?: ActiveFSTruncateOptions;
}

interface MetadataProtocolBody<Auth = unknown, Meta = unknown> extends ProtocolBody<Auth, Meta> {
  options: ActiveFSMetadataUpdateOptions<Meta>;
}

interface SessionCreateBody<Auth = unknown, Meta = unknown> {
  ctx?: ActiveFSContext<Auth, Meta>;
  path?: string;
  options?: Omit<ActiveFSWatchOptions, "signal">;
}

interface EncodedReadResult<Meta = unknown> {
  content?: string;
  contentBase64?: string;
  stat?: ActiveFSStat<Meta>;
  meta?: Meta;
}

interface EncodedCommandResult<Meta = unknown> {
  entries?: ActiveFSDirEntry<Meta>[];
  stat?: ActiveFSStat<Meta> | null;
  read?: EncodedReadResult<Meta>;
  search?: ActiveFSSearchResult<Meta>;
  stats?: ActiveFSStat<Meta>[];
}

interface SessionSink {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  close(): Promise<void>;
}

interface SessionRecord<Auth = unknown, Meta = unknown> {
  sessionId: string;
  isolationKey: string;
  context: ActiveFSContext<Auth, Meta>;
  path: ActiveFSPath;
  options?: Omit<ActiveFSWatchOptions, "signal">;
  createdAt: string;
  nextSequence: number;
  lastAckSequence: number;
  events: ActiveFSSessionEvent[];
  activity: unknown[];
  sinks: Set<SessionSink>;
  eventSigningSecret?: Uint8Array;
  previousEventDigest?: string;
  eventQueue: Promise<void>;
}

interface ScopedOperationStatus {
  isolationKey: string;
  status: ActiveFSTreeOperationStatus;
}

interface ScopedChangeRecord {
  isolationKey: string;
  sequence: number;
  issuedAt: string;
  type: "path.invalidated";
  path: ActiveFSPath;
  targetPath?: ActiveFSPath;
  revision?: string;
}

interface ScopedIdempotencyRecord {
  isolationKey: string;
  fingerprint: string;
  promise: Promise<unknown>;
  settled: boolean;
}

interface ServiceState<Auth = unknown, Meta = unknown> {
  sessions: Map<string, SessionRecord<Auth, Meta>>;
  operationStatuses: Map<string, ScopedOperationStatus>;
  idempotencyRecords: Map<string, ScopedIdempotencyRecord>;
  changes: ScopedChangeRecord[];
  nextChangeSequenceByIsolation: Map<string, number>;
  droppedChangeSequenceByIsolation: Map<string, number>;
  isolationScopes: Map<string, true>;
  evictedIsolationScopes: Map<string, true>;
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RETAINED = 512;
const DEFAULT_MAX_SESSIONS = 512;
const DEFAULT_MAX_ACTIVITY = 512;
const DEFAULT_MAX_ISOLATION_SCOPES = 64;
const DEFAULT_HOSTED_MAX_RETAINED = 64;
const DEFAULT_HOSTED_MAX_SESSIONS = 8;
const DEFAULT_HOSTED_MAX_SESSION_EVENTS = 128;
const DEFAULT_HOSTED_MAX_ACTIVITY = 128;
const encoder = new TextEncoder();

/** Creates the route-independent Web-standard Source API engine. */
export function createActiveFSSourceService<Auth = unknown, Meta = unknown>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>
): ActiveFSSourceService<Auth, Meta> {
  validateServiceLimits(options);
  const capabilities = activeFSSourceCapabilities(options.tree);
  const state: ServiceState<Auth, Meta> = {
    sessions: new Map(),
    operationStatuses: new Map(),
    idempotencyRecords: new Map(),
    changes: [],
    nextChangeSequenceByIsolation: new Map(),
    droppedChangeSequenceByIsolation: new Map(),
    isolationScopes: new Map(),
    evictedIsolationScopes: new Map()
  };

  return {
    capabilities,
    async handle(operation, request, params = {}) {
      try {
        return await handleOperation(options, capabilities, state, operation, request, params);
      } catch (error) {
        return errorResponse(error);
      }
    },
    async revokeSession(sessionId, reason = "revoked by the source host") {
      const session = state.sessions.get(validateResourceId(sessionId, "sessionId"));
      if (!session) {
        return false;
      }
      await queueSessionEvent(options, session, "session.revoked", { reason });
      state.sessions.delete(sessionId);
      await closeSessionRecord(session);
      return true;
    }
  };
}

async function handleOperation<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  capabilities: ReturnType<typeof activeFSSourceCapabilities<Auth, Meta>>,
  state: ServiceState<Auth, Meta>,
  operation: ActiveFSSourceOperation,
  request: Request,
  params: ActiveFSSourceOperationParams
): Promise<Response> {
  assertMethod(operation, request.method);
  const body = operationBody(operation)
    ? await readRequestJson(request, options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES, operation === "createSession")
    : undefined;
  const session = params.sessionId ? state.sessions.get(validateResourceId(params.sessionId, "sessionId")) : undefined;
  if (params.sessionId && !session) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS session: ${params.sessionId}`);
  }
  const resolved = await resolveRequestContext(options, operation, request, body, session);
  if (session && resolved.revokeSession) {
    await revokeAndDeleteSession(options, state, session, "authoritative session access was revoked");
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS session: ${params.sessionId}`);
  }
  if (session && session.isolationKey !== resolved.isolationKey) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS session: ${params.sessionId}`);
  }
  if (operationUsesRetainedState(operation)) {
    await touchIsolationScope(options, state, resolved.isolationKey);
  }
  if (session) {
    session.context = stripContextSignal(resolved.context);
  }

  switch (operation) {
    case "handshake":
      return jsonResponse(200, await sourceHandshake(options, capabilities, request, resolved.context));
    case "capabilities":
      return jsonResponse(200, capabilities);
    case "config": {
      const handshake = await sourceHandshake(options, capabilities, request, resolved.context);
      const config: ActiveFSSourceConfigDocument = {
        schemaVersion: 1,
        protocol: "activefs-source",
        protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
        capabilities: handshake.capabilities,
        server: handshake.server,
        workspace: handshake.workspace,
        cache: {
          ...handshake.cache,
          persistentReadCache: "off-unless-session-coherent"
        },
        auth: handshake.auth,
        freshness: handshake.freshness,
        mutations: handshake.mutations,
        revisions: handshake.revisions
      };
      return jsonResponse(200, config);
    }
    case "policy":
      return jsonResponse(200, {
        schemaVersion: 1,
        policy: null,
        defaultAccess: "tree-owned",
        message: "This generic Source API helper does not define tree/provider policy; the served tree decides each operation."
      });
    case "changes":
      return handleChanges(request, state, resolved.isolationKey);
    case "stat":
      return handleStat(options.tree, resolved.context, body);
    case "list":
      return handleList(options.tree, resolved.context, body);
    case "read":
      return handleRead(options.tree, resolved.context, request, body);
    case "search":
      return handleSearch(options.tree, capabilities, resolved.context, body);
    case "command":
      return handleCommand(options.tree, capabilities, resolved.context, body);
    case "write":
    case "delete":
    case "mkdir":
    case "rmdir":
    case "rename":
    case "copy":
    case "truncate":
    case "metadata":
      return handleMutation(options, capabilities, state, operation, request, resolved, body);
    case "createSession":
      return handleCreateSession(options, state, request, resolved, body);
    case "sessionEvents":
      return handleSessionEvents(options, request, session!, resolved.context);
    case "sessionAck":
      return handleSessionAck(options, session!, body);
    case "sessionActivity":
      return handleSessionActivity(options, session!, body);
    case "operationStatus":
      return handleOperationStatus(state, resolved.isolationKey, params.operationId);
  }
}

async function sourceHandshake<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  capabilities: ReturnType<typeof activeFSSourceCapabilities<Auth, Meta>>,
  request: Request,
  context: ActiveFSContext<Auth, Meta>
): Promise<ActiveFSTreeHandshake> {
  const base: ActiveFSTreeHandshake = {
    protocol: "activefs-source",
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    endpoints: options.endpoints,
    capabilities,
    server: { name: options.tree.name },
    workspace: {
      displayName: options.tree.name,
      suggestedMountPath: normalizeSourceMountPath(options.tree.name)
    },
    auth: { required: Boolean(options.resolveContext), schemes: options.resolveContext ? ["custom"] : undefined },
    freshness: {
      sessions: Boolean(options.endpoints.sessions),
      sse: Boolean(options.endpoints.sessions && capabilities.watchable),
      changes: Boolean(options.endpoints.changes)
    },
    mutations: {
      writable: capabilities.writable,
      operations: Object.entries(capabilities.mutable)
        .filter(([, enabled]) => enabled)
        .map(([name]) => name)
    }
  };
  const hints = typeof options.handshake === "function"
    ? await options.handshake({ request, tree: options.tree, capabilities, defaultHandshake: base, context })
    : options.handshake;
  return mergeActiveFSSourceHandshake(base, hints);
}

async function resolveRequestContext<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  operation: ActiveFSSourceOperation,
  request: Request,
  body: unknown,
  session: SessionRecord<Auth, Meta> | undefined
): Promise<ActiveFSSourceResolvedContext<Auth, Meta>> {
  const untrustedContext = extractUntrustedContext<Auth, Meta>(body, !options.resolveContext);
  if (options.resolveContext) {
    let resolved: ActiveFSSourceResolvedContext<Auth, Meta>;
    try {
      resolved = await options.resolveContext({
        request,
        operation,
        untrustedContext,
        session: session ? { sessionId: session.sessionId, isolationKey: session.isolationKey } : undefined
      });
    } catch (error) {
      throw sanitizedContextResolverError(error);
    }
    if (!resolved || !isRecord(resolved.context) || typeof resolved.isolationKey !== "string" || resolved.isolationKey.length === 0) {
      throw new ActiveFSError("SOURCE_ERROR", "Source API context resolver returned an invalid result");
    }
    return {
      context: { ...resolved.context, signal: request.signal },
      isolationKey: resolved.isolationKey,
      revokeSession: resolved.revokeSession === true
    };
  }
  if (operationNeedsContext(operation) && !untrustedContext) {
    throw new ActiveFSError("INVALID_REQUEST", "Source service request body must include ctx");
  }
  return {
    context: { ...(untrustedContext ?? {}), signal: request.signal } as ActiveFSContext<Auth, Meta>,
    isolationKey: "anonymous"
  };
}

async function handleStat<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  body: unknown
): Promise<Response> {
  const path = protocolPath(body);
  const info = await tree.info(context, path);
  return jsonResponse(200, info ? treeInfoToSourceStat(info, path) : null);
}

async function handleList<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  body: unknown
): Promise<Response> {
  const path = protocolPath(body);
  return jsonResponse(200, treeListToSourceEntries(await tree.list(context, path), path));
}

async function handleRead<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  request: Request,
  value: unknown
): Promise<Response> {
  const body = value as ReadProtocolBody<Auth, Meta>;
  const path = protocolPath(body);
  const result = await tree.read(context, path, body.options);
  const content = treeReadContent(result);
  const info = treeReadInfo(result) ?? await tree.info(context, path);
  const sourceResult: ActiveFSReadResult<Meta> = {
    content: treeContentToSourceContent(content),
    stat: info ? treeInfoToSourceStat(info, path) : undefined,
    meta: treeReadData(result) ?? info?.data
  };
  const wantsOctets = body.responseFormat === "octet-stream" || request.headers.get("accept")
    ?.split(",")
    .some((entry) => entry.trim() === "application/octet-stream");
  if (!wantsOctets) {
    return jsonResponse(200, encodeReadResult(sourceResult));
  }
  const bytes = activeFSContentToBytes(sourceResult.content);
  const digest = await contentDigestHeader(bytes);
  const headers = new Headers({
    "content-type": sourceResult.stat?.mimeType ?? "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "content-digest": digest,
    "repr-digest": digest
  });
  if (sourceResult.stat) {
    headers.set("x-activefs-stat", encodeHeaderJson(sourceResult.stat));
  }
  if (sourceResult.meta !== undefined) {
    headers.set("x-activefs-meta", encodeHeaderJson(sourceResult.meta));
  }
  return new Response(toArrayBuffer(bytes), { status: 200, headers });
}

async function handleSearch<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  capabilities: ReturnType<typeof activeFSSourceCapabilities<Auth, Meta>>,
  context: ActiveFSContext<Auth, Meta>,
  value: unknown
): Promise<Response> {
  const body = value as SearchProtocolBody<Auth, Meta>;
  const path = protocolPath(body);
  if (!capabilities.searchable) {
    throw new ActiveFSError("UNSUPPORTED", "Tree source does not support search", { path });
  }
  if (!isRecord(body.query) || typeof body.query.pattern !== "string") {
    throw new ActiveFSError("INVALID_REQUEST", "Search request must include query.pattern", { path });
  }
  return jsonResponse(200, treeSearchToSourceSearch(await tree.search(context, path, body.query)));
}

async function handleCommand<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  capabilities: ReturnType<typeof activeFSSourceCapabilities<Auth, Meta>>,
  context: ActiveFSContext<Auth, Meta>,
  value: unknown
): Promise<Response> {
  const body = value as CommandProtocolBody<Auth, Meta>;
  const path = protocolPath(body);
  if (!isActiveFSTreeCommand(body.command) || !isRecord(body.input)) {
    throw new ActiveFSError("INVALID_REQUEST", "Command request must include a supported command and input object", { path });
  }
  if (!capabilities.commands.includes(body.command)) {
    throw new ActiveFSError("UNSUPPORTED", `Tree source does not support ${body.command}`, { path });
  }
  return jsonResponse(200, await encodeTreeCommandResult(tree, context, body.command, path, body.input));
}

async function handleMutation<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  capabilities: ReturnType<typeof activeFSSourceCapabilities<Auth, Meta>>,
  state: ServiceState<Auth, Meta>,
  operation: Extract<ActiveFSSourceOperation, "write" | "delete" | "mkdir" | "rmdir" | "rename" | "copy" | "truncate" | "metadata">,
  request: Request,
  resolved: ActiveFSSourceResolvedContext<Auth, Meta>,
  value: unknown
): Promise<Response> {
  const path = protocolPath(value);
  const capability = operation === "metadata" ? "updateMetadata" : operation;
  if (!capabilities.mutable[capability]) {
    throw new ActiveFSError("UNSUPPORTED", `Tree source does not support ${operation}`, { path });
  }
  const targetPath = operation === "rename" || operation === "copy"
    ? normalizeActiveFSPath((value as RenameProtocolBody<Auth, Meta>).toPath)
    : undefined;
  const idempotencyKey = mutationIdempotencyKey(value) ?? request.headers.get("idempotency-key") ?? undefined;
  const result = await runTrackedMutation(options, state, request, resolved, operation, path, targetPath, idempotencyKey, value, async () => {
    switch (operation) {
      case "write": {
        const body = value as WriteProtocolBody<Auth, Meta>;
        const content = decodeWriteContent(body);
        await verifyWriteDigest(content, body.digest, path);
        const before = await options.tree.info(resolved.context, path);
        const mutation = await options.tree.write(resolved.context, path, content, body.options);
        const info = await options.tree.info(resolved.context, path);
        return {
          stat: info ? treeInfoToSourceStat(info, path) : undefined,
          created: mutationCreated(mutation, path) ?? before === null,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
      case "delete":
      case "rmdir": {
        const body = value as DeleteProtocolBody<Auth, Meta>;
        const mutation = await options.tree.remove(resolved.context, path, body.options);
        return { path, deleted: true, revision: mutationRevision(mutation), meta: mutationData(mutation) };
      }
      case "mkdir": {
        const body = value as MkdirProtocolBody<Auth, Meta>;
        const mutation = await options.tree.makeDir(resolved.context, path, body.options);
        const info = await options.tree.info(resolved.context, path);
        return {
          stat: info ? treeInfoToSourceStat(info, path) : undefined,
          created: mutationCreated(mutation, path) ?? true,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
      case "rename": {
        const body = value as RenameProtocolBody<Auth, Meta>;
        const mutation = await options.tree.move(resolved.context, path, targetPath!, body.options);
        const info = await options.tree.info(resolved.context, targetPath!);
        return {
          from: path,
          to: targetPath,
          stat: info ? treeInfoToSourceStat(info, targetPath!) : undefined,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
      case "copy": {
        const body = value as CopyProtocolBody<Auth, Meta>;
        const mutation = await options.tree.copy(resolved.context, path, targetPath!, body.options);
        const info = await options.tree.info(resolved.context, targetPath!);
        return {
          from: path,
          to: targetPath,
          stat: info ? treeInfoToSourceStat(info, targetPath!) : undefined,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
      case "truncate": {
        const body = value as TruncateProtocolBody<Auth, Meta>;
        const mutation = await options.tree.truncate(resolved.context, path, body.options);
        const info = await options.tree.info(resolved.context, path);
        return {
          stat: info ? treeInfoToSourceStat(info, path) : undefined,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
      case "metadata": {
        const body = value as MetadataProtocolBody<Auth, Meta>;
        const mutation = await options.tree.updateInfo(resolved.context, path, body.options);
        const info = await options.tree.info(resolved.context, path);
        return {
          stat: info ? treeInfoToSourceStat(info, path) : undefined,
          revision: mutationRevision(mutation),
          meta: mutationData(mutation)
        };
      }
    }
  });
  return jsonResponse(200, result);
}

async function runTrackedMutation<Auth, Meta, Result extends { operationId?: string; revision?: string }>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  request: Request,
  resolved: ActiveFSSourceResolvedContext<Auth, Meta>,
  operation: ActiveFSTreeOperationStatus["operation"],
  path: ActiveFSPath,
  targetPath: ActiveFSPath | undefined,
  idempotencyKey: string | undefined,
  requestBody: unknown,
  execute: () => Promise<Result>
): Promise<Result & { operationId: string; operationStatusEndpoint: string }> {
  if (idempotencyKey) {
    const recordKey = scopedKey(resolved.isolationKey, idempotencyKey);
    const fingerprint = await mutationFingerprint(operation, requestBody, Boolean(options.resolveContext));
    const existing = state.idempotencyRecords.get(recordKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ActiveFSError(
          "CONFLICT",
          "Idempotency key was already used for a different mutation request",
          { path }
        );
      }
      return existing.promise as Promise<Result & { operationId: string; operationStatusEndpoint: string }>;
    }
    makeIdempotencyCapacity(options, state, resolved.isolationKey);
    const record: ScopedIdempotencyRecord = {
      isolationKey: resolved.isolationKey,
      fingerprint,
      promise: Promise.resolve(undefined),
      settled: false
    };
    const promise = performTrackedMutation(
      options,
      state,
      request,
      resolved,
      operation,
      path,
      targetPath,
      idempotencyKey,
      execute
    );
    record.promise = promise;
    state.idempotencyRecords.set(recordKey, record);
    void promise.then(
      () => { record.settled = true; },
      () => { record.settled = true; }
    );
    return promise;
  }
  return performTrackedMutation(
    options,
    state,
    request,
    resolved,
    operation,
    path,
    targetPath,
    idempotencyKey,
    execute
  );
}

async function performTrackedMutation<Auth, Meta, Result extends { operationId?: string; revision?: string }>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  request: Request,
  resolved: ActiveFSSourceResolvedContext<Auth, Meta>,
  operation: ActiveFSTreeOperationStatus["operation"],
  path: ActiveFSPath,
  targetPath: ActiveFSPath | undefined,
  idempotencyKey: string | undefined,
  execute: () => Promise<Result>
): Promise<Result & { operationId: string; operationStatusEndpoint: string }> {
  const startedAt = new Date().toISOString();
  const initialOperationId = await operationIdForRequest(resolved.isolationKey, idempotencyKey);
  const initialEndpoint = operationStatusLink(options, request, initialOperationId);
  retainOperationStatus(options, state, resolved.isolationKey, {
    operationId: initialOperationId,
    operationStatusEndpoint: initialEndpoint,
    status: "running",
    operation,
    path,
    targetPath,
    startedAt
  });
  try {
    const result = await execute();
    const operationId = result.operationId ?? initialOperationId;
    const operationStatusEndpoint = operationStatusLink(options, request, operationId);
    const resultWithOperation = { ...result, operationId, operationStatusEndpoint };
    if (operationId !== initialOperationId) {
      state.operationStatuses.delete(scopedKey(resolved.isolationKey, initialOperationId));
    }
    const status: ActiveFSTreeOperationStatus = {
      operationId,
      operationStatusEndpoint,
      status: "succeeded",
      operation,
      path,
      targetPath,
      startedAt,
      completedAt: new Date().toISOString(),
      revision: result.revision,
      result: resultWithOperation
    };
    retainOperationStatus(options, state, resolved.isolationKey, status);
    recordChange(options, state, resolved.isolationKey, status);
    return resultWithOperation;
  } catch (error) {
    const status: ActiveFSTreeOperationStatus = {
      operationId: initialOperationId,
      operationStatusEndpoint: initialEndpoint,
      status: "failed",
      operation,
      path,
      targetPath,
      startedAt,
      completedAt: new Date().toISOString(),
      error: activeFSErrorPayload(error)
    };
    retainOperationStatus(options, state, resolved.isolationKey, status);
    recordChange(options, state, resolved.isolationKey, status);
    if (error && typeof error === "object") {
      Object.assign(error, {
        operationId: initialOperationId,
        operationStatusEndpoint: initialEndpoint
      });
    }
    throw error;
  }
}

async function handleCreateSession<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  request: Request,
  resolved: ActiveFSSourceResolvedContext<Auth, Meta>,
  value: unknown
): Promise<Response> {
  if (!options.endpoints.sessions) {
    throw new ActiveFSError("UNSUPPORTED", "Source API sessions are not configured");
  }
  const body = (isRecord(value) ? value : {}) as SessionCreateBody<Auth, Meta>;
  const sessionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const path = normalizeActiveFSPath(body.path ?? "/");
  const signingSecret = options.eventSigningSecret === undefined
    ? undefined
    : typeof options.eventSigningSecret === "string"
      ? encoder.encode(options.eventSigningSecret)
      : options.eventSigningSecret;
  const session: SessionRecord<Auth, Meta> = {
    sessionId,
    isolationKey: resolved.isolationKey,
    context: stripContextSignal(resolved.context),
    path,
    options: body.options,
    createdAt,
    nextSequence: 1,
    lastAckSequence: 0,
    events: [],
    activity: [],
    sinks: new Set(),
    eventSigningSecret: signingSecret,
    eventQueue: Promise.resolve()
  };
  // Resolve host-owned public links before retaining state. A missing route
  // mapping must fail without leaving an unreachable session behind.
  const links = sessionLinks(options, request, sessionId);
  state.sessions.set(sessionId, session);
  const maxSessions = options.maxRetainedSessions
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_SESSIONS : DEFAULT_MAX_SESSIONS);
  while (sessionsForIsolation(state, resolved.isolationKey).length > maxSessions) {
    const oldest = sessionsForIsolation(state, resolved.isolationKey)
      .find((candidate) => candidate.sessionId !== sessionId);
    if (!oldest) break;
    await revokeAndDeleteSession(options, state, oldest, "session retention limit exceeded");
  }
  const response: ActiveFSTreeSession = {
    sessionId,
    createdAt,
    cacheMode: "off",
    ...links,
    integrity: {
      eventChain: "sha-256",
      eventMac: signingSecret ? "hmac-sha-256" : undefined
    }
  };
  return jsonResponse(201, response);
}

function handleSessionEvents<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  request: Request,
  session: SessionRecord<Auth, Meta>,
  requestContext: ActiveFSContext<Auth, Meta>
): Response {
  const lastEventIdHeader = request.headers.get("last-event-id");
  const wantsReplay = lastEventIdHeader !== null;
  const lastEventId = lastEventIdHeader === null ? 0 : Number(lastEventIdHeader);
  if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
    throw new ActiveFSError("INVALID_REQUEST", "Last-Event-ID must be a non-negative integer");
  }
  let sink: SessionSink | undefined;
  let subscription: ActiveFSWatchSubscription | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (sink) {
      sink.closed = true;
      session.sinks.delete(sink);
    }
    await subscription?.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = {
        controller,
        closed: false,
        close: async () => {
          try {
            if (!closed) {
              controller.close();
            }
          } finally {
            await close();
          }
        }
      };
      session.sinks.add(sink);
      request.signal.addEventListener("abort", () => void close(), { once: true });
      void (async () => {
        try {
          await session.eventQueue;
          const oldestAvailable = session.events[0]?.sequence ?? session.nextSequence;
          const newestAvailable = session.nextSequence - 1;
          const replayGap = wantsReplay && (lastEventId > newestAvailable ||
            lastEventId < oldestAvailable - 1);
          if (replayGap) {
            let gapEvent: ActiveFSSessionEvent | undefined;
            session.eventQueue = session.eventQueue.then(async () => {
              gapEvent = await appendSessionEvent(options, session, "resync.required", {
                reason: "event replay gap"
              });
            });
            await session.eventQueue;
            enqueueSse(sink!, gapEvent!);
          } else if (wantsReplay) {
            for (const event of session.events.filter((candidate) => candidate.sequence > lastEventId)) {
              enqueueSse(sink!, event);
            }
          }
          try {
            subscription = await options.tree.watch(
              { ...session.context, signal: requestContext.signal },
              session.path,
              (event) => {
                queueSessionEvent(options, session, event.type === "invalidate" ? "path.invalidated" : "tree.changed", {
                  path: event.path,
                  sourceEventType: event.type,
                  revision: event.stat?.revision,
                  etag: event.stat?.etag,
                  stat: event.stat,
                  meta: event.meta
                });
              },
              session.options
            );
          } catch (error) {
            if (!(error instanceof ActiveFSError) || error.code !== "UNSUPPORTED") {
              throw error;
            }
          }
          if (!subscription) {
            queueSessionEvent(options, session, "resync.required", { reason: "watch is not available" });
          }
          queueSessionEvent(options, session, "heartbeat", { lastAckSequence: session.lastAckSequence });
          heartbeat = setInterval(() => {
            queueSessionEvent(options, session, "heartbeat", { lastAckSequence: session.lastAckSequence });
          }, 15_000);
        } catch (error) {
          if (!closed) {
            controller.error(error);
          }
          await close();
        }
      })();
    },
    async cancel() {
      await close();
    }
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}

async function closeSessionRecord<Auth, Meta>(session: SessionRecord<Auth, Meta>): Promise<void> {
  const sinks = [...session.sinks];
  await Promise.all(sinks.map(async (sink) => {
    if (!sink.closed) {
      try {
        await sink.close();
      } catch {
        // Closing retained server state is best-effort, but every sink gets a
        // cleanup attempt even if a runtime rejects one stream close.
      }
    }
  }));
}

async function revokeAndDeleteSession<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  session: SessionRecord<Auth, Meta>,
  reason: string
): Promise<void> {
  await queueSessionEvent(options, session, "session.revoked", { reason });
  state.sessions.delete(session.sessionId);
  await closeSessionRecord(session);
}

async function handleSessionAck<Auth, Meta>(
  _options: ActiveFSSourceServiceOptions<Auth, Meta>,
  session: SessionRecord<Auth, Meta>,
  value: unknown
): Promise<Response> {
  const sequence = isRecord(value) && typeof value.lastAppliedSequence === "number"
    ? value.lastAppliedSequence
    : undefined;
  if (sequence === undefined || sequence < 0) {
    throw new ActiveFSError("INVALID_REQUEST", "ACK body must include lastAppliedSequence");
  }
  session.lastAckSequence = Math.max(session.lastAckSequence, sequence);
  return jsonResponse(200, { sessionId: session.sessionId, lastAckSequence: session.lastAckSequence });
}

async function handleSessionActivity<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  session: SessionRecord<Auth, Meta>,
  value: unknown
): Promise<Response> {
  session.activity.push(value);
  const max = options.maxSessionActivityBacklog
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_ACTIVITY : DEFAULT_MAX_ACTIVITY);
  if (session.activity.length > max) {
    session.activity.splice(0, session.activity.length - max);
  }
  return jsonResponse(202, { sessionId: session.sessionId, accepted: true, backlog: session.activity.length });
}

async function handleChanges<Auth, Meta>(
  request: Request,
  state: ServiceState<Auth, Meta>,
  isolationKey: string
): Promise<Response> {
  const since = Number.parseInt(new URL(request.url).searchParams.get("since") ?? "0", 10);
  const scoped = state.changes.filter((record) => record.isolationKey === isolationKey);
  const latestSequence = (state.nextChangeSequenceByIsolation.get(isolationKey) ?? 1) - 1;
  const droppedThrough = state.droppedChangeSequenceByIsolation.get(isolationKey) ?? 0;
  const truncated = Number.isFinite(since) && (
    since > latestSequence ||
    since < droppedThrough
  );
  const changes = scoped.filter((record) => Number.isFinite(since) ? record.sequence > since : true)
    .map(({ isolationKey: _isolationKey, ...record }) => record);
  return jsonResponse(200, {
    schemaVersion: 1,
    changes,
    latestSequence,
    truncated
  });
}

async function handleOperationStatus<Auth, Meta>(
  state: ServiceState<Auth, Meta>,
  isolationKey: string,
  operationIdValue: string | undefined
): Promise<Response> {
  const operationId = validateResourceId(operationIdValue, "operationId");
  const record = state.operationStatuses.get(scopedKey(isolationKey, operationId));
  if (!record) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS operation: ${operationId}`);
  }
  return jsonResponse(200, record.status);
}

function queueSessionEvent<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  session: SessionRecord<Auth, Meta>,
  type: ActiveFSSessionEvent["type"],
  payload: Record<string, unknown>
): Promise<void> {
  session.eventQueue = session.eventQueue
    .then(async () => {
      const event = await appendSessionEvent(options, session, type, payload);
      for (const sink of session.sinks) {
        enqueueSse(sink, event);
      }
    })
    .catch(() => undefined);
  return session.eventQueue;
}

async function appendSessionEvent<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  session: SessionRecord<Auth, Meta>,
  type: ActiveFSSessionEvent["type"],
  payload: Record<string, unknown>
): Promise<ActiveFSSessionEvent> {
  const event: ActiveFSSessionEvent = {
    id: `${session.sessionId}:${session.nextSequence}`,
    sessionId: session.sessionId,
    sequence: session.nextSequence,
    issuedAt: new Date().toISOString(),
    type,
    payload,
    payloadDigest: await sha256Base64(encoder.encode(JSON.stringify(payload))),
    previousEventDigest: session.previousEventDigest
  };
  if (session.eventSigningSecret) {
    event.eventMac = {
      algorithm: "hmac-sha-256",
      value: await hmacSha256Base64(session.eventSigningSecret, encoder.encode(JSON.stringify(event)))
    };
  }
  session.nextSequence += 1;
  session.previousEventDigest = await sha256Base64(encoder.encode(JSON.stringify(event)));
  session.events.push(event);
  const max = options.maxRetainedSessionEvents
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_SESSION_EVENTS : DEFAULT_MAX_RETAINED);
  if (session.events.length > max) {
    session.events.splice(0, session.events.length - max);
  }
  return event;
}

function enqueueSse(sink: SessionSink, event: ActiveFSSessionEvent): void {
  if (!sink.closed) {
    sink.controller.enqueue(encoder.encode(encodeSessionSse(event)));
  }
}

function encodeSessionSse(event: ActiveFSSessionEvent): string {
  const data = JSON.stringify(event).split(/\r?\n/).map((line) => `data: ${line}`).join("\r\n");
  return `id: ${event.sequence}\r\nevent: ${event.type}\r\n${data}\r\n\r\n`;
}

async function readRequestJson(request: Request, maxBytes: number, allowEmpty: boolean): Promise<unknown> {
  const advertisedLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new ActiveFSError("INVALID_REQUEST", "Source service request body exceeds the configured limit");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxBytes) {
          await reader.cancel();
          throw new ActiveFSError("INVALID_REQUEST", "Source service request body exceeds the configured limit");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") {
    if (allowEmpty) {
      return {};
    }
    throw new ActiveFSError("INVALID_REQUEST", "Source service requests must include a JSON body");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ActiveFSError("INVALID_REQUEST", "Source service request body must be valid JSON", { cause: error });
  }
}

function extractUntrustedContext<Auth, Meta>(
  body: unknown,
  requireObject: boolean
): Omit<ActiveFSContext<Auth, Meta>, "signal"> | undefined {
  if (!isRecord(body) || !("ctx" in body)) {
    return undefined;
  }
  if (!isRecord(body.ctx)) {
    if (requireObject) {
      throw new ActiveFSError("INVALID_REQUEST", "Source service ctx must be an object");
    }
    return undefined;
  }
  const { signal: _signal, ...context } = body.ctx as ActiveFSContext<Auth, Meta>;
  return context;
}

function sanitizedContextResolverError(error: unknown): ActiveFSError {
  if (error instanceof ActiveFSError) {
    const message = error.code === "UNAUTHORIZED"
      ? "Source API credentials are missing or invalid"
      : error.code === "FORBIDDEN"
        ? "Source API request is not permitted"
        : "Source API request context could not be resolved";
    return new ActiveFSError(error.code, message, { path: error.path });
  }
  return new ActiveFSError("SOURCE_ERROR", "Source API request context could not be resolved");
}

function protocolPath(body: unknown): ActiveFSPath {
  if (!isRecord(body) || typeof body.path !== "string") {
    throw new ActiveFSError("INVALID_REQUEST", "Source service request body must include path");
  }
  return normalizeActiveFSPath(body.path);
}

function operationBody(operation: ActiveFSSourceOperation): boolean {
  return ![
    "handshake",
    "capabilities",
    "config",
    "policy",
    "changes",
    "sessionEvents",
    "operationStatus"
  ].includes(operation);
}

function operationNeedsContext(operation: ActiveFSSourceOperation): boolean {
  return ![
    "handshake",
    "capabilities",
    "config",
    "policy",
    "changes",
    "sessionEvents",
    "sessionAck",
    "sessionActivity",
    "operationStatus"
  ].includes(operation);
}

function stripContextSignal<Auth, Meta>(
  context: ActiveFSContext<Auth, Meta>
): ActiveFSContext<Auth, Meta> {
  const { signal: _signal, ...stored } = context;
  return stored;
}

function assertMethod(operation: ActiveFSSourceOperation, method: string): void {
  const expected = operation === "handshake" || operation === "capabilities" || operation === "config" ||
    operation === "policy" || operation === "changes" || operation === "sessionEvents" || operation === "operationStatus"
    ? "GET"
    : "POST";
  if (method !== expected) {
    throw new ActiveFSError("UNSUPPORTED", `${operation} requires ${expected}`);
  }
}

function sessionLinks<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  request: Request,
  sessionId: string
): Pick<ActiveFSTreeSession, "eventEndpoint" | "ackEndpoint" | "activityEndpoint"> {
  if (options.resourceLinks?.session) {
    const links = options.resourceLinks.session({ request, sessionId });
    if (!isRecord(links)) {
      throw new ActiveFSError("SOURCE_ERROR", "Source API resourceLinks.session returned an invalid result");
    }
    for (const field of ["eventEndpoint", "ackEndpoint", "activityEndpoint"] as const) {
      assertConcreteResourceLink(links[field], request.url, `resourceLinks.session.${field}`);
    }
    return links;
  }
  throw new ActiveFSError(
    "SOURCE_ERROR",
    "Source API sessions require explicit resourceLinks.session route wiring"
  );
}

function operationStatusLink<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  request: Request,
  operationId: string
): string {
  if (options.resourceLinks?.operationStatus) {
    const link = options.resourceLinks.operationStatus({ request, operationId });
    assertConcreteResourceLink(link, request.url, "resourceLinks.operationStatus");
    return link;
  }
  throw new ActiveFSError(
    "SOURCE_ERROR",
    "Source API mutations require explicit resourceLinks.operationStatus route wiring"
  );
}

function assertConcreteResourceLink(value: unknown, requestUrl: string, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new ActiveFSError("SOURCE_ERROR", `Source API ${field} must return a non-empty URL reference`);
  }
  let resolved: URL;
  try {
    resolved = new URL(value, requestUrl);
  } catch {
    throw new ActiveFSError("SOURCE_ERROR", `Source API ${field} must return a valid URL reference`);
  }
  if ((resolved.protocol !== "http:" && resolved.protocol !== "https:")
    || resolved.hash || resolved.username || resolved.password) {
    throw new ActiveFSError(
      "SOURCE_ERROR",
      `Source API ${field} must return an HTTP(S) URL reference without credentials or a fragment`
    );
  }
}

function retainOperationStatus<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  isolationKey: string,
  status: ActiveFSTreeOperationStatus
): void {
  if (!state.isolationScopes.has(isolationKey)) return;
  state.operationStatuses.set(scopedKey(isolationKey, status.operationId), { isolationKey, status });
  const max = options.maxRetainedOperationStatuses
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_RETAINED : DEFAULT_MAX_RETAINED);
  while (operationStatusesForIsolation(state, isolationKey).length > max) {
    const oldest = operationStatusesForIsolation(state, isolationKey)[0];
    if (!oldest) break;
    state.operationStatuses.delete(oldest);
  }
}

function recordChange<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  isolationKey: string,
  status: ActiveFSTreeOperationStatus
): void {
  if (!state.isolationScopes.has(isolationKey)) return;
  const sequence = state.nextChangeSequenceByIsolation.get(isolationKey) ?? 1;
  state.nextChangeSequenceByIsolation.set(isolationKey, sequence + 1);
  state.changes.push({
    isolationKey,
    sequence,
    issuedAt: status.completedAt ?? new Date().toISOString(),
    type: "path.invalidated",
    path: status.path,
    targetPath: status.targetPath,
    revision: status.revision
  });
  const max = options.maxRetainedChanges
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_RETAINED : DEFAULT_MAX_RETAINED);
  const scoped = state.changes.filter((record) => record.isolationKey === isolationKey);
  if (scoped.length > max) {
    const remove = new Set(scoped.slice(0, scoped.length - max));
    const removedThrough = scoped[scoped.length - max - 1]?.sequence;
    state.changes = state.changes.filter((record) => !remove.has(record));
    if (removedThrough !== undefined) {
      state.droppedChangeSequenceByIsolation.set(isolationKey, removedThrough);
    }
  }
}

function sessionsForIsolation<Auth, Meta>(
  state: ServiceState<Auth, Meta>,
  isolationKey: string
): SessionRecord<Auth, Meta>[] {
  return [...state.sessions.values()].filter((record) => record.isolationKey === isolationKey);
}

function operationStatusesForIsolation<Auth, Meta>(
  state: ServiceState<Auth, Meta>,
  isolationKey: string
): string[] {
  return [...state.operationStatuses.entries()]
    .filter(([, record]) => record.isolationKey === isolationKey)
    .map(([key]) => key);
}

function makeIdempotencyCapacity<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  isolationKey: string
): void {
  const max = options.maxRetainedIdempotencyRecords
    ?? options.maxRetainedOperationStatuses
    ?? (options.resolveContext ? DEFAULT_HOSTED_MAX_RETAINED : DEFAULT_MAX_RETAINED);
  const globalMax = max * (options.maxRetainedIsolationScopes ?? DEFAULT_MAX_ISOLATION_SCOPES);
  while (state.idempotencyRecords.size >= globalMax) {
    const oldestSettled = [...state.idempotencyRecords.entries()].find(([, record]) => record.settled);
    if (!oldestSettled) {
      throw new ActiveFSError("TRANSIENT", "Source API idempotency capacity is temporarily exhausted");
    }
    state.idempotencyRecords.delete(oldestSettled[0]);
  }
  const scoped = [...state.idempotencyRecords.entries()]
    .filter(([, record]) => record.isolationKey === isolationKey);
  while (scoped.length >= max) {
    const oldestSettledIndex = scoped.findIndex(([, record]) => record.settled);
    if (oldestSettledIndex < 0) {
      throw new ActiveFSError("TRANSIENT", "Source API idempotency capacity is temporarily exhausted");
    }
    const [[key]] = scoped.splice(oldestSettledIndex, 1);
    state.idempotencyRecords.delete(key);
  }
}

async function mutationFingerprint(
  operation: string,
  requestBody: unknown,
  ignoreUntrustedContext: boolean
): Promise<string> {
  return sha256Hex(encoder.encode(stableStringify({
    operation,
    request: requestBodyForFingerprint(requestBody, ignoreUntrustedContext)
  })));
}

function requestBodyForFingerprint(value: unknown, ignoreUntrustedContext: boolean): unknown {
  if (!isRecord(value)) return value;
  const { ctx, ...withoutContext } = value;
  const body = ignoreUntrustedContext ? withoutContext : { ...withoutContext, ctx };
  if (!isRecord(body.options)) return body;
  const { idempotencyKey: _idempotencyKey, ...mutationOptions } = body.options;
  return { ...body, options: mutationOptions };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function touchIsolationScope<Auth, Meta>(
  options: ActiveFSSourceServiceOptions<Auth, Meta>,
  state: ServiceState<Auth, Meta>,
  isolationKey: string
): Promise<void> {
  if (state.evictedIsolationScopes.delete(isolationKey)) {
    state.nextChangeSequenceByIsolation.set(isolationKey, 2);
    state.droppedChangeSequenceByIsolation.set(isolationKey, 1);
  }
  state.isolationScopes.delete(isolationKey);
  state.isolationScopes.set(isolationKey, true);
  const max = options.maxRetainedIsolationScopes ?? DEFAULT_MAX_ISOLATION_SCOPES;
  while (state.isolationScopes.size > max) {
    const oldest = state.isolationScopes.keys().next().value as string | undefined;
    if (oldest === undefined || oldest === isolationKey) break;
    state.isolationScopes.delete(oldest);
    for (const session of sessionsForIsolation(state, oldest)) {
      await revokeAndDeleteSession(options, state, session, "isolation scope retention limit exceeded");
    }
    for (const [key, record] of state.operationStatuses) {
      if (record.isolationKey === oldest) state.operationStatuses.delete(key);
    }
    for (const [key, record] of state.idempotencyRecords) {
      if (record.isolationKey === oldest && record.settled) state.idempotencyRecords.delete(key);
    }
    state.changes = state.changes.filter((record) => record.isolationKey !== oldest);
    state.nextChangeSequenceByIsolation.delete(oldest);
    state.droppedChangeSequenceByIsolation.delete(oldest);
    state.evictedIsolationScopes.delete(oldest);
    state.evictedIsolationScopes.set(oldest, true);
    while (state.evictedIsolationScopes.size > max) {
      const oldestTombstone = state.evictedIsolationScopes.keys().next().value as string | undefined;
      if (oldestTombstone === undefined) break;
      state.evictedIsolationScopes.delete(oldestTombstone);
    }
  }
}

function operationUsesRetainedState(operation: ActiveFSSourceOperation): boolean {
  return operation === "changes"
    || operation === "createSession"
    || operation === "sessionEvents"
    || operation === "sessionAck"
    || operation === "sessionActivity"
    || operation === "operationStatus"
    || ["write", "delete", "mkdir", "rmdir", "rename", "copy", "truncate", "metadata"].includes(operation);
}

function validateServiceLimits<Auth, Meta>(options: ActiveFSSourceServiceOptions<Auth, Meta>): void {
  for (const [field, value] of Object.entries({
    maxRetainedOperationStatuses: options.maxRetainedOperationStatuses,
    maxRetainedIdempotencyRecords: options.maxRetainedIdempotencyRecords,
    maxRetainedChanges: options.maxRetainedChanges,
    maxRetainedSessions: options.maxRetainedSessions,
    maxRetainedSessionEvents: options.maxRetainedSessionEvents,
    maxRetainedIsolationScopes: options.maxRetainedIsolationScopes
  })) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new ActiveFSError("INVALID_REQUEST", `Source API ${field} must be a positive safe integer`);
    }
  }
  if (options.maxRequestBodyBytes !== undefined
    && (!Number.isSafeInteger(options.maxRequestBodyBytes) || options.maxRequestBodyBytes < 0)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API maxRequestBodyBytes must be a non-negative safe integer");
  }
  if (options.maxSessionActivityBacklog !== undefined
    && (!Number.isSafeInteger(options.maxSessionActivityBacklog) || options.maxSessionActivityBacklog < 0)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API maxSessionActivityBacklog must be a non-negative safe integer");
  }
}

async function operationIdForRequest(isolationKey: string, idempotencyKey: string | undefined): Promise<string> {
  if (idempotencyKey) {
    return `idempotency:${await sha256Hex(encoder.encode(`${isolationKey}\0${idempotencyKey}`))}`;
  }
  return crypto.randomUUID();
}

function scopedKey(isolationKey: string, id: string): string {
  return `${isolationKey.length}:${isolationKey}${id}`;
}

function mutationIdempotencyKey(value: unknown): string | undefined {
  return isRecord(value) && isRecord(value.options) && typeof value.options.idempotencyKey === "string"
    ? value.options.idempotencyKey
    : undefined;
}

function validateResourceId(value: string | undefined, label: string): string {
  if (!value || value.includes("/") || value.includes("\\")) {
    throw new ActiveFSError("INVALID_PATH", `Invalid Source API ${label}`);
  }
  return value;
}

function treeInfoToSourceStat<Meta>(
  info: NonNullable<ActiveFSTreeInfo<Meta>>,
  fallbackPath: ActiveFSPath
): ActiveFSStat<Meta> {
  const path = info.path ? normalizeActiveFSPath(info.path) : fallbackPath;
  return {
    name: info.name ?? (path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1)),
    path,
    kind: info.kind ?? "file",
    capabilities: treeCapabilitiesFromInfo(info),
    size: info.size,
    mtimeMs: info.mtimeMs,
    mimeType: info.type,
    enumerable: info.enumerable,
    meta: info.data,
    etag: info.etag,
    revision: info.revision
  };
}

function treeListToSourceEntries<Auth, Meta>(
  result: ActiveFSTreeListResult<Auth, Meta>,
  basePath: ActiveFSPath
): ActiveFSDirEntry<Meta>[] {
  if (Array.isArray(result)) {
    return result
      .filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info))
      .map((info) => treeInfoToSourceEntry(info, basePath))
      .sort(compareEntries);
  }
  return Object.entries(result)
    .map(([name, declaration]) => {
      const path = joinActiveFSPath(basePath, name);
      const node = declaration as ActiveFSTreeNodeDeclaration<Auth, Meta> & { treeNodeKind?: "file" | "directory" };
      return {
        name,
        path,
        kind: node.treeNodeKind === "file" ? "file" : "directory",
        capabilities: {}
      } as ActiveFSDirEntry<Meta>;
    })
    .sort(compareEntries);
}

function treeInfoToSourceEntry<Meta>(
  info: NonNullable<ActiveFSTreeInfo<Meta>>,
  basePath: ActiveFSPath
): ActiveFSDirEntry<Meta> {
  const path = normalizeActiveFSPath(info.path ?? joinActiveFSPath(basePath, info.name ?? ""));
  return {
    name: info.name ?? path.slice(path.lastIndexOf("/") + 1),
    path,
    kind: info.kind ?? "file",
    capabilities: treeCapabilitiesFromInfo(info),
    size: info.size,
    mtimeMs: info.mtimeMs,
    mimeType: info.type,
    enumerable: info.enumerable,
    meta: info.data
  };
}

function treeCapabilitiesFromInfo<Meta>(info: NonNullable<ActiveFSTreeInfo<Meta>>) {
  return {
    read: info.permissions?.readable,
    readable: info.permissions?.readable,
    write: info.permissions?.writable,
    writable: info.permissions?.writable,
    search: info.permissions?.searchable,
    searchable: info.permissions?.searchable,
    delete: info.permissions?.deletable,
    rename: info.permissions?.renamable,
    copy: info.permissions?.copyable
  };
}

function compareEntries<Meta>(left: ActiveFSDirEntry<Meta>, right: ActiveFSDirEntry<Meta>): number {
  return left.path.localeCompare(right.path);
}

function treeSearchToSourceSearch<Meta>(result: ActiveFSTreeSearchResult<Meta>): ActiveFSSearchResult<Meta> {
  return {
    matches: result.matches.map((match) => ({
      path: normalizeActiveFSPath(match.path),
      line: match.line,
      column: match.column,
      excerpt: match.excerpt,
      score: match.score,
      meta: match.data ?? match.meta
    })),
    complete: result.complete,
    strategy: result.strategy,
    incompleteReasons: result.incompleteReasons
  };
}

async function encodeTreeCommandResult<Auth, Meta, Command extends ActiveFSTreeCommand>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  command: Command,
  path: ActiveFSPath,
  input: ActiveFSCommandInput<Command>
): Promise<EncodedCommandResult<Meta>> {
  const result = await tree.command(context, command, path, input);
  if (command === "ls") {
    return {
      entries: (result as ActiveFSTreeCommandResultMap<Meta>["ls"])
        .map((info) => treeInfoToSourceEntry(info, path))
        .sort(compareEntries)
    };
  }
  if (command === "stat") {
    const info = result as ActiveFSTreeCommandResultMap<Meta>["stat"];
    return { stat: info ? treeInfoToSourceStat(info, path) : null };
  }
  if (command === "grep" || command === "rg") {
    return { search: treeSearchToSourceSearch(result as ActiveFSTreeCommandResultMap<Meta>["grep"]) };
  }
  if (command === "find") {
    return {
      stats: (result as ActiveFSTreeCommandResultMap<Meta>["find"])
        .map((info) => treeInfoToSourceStat(info, info.path ? normalizeActiveFSPath(info.path) : path))
    };
  }
  const readResult = result as ActiveFSTreeReadResult<Meta>;
  const info = treeReadInfo(readResult) ?? await tree.info(context, path);
  return {
    read: encodeReadResult({
      content: treeContentToSourceContent(treeReadContent(readResult)),
      stat: info ? treeInfoToSourceStat(info, path) : undefined,
      meta: treeReadData(readResult) ?? info?.data
    })
  };
}

function treeReadContent<Meta>(result: ActiveFSTreeReadResult<Meta>): string | Uint8Array | ArrayBuffer {
  return typeof result === "string" || result instanceof Uint8Array || result instanceof ArrayBuffer
    ? result
    : result.content;
}

function treeReadInfo<Meta>(result: ActiveFSTreeReadResult<Meta>): ActiveFSTreeInfo<Meta> | undefined {
  return typeof result === "object" && !(result instanceof Uint8Array) && !(result instanceof ArrayBuffer) && "content" in result
    ? result.info
    : undefined;
}

function treeReadData<Meta>(result: ActiveFSTreeReadResult<Meta>): Meta | undefined {
  return typeof result === "object" && !(result instanceof Uint8Array) && !(result instanceof ArrayBuffer) && "content" in result
    ? result.data ?? result.meta
    : undefined;
}

function treeContentToSourceContent(content: string | Uint8Array | ArrayBuffer): string | Uint8Array {
  return content instanceof ArrayBuffer ? new Uint8Array(content) : content;
}

function encodeReadResult<Meta>(result: ActiveFSReadResult<Meta>): EncodedReadResult<Meta> {
  return {
    ...(typeof result.content === "string" ? { content: result.content } : { contentBase64: bytesToBase64(result.content) }),
    stat: result.stat,
    meta: result.meta
  };
}

function decodeWriteContent(body: WriteProtocolBody): string | Uint8Array {
  if (typeof body.content === "string") {
    return body.content;
  }
  if (typeof body.contentBase64 === "string") {
    return base64ToBytes(body.contentBase64);
  }
  throw new ActiveFSError("INVALID_REQUEST", "Write request must include content or contentBase64");
}

async function verifyWriteDigest(
  content: string | Uint8Array,
  digest: WriteProtocolBody["digest"],
  path: ActiveFSPath
): Promise<void> {
  if (!digest) {
    return;
  }
  if (digest.algorithm !== "sha-256") {
    throw new ActiveFSError("UNSUPPORTED", `Unsupported write digest algorithm: ${digest.algorithm}`, { path });
  }
  if (await sha256Base64(activeFSContentToBytes(content)) !== digest.value) {
    throw new ActiveFSError("INVALID_REQUEST", "Write content digest mismatch", { path });
  }
}

function mutationRevision<Auth, Meta>(result: ActiveFSTreeMutationResult<Auth, Meta>): string | undefined {
  const record = isRecord(result) ? result as Record<string, unknown> : undefined;
  return typeof record?.revision === "string" ? record.revision : undefined;
}

function mutationData<Auth, Meta>(result: ActiveFSTreeMutationResult<Auth, Meta>): Meta | undefined {
  const record = isRecord(result) ? result as Record<string, unknown> : undefined;
  return record ? (record.data ?? record.meta) as Meta | undefined : undefined;
}

function mutationCreated<Auth, Meta>(
  result: ActiveFSTreeMutationResult<Auth, Meta>,
  path: ActiveFSPath
): boolean | undefined {
  if (!isRecord(result) || !("created" in result)) {
    return undefined;
  }
  return result.created === path;
}

async function jsonResponse(status: number, body: unknown): Promise<Response> {
  const payload = `${JSON.stringify(body)}\n`;
  return new Response(payload, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "repr-digest": await contentDigestHeader(encoder.encode(payload))
    }
  });
}

async function errorResponse(error: unknown): Promise<Response> {
  const activeError = toActiveFSError(error);
  const payload = activeFSErrorPayload(activeError);
  const operation = operationReferenceFromError(error);
  return jsonResponse(statusForError(activeError, protocolErrorCodeFromActiveFS(activeError.code)), {
    error: payload,
    operation
  } satisfies ActiveFSErrorResponse);
}

function operationReferenceFromError(error: unknown) {
  return isRecord(error) && typeof error.operationId === "string" &&
    typeof error.operationStatusEndpoint === "string"
    ? {
      operationId: error.operationId,
      operationStatusEndpoint: error.operationStatusEndpoint
    }
    : undefined;
}

function toActiveFSError(error: unknown): ActiveFSError {
  if (error instanceof ActiveFSError) {
    if (error.code === "SOURCE_ERROR") {
      return new ActiveFSError("SOURCE_ERROR", "Source API service failed", { path: error.path, cause: error });
    }
    if (error.code === "UNAUTHORIZED") {
      return new ActiveFSError("UNAUTHORIZED", "Source API credentials are missing or invalid", {
        path: error.path,
        cause: error
      });
    }
    return error;
  }
  return new ActiveFSError("SOURCE_ERROR", "Source API service failed", { cause: error });
}

function activeFSErrorPayload(error: unknown): ActiveFSErrorPayload {
  const activeError = toActiveFSError(error);
  const code = protocolErrorCodeFromActiveFS(activeError.code);
  return {
    name: protocolErrorName(code),
    code,
    internalCode: activeError.code,
    message: activeError.message,
    path: activeError.path
  };
}

function statusForError(error: ActiveFSError, code: ActiveFSTreeProtocolErrorCode): number {
  if (error.code === "UNAUTHORIZED") {
    return 401;
  }
  switch (code) {
    case "INVALID_PATH":
    case "NOT_A_DIRECTORY":
    case "IS_DIRECTORY":
      return 400;
    case "PERMISSION_DENIED":
      return 403;
    case "CONFLICT":
      return 409;
    case "PRECONDITION_FAILED":
      return 412;
    case "RANGE_NOT_SATISFIABLE":
      return 416;
    case "NOT_FOUND":
      return 404;
    case "UNSUPPORTED_OPERATION":
      return 405;
    case "TRANSIENT_TRANSPORT":
    case "SOURCE_UNAVAILABLE":
      return 503;
    case "TIMEOUT":
      return 504;
    case "INTERNAL_ERROR":
    default:
      return 500;
  }
}

function protocolErrorCodeFromActiveFS(code: ActiveFSError["code"]): ActiveFSTreeProtocolErrorCode {
  switch (code) {
    case "NOT_FOUND":
    case "NOT_MOUNTED":
      return "NOT_FOUND";
    case "NOT_DIRECTORY":
      return "NOT_A_DIRECTORY";
    case "NOT_FILE":
      return "IS_DIRECTORY";
    case "INVALID_PATH":
    case "INVALID_REQUEST":
      return "INVALID_PATH";
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "PERMISSION_DENIED";
    case "CONFLICT":
      return "CONFLICT";
    case "PRECONDITION_FAILED":
      return "PRECONDITION_FAILED";
    case "TRANSIENT":
      return "TRANSIENT_TRANSPORT";
    case "UNSUPPORTED":
      return "UNSUPPORTED_OPERATION";
    case "SOURCE_ERROR":
    default:
      return "INTERNAL_ERROR";
  }
}

function protocolErrorName(code: ActiveFSTreeProtocolErrorCode): string {
  const names: Record<ActiveFSTreeProtocolErrorCode, string> = {
    NOT_FOUND: "ActiveFSNotFoundError",
    NOT_A_DIRECTORY: "ActiveFSNotADirectoryError",
    IS_DIRECTORY: "ActiveFSIsDirectoryError",
    PERMISSION_DENIED: "ActiveFSPermissionDeniedError",
    CONFLICT: "ActiveFSConflictError",
    PRECONDITION_FAILED: "ActiveFSPreconditionFailedError",
    UNSUPPORTED_OPERATION: "ActiveFSUnsupportedOperationError",
    INVALID_PATH: "ActiveFSInvalidPathError",
    RANGE_NOT_SATISFIABLE: "ActiveFSRangeNotSatisfiableError",
    TRANSIENT_TRANSPORT: "ActiveFSTransientTransportError",
    SOURCE_UNAVAILABLE: "ActiveFSTreeUnavailableError",
    TIMEOUT: "ActiveFSTimeoutError",
    INTERNAL_ERROR: "ActiveFSInternalError"
  };
  return names[code];
}

async function contentDigestHeader(bytes: Uint8Array): Promise<string> {
  return `sha-256=:${await sha256Base64(bytes)}:`;
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256Base64(secret: Uint8Array, bytes: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(bytes))));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeHeaderJson(value: unknown): string {
  return bytesToBase64(encoder.encode(JSON.stringify(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function isActiveFSTreeCommand(value: unknown): value is ActiveFSTreeCommand {
  return typeof value === "string" && ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"].includes(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
