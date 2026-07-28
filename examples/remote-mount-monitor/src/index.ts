import {
  createActiveFS,
  createActiveFSClient,
  dir,
  fsTree,
  json,
  normalizeActiveFSPath,
  text,
  type ActiveFS,
  type ActiveFSClientOperationEvent,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSLogicalClient,
  type ActiveFSTree,
  type ActiveFSTreeInfo,
  type ActiveFSTreeListResult,
  type ActiveFSTreeMutationResult,
  type ActiveFSTreeReadResult,
  type ActiveFSTreeSearchResult
} from "@activefs/core";
import {
  createActiveFSTreeServer,
  createHttpSourceClient,
  defaultActiveFSSourceNodeRoutes
} from "@activefs/source-http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const MAX_TIMELINE_EVENTS = 120;

export interface CreateRemoteMountMonitorTreeInput {
  name?: string;
  suggestedMountPath?: string;
}

export interface RemoteMountMonitorTree {
  id: string;
  name: string;
  suggestedMountPath: ActiveFSPath;
  treeUrl: string;
  createdAt: string;
}

export interface RemoteMountMonitorMount {
  id: string;
  treeId: string;
  label: string;
  clientId: string;
  mountPath: ActiveFSPath;
  connectedAt: string;
  lastSeenAt: string;
  status: RemoteMountMonitorMountStatus;
}

