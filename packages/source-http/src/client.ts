import {
  ActiveFSError,
  activeFSContentToBytes,
  joinActiveFSPath,
  matchesActiveFSWatchRoot,
  normalizeActiveFSPath,
  runDefaultActiveFSTreeCommand,
  type ActiveFSCapabilities,
  type ActiveFSCommandInput,
  type ActiveFSContext,
  type ActiveFSCopyResult,
  type ActiveFSDeleteResult,
  type ActiveFSDirEntry,
  type ActiveFSErrorCode,
  type ActiveFSMkdirResult,
  type ActiveFSMetadataUpdateResult,
  type ActiveFSPath,
  type ActiveFSReadResult,
  type ActiveFSRenameResult,
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
  type ActiveFSTruncateResult,
  type ActiveFSWatchEvent,
  type ActiveFSWatchOptions,
  type ActiveFSWatchSubscription,
  type ActiveFSWriteResult,
  type MaybePromise
} from "@activefs/core";
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";
import {
  ACTIVEFS_SOURCE_ENDPOINT_KEYS,
  ACTIVEFS_SOURCE_PROTOCOL_VERSION,
  assertActiveFSSourceCapabilityEndpoints,
  assertActiveFSSourceCapabilities,
  assertActiveFSSourceConfigDocument,
  assertActiveFSSourceHandshake,
  resolveActiveFSSourceUrl,
  validateActiveFSSourceDiscoveryUrl,
  type ActiveFSErrorResponse,
  type ActiveFSOperationReference,
  type ActiveFSSessionEvent,
  type ActiveFSSourceConfigDocument,
  type ActiveFSSourceEndpoints,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeOperationStatus,
  type ActiveFSTreeProtocolErrorCode,
  type ActiveFSTreeServiceCapabilities,
  type ActiveFSTreeSession,
  type ActiveFSTreeSessionAckResult,
  type ActiveFSTreeSessionActivityResult
} from "./protocol.js";

