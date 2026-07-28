import {
  ActiveFSError,
  normalizeActiveFSPath,
  type ActiveFSCapabilities,
  type ActiveFSContext,
  type ActiveFSErrorCode,
  type ActiveFSPath,
  type ActiveFSTree,
  type ActiveFSTreeCommand,
  type MaybePromise
} from "@activefs/core";

/** Current ActiveFS Source API protocol version. */
export const ACTIVEFS_SOURCE_PROTOCOL_VERSION = 1;

/** Operation URLs advertised by a Source API discovery document. */
export interface ActiveFSSourceEndpoints {
  stat: string;
  list: string;
  read: string;
  search?: string;
  command?: string;
  write?: string;
  delete?: string;
  mkdir?: string;
  rmdir?: string;
  rename?: string;
  copy?: string;
  truncate?: string;
  metadata?: string;
  sessions?: string;
  changes?: string;
  capabilities?: string;
  config?: string;
  policy?: string;
}

/** Capability document advertised by an ActiveFS Source API service. */
export interface ActiveFSTreeServiceCapabilities {
  protocolVersion: 1;
  statable: boolean;
  listable: boolean;
  readable: boolean;
  writable: boolean;
  mutable: {
    create: boolean;
    write: boolean;
    truncate: boolean;
    delete: boolean;
    mkdir: boolean;
    rmdir: boolean;
    rename: boolean;
    copy: boolean;
    updateMetadata: boolean;
  };
  searchable: boolean;
  commands: ActiveFSTreeCommand[];
  watchable: boolean;
  rangeReadable: boolean;
  activefs: ActiveFSCapabilities;
}

/** Discovery document returned by the exact URL registered by the client. */
export interface ActiveFSTreeHandshake {
  protocol: "activefs-source";
  protocolVersion: 1;
  endpoints: ActiveFSSourceEndpoints;
  capabilities: ActiveFSTreeServiceCapabilities;
  server?: {
    name?: string;
    version?: string;
  };
  workspace?: {
    displayName?: string;
    suggestedMountPath?: ActiveFSPath;
  };
  adapters?: {
    mount?: Array<{
      protocol: string;
      url: string;
    }>;
  };
  cache?: {
    contentTtlMs?: number;
    directoryTtlMs?: number;
  };
  auth?: {
    required?: boolean;
    schemes?: string[];
    message?: string;
    hints?: Record<string, unknown>;
  };
  freshness?: {
    sessions?: boolean;
    sse?: boolean;
    changes?: boolean;
  };
  mutations?: {
    writable?: boolean;
    operations?: string[];
  };
  revisions?: {
    config?: string;
    policy?: string;
  };
}

/** Safe, revisionable setup hints returned by an advertised config endpoint. */
export interface ActiveFSSourceConfigDocument {
  schemaVersion: 1;
  protocol: "activefs-source";
  protocolVersion: 1;
  capabilities?: ActiveFSTreeServiceCapabilities;
  server?: ActiveFSTreeHandshake["server"];
  workspace?: ActiveFSTreeHandshake["workspace"];
  cache?: ActiveFSTreeHandshake["cache"] & {
    persistentReadCache?: "off-unless-session-coherent";
  };
  auth?: ActiveFSTreeHandshake["auth"];
  freshness?: ActiveFSTreeHandshake["freshness"];
  mutations?: ActiveFSTreeHandshake["mutations"];
  revisions?: ActiveFSTreeHandshake["revisions"];
}

/** External Source API error codes accepted on the wire. */
export type ActiveFSTreeProtocolErrorCode =
  | "NOT_FOUND"
  | "NOT_A_DIRECTORY"
  | "IS_DIRECTORY"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "UNSUPPORTED_OPERATION"
  | "INVALID_PATH"
  | "RANGE_NOT_SATISFIABLE"
  | "TRANSIENT_TRANSPORT"
  | "SOURCE_UNAVAILABLE"
  | "TIMEOUT"
  | "INTERNAL_ERROR";