export interface RemoteMountMonitorTimelineEvent {
  id: number;
  type: "tree-request" | "client-activity";
  treeId: string;
  mountId?: string;
  clientId?: string;
  operation: string;
  path: ActiveFSPath;
  logicalPath?: ActiveFSPath;
  targetPath?: ActiveFSPath;
  result: "ok" | "error";
  detail?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface RemoteMountMonitorState {
  serverTime: string;
  trees: RemoteMountMonitorTree[];
  mounts: RemoteMountMonitorMount[];
  events: RemoteMountMonitorTimelineEvent[];
}

export interface RemoteMountMonitorServer {
  url: string;
  server: Server;
  createTree(input?: CreateRemoteMountMonitorTreeInput): RemoteMountMonitorTree;
  state(): RemoteMountMonitorState;
  close(): Promise<void>;
}

export interface CreateMonitoredRemoteMountOptions {
  monitorUrl: string;
  treeId: string;
  mountPath: string;
  label?: string;
  clientId?: string;
  fetch?: typeof fetch;
}

export interface MonitoredRemoteMount {
  tree: RemoteMountMonitorTree;
  mount: RemoteMountMonitorMount;
  fs: ActiveFS;
  client: ActiveFSLogicalClient;
  close(): Promise<void>;
}

interface TreeRecord {
  info: RemoteMountMonitorTree;
  handler: TreeApiRequestHandler;
}

type TreeApiRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => void | Promise<void>;

type TreeRequestOperation =
  | "info"
  | "list"
  | "read"
  | "search"
  | "write"
  | "remove"
  | "makeDir"
  | "move"
  | "copy"
  | "truncate"
  | "updateInfo";
export type RemoteMountMonitorMountStatus = "mounted" | "unmounted";

interface TreeRequestContext {
  mountId: string;
  clientId: string;
}

const treeRequestContext = new AsyncLocalStorage<TreeRequestContext>();

class RemoteMountMonitorController {
  private baseUrl = "";
  private readonly trees = new Map<string, TreeRecord>();
  private readonly mounts = new Map<string, RemoteMountMonitorMount>();
  private readonly mountKeys = new Map<string, string>();
  private readonly sinks = new Set<ServerResponse>();
  private timeline: RemoteMountMonitorTimelineEvent[] = [];
  private nextTreeNumber = 1;
  private nextMountNumber = 1;
  private nextEventId = 1;

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, "");
  }

  createTree(input: CreateRemoteMountMonitorTreeInput = {}): RemoteMountMonitorTree {
    if (!this.baseUrl) {
      throw new Error("Remote mount monitor URL is not ready.");
    }
    const name = (input.name?.trim() || `tree ${this.nextTreeNumber}`).slice(0, 60);
    const id = this.uniqueTreeId(name);
    this.nextTreeNumber += 1;
    const info: RemoteMountMonitorTree = {
      id,
      name,
      suggestedMountPath: normalizeActiveFSPath(input.suggestedMountPath ?? `/${id}`),
      treeUrl: this.treeUrlFor(id),
      createdAt: new Date().toISOString()
    };
    const tree = instrumentTree(
      info.id,
      createMonitorDemoTree(() => info),
      (event) => this.recordTreeRequest(event)
    );
    this.trees.set(id, {
      info,
      handler: createActiveFSTreeServer({
        tree,
        routes: defaultActiveFSSourceNodeRoutes(`/trees/${encodeURIComponent(id)}/source`),
        handshake: {
          server: { name: "remote-mount-monitor", version: "1.0.0" },
          workspace: {
            displayName: info.name,
            suggestedMountPath: info.suggestedMountPath
          },
          cache: { directoryTtlMs: 10_000 }
        }
      })
    });
    this.broadcastState();
    return info;
  }

  state(): RemoteMountMonitorState {
    return {
      serverTime: new Date().toISOString(),
      trees: [...this.trees.values()].map((record) => record.info),
      mounts: [...this.mounts.values()],
      events: this.timeline
    };
  }

  registerMount(input: {
    treeId: string;
    mountPath: string;
    label?: string;
    clientId?: string;
  }): RemoteMountMonitorMount {
    const tree = this.trees.get(input.treeId);
    if (!tree) {
      throw new Error(`Unknown monitor tree: ${input.treeId}`);
    }
    const now = new Date().toISOString();
    const id = `mount-${this.nextMountNumber}`;
    const mount: RemoteMountMonitorMount = {
      id,
      treeId: tree.info.id,
      label: input.label?.trim() || `mounted client ${this.nextMountNumber}`,
      clientId: input.clientId?.trim() || `client-${this.nextMountNumber}`,
      mountPath: normalizeActiveFSPath(input.mountPath),
      connectedAt: now,
      lastSeenAt: now,
      status: "mounted"
    };
    this.nextMountNumber += 1;
    this.mounts.set(id, mount);
    this.mountKeys.set(this.mountKey(tree.info.id, mount.clientId), id);
    this.broadcastState();
    return mount;
  }

  closeMount(mountId: string): RemoteMountMonitorMount {
    const mount = this.mounts.get(mountId);
    if (!mount) {
      throw new Error(`Unknown monitor mount: ${mountId}`);
    }
    const closed = {
      ...mount,
      status: "unmounted" as const,
      lastSeenAt: new Date().toISOString()
    };
    this.mounts.set(mountId, closed);
    this.broadcastState();
    return closed;
  }

  recordClientActivity(mountId: string, activity: ActiveFSClientOperationEvent): void {
    const mount = this.mounts.get(mountId);
    if (!mount) {
      throw new Error(`Unknown monitor mount: ${mountId}`);
    }
    const updatedMount = {
      ...mount,
      lastSeenAt: new Date().toISOString(),
      status: "mounted" as const
    };
    this.mounts.set(mountId, updatedMount);
    this.addTimelineEvent({
      type: "client-activity",
      treeId: mount.treeId,
      mountId,
      clientId: mount.clientId,
      operation: activity.operation,
      path: treePathFromLogicalPath(mount.mountPath, activity.path),
      logicalPath: activity.path,
      targetPath: activity.targetPath,
      result: activity.result,
      detail: activity.stat ? `${activity.stat.kind} ${activity.stat.path}` : undefined,
      error: activity.error,
      startedAt: activity.startedAt,
      completedAt: activity.completedAt,
      durationMs: durationBetween(activity.startedAt, activity.completedAt)
    });
  }

  async handleTreeApi(treeId: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const record = this.trees.get(treeId);
    if (!record) {
      writeJson(response, 404, { error: `Unknown monitor tree: ${treeId}` });
      return;
    }
    const context = this.ensureObservedTreeConnection(treeId, request);
    if (isSessionEventRequest(request)) {
      response.once("close", () => {
        this.markMountUnmounted(context.mountId);
      });
    }
    await treeRequestContext.run(context, () => record.handler(request, response));
  }

  subscribe(response: ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    this.sinks.add(response);
    writeSse(response, "state", this.state());
    response.on("close", () => {
      this.sinks.delete(response);
    });
  }

  private treeUrlFor(treeId: string): string {
    return `${this.baseUrl}/trees/${encodeURIComponent(treeId)}/source/`;
  }

  private uniqueTreeId(name: string): string {
    const base = slugify(name) || `tree-${this.nextTreeNumber}`;
    let candidate = base;
    let suffix = 2;
    while (this.trees.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private recordTreeRequest(event: Omit<RemoteMountMonitorTimelineEvent, "id" | "type">): void {
    const context = treeRequestContext.getStore();
    this.addTimelineEvent({
      ...event,
      mountId: event.mountId ?? context?.mountId,
      clientId: event.clientId ?? context?.clientId,
      type: "tree-request"
    });
  }

  private ensureObservedTreeConnection(
    treeId: string,
    request: IncomingMessage
  ): TreeRequestContext {
    const tree = this.trees.get(treeId);
    if (!tree) {
      throw new Error(`Unknown monitor tree: ${treeId}`);
    }
    const explicitMountId = headerValue(request, "x-activefs-monitor-mount-id");
    const clientId = headerValue(request, "x-activefs-monitor-client-id") ?? inferredClientId(request);
    const key = this.mountKey(treeId, clientId);
    const status = observedMountStatus(request);
    const mountId = explicitMountId && this.mounts.has(explicitMountId)
      ? explicitMountId
      : this.mountKeys.get(key);
    const now = new Date().toISOString();

    if (mountId) {
      const existing = this.mounts.get(mountId)!;
      const next = {
        ...existing,
        label: headerValue(request, "x-activefs-monitor-label") ?? existing.label,
        mountPath: normalizeActiveFSPath(
          headerValue(request, "x-activefs-monitor-mount-path") ?? existing.mountPath
        ),
        lastSeenAt: now,
        status: existing.status === "mounted" || status === "mounted" ? "mounted" as const : "unmounted" as const
      };
      this.mounts.set(mountId, next);
      this.mountKeys.set(key, mountId);
      this.broadcastState();
      return { mountId, clientId: next.clientId };
    }

    const id = `mount-${this.nextMountNumber}`;
    const mount: RemoteMountMonitorMount = {
      id,
      treeId,
      label: headerValue(request, "x-activefs-monitor-label") ?? inferredClientLabel(request),
      clientId,
      mountPath: normalizeActiveFSPath(
        headerValue(request, "x-activefs-monitor-mount-path") ?? tree.info.suggestedMountPath
      ),
      connectedAt: now,
      lastSeenAt: now,
      status
    };
    this.nextMountNumber += 1;
    this.mounts.set(id, mount);
    this.mountKeys.set(key, id);
    this.broadcastState();
    return { mountId: id, clientId };
  }

  private mountKey(treeId: string, clientId: string): string {
    return `${treeId}:${clientId}`;
  }

  private markMountUnmounted(mountId: string): void {
    const mount = this.mounts.get(mountId);
    if (!mount) {
      return;
    }
    this.mounts.set(mountId, {
      ...mount,
      lastSeenAt: new Date().toISOString(),
      status: "unmounted"
    });
    this.broadcastState();
  }

  private addTimelineEvent(event: Omit<RemoteMountMonitorTimelineEvent, "id">): void {
    this.timeline = [
      ...this.timeline,
      {
        ...event,
        id: this.nextEventId
      }
    ].slice(-MAX_TIMELINE_EVENTS);
    this.nextEventId += 1;
    this.broadcastState();
  }

  private broadcastState(): void {
    const state = this.state();
    for (const sink of this.sinks) {
      writeSse(sink, "state", state);
    }
  }
}

export async function startRemoteMountMonitorServer(options: {
  hostname?: string;
  port?: number;
  initialTrees?: CreateRemoteMountMonitorTreeInput[];
} = {}): Promise<RemoteMountMonitorServer> {
  const controller = new RemoteMountMonitorController();
  const hostname = options.hostname ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handleMonitorRequest(controller, request, response).catch((error) => {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const url = `http://${hostname}:${port}`;
  controller.setBaseUrl(url);
  for (const tree of options.initialTrees ?? []) {
    controller.createTree(tree);
  }

  return {
    url,
    server,
    createTree: (input) => controller.createTree(input),
    state: () => controller.state(),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

export async function createMonitoredRemoteMount(
  options: CreateMonitoredRemoteMountOptions
): Promise<MonitoredRemoteMount> {
  const fetchImpl = options.fetch ?? fetch;
  const normalizedMonitorUrl = options.monitorUrl.replace(/\/+$/, "");
  const state = await fetchJson<RemoteMountMonitorState>(
    fetchImpl,
    `${normalizedMonitorUrl}/api/state`
  );
  const tree = state.trees.find((candidate) => candidate.id === options.treeId);
  if (!tree) {
    throw new Error(`Unknown monitor tree: ${options.treeId}`);
  }
  const mount = await fetchJson<RemoteMountMonitorMount>(
    fetchImpl,
    `${normalizedMonitorUrl}/api/mounts`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        treeId: tree.id,
        mountPath: options.mountPath,
        label: options.label,
        clientId: options.clientId
      })
    }
  );
  const remote = createHttpSourceClient({
    url: tree.treeUrl,
    name: tree.id,
    fetch: fetchImpl,
    auth: {
      headers: {
        "x-activefs-monitor-mount-id": mount.id,
        "x-activefs-monitor-client-id": mount.clientId,
        "x-activefs-monitor-label": mount.label,
        "x-activefs-monitor-mount-path": mount.mountPath,
        "x-activefs-monitor-status": "mounted"
      }
    }
  });
  const fs = createActiveFS().mount(mount.mountPath, remote);
  const client = createActiveFSClient(fs, {
    onActivity: async (event) => {
      await fetchJson(fetchImpl, `${normalizedMonitorUrl}/api/mounts/${mount.id}/activity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event)
      }).catch(() => undefined);
    }
  });

  return {
    tree,
    mount,
    fs,
    client,
    close: async () => {
      await fetchJson(fetchImpl, `${normalizedMonitorUrl}/api/mounts/${mount.id}/disconnect`, {
        method: "POST"
      }).catch(() => undefined);
    }
  };
}

export async function runRemoteMountMonitorExample(): Promise<{
  monitorUrl: string;
  trees: string[];
  mounts: number;
  treeRequestEvents: number;
  clientActivityEvents: number;
  entries: string[];
  readme: string;
  matches: number;
}> {
  const monitor = await startRemoteMountMonitorServer();
  try {
    const docs = monitor.createTree({ name: "docs", suggestedMountPath: "/docs" });
    monitor.createTree({ name: "reports", suggestedMountPath: "/reports" });
    const mount = await createMonitoredRemoteMount({
      monitorUrl: monitor.url,
      treeId: docs.id,
      mountPath: "/docs",
      label: "demo mounted client"
    });

    const entries = await mount.client.readdir("/docs");
    const readme = await mount.client.readFile("/docs/README.md");
    const matches = await mount.client.search("/docs", { pattern: "remote" });
    const state = monitor.state();

    return {
      monitorUrl: monitor.url,
      trees: state.trees.map((tree) => tree.id),
      mounts: state.mounts.length,
      treeRequestEvents: state.events.filter((event) => event.type === "tree-request").length,
      clientActivityEvents: state.events.filter((event) => event.type === "client-activity").length,
      entries: entries.map((entry) => entry.path),
      readme: textContent(readme),
      matches: matches.matches.length
    };
  } finally {
    await monitor.close();
  }
}

async function handleMonitorRequest(
  controller: RemoteMountMonitorController,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://activefs-monitor.local");

  const treeApiMatch = /^\/trees\/([^/]+)\/source(?:\/.*)?$/.exec(url.pathname);
  if (treeApiMatch) {
    const treeId = decodeURIComponent(treeApiMatch[1]!);
    await controller.handleTreeApi(treeId, request, response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    writeHtml(response, monitorPageHtml());
    return;
  }

  if (request.method === "GET" && url.pathname === "/events") {
    controller.subscribe(response);
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    writeJson(response, 200, controller.state());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/trees") {
    writeJson(response, 200, { trees: controller.state().trees });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/trees") {
    const body = await readJson<CreateRemoteMountMonitorTreeInput>(request);
    writeJson(response, 201, controller.createTree(body));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mounts") {
    const body = await readJson<{
      treeId?: string;
      mountPath?: string;
      label?: string;
      clientId?: string;
    }>(request);
    if (!body.treeId || !body.mountPath) {
      writeJson(response, 400, { error: "treeId and mountPath are required." });
      return;
    }
    writeJson(response, 201, controller.registerMount({
      treeId: body.treeId,
      mountPath: body.mountPath,
      label: body.label,
      clientId: body.clientId
    }));
    return;
  }

  const activityMatch = /^\/api\/mounts\/([^/]+)\/activity$/.exec(url.pathname);
  if (request.method === "POST" && activityMatch) {
    const mountId = decodeURIComponent(activityMatch[1]!);
    const body = await readJson<ActiveFSClientOperationEvent>(request);
    controller.recordClientActivity(mountId, body);
    writeJson(response, 202, { accepted: true });
    return;
  }

  const disconnectMatch = /^\/api\/mounts\/([^/]+)\/disconnect$/.exec(url.pathname);
  if (request.method === "POST" && disconnectMatch) {
    const mountId = decodeURIComponent(disconnectMatch[1]!);
    writeJson(response, 200, controller.closeMount(mountId));
    return;
  }

  writeJson(response, 404, { error: "Not found" });
}

function createMonitorDemoTree(infoForRead: () => RemoteMountMonitorTree): ActiveFSTree {
  const treeContent = (path: ActiveFSPath) => () => treeFiles(infoForRead()).get(path) ?? "";
  return fsTree({
    "/README.md": text(treeContent("/README.md"), { type: "text/markdown" }),
    "/mount.json": json(() => {
      const info = infoForRead();
      return {
        treeId: info.id,
        treeUrl: info.treeUrl,
        suggestedMountPath: info.suggestedMountPath
      };
    }),
    files: dir({
      "tree.txt": text(treeContent("/files/tree.txt")),
      "requests.txt": text(treeContent("/files/requests.txt"))
    })
  }, {
    name: infoForRead().id,
    search: ({ path, query }) => {
      const searchQuery = query!;
      const normalizedPath = normalizeActiveFSPath(path);
      const needle = searchQuery.caseSensitive ? searchQuery.pattern : searchQuery.pattern.toLowerCase();
      const allMatches = [...treeFiles(infoForRead()).entries()]
        .filter(([filePath, content]) => {
          const inScope = normalizedPath === "/" ||
            filePath === normalizedPath ||
            filePath.startsWith(`${normalizedPath}/`);
          const haystack = searchQuery.caseSensitive ? content : content.toLowerCase();
          return inScope && haystack.includes(needle);
        })
        .map(([filePath, content]) => {
          const haystack = searchQuery.caseSensitive ? content : content.toLowerCase();
          return {
            path: filePath,
            line: 1,
            column: Math.max(haystack.indexOf(needle), 0) + 1,
            excerpt: content.split(/\r?\n/)[0] ?? ""
          };
        });
      const maxResults = searchQuery.maxResults ?? Number.POSITIVE_INFINITY;
      const complete = allMatches.length <= maxResults;
      return {
        matches: allMatches.slice(0, maxResults),
        complete,
        strategy: "source",
        incompleteReasons: complete ? undefined : ["max-results"]
      };
    }
  });
}

function treeFiles(info: RemoteMountMonitorTree): Map<ActiveFSPath, string> {
  return new Map<ActiveFSPath, string>([
    [
      "/README.md",
      [
        `# ${info.name}`,
        "",
        "This file is owned by the remote mount monitor server.",
        `Tree id: ${info.id}`,
        `Source API URL: ${info.treeUrl}`,
        `Suggested mount path: ${info.suggestedMountPath}`,
        "",
        "Mounted clients can list, stat, read, and search this remote tree."
      ].join("\n")
    ],
    [
      "/mount.json",
      `${JSON.stringify({
        treeId: info.id,
        treeUrl: info.treeUrl,
        suggestedMountPath: info.suggestedMountPath
      }, null, 2)}\n`
    ],
    [
      "/files/tree.txt",
      `Tree ${info.id} exposes plain files through the ActiveFS Source API.\n`
    ],
    [
      "/files/requests.txt",
      "Open the monitor page while a mounted client lists or reads files to see requests stream into this tree column.\n"
    ]
  ]);
}

function instrumentTree(
  treeId: string,
  tree: ActiveFSTree,
  record: (event: Omit<RemoteMountMonitorTimelineEvent, "id" | "type">) => void
): ActiveFSTree {
  const run = async <Result>(
    operation: TreeRequestOperation,
    path: string,
    action: (normalizedPath: ActiveFSPath) => Result | Promise<Result>,
    detail: (result: Result) => string | undefined
  ): Promise<Result> => {
    const normalizedPath = normalizeActiveFSPath(path);
    const startedAt = new Date();
    try {
      const result = await action(normalizedPath);
      const completedAt = new Date();
      record({
        treeId,
        operation,
        path: normalizedPath,
        result: "ok",
        detail: detail(result),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime()
      });
      return result;
    } catch (error) {
      const completedAt = new Date();
      record({
        treeId,
        operation,
        path: normalizedPath,
        result: "error",
        error: error instanceof Error ? error.message : String(error),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime()
      });
      throw error;
    }
  };

  const instrumented: ActiveFSTree = {
    name: tree.name,
    get capabilities() {
      return tree.capabilities;
    },
    set(path, declaration) {
      tree.set(path, declaration);
      return instrumented;
    },
    path: (path) => tree.path(path),
    info: (context, path) =>
      run("info", path, (normalizedPath) => tree.info(context, normalizedPath), describeInfo),
    list: (context, path) =>
      run("list", path, (normalizedPath) => tree.list(context, normalizedPath), describeList),
    read: (context, path, options) =>
      run("read", path, (normalizedPath) => tree.read(context, normalizedPath, options), describeRead),
    search: (context, path, query) =>
      run("search", path, (normalizedPath) => tree.search(context, normalizedPath, query), describeSearch),
    walk: (context, path, options) => tree.walk(context, path, options),
    write: (context, path, content, options) =>
      run("write", path, (normalizedPath) => tree.write(context, normalizedPath, content, options), describeMutation),
    remove: (context, path, options) =>
      run("remove", path, (normalizedPath) => tree.remove(context, normalizedPath, options), describeMutation),
    makeDir: (context, path, options) =>
      run("makeDir", path, (normalizedPath) => tree.makeDir(context, normalizedPath, options), describeMutation),
    move: (context, fromPath, toPath, options) =>
      run("move", fromPath, (normalizedPath) => tree.move(context, normalizedPath, toPath, options), describeMutation),
    copy: (context, fromPath, toPath, options) =>
      run("copy", fromPath, (normalizedPath) => tree.copy(context, normalizedPath, toPath, options), describeMutation),
    truncate: (context, path, options) =>
      run("truncate", path, (normalizedPath) => tree.truncate(context, normalizedPath, options), describeMutation),
    updateInfo: (context, path, options) =>
      run("updateInfo", path, (normalizedPath) => tree.updateInfo(context, normalizedPath, options), describeMutation),
    watch: (context, path, onEvent, options) => tree.watch(context, path, onEvent, options),
    pre(operation, hook) {
      tree.pre(operation, hook);
      return instrumented;
    },
    post(operation, hook) {
      tree.post(operation, hook);
      return instrumented;
    },
    on(event, handler) {
      tree.on(event, handler);
      return instrumented;
    },
    onChange(handler) {
      tree.onChange(handler);
      return instrumented;
    },
    command: (context, command, path, input) => tree.command(context, command, path, input)
  };

  return instrumented;
}

function describeInfo(info: ActiveFSTreeInfo): string {
  return info ? `${info.kind ?? "entry"} ${normalizeActiveFSPath(info.path ?? "/")}` : "missing";
}

function describeList(result: ActiveFSTreeListResult): string {
  return `${Array.isArray(result) ? result.length : Object.keys(result).length} entries`;
}

function describeRead(result: ActiveFSTreeReadResult): string {
  return `${contentLength(treeReadContent(result))} bytes`;
}

function describeSearch(result: ActiveFSTreeSearchResult): string {
  return `${result.matches.length} matches`;
}

function describeMutation(result: ActiveFSTreeMutationResult): string {
  if (result && typeof result === "object" && "modified" in result && result.modified) {
    return `modified ${result.modified}`;
  }
  if (result && typeof result === "object" && "created" in result && result.created) {
    return `created ${result.created}`;
  }
  return "mutation accepted";
}

function treeReadContent(result: ActiveFSTreeReadResult): string | Uint8Array | ArrayBuffer {
  return result && typeof result === "object" && "content" in result
    ? result.content as string | Uint8Array | ArrayBuffer
    : result as string | Uint8Array | ArrayBuffer;
}

function contentLength(content: string | Uint8Array | ArrayBuffer): number {
  if (typeof content === "string") {
    return new TextEncoder().encode(content).byteLength;
  }
  return content instanceof ArrayBuffer ? content.byteLength : content.byteLength;
}

function treePathFromLogicalPath(mountPath: ActiveFSPath, logicalPath: ActiveFSPath): ActiveFSPath {
  if (logicalPath === mountPath) {
    return "/";
  }
  if (logicalPath.startsWith(`${mountPath}/`)) {
    return normalizeActiveFSPath(logicalPath.slice(mountPath.length));
  }
  return logicalPath;
}

function durationBetween(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  return Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : 0;
}

async function fetchJson<Result>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<Result> {
  const { headers, ...rest } = init ?? {};
  const response = await fetchImpl(url, {
    ...rest,
    headers: jsonHeaders(headers)
  });
  if (!response.ok) {
    throw new Error(`Request failed ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Result>;
}

function jsonHeaders(headers: HeadersInit | undefined): HeadersInit {
  if (!headers) {
    return { accept: "application/json" };
  }
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    if (!next.has("accept")) {
      next.set("accept", "application/json");
    }
    return next;
  }
  if (Array.isArray(headers)) {
    return [["accept", "application/json"], ...headers];
  }
  return {
    accept: "application/json",
    ...headers
  };
}

async function readJson<Result>(request: IncomingMessage): Promise<Result> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return (body ? JSON.parse(body) : {}) as Result;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function writeHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8"
  });
  response.end(html);
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function inferredClientId(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  const userAgent = headerValue(request, "user-agent") ?? "tree-api";
  return slugify(`${address}-${userAgent}`) || "tree-api-client";
}

function inferredClientLabel(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "client";
  const userAgent = headerValue(request, "user-agent");
  return userAgent ? `Source API ${address}` : `Source API client ${address}`;
}

function observedMountStatus(request: IncomingMessage): RemoteMountMonitorMountStatus {
  const explicit = headerValue(request, "x-activefs-monitor-status");
  if (explicit === "mounted" || explicit === "unmounted") {
    return explicit;
  }
  const url = new URL(request.url ?? "/", "http://activefs-tree.local");
  const endpoint = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  return ["stat", "list", "read", "search", "write", "delete", "sessions"].includes(endpoint)
    ? "mounted"
    : "unmounted";
}

function isSessionEventRequest(request: IncomingMessage): boolean {
  const url = new URL(request.url ?? "/", "http://activefs-tree.local");
  return request.method === "GET" && /\/sessions\/[^/]+\/events$/.test(url.pathname);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

function monitorPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ActiveFS Remote Mount Monitor</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #11110f;
      --surface: #191917;
      --surface-2: #22221f;
      --line: #34342f;
      --text: #f4f1e8;
      --muted: #a7a296;
      --accent: #8ee86b;
      --accent-2: #f0b84d;
      --bad: #ff6b5f;
      --info: #6bc7e8;
      --quiet: #777166;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    button, input {
      font: inherit;
    }

    .shell {
      min-height: 100svh;
      display: grid;
      grid-template-rows: auto auto 1fr;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
      padding: 22px 28px 18px;
      border-bottom: 1px solid var(--line);
    }

    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 680;
      letter-spacing: 0;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--muted);
      white-space: nowrap;
    }

    .status::before {
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 16px rgba(142, 232, 107, 0.55);
    }

    .toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 28px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }

    form {
      display: flex;
      align-items: center;
      gap: 10px;
      width: min(620px, 100%);
    }

    input {
      min-width: 0;
      width: 100%;
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--line);
      background: #0f0f0d;
      color: var(--text);
      outline: none;
    }

    input:focus {
      border-color: var(--info);
    }

    button {
      height: 38px;
      padding: 0 14px;
      border: 1px solid #5d7b47;
      background: #25351f;
      color: var(--text);
      cursor: pointer;
      white-space: nowrap;
    }

    button:hover {
      border-color: var(--accent);
    }

    .count {
      color: var(--muted);
      white-space: nowrap;
    }

    .columns {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(320px, 380px);
      gap: 1px;
      overflow-x: auto;
      background: var(--line);
    }

    .empty {
      padding: 42px 28px;
      color: var(--muted);
      background: var(--bg);
    }

    .tree-column {
      min-height: calc(100svh - 126px);
      display: grid;
      grid-template-rows: auto auto auto 1fr;
      background: var(--surface);
      border-top: 2px solid transparent;
      transition: border-color 160ms ease, background 160ms ease;
    }

    .tree-column[data-hot="true"] {
      border-color: var(--accent);
      background: #1d2119;
    }

    .tree-head {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line);
    }

    .tree-head h2 {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .mono {
      overflow-wrap: anywhere;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      color: var(--muted);
    }

    .mounts {
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
    }

    .mount-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: start;
      gap: 12px;
      padding: 9px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .mount-row:last-child {
      border-bottom: 0;
    }

    .connection-dot,
    .event-marker {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--conn, var(--info));
      box-shadow: 0 0 12px color-mix(in srgb, var(--conn, var(--info)) 55%, transparent);
    }

    .connection-dot {
      margin-top: 5px;
    }

    .mount-title {
      overflow-wrap: anywhere;
    }

    .pill {
      align-self: start;
      color: #0e140d;
      background: var(--accent);
      padding: 2px 7px;
      font-size: 12px;
      font-weight: 650;
    }

    .pill.unmounted {
      background: var(--quiet);
      color: var(--text);
    }

    .section-label {
      margin: 0 0 7px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .events {
      min-height: 0;
      overflow-y: auto;
      padding: 14px 18px 22px;
    }

    .event-row {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 9px 10px;
      align-items: start;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .event-row:last-child {
      border-bottom: 0;
    }

    .event-type {
      color: var(--info);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      min-width: 48px;
    }

    .event-row.error .event-type {
      color: var(--bad);
    }

    .event-main {
      min-width: 0;
    }

    .event-path {
      overflow-wrap: anywhere;
      color: var(--text);
    }

    .event-meta {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }

    @media (max-width: 720px) {
      header,
      .toolbar {
        padding-left: 16px;
        padding-right: 16px;
      }

      header,
      .toolbar,
      form {
        align-items: stretch;
        flex-direction: column;
      }

      .columns {
        grid-auto-columns: minmax(280px, 86vw);
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header>
      <h1>ActiveFS Remote Mount Monitor</h1>
      <div class="status" id="serverStatus">Connecting</div>
    </header>
    <section class="toolbar">
      <form id="createTreeForm">
        <input id="treeName" name="treeName" placeholder="Tree name" autocomplete="off">
        <button type="submit">Create Tree</button>
      </form>
      <div class="count" id="summary">0 trees</div>
    </section>
    <section id="columns" class="columns">
      <div class="empty">No trees yet.</div>
    </section>
  </main>
  <script>
    let state = { trees: [], mounts: [], events: [] };

    const columns = document.getElementById("columns");
    const status = document.getElementById("serverStatus");
    const summary = document.getElementById("summary");
    const form = document.getElementById("createTreeForm");
    const nameInput = document.getElementById("treeName");

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function (character) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;"
        }[character];
      });
    }

    function eventLabel(event) {
      return event.type === "tree-request" ? "remote" : "client";
    }

    const connectionColors = ["#6bc7e8", "#f0b84d", "#8ee86b", "#ff8f70", "#b79cff", "#52d0a8"];

    function connectionColor(index) {
      return connectionColors[index % connectionColors.length];
    }

    function render() {
      status.textContent = state.trees.length + " trees";
      summary.textContent = state.mounts.length + " mounts / " + state.events.length + " events";

      if (state.trees.length === 0) {
        columns.innerHTML = '<div class="empty">No trees yet.</div>';
        return;
      }

      const latestByTree = new Map();
      for (const event of state.events) {
        latestByTree.set(event.treeId, event.id);
      }
      const latestEventId = state.events.length ? state.events[state.events.length - 1].id : 0;

      columns.innerHTML = state.trees.map(function (tree) {
        const mounts = state.mounts.filter(function (mount) { return mount.treeId === tree.id; });
        const mountById = new Map(mounts.map(function (mount, index) {
          return [mount.id, { mount: mount, color: connectionColor(index) }];
        }));
        const events = state.events
          .filter(function (event) { return event.treeId === tree.id; })
          .slice(-18)
          .reverse();
        const hot = latestByTree.get(tree.id) === latestEventId;

        return '<article class="tree-column" data-hot="' + hot + '">' +
          '<div class="tree-head">' +
            '<h2>' + escapeHtml(tree.name) + '</h2>' +
            '<div class="mono">' + escapeHtml(tree.treeUrl) + '</div>' +
          '</div>' +
          '<div class="mounts">' +
            '<p class="section-label">Connected Mounts</p>' +
            (mounts.length ? mounts.map(function (mount, index) {
              const color = connectionColor(index);
              return '<div class="mount-row" style="--conn: ' + color + '">' +
                '<span class="connection-dot" aria-hidden="true"></span>' +
                '<div class="mount-main">' +
                  '<div class="mount-title">' + escapeHtml(mount.label) + '</div>' +
                  '<div class="mono">' + escapeHtml(mount.mountPath) + ' / ' + escapeHtml(mount.clientId) + '</div>' +
                '</div>' +
                '<span class="pill ' + (mount.status === "unmounted" ? "unmounted" : "") + '">' + escapeHtml(mount.status) + '</span>' +
              '</div>';
            }).join("") : '<div class="mono">No connected clients</div>') +
          '</div>' +
          '<div class="events">' +
            '<p class="section-label">Requests</p>' +
            (events.length ? events.map(function (event) {
              const connection = event.mountId ? mountById.get(event.mountId) : undefined;
              const connectionLabel = connection ? connection.mount.label : (event.clientId || "tree");
              const color = connection ? connection.color : "#777166";
              const path = event.logicalPath || event.path;
              const detail = event.detail || event.error || "";
              return '<div class="event-row ' + (event.result === "error" ? "error" : "") + '" style="--conn: ' + color + '">' +
                '<span class="event-marker" title="' + escapeHtml(connectionLabel) + '"></span>' +
                '<div class="event-type">' + escapeHtml(eventLabel(event)) + '</div>' +
                '<div class="event-main">' +
                  '<div class="event-path">' + escapeHtml(event.operation) + ' ' + escapeHtml(path) + '</div>' +
                  '<div class="event-meta">' + escapeHtml(connectionLabel) + ' / ' + escapeHtml(detail) + ' / ' + event.durationMs + 'ms</div>' +
                '</div>' +
              '</div>';
            }).join("") : '<div class="mono">No requests yet</div>') +
          '</div>' +
        '</article>';
      }).join("");
    }

    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      const name = nameInput.value.trim();
      const response = await fetch("/api/trees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || undefined })
      });
      if (response.ok) {
        nameInput.value = "";
      }
    });

    const events = new EventSource("/events");
    events.addEventListener("state", function (event) {
      state = JSON.parse(event.data);
      render();
    });
  </script>
</body>
</html>`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shouldServe = process.argv.includes("--serve");
  if (shouldServe) {
    const portArg = process.argv.find((arg) => arg.startsWith("--port="));
    const port = portArg ? Number.parseInt(portArg.slice("--port=".length), 10) : Number(process.env.PORT ?? 3998);
    const server = await startRemoteMountMonitorServer({
      port,
      initialTrees: [
        { name: "docs", suggestedMountPath: "/docs" },
        { name: "reports", suggestedMountPath: "/reports" }
      ]
    });
    console.log(`ActiveFS remote mount monitor listening at ${server.url}`);
    console.log(`Open ${server.url}`);
  } else {
    const result = await runRemoteMountMonitorExample();
    console.log(`monitor page: ${result.monitorUrl}`);
    console.log(`remote mount monitor trees: ${result.trees.length}`);
    console.log(`connected mounts: ${result.mounts}`);
    console.log(`tree request events: ${result.treeRequestEvents}`);
    console.log(`client activity events: ${result.clientActivityEvents}`);
    console.log(result.entries.join("\n"));
    console.log(result.readme.split("\n")[0]);
    console.log(`remote matches: ${result.matches}`);
  }
}