export type HttpSourceClientAuth =
  | string
  | { type?: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { headers: Record<string, string> }
  | ((request: HttpSourceClientAuthRequest) => MaybePromise<Record<string, string>>);

export interface HttpSourceClientAuthRequest {
  method: "GET" | "POST";
  endpoint: string;
  url: string;
}

export interface HttpSourceClientOptions {
  /** Exact discovery/handshake URL. It is never treated as a service base. */
  url: string | URL;
  auth?: HttpSourceClientAuth | false;
  /** Explicit auth descriptors for individually approved cross-origin endpoints. */
  authByOrigin?: Readonly<Record<string, HttpSourceClientAuth | false>>;
  allowedEndpointOrigins?: readonly string[];
  allowInsecureHttp?: boolean;
  maxRedirects?: number;
  fetch?: typeof fetch;
  name?: string;
  capabilities?: Partial<ActiveFSTreeServiceCapabilities>;
  handshake?: ActiveFSTreeHandshake;
  /** Optional shared secret used to authenticate signed session events. */
  eventMacSecret?: string | Uint8Array;
}

/** Options for consuming one discovered session event stream. */
export interface HttpActiveFSSessionEventStreamOptions {
  signal?: AbortSignal;
  verificationState?: ActiveFSSessionEventVerificationState;
}

export interface HttpActiveFSTree<Auth = unknown, Meta = unknown> extends ActiveFSTree<Auth, Meta> {
  discoveryUrl: string;
  fetchHandshake(): Promise<ActiveFSTreeHandshake>;
  /** Refetches discovery and atomically replaces the client's endpoint map. */
  refreshHandshake(): Promise<ActiveFSTreeHandshake>;
  fetchCapabilities(): Promise<ActiveFSTreeServiceCapabilities>;
  fetchConfig(): Promise<ActiveFSSourceConfigDocument | undefined>;
  createSession(
    context?: ActiveFSContext<Auth, Meta>,
    path?: ActiveFSPath,
    options?: Omit<ActiveFSWatchOptions, "signal">
  ): Promise<ActiveFSTreeSession>;
  ackSession(sessionId: string, lastAppliedSequence: number): Promise<ActiveFSTreeSessionAckResult>;
  reportSessionActivity(sessionId: string, activity: unknown): Promise<ActiveFSTreeSessionActivityResult>;
  /** Consumes and verifies one session's discovered SSE event stream. */
  streamSessionEvents(
    sessionId: string,
    onEvent: (
      event: ActiveFSSessionEvent,
      verificationState: ActiveFSSessionEventVerificationState
    ) => MaybePromise<void>,
    options?: HttpActiveFSSessionEventStreamOptions
  ): Promise<ActiveFSSessionEventVerificationState>;
  fetchOperationStatus(reference: string | ActiveFSOperationReference): Promise<ActiveFSTreeOperationStatus>;
}

export interface ActiveFSSessionEventVerificationState {
  sessionId?: string;
  lastSequence?: number;
  previousEventDigest?: string;
  eventMacSecret?: string | Uint8Array;
  requireEventMac?: boolean;
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

interface ResolvedHandshake {
  document: ActiveFSTreeHandshake;
  endpoints: ActiveFSSourceEndpoints;
  responseUrl: string;
}

interface RequestResult {
  response: Response;
  finalUrl: string;
}

interface JsonRequestResult<Result> {
  value: Result;
  responseUrl: string;
}

/** Creates an ActiveFSTree backed by a discovery-driven Source API. */
export function createHttpSourceClient<Auth = unknown, Meta = unknown>(
  options: HttpSourceClientOptions
): HttpActiveFSTree<Auth, Meta> {
  const discoveryUrl = validateActiveFSSourceDiscoveryUrl(options.url, {
    allowInsecureHttp: options.allowInsecureHttp
  });
  const fetchImpl = options.fetch ?? fetch;
  const mutableCapabilities = activeFSCapabilitiesFromProtocol(options.capabilities);
  const sessions = new Map<string, ActiveFSTreeSession>();
  const operationLinks = new Map<string, string>();
  let handshakePromise: Promise<ResolvedHandshake> | undefined;

  const applyResolvedHandshake = (resolved: ResolvedHandshake): ResolvedHandshake => {
    Object.assign(mutableCapabilities, activeFSCapabilitiesFromProtocol(resolved.document.capabilities));
    return resolved;
  };

  const ensureHandshake = (): Promise<ResolvedHandshake> => {
    handshakePromise ??= options.handshake
      ? Promise.resolve(resolveHandshake(options.handshake, discoveryUrl, options))
      : fetchDiscovery(options, fetchImpl, discoveryUrl).then(({ document, responseUrl }) =>
        resolveHandshake(document, responseUrl, options)
      );
    return handshakePromise.then(applyResolvedHandshake);
  };

  const refreshHandshake = async (): Promise<ResolvedHandshake> => {
    const pending = fetchDiscovery(options, fetchImpl, discoveryUrl).then(({ document, responseUrl }) =>
      resolveHandshake(document, responseUrl, options)
    );
    handshakePromise = pending;
    try {
      return applyResolvedHandshake(await pending);
    } catch (error) {
      if (handshakePromise === pending) handshakePromise = undefined;
      throw error;
    }
  };

  const requestJsonWithResponse = async <Result>(
    endpointKey: keyof ActiveFSSourceEndpoints,
    method: "GET" | "POST",
    body?: unknown,
    path?: ActiveFSPath
  ): Promise<JsonRequestResult<Result>> => {
    const handshake = await ensureHandshake();
    const url = handshake.endpoints[endpointKey];
    if (!url) {
      throw new ActiveFSError("UNSUPPORTED", `Source API did not advertise endpoints.${endpointKey}`, { path });
    }
    const { response, finalUrl } = await authenticatedFetch(options, fetchImpl, method, endpointKey, url, {
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const error = await activeFSErrorFromResponse(response, path);
      const reference = operationReferenceFromError(error);
      if (reference) {
        retainOperationLink(reference, operationLinks, response.url || finalUrl, options);
      }
      throw error;
    }
    return {
      value: JSON.parse(await verifiedResponseText(response, path)) as Result,
      responseUrl: response.url || finalUrl
    };
  };

  const requestJson = async <Result>(
    endpointKey: keyof ActiveFSSourceEndpoints,
    method: "GET" | "POST",
    body?: unknown,
    path?: ActiveFSPath
  ): Promise<Result> => (await requestJsonWithResponse<Result>(endpointKey, method, body, path)).value;

  const tree: HttpActiveFSTree<Auth, Meta> = {
    name: options.name ?? "http-source",
    discoveryUrl,
    capabilities: mutableCapabilities,
    set: unsupportedHttpTreeDeclarationMutation,
    path: unsupportedHttpTreePathHandle,
    pre() { return this; },
    post() { return this; },
    on() { return this; },
    onChange() { return this; },
    fetchHandshake: async () => (await ensureHandshake()).document,
    refreshHandshake: async () => (await refreshHandshake()).document,
    fetchCapabilities: async () => {
      const handshake = await ensureHandshake();
      if (!handshake.endpoints.capabilities) {
        return handshake.document.capabilities;
      }
      const capabilities = await requestJson<ActiveFSTreeServiceCapabilities>("capabilities", "GET");
      assertActiveFSSourceCapabilities(capabilities);
      assertActiveFSSourceCapabilityEndpoints(capabilities, handshake.endpoints);
      Object.assign(mutableCapabilities, activeFSCapabilitiesFromProtocol(capabilities));
      return capabilities;
    },
    fetchConfig: async () => {
      const handshake = await ensureHandshake();
      if (!handshake.endpoints.config) {
        return undefined;
      }
      const config = await requestJson<ActiveFSSourceConfigDocument>("config", "GET");
      assertActiveFSSourceConfigDocument(config);
      if (config.capabilities) {
        assertActiveFSSourceCapabilityEndpoints(config.capabilities, handshake.endpoints);
      }
      return config;
    },
    createSession: async (context = {}, path = "/", watchOptions) => {
      const { value: session, responseUrl } = await requestJsonWithResponse<ActiveFSTreeSession>("sessions", "POST", {
        ctx: serializeContext(context),
        path: normalizeActiveFSPath(path),
        options: watchOptions
      });
      const resolved = {
        ...session,
        eventEndpoint: resolveConcreteLink(session.eventEndpoint, responseUrl, options),
        ackEndpoint: resolveConcreteLink(session.ackEndpoint, responseUrl, options),
        activityEndpoint: resolveConcreteLink(session.activityEndpoint, responseUrl, options)
      };
      sessions.set(resolved.sessionId, resolved);
      return resolved;
    },
    ackSession: async (sessionId, lastAppliedSequence) => {
      const session = requireSession(sessions, sessionId);
      return requestConcreteJson<ActiveFSTreeSessionAckResult>(
        options,
        fetchImpl,
        "POST",
        "sessionAck",
        session.ackEndpoint,
        { lastAppliedSequence }
      );
    },
    reportSessionActivity: async (sessionId, activity) => {
      const session = requireSession(sessions, sessionId);
      return requestConcreteJson<ActiveFSTreeSessionActivityResult>(
        options,
        fetchImpl,
        "POST",
        "sessionActivity",
        session.activityEndpoint,
        activity
      );
    },
    streamSessionEvents: async (sessionId, onEvent, streamOptions) => {
      const session = requireSession(sessions, sessionId);
      const { response } = await authenticatedFetch(
        options,
        fetchImpl,
        "GET",
        "sessionEvents",
        session.eventEndpoint,
        {
          headers: {
            accept: "text/event-stream",
            ...(streamOptions?.verificationState?.lastSequence === undefined
              ? {}
              : { "last-event-id": String(streamOptions.verificationState.lastSequence) })
          },
          signal: streamOptions?.signal
        }
      );
      if (!response.ok) {
        throw await activeFSErrorFromResponse(response);
      }
      if (!response.body) {
        throw new ActiveFSError("SOURCE_ERROR", "HTTP Source API events response did not include a body");
      }
      let verification: ActiveFSSessionEventVerificationState = {
        ...streamOptions?.verificationState,
        sessionId,
        eventMacSecret: streamOptions?.verificationState?.eventMacSecret ?? options.eventMacSecret,
        requireEventMac: streamOptions?.verificationState?.requireEventMac
          ?? Boolean(options.eventMacSecret && session.integrity.eventMac)
      };
      await parseSse(response.body, async (value) => {
        const event = value as ActiveFSSessionEvent;
        verification = verifyActiveFSSessionEvent(event, verification);
        await onEvent(event, verification);
      });
      return verification;
    },
    fetchOperationStatus: async (reference) => {
      const operationId = typeof reference === "string" ? validateResourceId(reference, "operationId") : reference.operationId;
      const endpoint = typeof reference === "string" ? operationLinks.get(operationId) : reference.operationStatusEndpoint;
      if (!endpoint) {
        throw new ActiveFSError(
          "INVALID_REQUEST",
          `Operation ${operationId} requires its concrete operationStatusEndpoint`
        );
      }
      const handshake = await ensureHandshake();
      const resolvedEndpoint = resolveConcreteLink(endpoint, handshake.responseUrl, options);
      return requestConcreteJson<ActiveFSTreeOperationStatus>(options, fetchImpl, "GET", "operationStatus", resolvedEndpoint);
    },
    info: async (context, path) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const stat = await requestJson<ActiveFSStat<Meta> | null>("stat", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context)
      }, normalizedPath);
      return stat ? sourceStatToTreeInfo(stat) : null;
    },
    list: async (context, path) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const entries = await requestJson<ActiveFSDirEntry<Meta>[]>("list", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context)
      }, normalizedPath);
      return entries.map(sourceEntryToTreeInfo);
    },
    read: async (context, path, readOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const result = await requestJson<EncodedReadResult<Meta>>("read", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        options: readOptions
      }, normalizedPath);
      return sourceReadResultToTreeReadResult(decodeReadResult(result));
    },
    search: async (context, path, query) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const result = await requestJson<ActiveFSSearchResult<Meta>>("search", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        query
      }, normalizedPath);
      return sourceSearchResultToTreeSearchResult(result);
    },
    walk: async (context, path, walkOptions) => walkHttpTree(tree, context, path, walkOptions),
    command: async (context, command, path, input) => {
      const handshake = await ensureHandshake();
      if (!handshake.endpoints.command) {
        return runDefaultActiveFSTreeCommand(tree, context, command, path, input);
      }
      const normalizedPath = normalizeActiveFSPath(path);
      const result = await requestJson<EncodedCommandResult<Meta>>("command", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        command,
        input
      }, normalizedPath);
      return decodeHttpTreeCommandResult(command, result);
    },
    write: async (context, path, content, writeOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSWriteResult<Meta> & Partial<ActiveFSOperationReference>>("write", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        ...encodeWriteContent(content),
        digest: digestForWriteContent(content),
        options: writeOptions
      }, normalizedPath);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        ...sourceWriteResultToTreeMutation(normalizedPath, result),
        operationStatusEndpoint: result.operationStatusEndpoint
      } as unknown as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    remove: async (context, path, deleteOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSDeleteResult<Meta> & Partial<ActiveFSOperationReference>>("delete", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        options: deleteOptions
      }, normalizedPath);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        removed: result.path,
        operationId: result.operationId,
        operationStatusEndpoint: result.operationStatusEndpoint,
        revision: result.revision,
        data: result.meta
      } as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    makeDir: async (context, path, mkdirOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSMkdirResult<Meta> & Partial<ActiveFSOperationReference>>("mkdir", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        options: mkdirOptions
      }, normalizedPath);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        ...sourceMkdirResultToTreeMutation(normalizedPath, result),
        operationStatusEndpoint: result.operationStatusEndpoint
      } as unknown as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    move: async (context, fromPath, toPath, renameOptions) => {
      const from = normalizeActiveFSPath(fromPath);
      const to = normalizeActiveFSPath(toPath);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSRenameResult<Meta> & Partial<ActiveFSOperationReference>>("rename", "POST", {
        path: from,
        toPath: to,
        ctx: serializeContext(context),
        options: renameOptions
      }, from);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        moved: { from: result.from, to: result.to },
        info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        operationStatusEndpoint: result.operationStatusEndpoint,
        revision: result.revision,
        data: result.meta
      } as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    copy: async (context, fromPath, toPath, copyOptions) => {
      const from = normalizeActiveFSPath(fromPath);
      const to = normalizeActiveFSPath(toPath);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSCopyResult<Meta> & Partial<ActiveFSOperationReference>>("copy", "POST", {
        path: from,
        toPath: to,
        ctx: serializeContext(context),
        options: copyOptions
      }, from);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        copied: { from: result.from, to: result.to },
        info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        operationStatusEndpoint: result.operationStatusEndpoint,
        revision: result.revision,
        data: result.meta
      } as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    truncate: async (context, path, truncateOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSTruncateResult<Meta> & Partial<ActiveFSOperationReference>>("truncate", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        options: truncateOptions
      }, normalizedPath);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        modified: normalizedPath,
        info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        operationStatusEndpoint: result.operationStatusEndpoint,
        revision: result.revision,
        data: result.meta
      } as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    updateInfo: async (context, path, metadataOptions) => {
      const normalizedPath = normalizeActiveFSPath(path);
      const { value: result, responseUrl } = await requestJsonWithResponse<ActiveFSMetadataUpdateResult<Meta> & Partial<ActiveFSOperationReference>>("metadata", "POST", {
        path: normalizedPath,
        ctx: serializeContext(context),
        options: metadataOptions
      }, normalizedPath);
      retainOperationLink(result, operationLinks, responseUrl, options);
      return {
        modified: normalizedPath,
        info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
        operationId: result.operationId,
        operationStatusEndpoint: result.operationStatusEndpoint,
        revision: result.revision,
        data: result.meta
      } as ActiveFSTreeMutationResult<Auth, Meta>;
    },
    watch: async (context, path, onEvent, watchOptions) => watchHttpSource({
      client: tree,
      authOptions: options,
      fetch: fetchImpl,
      context,
      path,
      onEvent,
      options: watchOptions
    })
  };

  return tree;
}