/** Route-independent operation selected by trusted host/router wiring. */
export type ActiveFSSourceOperation =
  | "handshake"
  | "capabilities"
  | "config"
  | "policy"
  | "changes"
  | "stat"
  | "list"
  | "read"
  | "search"
  | "command"
  | "write"
  | "delete"
  | "mkdir"
  | "rmdir"
  | "rename"
  | "copy"
  | "truncate"
  | "metadata"
  | "createSession"
  | "sessionEvents"
  | "sessionAck"
  | "sessionActivity"
  | "operationStatus";

/** Trusted path parameters supplied by the host router. */
export interface ActiveFSSourceOperationParams {
  sessionId?: string;
  operationId?: string;
}

/** Authoritative context and server-only isolation scope. */
export interface ActiveFSSourceResolvedContext<Auth = unknown, Meta = unknown> {
  context: ActiveFSContext<Auth, Meta>;
  isolationKey: string;
  /** Host-authoritative instruction to revoke the addressed session. */
  revokeSession?: boolean;
}

/** Input passed to a host-owned HTTP credential/context resolver. */
export interface ActiveFSSourceContextResolverInput<Auth = unknown, Meta = unknown> {
  request: Request;
  operation: ActiveFSSourceOperation;
  untrustedContext?: Readonly<Omit<ActiveFSContext<Auth, Meta>, "signal">>;
  session?: {
    sessionId: string;
    isolationKey: string;
  };
}

/** Validates a request and constructs final opaque tree auth/meta. */
export type ActiveFSSourceContextResolver<Auth = unknown, Meta = unknown> = (
  input: ActiveFSSourceContextResolverInput<Auth, Meta>
) => MaybePromise<ActiveFSSourceResolvedContext<Auth, Meta>>;

/** Signed or digest-chained session event. */
export interface ActiveFSSessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  issuedAt: string;
  type:
    | "heartbeat"
    | "config.changed"
    | "policy.changed"
    | "tree.changed"
    | "path.invalidated"
    | "resync.required"
    | "session.revoked";
  payload: Record<string, unknown>;
  payloadDigest: string;
  previousEventDigest?: string;
  eventMac?: {
    algorithm: "hmac-sha-256";
    value: string;
  };
}

/** Session descriptor returned by the server. */
export interface ActiveFSTreeSession {
  sessionId: string;
  createdAt: string;
  cacheMode: "off" | "realtime/coherent";
  eventEndpoint: string;
  ackEndpoint: string;
  activityEndpoint: string;
  integrity: {
    eventChain: "sha-256";
    eventMac?: "hmac-sha-256";
  };
}

export interface ActiveFSTreeSessionAckResult {
  sessionId: string;
  lastAckSequence: number;
}

export interface ActiveFSTreeSessionActivityResult {
  sessionId: string;
  accepted: boolean;
  backlog: number;
}

export interface ActiveFSTreeOperationStatus {
  operationId: string;
  operationStatusEndpoint: string;
  status: "running" | "succeeded" | "failed";
  operation: "write" | "delete" | "mkdir" | "rmdir" | "rename" | "copy" | "truncate" | "metadata";
  path: ActiveFSPath;
  targetPath?: ActiveFSPath;
  startedAt: string;
  completedAt?: string;
  revision?: string;
  result?: unknown;
  error?: ActiveFSErrorPayload;
}

export interface ActiveFSOperationReference {
  operationId: string;
  operationStatusEndpoint: string;
}

export interface ActiveFSErrorPayload {
  name: string;
  code: ActiveFSTreeProtocolErrorCode | ActiveFSErrorCode;
  internalCode?: ActiveFSErrorCode;
  message: string;
  path?: ActiveFSPath;
}

export interface ActiveFSErrorResponse {
  error: ActiveFSErrorPayload;
  operation?: ActiveFSOperationReference;
}