async function fetchDiscovery(
  options: HttpSourceClientOptions,
  fetchImpl: typeof fetch,
  discoveryUrl: string
): Promise<{ document: ActiveFSTreeHandshake; responseUrl: string }> {
  const { response, finalUrl } = await authenticatedFetch(options, fetchImpl, "GET", "handshake", discoveryUrl, {
    headers: { accept: "application/json" }
  });
  if (!response.ok) {
    throw await activeFSErrorFromResponse(response);
  }
  const document = JSON.parse(await verifiedResponseText(response)) as ActiveFSTreeHandshake;
  return { document, responseUrl: response.url || finalUrl };
}

function resolveHandshake(
  document: ActiveFSTreeHandshake,
  responseUrl: string,
  options: HttpSourceClientOptions
): ResolvedHandshake {
  assertActiveFSSourceHandshake(document);
  const endpoints = { ...document.endpoints };
  for (const key of ACTIVEFS_SOURCE_ENDPOINT_KEYS) {
    const reference = document.endpoints[key];
    if (reference) {
      endpoints[key] = resolveActiveFSSourceUrl(reference, responseUrl, {
        allowedOrigins: options.allowedEndpointOrigins,
        allowInsecureHttp: options.allowInsecureHttp
      });
    }
  }
  return {
    document: { ...document, endpoints },
    endpoints,
    responseUrl
  };
}