export type ActiveFSSourceHandshakeHints =
  Partial<Omit<ActiveFSTreeHandshake, "protocol" | "protocolVersion" | "capabilities" | "endpoints">> & {
    endpoints?: Partial<ActiveFSSourceEndpoints>;
    capabilities?: Partial<ActiveFSTreeServiceCapabilities> & {
      activefs?: ActiveFSCapabilities;
      mutable?: Partial<ActiveFSTreeServiceCapabilities["mutable"]>;
    };
  };

export interface ActiveFSSourceHandshakeRequest<Auth = unknown, Meta = unknown> {
  request: Request;
  tree: ActiveFSTree<Auth, Meta>;
  capabilities: ActiveFSTreeServiceCapabilities;
  defaultHandshake: ActiveFSTreeHandshake;
  context: ActiveFSContext<Auth, Meta>;
}

export type ActiveFSSourceHandshakeOption<Auth = unknown, Meta = unknown> =
  | ActiveFSSourceHandshakeHints
  | ((request: ActiveFSSourceHandshakeRequest<Auth, Meta>) => MaybePromise<ActiveFSSourceHandshakeHints>);

/** The framework-neutral service used by both Fetch and Node adapters. */
export interface ActiveFSSourceService<Auth = unknown, Meta = unknown> {
  readonly capabilities: ActiveFSTreeServiceCapabilities;
  handle(
    operation: ActiveFSSourceOperation,
    request: Request,
    params?: ActiveFSSourceOperationParams
  ): Promise<Response>;
  /** Revokes a server-held session and closes its active event/watch resources. */
  revokeSession(sessionId: string, reason?: string): Promise<boolean>;
}

export interface ActiveFSSourceServiceOptions<Auth = unknown, Meta = unknown> {
  tree: ActiveFSTree<Auth, Meta>;
  endpoints: ActiveFSSourceEndpoints;
  /**
   * Maps newly created resource IDs to application-owned public routes.
   * Session and mutation operations fail closed when their mapping is absent.
   */
  resourceLinks?: {
    session?: (input: {
      request: Request;
      sessionId: string;
    }) => {
      eventEndpoint: string;
      ackEndpoint: string;
      activityEndpoint: string;
    };
    operationStatus?: (input: {
      request: Request;
      operationId: string;
    }) => string;
  };
  resolveContext?: ActiveFSSourceContextResolver<Auth, Meta>;
  eventSigningSecret?: string | Uint8Array;
  handshake?: ActiveFSSourceHandshakeOption<Auth, Meta>;
  maxRequestBodyBytes?: number;
  maxRetainedOperationStatuses?: number;
  /** Maximum idempotency records retained per authoritative isolation scope. */
  maxRetainedIdempotencyRecords?: number;
  maxRetainedChanges?: number;
  maxRetainedSessions?: number;
  maxRetainedSessionEvents?: number;
  maxSessionActivityBacklog?: number;
  /** Maximum authoritative isolation scopes retained by the in-memory service. */
  maxRetainedIsolationScopes?: number;
}

const ENDPOINT_KEYS = [
  "stat",
  "list",
  "read",
  "search",
  "command",
  "write",
  "delete",
  "mkdir",
  "rmdir",
  "rename",
  "copy",
  "truncate",
  "metadata",
  "sessions",
  "changes",
  "capabilities",
  "config",
  "policy"
] as const satisfies readonly (keyof ActiveFSSourceEndpoints)[];

export const ACTIVEFS_SOURCE_ENDPOINT_KEYS = ENDPOINT_KEYS;