async function authenticatedFetch(
  options: HttpSourceClientOptions,
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  endpoint: string,
  url: string,
  init: Omit<RequestInit, "method" | "redirect">
): Promise<RequestResult> {
  let current = url;
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (endpoint === "handshake") {
      validateActiveFSSourceDiscoveryUrl(current, { allowInsecureHttp: options.allowInsecureHttp });
    } else {
      resolveActiveFSSourceUrl(current, options.url, {
        allowedOrigins: options.allowedEndpointOrigins,
        allowInsecureHttp: options.allowInsecureHttp
      });
    }
    const auth = authForUrl(options, current);
    const authHeaders = await clientAuthHeaders(auth, { method, endpoint, url: current });
    const response = await fetchImpl(current, {
      ...init,
      method,
      redirect: "manual",
      headers: { ...headersToRecord(init.headers), ...authHeaders }
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: current };
    }
    if (redirects === maxRedirects) {
      throw new ActiveFSError("SOURCE_ERROR", "Source API redirect limit exceeded");
    }
    const location = response.headers.get("location");
    if (!location) {
      throw new ActiveFSError("SOURCE_ERROR", "Source API redirect did not include Location");
    }
    current = resolveActiveFSSourceUrl(location, current, {
      allowedOrigins: options.allowedEndpointOrigins,
      allowInsecureHttp: options.allowInsecureHttp
    });
  }
  throw new ActiveFSError("SOURCE_ERROR", "Source API redirect limit exceeded");
}