/** Computes protocol capabilities from the served tree. */
export function activeFSSourceCapabilities<Auth, Meta>(
  tree: ActiveFSTree<Auth, Meta>
): ActiveFSTreeServiceCapabilities {
  const source = tree.capabilities ?? {};
  const searchable = source.search !== false && source.searchable !== false;
  const watchable = source.watch !== false && source.watchable !== false;
  const writable = Boolean(source.write || source.create || source.writable);
  const statable = source.stat !== false;
  const listable = source.list !== false;
  const readable = source.read !== false;
  const commands: ActiveFSTreeCommand[] = [
    ...(listable ? (["ls"] as const) : []),
    ...(statable ? (["stat"] as const) : []),
    ...(readable ? (["cat", "head", "tail", "sed"] as const) : []),
    ...(searchable ? (["grep", "rg"] as const) : []),
    ...(statable && listable ? (["find"] as const) : [])
  ];
  const mutable = {
    create: Boolean(source.create || writable),
    write: writable,
    truncate: Boolean(source.truncate || writable),
    delete: Boolean(source.delete || writable),
    mkdir: Boolean(source.mkdir || source.create || writable),
    rmdir: Boolean(source.rmdir || source.delete || writable),
    rename: Boolean(source.rename || writable),
    copy: Boolean(source.copy || writable),
    updateMetadata: Boolean(source.updateMetadata || writable)
  };
  return {
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    statable,
    listable,
    readable,
    writable,
    mutable,
    searchable,
    commands,
    watchable,
    rangeReadable: source.rangeReadable !== false,
    activefs: {
      ...source,
      stat: statable,
      list: listable,
      read: readable,
      search: searchable,
      create: mutable.create,
      write: writable,
      truncate: mutable.truncate,
      delete: mutable.delete,
      mkdir: mutable.mkdir,
      rmdir: mutable.rmdir,
      rename: mutable.rename,
      copy: mutable.copy,
      updateMetadata: mutable.updateMetadata,
      watch: watchable,
      readable: source.readable ?? readable,
      writable: source.writable ?? writable,
      searchable: source.searchable ?? searchable,
      watchable: source.watchable ?? watchable,
      rangeReadable: source.rangeReadable !== false,
      commands
    }
  };
}

/** Validates a discovery URL without rewriting its path or query. */
export function validateActiveFSSourceDiscoveryUrl(
  url: string | URL,
  options: { allowInsecureHttp?: boolean } = {}
): string {
  const value = typeof url === "string" ? url : url.href;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ActiveFSError("INVALID_REQUEST", "Source API discovery URL is invalid");
  }
  if (parsed.hash) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API discovery URLs must not include a fragment");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ActiveFSError("INVALID_REQUEST", "Source API discovery URLs must use http: or https:");
  }
  if (parsed.username || parsed.password) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API discovery URLs must not include credentials");
  }
  if (parsed.protocol === "http:" && !options.allowInsecureHttp && !isLoopbackHostname(parsed.hostname)) {
    throw new ActiveFSError("INVALID_REQUEST", "Insecure Source API discovery URLs are allowed only on loopback hosts");
  }
  return value;
}

/** Resolves and validates one endpoint reference against a discovery response URL. */
export function resolveActiveFSSourceUrl(
  reference: string,
  baseUrl: string | URL,
  options: { allowedOrigins?: readonly string[]; allowInsecureHttp?: boolean } = {}
): string {
  if (!reference || reference.includes("\0")) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API endpoint references must be non-empty URLs");
  }
  const base = new URL(baseUrl.toString());
  const resolved = new URL(reference, base);
  if (resolved.hash) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API endpoint references must not include fragments");
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new ActiveFSError("INVALID_REQUEST", `Unsupported Source API endpoint scheme: ${resolved.protocol}`);
  }
  if (resolved.username || resolved.password) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API endpoint references must not include credentials");
  }
  if (resolved.protocol === "http:" && !options.allowInsecureHttp && !isLoopbackHostname(resolved.hostname)) {
    throw new ActiveFSError("INVALID_REQUEST", "Insecure Source API endpoints are allowed only on loopback hosts");
  }
  const allowedOrigins = new Set([base.origin, ...(options.allowedOrigins ?? [])]);
  if (!allowedOrigins.has(resolved.origin)) {
    throw new ActiveFSError("FORBIDDEN", `Source API endpoint origin is not allowed: ${resolved.origin}`);
  }
  return resolved.href;
}