function authForUrl(options: HttpSourceClientOptions, url: string): HttpSourceClientAuth | false | undefined {
  const discoveryOrigin = new URL(validateActiveFSSourceDiscoveryUrl(options.url, {
    allowInsecureHttp: options.allowInsecureHttp
  })).origin;
  const origin = new URL(url).origin;
  if (origin === discoveryOrigin) {
    return options.auth;
  }
  return options.authByOrigin?.[origin] ?? false;
}

async function requestConcreteJson<Result>(
  options: HttpSourceClientOptions,
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  endpoint: string,
  url: string,
  body?: unknown
): Promise<Result> {
  const { response } = await authenticatedFetch(options, fetchImpl, method, endpoint, url, {
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw await activeFSErrorFromResponse(response);
  }
  return JSON.parse(await verifiedResponseText(response)) as Result;
}

function retainOperationLink(
  result: Partial<ActiveFSOperationReference>,
  links: Map<string, string>,
  responseUrl: string,
  options: HttpSourceClientOptions
): void {
  if (typeof result.operationId === "string" && typeof result.operationStatusEndpoint === "string") {
    const resolved = resolveConcreteLink(result.operationStatusEndpoint, responseUrl, options);
    result.operationStatusEndpoint = resolved;
    links.set(result.operationId, resolved);
  }
}

function resolveConcreteLink(reference: string, responseUrl: string, options: HttpSourceClientOptions): string {
  return resolveActiveFSSourceUrl(reference, responseUrl, {
    allowedOrigins: options.allowedEndpointOrigins,
    allowInsecureHttp: options.allowInsecureHttp
  });
}

function requireSession(sessions: Map<string, ActiveFSTreeSession>, sessionId: string): ActiveFSTreeSession {
  validateResourceId(sessionId, "sessionId");
  const session = sessions.get(sessionId);
  if (!session) {
    throw new ActiveFSError("INVALID_REQUEST", `Session ${sessionId} has no discovered resource links`);
  }
  return session;
}

async function watchHttpSource<Auth, Meta>(options: {
  client: HttpActiveFSTree<Auth, Meta>;
  authOptions: HttpSourceClientOptions;
  fetch: typeof fetch;
  context: ActiveFSContext<Auth, Meta>;
  path: ActiveFSPath;
  onEvent: (event: ActiveFSWatchEvent<Meta>) => void;
  options?: ActiveFSWatchOptions;
}): Promise<ActiveFSWatchSubscription> {
  const controller = new AbortController();
  options.options?.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const path = normalizeActiveFSPath(options.path);
  const session = await options.client.createSession(options.context, path, stripWatchSignal(options.options));

  let closed = false;
  let lastSequence = 0;
  let ready = false;
  let markReady: () => void = () => undefined;
  const readySignal = new Promise<void>((resolve) => { markReady = resolve; });
  const pump = options.client.streamSessionEvents(session.sessionId, async (sessionEvent) => {
    lastSequence = Math.max(lastSequence, sessionEvent.sequence);
    const watchEvent = watchEventFromSessionEvent<Meta>(sessionEvent, path, options.options);
    if (watchEvent) {
      options.onEvent(watchEvent);
    }
    await options.client.ackSession(session.sessionId, sessionEvent.sequence);
    if (!ready) {
      ready = true;
      markReady();
    }
  }, { signal: controller.signal }).catch((error) => {
    if (!closed && !isAbortError(error)) {
      throw error;
    }
  });

  await Promise.race([readySignal, new Promise<void>((resolve) => setTimeout(resolve, 250))]);
  return {
    close: async () => {
      closed = true;
      controller.abort();
      await pump;
      if (lastSequence > 0) {
        await options.client.ackSession(session.sessionId, lastSequence).catch(() => undefined);
      }
    }
  };
}

function stripWatchSignal(options: ActiveFSWatchOptions | undefined): Omit<ActiveFSWatchOptions, "signal"> | undefined {
  if (!options) {
    return undefined;
  }
  const { signal: _signal, ...serializable } = options;
  return serializable;
}

function watchEventFromSessionEvent<Meta>(
  event: ActiveFSSessionEvent,
  rootPath: ActiveFSPath,
  options: ActiveFSWatchOptions | undefined
): ActiveFSWatchEvent<Meta> | undefined {
  if (event.type === "heartbeat") {
    return undefined;
  }
  const path = typeof event.payload.path === "string" && event.payload.path.startsWith("/")
    ? normalizeActiveFSPath(event.payload.path)
    : rootPath;
  if (!matchesActiveFSWatchRoot(rootPath, path, { recursive: options?.recursive })) {
    return undefined;
  }
  if (event.type === "path.invalidated" || event.type === "resync.required" || event.type === "session.revoked") {
    return withSessionMeta({ type: "invalidate", path }, event);
  }
  if (event.type === "tree.changed") {
    const sourceType = event.payload.sourceEventType;
    const type = sourceType === "create" || sourceType === "change" || sourceType === "delete" || sourceType === "invalidate"
      ? sourceType
      : "change";
    return withSessionMeta({ type, path }, event);
  }
  if (event.type === "config.changed" || event.type === "policy.changed") {
    return withSessionMeta({ type: "invalidate", path: rootPath }, event);
  }
  return undefined;
}

function withSessionMeta<Meta>(event: ActiveFSWatchEvent<Meta>, source: ActiveFSSessionEvent): ActiveFSWatchEvent<Meta> {
  return {
    ...event,
    ...(source.payload.stat && typeof source.payload.stat === "object" ? { stat: source.payload.stat as ActiveFSWatchEvent<Meta>["stat"] } : {}),
    ...(source.payload.meta !== undefined ? { meta: source.payload.meta as Meta } : {})
  };
}

async function parseSse(body: ReadableStream<Uint8Array>, onEvent: (event: unknown) => MaybePromise<void>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = findSseSeparator(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) await onEvent(JSON.parse(data));
      separator = findSseSeparator(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) await onEvent(JSON.parse(data));
  }
}