/** Validates endpoint shape and capability consistency. */
export function assertActiveFSSourceHandshake(
  value: unknown
): asserts value is ActiveFSTreeHandshake {
  if (!isRecord(value) || value.protocol !== "activefs-source") {
    throw new ActiveFSError("UNSUPPORTED", "Endpoint did not return an ActiveFS Source API handshake");
  }
  if (value.protocolVersion !== ACTIVEFS_SOURCE_PROTOCOL_VERSION) {
    throw new ActiveFSError(
      "UNSUPPORTED",
      `Unsupported ActiveFS Source API protocol version: ${String(value.protocolVersion)}`
    );
  }
  if (!isRecord(value.capabilities)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API handshake must include capabilities");
  }
  assertActiveFSSourceCapabilities(value.capabilities);
  if (!isRecord(value.endpoints)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API handshake must include endpoints");
  }
  for (const required of ["stat", "list", "read"] as const) {
    if (typeof value.endpoints[required] !== "string" || value.endpoints[required].length === 0) {
      throw new ActiveFSError("INVALID_REQUEST", `Source API handshake is missing endpoints.${required}`);
    }
  }
  for (const key of ENDPOINT_KEYS) {
    const endpoint = value.endpoints[key];
    if (endpoint !== undefined && typeof endpoint !== "string") {
      throw new ActiveFSError("INVALID_REQUEST", `Source API endpoints.${key} must be a string`);
    }
  }
  assertActiveFSSourceCapabilityEndpoints(
    value.capabilities as unknown as ActiveFSTreeServiceCapabilities,
    value.endpoints as unknown as ActiveFSSourceEndpoints
  );
  assertActiveFSSourceSetupHints(value);
}

/** Validates the safe config document used during initial remote setup. */
export function assertActiveFSSourceConfigDocument(
  value: unknown
): asserts value is ActiveFSSourceConfigDocument {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.protocol !== "activefs-source") {
    throw new ActiveFSError("INVALID_REQUEST", "Source API config document has an invalid schema or protocol");
  }
  if (value.protocolVersion !== ACTIVEFS_SOURCE_PROTOCOL_VERSION) {
    throw new ActiveFSError(
      "UNSUPPORTED",
      `Unsupported ActiveFS Source API config version: ${String(value.protocolVersion)}`
    );
  }
  if (value.capabilities !== undefined) {
    assertActiveFSSourceCapabilities(value.capabilities);
  }
  assertActiveFSSourceSetupHints(value);
  if (isRecord(value.cache) && value.cache.persistentReadCache !== undefined
    && value.cache.persistentReadCache !== "off-unless-session-coherent") {
    throw new ActiveFSError(
      "INVALID_REQUEST",
      "Source API config cache.persistentReadCache has an unsupported value"
    );
  }
}

/** Validates a standalone capabilities document. */
export function assertActiveFSSourceCapabilities(
  value: unknown
): asserts value is ActiveFSTreeServiceCapabilities {
  if (!isRecord(value)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API capabilities must be an object");
  }
  if (value.protocolVersion !== ACTIVEFS_SOURCE_PROTOCOL_VERSION) {
    throw new ActiveFSError(
      "UNSUPPORTED",
      `Unsupported ActiveFS Source API protocol version: ${String(value.protocolVersion)}`
    );
  }
  for (const field of [
    "statable",
    "listable",
    "readable",
    "writable",
    "searchable",
    "watchable",
    "rangeReadable"
  ] as const) {
    if (typeof value[field] !== "boolean") {
      throw new ActiveFSError("INVALID_REQUEST", `Source API capabilities.${field} must be a boolean`);
    }
  }
  if (value.statable !== true || value.listable !== true || value.readable !== true) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API V1 requires stat, list, and read capabilities");
  }
  if (!Array.isArray(value.commands) || value.commands.some((command) => !isActiveFSTreeCommand(command))) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API capabilities.commands must contain supported command names");
  }
  if (!isRecord(value.mutable)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API capabilities.mutable must be an object");
  }
  for (const field of [
    "create",
    "write",
    "truncate",
    "delete",
    "mkdir",
    "rmdir",
    "rename",
    "copy",
    "updateMetadata"
  ] as const) {
    if (typeof value.mutable[field] !== "boolean") {
      throw new ActiveFSError("INVALID_REQUEST", `Source API capabilities.mutable.${field} must be a boolean`);
    }
  }
  if (!isRecord(value.activefs)) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API capabilities.activefs must be an object");
  }
  if (value.writable !== value.mutable.write) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API writable and mutable.write capabilities must agree");
  }
}

/** Validates that a capability document agrees with an advertised endpoint map. */
export function assertActiveFSSourceCapabilityEndpoints(
  capabilities: ActiveFSTreeServiceCapabilities,
  endpoints: ActiveFSSourceEndpoints
): void {
  assertCapabilityEndpoint(capabilities.searchable, endpoints.search, "search");
  assertCapabilityEndpoint(capabilities.commands.length > 0, endpoints.command, "command");
  assertCapabilityEndpoint(capabilities.mutable.write, endpoints.write, "write");
  assertCapabilityEndpoint(capabilities.mutable.delete, endpoints.delete, "delete");
  assertCapabilityEndpoint(capabilities.mutable.mkdir, endpoints.mkdir, "mkdir");
  assertCapabilityEndpoint(capabilities.mutable.rmdir, endpoints.rmdir, "rmdir");
  assertCapabilityEndpoint(capabilities.mutable.rename, endpoints.rename, "rename");
  assertCapabilityEndpoint(capabilities.mutable.copy, endpoints.copy, "copy");
  assertCapabilityEndpoint(capabilities.mutable.truncate, endpoints.truncate, "truncate");
  assertCapabilityEndpoint(capabilities.mutable.updateMetadata, endpoints.metadata, "metadata");
  if (capabilities.watchable && !endpoints.sessions) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API watch capability requires endpoints.sessions");
  }
}

/** Merges host hints without allowing protocol identity or required routes to drift. */
export function mergeActiveFSSourceHandshake(
  base: ActiveFSTreeHandshake,
  hints: ActiveFSSourceHandshakeHints | undefined
): ActiveFSTreeHandshake {
  if (!hints) {
    return base;
  }
  const merged: ActiveFSTreeHandshake = {
    ...base,
    ...hints,
    protocol: "activefs-source",
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    endpoints: {
      ...base.endpoints,
      ...hints.endpoints
    },
    capabilities: {
      ...base.capabilities,
      ...hints.capabilities,
      mutable: {
        ...base.capabilities.mutable,
        ...hints.capabilities?.mutable
      },
      activefs: {
        ...base.capabilities.activefs,
        ...hints.capabilities?.activefs
      }
    }
  };
  assertActiveFSSourceHandshake(merged);
  return merged;
}