function findSseSeparator(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function unsupportedHttpTreeDeclarationMutation(): never {
  throw new ActiveFSError("UNSUPPORTED", "HTTP tree clients cannot mutate declarations; configure paths on the server tree");
}

function unsupportedHttpTreePathHandle(): never {
  throw new ActiveFSError("UNSUPPORTED", "HTTP tree clients do not expose declaration path handles; configure paths on the server tree");
}

function sourceStatToTreeInfo<Meta>(stat: ActiveFSStat<Meta>): NonNullable<ActiveFSTreeInfo<Meta>> {
  return {
    path: stat.path,
    name: stat.name,
    kind: stat.kind,
    type: stat.mimeType,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    etag: stat.etag,
    revision: stat.revision,
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

function sourceEntryToTreeInfo<Meta>(entry: ActiveFSDirEntry<Meta>): NonNullable<ActiveFSTreeInfo<Meta>> {
  return {
    path: entry.path,
    name: entry.name,
    kind: entry.kind,
    type: entry.mimeType,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    enumerable: entry.enumerable,
    permissions: {
      readable: entry.capabilities?.readable ?? entry.capabilities?.read,
      writable: entry.capabilities?.writable ?? entry.capabilities?.write,
      searchable: entry.capabilities?.searchable ?? entry.capabilities?.search,
      deletable: entry.capabilities?.delete,
      renamable: entry.capabilities?.rename,
      copyable: entry.capabilities?.copy
    },
    data: entry.meta
  };
}

function sourceReadResultToTreeReadResult<Meta>(result: ActiveFSReadResult<Meta>): ActiveFSTreeReadResult<Meta> {
  return {
    content: result.content,
    info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
    data: result.meta
  };
}

function sourceSearchResultToTreeSearchResult<Meta>(result: ActiveFSSearchResult<Meta>): ActiveFSTreeSearchResult<Meta> {
  return {
    matches: result.matches.map((match) => ({ ...match, data: match.meta })),
    complete: result.complete,
    strategy: result.strategy,
    incompleteReasons: result.incompleteReasons
  };
}

function decodeHttpTreeCommandResult<Meta, Command extends ActiveFSTreeCommand>(
  command: Command,
  result: EncodedCommandResult<Meta>
): ActiveFSTreeCommandResultMap<Meta>[Command] {
  if (command === "ls" && result.entries) return result.entries.map(sourceEntryToTreeInfo) as ActiveFSTreeCommandResultMap<Meta>[Command];
  if (command === "stat" && "stat" in result) return (result.stat ? sourceStatToTreeInfo(result.stat) : null) as ActiveFSTreeCommandResultMap<Meta>[Command];
  if ((command === "grep" || command === "rg") && result.search) return sourceSearchResultToTreeSearchResult(result.search) as ActiveFSTreeCommandResultMap<Meta>[Command];
  if (command === "find" && result.stats) return result.stats.map(sourceStatToTreeInfo) as ActiveFSTreeCommandResultMap<Meta>[Command];
  if (result.read) return sourceReadResultToTreeReadResult(decodeReadResult(result.read)) as ActiveFSTreeCommandResultMap<Meta>[Command];
  throw new ActiveFSError("SOURCE_ERROR", `HTTP Source API command response did not match ${command}`);
}

function sourceWriteResultToTreeMutation<Auth, Meta>(path: ActiveFSPath, result: ActiveFSWriteResult<Meta>): ActiveFSTreeMutationResult<Auth, Meta> {
  return {
    modified: path,
    created: result.created ? path : undefined,
    info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
    operationId: result.operationId,
    revision: result.revision,
    data: result.meta
  };
}

function sourceMkdirResultToTreeMutation<Auth, Meta>(path: ActiveFSPath, result: ActiveFSMkdirResult<Meta>): ActiveFSTreeMutationResult<Auth, Meta> {
  return {
    created: result.created ? path : undefined,
    info: result.stat ? sourceStatToTreeInfo(result.stat) : undefined,
    operationId: result.operationId,
    revision: result.revision,
    data: result.meta
  };
}

async function walkHttpTree<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>,
  context: ActiveFSContext<Auth, Meta>,
  path: ActiveFSPath,
  options?: { includeNonEnumerable?: boolean }
): Promise<NonNullable<ActiveFSTreeInfo<Meta>>[]> {
  const root = normalizeActiveFSPath(path);
  const results: NonNullable<ActiveFSTreeInfo<Meta>>[] = [];
  const visit = async (current: ActiveFSPath): Promise<void> => {
    for (const info of treeListResultToInfos(await tree.list(context, current), current)) {
      if (options?.includeNonEnumerable || info.enumerable !== false) results.push(info);
      if (info.kind === "directory") await visit(normalizeActiveFSPath(info.path ?? joinActiveFSPath(current, info.name ?? "")));
    }
  };
  await visit(root);
  return results;
}

function treeListResultToInfos<Auth, Meta>(result: ActiveFSTreeListResult<Auth, Meta>, basePath: ActiveFSPath): NonNullable<ActiveFSTreeInfo<Meta>>[] {
  if (Array.isArray(result)) return result.filter((info): info is NonNullable<ActiveFSTreeInfo<Meta>> => Boolean(info));
  return Object.entries(result).map(([name, declaration]) => {
    const node = declaration as ActiveFSTreeNodeDeclaration<Auth, Meta> & { treeNodeKind?: "file" | "directory" };
    return { path: joinActiveFSPath(basePath, name), name, kind: node.treeNodeKind === "file" ? "file" : "directory" };
  });
}

function serializeContext<Auth, Meta>(context: ActiveFSContext<Auth, Meta>): Omit<ActiveFSContext<Auth, Meta>, "signal"> {
  const { signal: _signal, ...serializable } = context;
  return serializable;
}

function encodeWriteContent(content: string | Uint8Array): { content?: string; contentBase64?: string } {
  return typeof content === "string" ? { content } : { contentBase64: Buffer.from(content).toString("base64") };
}

function digestForWriteContent(content: string | Uint8Array): { algorithm: "sha-256"; value: string } {
  return { algorithm: "sha-256", value: sha256Base64(activeFSContentToBytes(content)) };
}

function decodeReadResult<Meta>(result: EncodedReadResult<Meta>): ActiveFSReadResult<Meta> {
  if (typeof result.content === "string") return { content: result.content, stat: result.stat, meta: result.meta };
  if (typeof result.contentBase64 === "string") return { content: new Uint8Array(Buffer.from(result.contentBase64, "base64")), stat: result.stat, meta: result.meta };
  throw new ActiveFSError("SOURCE_ERROR", "HTTP Source API read response did not include content");
}

/** Converts a generic client auth descriptor into request headers. */
export async function clientAuthHeaders(
  auth: HttpSourceClientAuth | false | undefined,
  request: HttpSourceClientAuthRequest
): Promise<Record<string, string>> {
  if (!auth) return {};
  if (typeof auth === "function") return auth(request);
  if (typeof auth === "string") return { authorization: `Bearer ${auth}` };
  if ("headers" in auth) return auth.headers;
  if (auth.type === "basic") {
    return { authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}` };
  }
  return { authorization: `Bearer ${auth.token}` };
}

async function activeFSErrorFromResponse(response: Response, path?: ActiveFSPath): Promise<ActiveFSError> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as Partial<ActiveFSErrorResponse>;
    if (parsed.error) {
      const error = new ActiveFSError(activeFSErrorCodeFromProtocol(parsed.error), parsed.error.message ?? "Source API error", {
        path: parsed.error.path ?? path
      });
      if (parsed.operation) {
        Object.assign(error, parsed.operation);
      }
      return error;
    }
  } catch {
    // Fall through to a generic HTTP Source API error.
  }
  return new ActiveFSError("SOURCE_ERROR", `HTTP Source API request failed with ${response.status}`, { path });
}

async function verifiedResponseText(response: Response, path?: ActiveFSPath): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  verifyAdvertisedResponseDigests(bytes, response.headers, path);
  return new TextDecoder().decode(bytes);
}

function verifyAdvertisedResponseDigests(bytes: Uint8Array, headers: Headers, path?: ActiveFSPath): void {
  for (const name of ["content-digest", "repr-digest"]) {
    const header = headers.get(name);
    if (!header) continue;
    const expected = /\bsha-256\s*=\s*:([A-Za-z0-9+/=]+):/.exec(header)?.[1]
      ?? /\bsha-256\s*=\s*"?([A-Za-z0-9+/=]+)"?/.exec(header)?.[1];
    if (!expected) throw new ActiveFSError("SOURCE_ERROR", `Unsupported ${name} header`, { path });
    if (sha256Base64(bytes) !== expected) throw new ActiveFSError("SOURCE_ERROR", `${name} mismatch`, { path });
  }
}

/** Verifies session event ordering, digest chain, and optional MAC. */
export function verifyActiveFSSessionEvent(
  event: ActiveFSSessionEvent,
  state: ActiveFSSessionEventVerificationState = {}
): ActiveFSSessionEventVerificationState {
  if (state.sessionId && event.sessionId !== state.sessionId) throw new ActiveFSError("SOURCE_ERROR", "Session event belongs to a different session");
  if (state.lastSequence !== undefined && event.sequence !== state.lastSequence + 1) throw new ActiveFSError("SOURCE_ERROR", "Session event sequence gap");
  if (event.payloadDigest !== sha256Base64(new TextEncoder().encode(JSON.stringify(event.payload)))) throw new ActiveFSError("SOURCE_ERROR", "Session event payload digest mismatch");
  if (state.previousEventDigest && event.previousEventDigest !== state.previousEventDigest) throw new ActiveFSError("SOURCE_ERROR", "Session event digest chain mismatch");
  if (state.requireEventMac && !event.eventMac) throw new ActiveFSError("SOURCE_ERROR", "Session event MAC is required");
  if (event.eventMac) {
    if (event.eventMac.algorithm !== "hmac-sha-256") throw new ActiveFSError("SOURCE_ERROR", "Session event MAC algorithm is unsupported");
    if (!state.eventMacSecret) {
      if (state.requireEventMac) throw new ActiveFSError("SOURCE_ERROR", "Session event MAC cannot be verified");
    } else {
    const secret = typeof state.eventMacSecret === "string" ? new TextEncoder().encode(state.eventMacSecret) : state.eventMacSecret;
    const { eventMac, ...unsigned } = event;
    if (eventMac.value !== createHmac("sha256", secret).update(new TextEncoder().encode(JSON.stringify(unsigned))).digest("base64")) {
      throw new ActiveFSError("SOURCE_ERROR", "Session event MAC mismatch");
    }
    }
  }
  return {
    ...state,
    sessionId: event.sessionId,
    lastSequence: event.sequence,
    previousEventDigest: sha256Base64(new TextEncoder().encode(JSON.stringify(event)))
  };
}

function activeFSCapabilitiesFromProtocol(capabilities?: Partial<ActiveFSTreeServiceCapabilities>): ActiveFSCapabilities {
  return {
    stat: capabilities?.statable,
    list: capabilities?.listable,
    read: capabilities?.readable,
    write: capabilities?.writable,
    create: capabilities?.mutable?.create,
    truncate: capabilities?.mutable?.truncate,
    delete: capabilities?.mutable?.delete,
    mkdir: capabilities?.mutable?.mkdir,
    rmdir: capabilities?.mutable?.rmdir,
    rename: capabilities?.mutable?.rename,
    copy: capabilities?.mutable?.copy,
    updateMetadata: capabilities?.mutable?.updateMetadata,
    search: capabilities?.searchable,
    watch: capabilities?.watchable,
    rangeReadable: capabilities?.rangeReadable,
    commands: capabilities?.commands
  };
}

function activeFSErrorCodeFromProtocol(payload: { code?: unknown; internalCode?: unknown; name?: unknown }): ActiveFSErrorCode {
  if (isActiveFSErrorCode(payload.internalCode)) return payload.internalCode;
  if (isActiveFSErrorCode(payload.code)) return payload.code;
  const map: Partial<Record<ActiveFSTreeProtocolErrorCode, ActiveFSErrorCode>> = {
    NOT_FOUND: "NOT_FOUND",
    NOT_A_DIRECTORY: "NOT_DIRECTORY",
    IS_DIRECTORY: "NOT_FILE",
    PERMISSION_DENIED: "FORBIDDEN",
    CONFLICT: "CONFLICT",
    PRECONDITION_FAILED: "PRECONDITION_FAILED",
    UNSUPPORTED_OPERATION: "UNSUPPORTED",
    INVALID_PATH: "INVALID_PATH",
    RANGE_NOT_SATISFIABLE: "INVALID_PATH",
    TRANSIENT_TRANSPORT: "TRANSIENT",
    SOURCE_UNAVAILABLE: "SOURCE_ERROR",
    TIMEOUT: "SOURCE_ERROR",
    INTERNAL_ERROR: "SOURCE_ERROR"
  };
  return typeof payload.code === "string" && payload.code in map
    ? map[payload.code as ActiveFSTreeProtocolErrorCode] ?? "SOURCE_ERROR"
    : "SOURCE_ERROR";
}

function validateResourceId(value: string, label: string): string {
  if (!value || value.includes("/") || value.includes("\\")) throw new ActiveFSError("INVALID_PATH", `Invalid Source API ${label}`);
  return value;
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (headers) {
    new Headers(headers).forEach((value, name) => {
      record[name] = value;
    });
  }
  return record;
}

function isActiveFSErrorCode(value: unknown): value is ActiveFSErrorCode {
  return typeof value === "string" && [
    "NOT_FOUND", "NOT_MOUNTED", "NOT_DIRECTORY", "NOT_FILE", "INVALID_PATH", "INVALID_REQUEST",
    "UNAUTHORIZED", "FORBIDDEN", "CONFLICT", "PRECONDITION_FAILED", "TRANSIENT", "UNSUPPORTED", "SOURCE_ERROR"
  ].includes(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function operationReferenceFromError(error: unknown): ActiveFSOperationReference | undefined {
  return error && typeof error === "object" &&
    "operationId" in error && typeof error.operationId === "string" &&
    "operationStatusEndpoint" in error && typeof error.operationStatusEndpoint === "string"
    ? {
      operationId: error.operationId,
      operationStatusEndpoint: error.operationStatusEndpoint
    }
    : undefined;
}