export function defaultActiveFSSourceEndpoints(prefix = "./"): ActiveFSSourceEndpoints {
  if (prefix.includes("\0") || prefix.includes("#") || prefix.includes("?")) {
    throw new ActiveFSError("INVALID_REQUEST", "Source API endpoint prefixes must not include query strings or fragments");
  }
  const root = prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`;
  const route = (name: string): string => `${root}${name}`;
  return {
    stat: route("stat"),
    list: route("list"),
    read: route("read"),
    search: route("search"),
    command: route("command"),
    write: route("write"),
    delete: route("delete"),
    mkdir: route("mkdir"),
    rmdir: route("rmdir"),
    rename: route("rename"),
    copy: route("copy"),
    truncate: route("truncate"),
    metadata: route("metadata"),
    sessions: route("sessions"),
    changes: route("changes"),
    capabilities: route("capabilities"),
    config: route("config"),
    policy: route("policy")
  };
}

export function normalizeSourceMountPath(name: string | undefined): ActiveFSPath {
  return normalizeActiveFSPath(`/${name ?? "remote"}`);
}

function assertCapabilityEndpoint(enabled: boolean, endpoint: unknown, operation: string): void {
  if (enabled !== (typeof endpoint === "string" && endpoint.length > 0)) {
    throw new ActiveFSError(
      "INVALID_REQUEST",
      `Source API ${operation} capability and endpoint must either both be enabled or both be absent`
    );
  }
}

function assertOptionalRecord(value: unknown, field: string): void {
  if (value !== undefined && !isRecord(value)) {
    throw new ActiveFSError("INVALID_REQUEST", `Source API config ${field} must be an object`);
  }
}

function assertActiveFSSourceSetupHints(value: Record<string, unknown>): void {
  for (const field of ["server", "workspace", "adapters", "cache", "auth", "freshness", "mutations", "revisions"] as const) {
    assertOptionalRecord(value[field], field);
  }

  if (isRecord(value.server)) {
    assertOptionalString(value.server.name, "server.name");
    assertOptionalString(value.server.version, "server.version");
  }
  if (isRecord(value.workspace)) {
    assertOptionalString(value.workspace.displayName, "workspace.displayName");
    if (value.workspace.suggestedMountPath !== undefined) {
      assertOptionalString(value.workspace.suggestedMountPath, "workspace.suggestedMountPath");
      const path = value.workspace.suggestedMountPath as string;
      if (normalizeActiveFSPath(path) !== path) {
        throw new ActiveFSError(
          "INVALID_REQUEST",
          "Source API workspace.suggestedMountPath must be a normalized absolute path"
        );
      }
    }
  }
  if (isRecord(value.adapters) && value.adapters.mount !== undefined) {
    if (!Array.isArray(value.adapters.mount) || value.adapters.mount.some((adapter) =>
      !isRecord(adapter) || typeof adapter.protocol !== "string" || typeof adapter.url !== "string"
    )) {
      throw new ActiveFSError("INVALID_REQUEST", "Source API adapters.mount must contain protocol and URL strings");
    }
  }
  if (isRecord(value.cache)) {
    assertOptionalNonNegativeNumber(value.cache.contentTtlMs, "cache.contentTtlMs");
    assertOptionalNonNegativeNumber(value.cache.directoryTtlMs, "cache.directoryTtlMs");
  }
  if (isRecord(value.auth)) {
    assertOptionalBoolean(value.auth.required, "auth.required");
    assertOptionalString(value.auth.message, "auth.message");
    if (value.auth.schemes !== undefined
      && (!Array.isArray(value.auth.schemes) || value.auth.schemes.some((scheme) => typeof scheme !== "string"))) {
      throw new ActiveFSError("INVALID_REQUEST", "Source API auth.schemes must contain strings");
    }
    if (value.auth.hints !== undefined && !isRecord(value.auth.hints)) {
      throw new ActiveFSError("INVALID_REQUEST", "Source API auth.hints must be an object");
    }
  }
  if (isRecord(value.freshness)) {
    assertOptionalBoolean(value.freshness.sessions, "freshness.sessions");
    assertOptionalBoolean(value.freshness.sse, "freshness.sse");
    assertOptionalBoolean(value.freshness.changes, "freshness.changes");
  }
  if (isRecord(value.mutations)) {
    assertOptionalBoolean(value.mutations.writable, "mutations.writable");
    if (value.mutations.operations !== undefined
      && (!Array.isArray(value.mutations.operations)
        || value.mutations.operations.some((operation) => typeof operation !== "string"))) {
      throw new ActiveFSError("INVALID_REQUEST", "Source API mutations.operations must contain strings");
    }
  }
  if (isRecord(value.revisions)) {
    assertOptionalString(value.revisions.config, "revisions.config");
    assertOptionalString(value.revisions.policy, "revisions.policy");
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new ActiveFSError("INVALID_REQUEST", `Source API ${field} must be a string`);
  }
}

function assertOptionalBoolean(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ActiveFSError("INVALID_REQUEST", `Source API ${field} must be a boolean`);
  }
}

function assertOptionalNonNegativeNumber(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    throw new ActiveFSError("INVALID_REQUEST", `Source API ${field} must be a non-negative finite number`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isActiveFSTreeCommand(value: unknown): value is ActiveFSTreeCommand {
  return typeof value === "string" && ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
