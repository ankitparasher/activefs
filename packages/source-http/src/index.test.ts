import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActiveFSError,
  createActiveFS,
  dir,
  fsTree,
  text as treeText,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSReadOptions,
  type ActiveFSSearchQuery,
  type ActiveFSTree,
  type ActiveFSTreeMutationResult,
  type ActiveFSTreeReadResult,
  type ActiveFSWatchEvent,
  type ActiveFSWatchSubscription
} from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import {
  ACTIVEFS_SOURCE_PROTOCOL_VERSION,
  clientAuthHeaders,
  createActiveFSSourceService,
  createActiveFSTreeServer,
  createHttpSourceClient,
  parseActiveFSTreeRemoteSpec,
  startActiveFSServer,
  verifyActiveFSSessionEvent,
  type ActiveFSSessionEvent,
  type ActiveFSSourceEndpoints,
  type ActiveFSTreeHandshake,
  type ActiveFSTreeServerHandle
} from "@activefs/source-http";

const servers: ActiveFSTreeServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HTTP Source API service protocol", () => {
  it("uses the exact discovery URL while the standalone helper owns its convenience routes", async () => {
    const server = await serve(
      createMemoryTree({
        files: {
          "/README.txt": "remote hello"
        }
      })
    );

    expect(parseActiveFSTreeRemoteSpec("docs:/docs=http://127.0.0.1:3999/activefs/v1")).toMatchObject({
      name: "docs",
      mountPath: "/docs",
      url: "http://127.0.0.1:3999/activefs/v1"
    });
    expect(() => parseActiveFSTreeRemoteSpec("bad-spec")).toThrow("name=url");
    expect(server.url).toContain("/_activefs/");

    const response = await fetch(new URL("stat", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/README.txt", ctx: {} })
    });
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toMatchObject({
      path: "/README.txt",
      kind: "file"
    });

    const oldPrefix = await fetch(new URL("/activefs/stat", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/README.txt", ctx: {} })
    });
    const bareRoot = await fetch(new URL("/stat", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/README.txt", ctx: {} })
    });
    expect(oldPrefix.status).toBe(404);
    expect(bareRoot.status).toBe(404);

    const capabilities = await fetch(new URL("capabilities", server.url));
    await expect(capabilities.json()).resolves.toMatchObject({
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      statable: true,
      listable: true,
      readable: true,
      activefs: {
        stat: true,
        list: true,
        read: true
      }
    });

    const custom = await serve(
      createMemoryTree({ files: { "/custom.txt": "custom" } }),
      undefined,
      { routes: { handshake: "/product/source-discovery.json" } }
    );
    expect(custom.url).toMatch(/\/product\/source-discovery\.json$/);
    const customClient = createHttpSourceClient({ url: custom.url });
    await expect(customClient.read({}, "/custom.txt")).resolves.toMatchObject({ content: "custom" });
  });

  it("returns a typed handshake with capabilities", async () => {
    const server = await serve(
      createMemoryTree({
        searchable: true,
        watchable: true,
        writable: true,
        files: { "/README.txt": "remote hello" }
      })
    );
    const client = createHttpSourceClient({ url: server.url, name: "docs" });

    const handshake = await client.fetchHandshake();

    expect(handshake).toMatchObject({
      protocol: "activefs-source",
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      capabilities: {
        protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
        readable: true,
        writable: true,
        searchable: true,
        watchable: true
      }
    });
    expect(client.capabilities).toMatchObject({
      read: true,
      write: true,
      search: true,
      watch: true
    });
  });

  it("keeps Node and Fetch protocol serialization equivalent", async () => {
    const treeOptions = {
      files: {
        "/text.txt": "hello",
        "/bytes.bin": new Uint8Array([0, 1, 2, 255])
      },
      writable: true,
      watchable: false
    };
    const nodeTree = createMemoryTree(treeOptions);
    const fetchTree = createMemoryTree(treeOptions);
    const server = await serve(nodeTree);
    const nodeHandshakeResponse = await fetch(server.url);
    const nodeHandshake = await nodeHandshakeResponse.json() as ActiveFSTreeHandshake;
    const service = createActiveFSSourceService({
      tree: fetchTree,
      endpoints: nodeHandshake.endpoints,
      resourceLinks: {
        session: ({ sessionId }) => ({
          eventEndpoint: `/_activefs/sessions/${sessionId}/events`,
          ackEndpoint: `/_activefs/sessions/${sessionId}/acks`,
          activityEndpoint: `/_activefs/sessions/${sessionId}/activity`
        }),
        operationStatus: ({ operationId }) => `/_activefs/operations/${encodeURIComponent(operationId)}`
      }
    });

    const vectors: Array<{
      operation: "handshake" | "capabilities" | "config" | "policy" | "list" | "read" | "stat";
      endpoint: keyof ActiveFSSourceEndpoints | "handshake";
      method: "GET" | "POST";
      body?: unknown;
      accept?: string;
    }> = [
      { operation: "handshake", endpoint: "handshake", method: "GET" },
      { operation: "capabilities", endpoint: "capabilities", method: "GET" },
      { operation: "config", endpoint: "config", method: "GET" },
      { operation: "policy", endpoint: "policy", method: "GET" },
      { operation: "list", endpoint: "list", method: "POST", body: { path: "/", ctx: {} } },
      { operation: "read", endpoint: "read", method: "POST", body: { path: "/text.txt", ctx: {} } },
      {
        operation: "read",
        endpoint: "read",
        method: "POST",
        body: { path: "/bytes.bin", ctx: {}, options: { offset: 1, length: 2 }, responseFormat: "octet-stream" },
        accept: "application/octet-stream"
      },
      { operation: "stat", endpoint: "stat", method: "POST", body: { path: "relative", ctx: {} } }
    ];

    for (const vector of vectors) {
      const endpoint = vector.endpoint === "handshake"
        ? server.url
        : new URL(nodeHandshake.endpoints[vector.endpoint]!, server.url).href;
      const init: RequestInit = {
        method: vector.method,
        headers: {
          ...(vector.body === undefined ? {} : { "content-type": "application/json" }),
          ...(vector.accept ? { accept: vector.accept } : {})
        },
        body: vector.body === undefined ? undefined : JSON.stringify(vector.body)
      };
      const [nodeResponse, fetchResponse] = await Promise.all([
        fetch(endpoint, init),
        service.handle(vector.operation, new Request(endpoint, init))
      ]);
      expect(fetchResponse.status, vector.operation).toBe(nodeResponse.status);
      for (const header of ["content-type", "content-digest", "repr-digest", "x-activefs-stat"]) {
        expect(fetchResponse.headers.get(header), `${vector.operation} ${header}`).toBe(nodeResponse.headers.get(header));
      }
      expect(
        new Uint8Array(await fetchResponse.arrayBuffer()),
        `${vector.operation} body`
      ).toEqual(new Uint8Array(await nodeResponse.arrayBuffer()));
    }

    const writeEndpoint = new URL(nodeHandshake.endpoints.write!, server.url).href;
    const mutationInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path: "/created.txt",
        content: "created",
        ctx: {},
        options: { idempotencyKey: "node-fetch-equivalence" }
      })
    };
    const [nodeMutationResponse, fetchMutationResponse] = await Promise.all([
      fetch(writeEndpoint, mutationInit),
      service.handle("write", new Request(writeEndpoint, mutationInit))
    ]);
    const nodeMutation = await nodeMutationResponse.json() as {
      operationId: string;
      operationStatusEndpoint: string;
    };
    const fetchMutation = await fetchMutationResponse.json() as typeof nodeMutation;
    expect(fetchMutation).toEqual(nodeMutation);

    const nodeStatusResponse = await fetch(new URL(nodeMutation.operationStatusEndpoint, server.url));
    const fetchStatusResponse = await service.handle(
      "operationStatus",
      new Request(new URL(fetchMutation.operationStatusEndpoint, server.url)),
      { operationId: fetchMutation.operationId }
    );
    const nodeStatus = await nodeStatusResponse.json() as Record<string, unknown>;
    const fetchStatus = await fetchStatusResponse.json() as Record<string, unknown>;
    const withoutTimes = ({ startedAt: _startedAt, completedAt: _completedAt, ...status }: Record<string, unknown>) => status;
    expect(withoutTimes(fetchStatus)).toEqual(withoutTimes(nodeStatus));

    const sessionEndpoint = new URL(nodeHandshake.endpoints.sessions!, server.url).href;
    const sessionInit: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/", ctx: {} })
    };
    const [nodeSessionResponse, fetchSessionResponse] = await Promise.all([
      fetch(sessionEndpoint, sessionInit),
      service.handle("createSession", new Request(sessionEndpoint, sessionInit))
    ]);
    const nodeSession = await nodeSessionResponse.json() as {
      sessionId: string;
      createdAt: string;
      eventEndpoint: string;
      ackEndpoint: string;
      activityEndpoint: string;
    };
    const fetchSession = await fetchSessionResponse.json() as typeof nodeSession;
    const normalizeSession = (session: typeof nodeSession) => ({
      ...session,
      sessionId: "<session>",
      createdAt: "<time>",
      eventEndpoint: session.eventEndpoint.replace(session.sessionId, "<session>"),
      ackEndpoint: session.ackEndpoint.replace(session.sessionId, "<session>"),
      activityEndpoint: session.activityEndpoint.replace(session.sessionId, "<session>")
    });
    expect(normalizeSession(fetchSession)).toEqual(normalizeSession(nodeSession));

    const nodeEvents = await fetch(new URL(nodeSession.eventEndpoint, server.url));
    const fetchEvents = await service.handle(
      "sessionEvents",
      new Request(new URL(fetchSession.eventEndpoint, server.url)),
      { sessionId: fetchSession.sessionId }
    );
    const nodeReader = nodeEvents.body!.getReader();
    const fetchReader = fetchEvents.body!.getReader();
    const [nodeEvent, fetchEvent] = await Promise.all([
      readSessionEventUntil(nodeReader, () => true),
      readSessionEventUntil(fetchReader, () => true)
    ]);
    expect({ type: fetchEvent.type, payload: fetchEvent.payload }).toEqual({
      type: nodeEvent.type,
      payload: nodeEvent.payload
    });
    await Promise.all([
      nodeReader.cancel().catch(() => undefined),
      fetchReader.cancel().catch(() => undefined)
    ]);
  });

  it("merges request-aware handshake hints with default capabilities", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/README.txt": "remote hello" },
        writable: true
      }),
      { type: "bearer", token: "handshake-token" },
      {
        handshake: ({ request }) => ({
          server: { name: "docs-source", version: "1.0.0" },
          workspace: {
            displayName: String(request.headers["x-workspace"] ?? "Docs"),
            suggestedMountPath: "/docs"
          },
          cache: { directoryTtlMs: 60_000 },
          revisions: { config: "cfg-1", policy: "pol-1" }
        })
      }
    );

    const response = await fetch(server.url, {
      headers: {
        authorization: "Bearer handshake-token",
        "x-workspace": "Tenant Docs"
      }
    });
    const handshake = await response.json();

    expect(handshake).toMatchObject({
      protocol: "activefs-source",
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      server: { name: "docs-source", version: "1.0.0" },
      workspace: { displayName: "Tenant Docs", suggestedMountPath: "/docs" },
      auth: { required: true, schemes: ["bearer"] },
      freshness: { sessions: true, changes: true },
      mutations: { writable: true, operations: expect.arrayContaining(["write"]) },
      cache: { directoryTtlMs: 60000 },
      revisions: { config: "cfg-1", policy: "pol-1" },
      capabilities: {
        protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
        writable: true
      }
    });
  });

  it("lists, stats, and reads a remote tree through ActiveFS", async () => {
    const server = await serve(
      createMemoryTree({
        files: {
          "/README.txt": "remote hello",
          "/nested/detail.txt": "nested remote detail"
        }
      })
    );
    const fs = createActiveFS().mount("/remote", createHttpSourceClient({ url: server.url }));

    const entries = await fs.list({}, "/remote");
    const stat = await fs.stat({}, "/remote/README.txt");
    const read = await fs.read({}, "/remote/README.txt");

    expect(entries.map((entry) => entry.path).sort()).toEqual(["/remote/README.txt", "/remote/nested"]);
    expect(stat).toMatchObject({ kind: "file", path: "/remote/README.txt", size: 12 });
    expect(text(read)).toBe("remote hello");
  });

  it("uses remote tree search when the service exposes it", async () => {
    let searchCalls = 0;
    const inner = createMemoryTree({
      searchable: true,
      files: {
        "/indexed.txt": "needle from indexed remote"
      }
    });
    const originalSearch = inner.search.bind(inner);
    const tree: ActiveFSTree = inner;
    tree.search = async (
      context: ActiveFSContext,
      path: ActiveFSPath,
      query: ActiveFSSearchQuery
    ) => {
      searchCalls += 1;
      return originalSearch(context, path, query);
    };
    const server = await serve(tree);
    const fs = createActiveFS().mount("/remote", createHttpSourceClient({ url: server.url }));

    const result = await fs.search({}, "/remote", { pattern: "needle" });

    expect(searchCalls).toBe(1);
    expect(result.matches.map((match) => match.path)).toEqual(["/remote/indexed.txt"]);
  });

  it("preserves optional command handlers across the Source API", async () => {
    let grepCalls = 0;
    const tree = fsTree({
      "diagram.png": treeText("binary placeholder").setGrep(({ path, input }) => {
        grepCalls += 1;
        return {
          matches: [{ path, excerpt: `OCR:${input.pattern}` }],
          complete: true,
          strategy: "source"
        };
      })
    });
    const server = await serve(tree);
    const fs = createActiveFS().mount("/remote", createHttpSourceClient({ url: server.url }));

    const result = await fs.command({}, "grep", "/remote/diagram.png", { pattern: "architecture" });

    expect(grepCalls).toBe(1);
    expect(result).toMatchObject({
      complete: true,
      strategy: "source",
      matches: [{ path: "/remote/diagram.png", excerpt: "OCR:architecture" }]
    });
  });

  it("falls back to remote list/read search when remote search is unsupported", async () => {
    const server = await serve(
      createMemoryTree({
        files: {
          "/a.txt": "needle in a",
          "/nested/b.txt": "needle in b"
        }
      })
    );
    const fs = createActiveFS().mount("/remote", createHttpSourceClient({ url: server.url }));

    const result = await fs.search({}, "/remote", { pattern: "needle" });

    expect(result.matches.map((match) => match.path).sort()).toEqual([
      "/remote/a.txt",
      "/remote/nested/b.txt"
    ]);
    expect(result.strategy).toBe("scan");
  });

  it("maps tree errors into standardized ActiveFSError responses", async () => {
    const server = await serve(createMemoryTree({ files: { "/exists.txt": "ok" } }));
    const client = createHttpSourceClient({ url: server.url });

    await expect(client.read({}, "/missing.txt")).rejects.toMatchObject({
      name: "ActiveFSError",
      code: "NOT_FOUND",
      path: "/missing.txt"
    });

    const response = await fetch(new URL("read", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/missing.txt", ctx: {} })
    });
    await expect(response.json()).resolves.toMatchObject({
      error: {
        name: "ActiveFSNotFoundError",
        code: "NOT_FOUND",
        internalCode: "NOT_FOUND",
        path: "/missing.txt"
      }
    });

    const directoryInner = createMemoryTree({ files: { "/exists.txt": "ok" } });
    const directoryServer = await serve({
      ...directoryInner,
      read: async (context, path, options) => {
        if (path === "/") {
          throw new ActiveFSError("NOT_FILE", "Path is a directory: /", { path });
        }
        return directoryInner.read(context, path, options);
      }
    });
    const directoryRead = await fetch(new URL("read", directoryServer.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/", ctx: {} })
    });
    await expect(directoryRead.json()).resolves.toMatchObject({
      error: {
        name: "ActiveFSIsDirectoryError",
        code: "IS_DIRECTORY",
        internalCode: "NOT_FILE",
        path: "/"
      }
    });

    const unsupportedSearch = await fetch(new URL("search", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/", ctx: {}, query: { pattern: "ok" } })
    });
    await expect(unsupportedSearch.json()).resolves.toMatchObject({
      error: {
        name: "ActiveFSUnsupportedOperationError",
        code: "UNSUPPORTED_OPERATION",
        internalCode: "UNSUPPORTED"
      }
    });
  });

  it("rejects unsupported routes, auth failures, malformed bodies, and unsupported mutations", async () => {
    const server = await serve(createMemoryTree({ files: { "/exists.txt": "ok" } }), {
      type: "basic",
      username: "alice",
      password: "secret",
      realm: "ActiveFS Test"
    });
    const auth = { authorization: "Basic YWxpY2U6c2VjcmV0" };

    const unauthenticated = await fetch(new URL("capabilities", server.url));
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.headers.get("www-authenticate")).toBe("Basic realm=\"ActiveFS Test\"");

    const callbackServer = await serve(
      createMemoryTree({ files: { "/callback.txt": "ok" } }),
      async (request) => request.headers["x-callback-auth"] === "allowed"
    );
    const callbackDenied = await fetch(callbackServer.url);
    const callbackAllowed = await fetch(callbackServer.url, {
      headers: { "x-callback-auth": "allowed" }
    });
    expect(callbackDenied.status).toBe(403);
    expect(callbackAllowed.status).toBe(200);

    const unsupportedGet = await fetch(new URL("unknown", server.url), { headers: auth });
    const missingPost = await fetch(new URL("unknown", server.url), { method: "POST", headers: auth });
    const emptyBody = await fetch(new URL("list", server.url), { method: "POST", headers: auth });
    const missingCtx = await postJson(server.url, "stat", { path: "/exists.txt" }, auth);
    const invalidCtx = await postJson(server.url, "stat", { path: "/exists.txt", ctx: null }, auth);
    const searchServer = await serve(createMemoryTree({ files: { "/exists.txt": "ok" }, searchable: true }));
    const invalidSearch = await postJson(searchServer.url, "search", { path: "/", ctx: {}, query: {} });
    const limitedServer = await serve(
      createMemoryTree({ files: { "/exists.txt": "ok" } }),
      undefined,
      { maxRequestBodyBytes: 64 }
    );
    const oversizedBody = await postJson(limitedServer.url, "list", {
      path: "/",
      ctx: { meta: { padding: "x".repeat(128) } }
    });
    const events = await fetch(new URL("events", server.url), { headers: auth });

    expect(unsupportedGet.status).toBe(404);
    expect(missingPost.status).toBe(404);
    expect(emptyBody.status).toBe(400);
    expect(missingCtx.status).toBe(400);
    expect(invalidCtx.status).toBe(400);
    expect(invalidSearch.status).toBe(400);
    expect(oversizedBody.status).toBe(400);
    await expect(oversizedBody.json()).resolves.toMatchObject({
      error: { code: "INVALID_PATH", internalCode: "INVALID_REQUEST" }
    });
    expect(events.status).toBe(404);

    const unsupportedMutations = [
      ["write", { path: "/exists.txt", ctx: {}, content: "new" }],
      ["delete", { path: "/exists.txt", ctx: {} }],
      ["mkdir", { path: "/dir", ctx: {} }],
      ["rmdir", { path: "/dir", ctx: {} }],
      ["rename", { path: "/exists.txt", toPath: "/renamed.txt", ctx: {} }],
      ["copy", { path: "/exists.txt", toPath: "/copy.txt", ctx: {} }],
      ["truncate", { path: "/exists.txt", ctx: {} }],
      ["metadata", { path: "/exists.txt", ctx: {}, options: { mtimeMs: 1 } }]
    ] as const;

    for (const [endpoint, body] of unsupportedMutations) {
      const response = await postJson(server.url, endpoint, body, auth);
      expect(response.status, endpoint).toBe(405);
      await expect(response.json(), endpoint).resolves.toMatchObject({
        error: {
          code: "UNSUPPORTED_OPERATION"
        }
      });
    }
  });

  it("validates client handshakes, response digests, read payloads, and session routes", async () => {
    const badHandshake = createHttpSourceClient({
      url: "http://activefs.test/",
      allowInsecureHttp: true,
      fetch: async () =>
        new Response(JSON.stringify({ protocol: "other", protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION }), {
          status: 200
        })
    });
    await expect(badHandshake.fetchHandshake()).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const badCapabilities = createHttpSourceClient({
      url: "http://activefs.test/",
      allowInsecureHttp: true,
      fetch: async () =>
        new Response(JSON.stringify({ protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION + 1 }), { status: 200 })
    });
    await expect(badCapabilities.fetchCapabilities()).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const badReadPayload = createHttpSourceClient({
      url: "http://activefs.test/",
      allowInsecureHttp: true,
      handshake: minimalHandshake({
        stat: "http://activefs.test/stat",
        list: "http://activefs.test/list",
        read: "http://activefs.test/read"
      }),
      fetch: async () => new Response(JSON.stringify({ stat: null }), { status: 200 })
    });
    await expect(badReadPayload.read({}, "/bad.txt")).rejects.toMatchObject({
      code: "SOURCE_ERROR",
      message: "HTTP Source API read response did not include content"
    });

    const unsupportedDigest = createHttpSourceClient({
      url: "http://activefs.test/",
      allowInsecureHttp: true,
      fetch: async () =>
        new Response("{\"protocolVersion\":1}\n", {
          status: 200,
          headers: { "content-digest": "md5=:AAAA:" }
        })
    });
    await expect(unsupportedDigest.fetchCapabilities()).rejects.toMatchObject({
      code: "SOURCE_ERROR",
      message: "Unsupported content-digest header"
    });

    const server = await serve(createMemoryTree({ files: { "/exists.txt": "ok" } }));
    const session = await postJson(server.url, "sessions", { ctx: {}, path: "/" });
    const created = await session.json() as { sessionId: string };
    const unknownSession = await fetch(new URL("sessions/missing/events", server.url));
    const wrongEventsMethod = await fetch(new URL(`sessions/${created.sessionId}/events`, server.url), {
      method: "POST"
    });
    const badAck = await postJson(server.url, `sessions/${created.sessionId}/acks`, { lastAppliedSequence: -1 });
    const wrongActivityMethod = await fetch(new URL(`sessions/${created.sessionId}/activity`, server.url));
    const missingOperation = await fetch(new URL("operations/missing", server.url));

    expect(unknownSession.status).toBe(404);
    expect(wrongEventsMethod.status).toBe(405);
    expect(badAck.status).toBe(400);
    expect(wrongActivityMethod.status).toBe(405);
    expect(missingOperation.status).toBe(404);
    await expect(createHttpSourceClient({ url: server.url }).ackSession("bad/session", 1)).rejects.toMatchObject({
      code: "INVALID_PATH"
    });
  });

  it("accepts required external Source API v1 error codes from remote services", async () => {
    const expected = new Map<string, string>([
      ["NOT_FOUND", "NOT_FOUND"],
      ["NOT_A_DIRECTORY", "NOT_DIRECTORY"],
      ["IS_DIRECTORY", "NOT_FILE"],
      ["PERMISSION_DENIED", "FORBIDDEN"],
      ["UNSUPPORTED_OPERATION", "UNSUPPORTED"],
      ["INVALID_PATH", "INVALID_PATH"],
      ["RANGE_NOT_SATISFIABLE", "INVALID_PATH"],
      ["SOURCE_UNAVAILABLE", "SOURCE_ERROR"],
      ["TIMEOUT", "SOURCE_ERROR"],
      ["INTERNAL_ERROR", "SOURCE_ERROR"]
    ]);

    for (const [externalCode, internalCode] of expected) {
      const client = createHttpSourceClient({
        url: "http://activefs.test/",
        allowInsecureHttp: true,
        fetch: (async () =>
          new Response(
            JSON.stringify({
              error: {
                name: "ActiveFSError",
                code: externalCode,
                message: externalCode,
                path: "/bad"
              }
            }),
            {
              status: 500,
              headers: { "content-type": "application/json" }
            }
          )) as typeof fetch
      });

      await expect(client.read({}, "/bad")).rejects.toMatchObject({
        name: "ActiveFSError",
        code: internalCode,
        path: "/bad"
      });
    }
  });

  it("routes writes over HTTP through the client", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/note.txt": "old" },
        writable: true,
        watchable: true
      })
    );
    const client = createHttpSourceClient({ url: server.url });

    const result = await client.write!({}, "/note.txt", "new", {
      contentType: "text/plain"
    });

    expect(result).toMatchObject({
      modified: "/note.txt",
      info: {
        path: "/note.txt",
        kind: "file"
      }
    });
    expect(mutationOperationId(result)).toBeDefined();
    await expect(client.read({}, "/note.txt")).resolves.toMatchObject({
      content: "new"
    });
  });

  it("serves fsTree trees directly over Source API with writable defaults and SSE events", async () => {
    const committed: string[] = [];
    const tree = fsTree({
      "/README.md": treeText("# Remote Tree\n", { type: "text/markdown" }),
      scratch: dir({}, { writable: true })
    });
    tree.onChange((event) => {
      committed.push(`${event.type}:${event.path}`);
    });
    const server = await startActiveFSServer({ tree });
    servers.push(server);
    const client = createHttpSourceClient({ url: server.url });
    const watched: ActiveFSWatchEvent[] = [];
    const subscription = await client.watch!({}, "/", (event) => watched.push(event), {
      recursive: true
    });

    await expect(client.read({}, "/README.md")).resolves.toMatchObject({
      content: "# Remote Tree\n"
    });
    await expect(client.info({}, "/README.md")).resolves.toMatchObject({
      path: "/README.md",
      kind: "file",
      type: "text/markdown"
    });
    await expect(client.list({}, "/")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "/README.md", kind: "file" }),
      expect.objectContaining({ path: "/scratch", kind: "directory" })
    ]));
    await expect(client.search!({}, "/", { pattern: "Remote Tree" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/README.md" })]
    });

    tree.set("/server-added.txt", treeText("server event\n"));
    await waitFor(() => watched.some((event) => event.path === "/server-added.txt"));
    await expect(client.read({}, "/server-added.txt")).resolves.toMatchObject({
      content: "server event\n"
    });

    const result = await client.write!({}, "/scratch/new.txt", "created over http", {
      contentType: "text/plain"
    });
    await waitFor(() => watched.some((event) => event.path === "/scratch/new.txt"));
    await subscription.close();

    expect(result).toMatchObject({
      created: "/scratch/new.txt",
      info: { path: "/scratch/new.txt", kind: "file" }
    });
    await expect(client.read({}, "/scratch/new.txt")).resolves.toMatchObject({
      content: "created over http"
    });
    expect(committed).toContain("created:/server-added.txt");
    expect(committed).toContain("created:/scratch/new.txt");
    expect(watched.map((event) => `${event.type}:${event.path}`)).toEqual(expect.arrayContaining([
      "create:/server-added.txt",
      "create:/scratch/new.txt"
    ]));
  });

  it("starts tree-first servers with startActiveFSServer sugar", async () => {
    const tree = fsTree({
      "/README.md": treeText("# Tree Server\n", { type: "text/markdown" })
    });
    const server = await startActiveFSServer({ tree });
    servers.push(server);
    const client = createHttpSourceClient({ url: server.url });

    await expect(client.read({}, "/README.md")).resolves.toMatchObject({
      content: "# Tree Server\n"
    });
  });

  it("routes canonical filesystem mutations over HTTP", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/existing.txt": "abcdef" },
        writable: true
      })
    );
    const client = createHttpSourceClient({ url: server.url });

    await client.makeDir({}, "/docs");
    await client.write!({}, "/docs/a.txt", "alpha");
    await client.copy!({}, "/docs/a.txt", "/docs/b.txt");
    await client.move({}, "/docs/b.txt", "/docs/c.txt");
    await client.truncate!({}, "/existing.txt", { length: 3 });
    await client.updateInfo({}, "/docs/c.txt", { mtimeMs: 42 });
    await client.remove({}, "/docs/a.txt");
    await client.remove({}, "/docs", { recursive: true });

    const truncated = await client.read({}, "/existing.txt", { encoding: "utf8" });

    expect(text(truncated)).toBe("abc");
    await expect(client.info({}, "/docs")).resolves.toBeNull();
  });

  it("builds client auth headers for all supported descriptors", async () => {
    await expect(clientAuthHeaders("token", {
      method: "GET",
      endpoint: "handshake",
      url: "http://source.test/handshake"
    })).resolves.toEqual({ authorization: "Bearer token" });
    await expect(clientAuthHeaders({ type: "basic", username: "u", password: "p" }, {
      method: "POST",
      endpoint: "read",
      url: "http://source.test/read"
    })).resolves.toEqual({ authorization: "Basic dTpw" });
    await expect(clientAuthHeaders({ headers: { "x-auth": "1" } }, {
      method: "GET",
      endpoint: "capabilities",
      url: "http://source.test/capabilities"
    })).resolves.toEqual({ "x-auth": "1" });
    await expect(clientAuthHeaders(async (request) => ({ "x-endpoint": request.endpoint }), {
      method: "GET",
      endpoint: "changes",
      url: "http://source.test/changes"
    })).resolves.toEqual({ "x-endpoint": "changes" });
    await expect(clientAuthHeaders(false, {
      method: "GET",
      endpoint: "changes",
      url: "http://source.test/changes"
    })).resolves.toEqual({});
  });

  it("forwards ctx.auth and ctx.meta without interpreting them", async () => {
    const seen: unknown[] = [];
    const inner = createMemoryTree({ files: { "/secure.txt": "secret" } });
    const originalRead = inner.read.bind(inner);
    const tree: ActiveFSTree = inner;
    tree.read = async (
      context: ActiveFSContext,
      path: ActiveFSPath,
      options?: ActiveFSReadOptions
    ) => {
      seen.push(context);
      return originalRead(context, path, options);
    };
    const server = await serve(tree, { type: "bearer", token: "transport-token" });
    const client = createHttpSourceClient({
      url: server.url,
      auth: { type: "bearer", token: "transport-token" }
    });

    await client.read(
      {
        auth: { subject: "ada" },
        meta: { requestId: "req-1" },
        traceId: "trace-1"
      },
      "/secure.txt"
    );

    expect(seen).toEqual([
      expect.objectContaining({
        auth: { subject: "ada" },
        meta: { requestId: "req-1" },
        traceId: "trace-1"
      })
    ]);
    expect((seen[0] as ActiveFSContext).signal).toBeInstanceOf(AbortSignal);
  });

  it("supports binary and range reads over JSON base64 and octet-stream responses", async () => {
    const server = await serve(
      createMemoryTree({
        files: {
          "/bytes.bin": new Uint8Array([0, 1, 2, 3, 255])
        }
      })
    );
    const client = createHttpSourceClient({ url: server.url });

    const base64Read = await client.read({}, "/bytes.bin", { offset: 1, length: 3 });
    expect([...bytes(base64Read)]).toEqual([1, 2, 3]);

    const response = await fetch(new URL("read", server.url), {
      method: "POST",
      headers: {
        accept: "application/octet-stream",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/bytes.bin",
        ctx: {},
        options: { offset: 2, length: 2 },
        responseFormat: "octet-stream"
      })
    });
    expect(response.ok).toBe(true);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([2, 3]);
    expect(response.headers.get("x-activefs-stat")).toBeTruthy();
    expect(response.headers.get("content-digest")).toMatch(/^sha-256=:/);
    expect(response.headers.get("repr-digest")).toMatch(/^sha-256=:/);
  });

  it("rejects advertised JSON response digest mismatches before parsing", async () => {
    const client = createHttpSourceClient({
      url: "http://activefs.test/",
      allowInsecureHttp: true,
      fetch: async () =>
        new Response("{\"protocolVersion\":1}\n", {
          status: 200,
          headers: {
            "content-type": "application/json",
            "repr-digest": "sha-256=:AAAA:"
          }
        })
    });

    await expect(client.fetchCapabilities()).rejects.toMatchObject({
      code: "SOURCE_ERROR",
      message: "repr-digest mismatch"
    });
  });

  it("maps SSE invalidation events into tree watch events", async () => {
    let emit: ((event: ActiveFSWatchEvent) => void) | undefined;
    let closeCalls = 0;
    const inner = createMemoryTree({ files: { "/watched.txt": "watch me" } });
    const tree: ActiveFSTree = inner;
    tree.capabilities = {
      ...inner.capabilities,
      watch: true,
      watchable: true
    };
    tree.watch = async (
      _context: ActiveFSContext,
      _path: ActiveFSPath,
      onEvent: (event: ActiveFSWatchEvent) => void
    ): Promise<ActiveFSWatchSubscription> => {
      emit = onEvent;
      return {
        close: () => {
          closeCalls += 1;
        }
      };
    };
    const server = await serve(tree);
    const client = createHttpSourceClient({ url: server.url });
    const events: ActiveFSWatchEvent[] = [];

    const subscription = await client.watch!({}, "/", (event) => events.push(event));
    await waitFor(() => emit !== undefined);
    emit!({ type: "invalidate", path: "/watched.txt", meta: { reason: "test" } });
    await waitFor(() => events.length === 1);
    await subscription.close();
    await waitFor(() => closeCalls === 1);

    expect(events).toEqual([
      { type: "invalidate", path: "/watched.txt", meta: { reason: "test" } }
    ]);
    expect(closeCalls).toBe(1);
  });

  it("exposes session-based SSE with ACK and activity endpoints", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/watched.txt": "old" },
        writable: true,
        watchable: true
      }),
      { type: "bearer", token: "session-token" }
    );
    const client = createHttpSourceClient({ url: server.url, auth: "session-token" });

    const session = await client.createSession();
    const events = await fetch(new URL(session.eventEndpoint, server.url), {
      headers: { authorization: "Bearer session-token" }
    });
    const reader = events.body!.getReader();

    await client.write!({}, "/watched.txt", "new");

    const eventText = await readSseChunk(reader);
    await reader.cancel().catch(() => undefined);
    expect(eventText).toContain(`sessionId":"${session.sessionId}`);
    expect(eventText).toMatch(/event: (heartbeat|tree\.changed|path\.invalidated|resync\.required)/);

    const ack = await client.ackSession(session.sessionId, 1);
    const activity = await client.reportSessionActivity(session.sessionId, {
      events: [{ operation: "read", path: "/watched.txt", source: "cache" }]
    });

    expect(ack).toMatchObject({ sessionId: session.sessionId, lastAckSequence: 1 });
    expect(activity).toMatchObject({ sessionId: session.sessionId, accepted: true, backlog: 1 });
  });

  it("enforces the configured retained-session bound through the Node adapter", async () => {
    let closeCalls = 0;
    const inner = createMemoryTree({ files: { "/watched.txt": "old" }, watchable: true });
    const tree: ActiveFSTree = {
      ...inner,
      watch: async () => ({ close: () => { closeCalls += 1; } })
    };
    const server = await serve(
      tree,
      undefined,
      { maxRetainedSessions: 1 }
    );
    const client = createHttpSourceClient({ url: server.url });

    const first = await client.createSession({}, "/");
    const firstEvents = await fetch(first.eventEndpoint);
    const firstReader = firstEvents.body!.getReader();
    await firstReader.read();
    const second = await client.createSession({}, "/");

    expect(closeCalls).toBe(1);
    await expect(readSessionEventUntil(firstReader, (event) => event.type === "session.revoked"))
      .resolves.toMatchObject({ payload: { reason: "session retention limit exceeded" } });
    await expect(firstReader.read()).resolves.toMatchObject({ done: true });
    await expect(client.ackSession(first.sessionId, 0)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(client.ackSession(second.sessionId, 0)).resolves.toMatchObject({
      sessionId: second.sessionId,
      lastAckSequence: 0
    });
  });

  it("forwards shared-service retention limits through the Node adapter", () => {
    const tree = createMemoryTree({ files: { "/watched.txt": "old" } });

    expect(() => createActiveFSTreeServer({
      tree,
      maxRetainedIdempotencyRecords: 0
    })).toThrow(/maxRetainedIdempotencyRecords must be a positive safe integer/);
    expect(() => createActiveFSTreeServer({
      tree,
      maxRetainedIsolationScopes: 0
    })).toThrow(/maxRetainedIsolationScopes must be a positive safe integer/);
  });

  it("retains tree operation status for committed mutations", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/watched.txt": "old" },
        writable: true
      }),
      { type: "bearer", token: "operation-token" }
    );
    const client = createHttpSourceClient({ url: server.url, auth: "operation-token" });
    const beforeChanges = await fetch(new URL("changes?since=0", server.url), {
      headers: { authorization: "Bearer operation-token" }
    });
    const before = await beforeChanges.json() as { latestSequence: number };

    const result = await client.write!({}, "/watched.txt", "new", { idempotencyKey: "write-1" });
    const operationId = mutationOperationId(result);
    const status = await client.fetchOperationStatus(operationId);

    expect(operationId).toMatch(/^idempotency:/);
    expect(status).toMatchObject({
      operationId,
      status: "succeeded",
      operation: "write",
      path: "/watched.txt",
      result: {
        operationId,
        created: false
      }
    });

    const changes = await fetch(new URL(`changes?since=${before.latestSequence}`, server.url), {
      headers: { authorization: "Bearer operation-token" }
    });
    await expect(changes.json()).resolves.toMatchObject({
      schemaVersion: 1,
      changes: [
        {
          type: "path.invalidated",
          path: "/watched.txt"
        }
      ]
    });
  });

  it("keeps sessions, operation status, and change records scoped to each server", async () => {
    const serverA = await serve(
      createMemoryTree({
        files: { "/a.txt": "a" },
        writable: true
      })
    );
    const serverB = await serve(
      createMemoryTree({
        files: { "/b.txt": "b" },
        writable: true
      })
    );
    const clientA = createHttpSourceClient({ url: serverA.url });
    const clientB = createHttpSourceClient({ url: serverB.url });

    const sessionA = await clientA.createSession();
    await expect(clientB.ackSession(sessionA.sessionId, 1)).rejects.toMatchObject({
      code: "INVALID_REQUEST"
    });

    const writeA = await clientA.write!({}, "/a.txt", "new a", {
      idempotencyKey: "server-a-write"
    });
    const operationReference = mutationOperationReference(writeA);
    const statusPath = new URL(operationReference.operationStatusEndpoint).pathname;
    await expect(clientB.fetchOperationStatus({
      operationId: operationReference.operationId,
      operationStatusEndpoint: new URL(statusPath, serverB.url).href
    })).rejects.toMatchObject({
      code: "NOT_FOUND"
    });

    const changesA = await fetch(new URL("changes?since=0", serverA.url));
    const changesB = await fetch(new URL("changes?since=0", serverB.url));

    await expect(changesA.json()).resolves.toMatchObject({
      latestSequence: 1,
      changes: [expect.objectContaining({ path: "/a.txt" })]
    });
    await expect(changesB.json()).resolves.toMatchObject({
      latestSequence: 0,
      changes: []
    });
  });

  it("retains failed operation status and maps generic HTTP errors", async () => {
    const inner = createMemoryTree({ files: {}, writable: true });
    const server = await serve({
      ...inner,
      write: async () => {
        throw new Error("disk full");
      }
    });
    const client = createHttpSourceClient({ url: server.url });

    let failedReference: { operationId: string; operationStatusEndpoint: string } | undefined;
    try {
      await client.write!({}, "/bad.txt", "bad", { idempotencyKey: "failed-write" });
    } catch (error) {
      expect(error).toMatchObject({ code: "SOURCE_ERROR", message: "Source API service failed" });
      failedReference = mutationOperationReference(error);
    }
    expect(failedReference).toBeDefined();
    await expect(client.fetchOperationStatus(failedReference!)).resolves.toMatchObject({
      operationId: failedReference!.operationId,
      status: "failed",
      error: {
        code: "INTERNAL_ERROR",
        internalCode: "SOURCE_ERROR",
        message: "Source API service failed"
      }
    });

    const generic = createHttpSourceClient({
      url: "http://source.test/",
      allowInsecureHttp: true,
      fetch: async () => new Response("not-json", { status: 502 })
    });
    await expect(generic.fetchCapabilities()).rejects.toMatchObject({
      code: "SOURCE_ERROR",
      message: "HTTP Source API request failed with 502"
    });
  });

  it("rejects direct event routes and closes session watch streams through abort", async () => {
    const server = await serve(createMemoryTree({ files: { "/a.txt": "a" }, watchable: true }));
    const directEvents = await fetch(new URL("events", server.url), {
      headers: { accept: "text/event-stream" }
    });
    expect(directEvents.status).toBe(404);

    let aborted = false;
    const client = createHttpSourceClient({
      url: "http://source.test/activefs/v1/",
      allowInsecureHttp: true,
      handshake: {
        ...minimalHandshake({
          stat: "http://source.test/stat",
          list: "http://source.test/list",
          read: "http://source.test/read",
          sessions: "http://source.test/sessions"
        }),
        capabilities: {
          ...minimalHandshake({
            stat: "http://source.test/stat",
            list: "http://source.test/list",
            read: "http://source.test/read"
          }).capabilities,
          watchable: true,
          activefs: { stat: true, list: true, read: true, watch: true }
        }
      },
      fetch: async (url, init) => {
        const href = url.toString();
        if (href.endsWith("/sessions")) {
          return new Response(JSON.stringify({
            sessionId: "session-1",
            createdAt: "2026-06-27T00:00:00.000Z",
            cacheMode: "off",
            eventEndpoint: "/activefs/v1/sessions/session-1/events",
            ackEndpoint: "/activefs/v1/sessions/session-1/acks",
            activityEndpoint: "/activefs/v1/sessions/session-1/activity",
            integrity: { eventChain: "sha-256" }
          }), { status: 201 });
        }
        if (href.endsWith("/acks")) {
          return new Response(JSON.stringify({ sessionId: "session-1", lastAckSequence: 1 }), { status: 200 });
        }
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": open\n\n"));
            init?.signal?.addEventListener("abort", () => {
              aborted = true;
              controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }));
            });
          },
          cancel() {
            aborted = true;
          }
        }), {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        });
      }
    });

    const subscription = await client.watch!({}, "/", () => undefined);
    await subscription.close();
    expect(aborted).toBe(true);
  });

  it("exposes generic config and tree-owned policy metadata endpoints", async () => {
    const server = await serve(
      createMemoryTree({
        files: { "/README.txt": "hello" },
        searchable: true
      })
    );

    const config = await fetch(new URL("config", server.url));
    const policy = await fetch(new URL("policy", server.url));

    await expect(config.json()).resolves.toMatchObject({
      schemaVersion: 1,
      protocol: "activefs-source",
      capabilities: {
        searchable: true
      },
      cache: {
        persistentReadCache: "off-unless-session-coherent"
      }
    });
    await expect(policy.json()).resolves.toMatchObject({
      schemaVersion: 1,
      policy: null,
      defaultAccess: "tree-owned"
    });
  });

  it("signs visibility-safe session events without broadcasting mutation paths", async () => {
    const secret = "session-secret";
    const server = await serve(
      createMemoryTree({
        files: { "/watched.txt": "old" },
        writable: true
      }),
      undefined,
      { eventSigningSecret: secret }
    );

    const created = await postJson(server.url, "sessions", { ctx: {}, path: "/", options: { recursive: true } });
    const session = await created.json() as {
      sessionId: string;
      eventEndpoint: string;
      integrity: { eventChain: string; eventMac?: string };
    };
    expect(session.integrity).toEqual({ eventChain: "sha-256", eventMac: "hmac-sha-256" });

    const events = await fetch(new URL(session.eventEndpoint, server.url));
    const reader = events.body!.getReader();
    const event = await readSessionEventUntil(reader, (candidate) =>
      candidate.type === "heartbeat" || candidate.type === "resync.required"
    );
    await reader.cancel().catch(() => undefined);
    const { eventMac, ...unsignedEvent } = event;
    expect(eventMac).toEqual({
      algorithm: "hmac-sha-256",
      value: createHmac("sha256", secret).update(JSON.stringify(unsignedEvent)).digest("base64")
    });
    expect(event).toMatchObject({
      sessionId: session.sessionId,
      payload: expect.any(Object)
    });

    const verified = verifyActiveFSSessionEvent(event as ActiveFSSessionEvent, {
      sessionId: session.sessionId,
      lastSequence: event.sequence - 1,
      eventMacSecret: secret
    });
    expect(verified.lastSequence).toBe(event.sequence);
    expect(() => verifyActiveFSSessionEvent(event as ActiveFSSessionEvent, {
      sessionId: session.sessionId,
      lastSequence: event.sequence - 1
    })).not.toThrow();
    expect(() => verifyActiveFSSessionEvent(event as ActiveFSSessionEvent, {
      sessionId: session.sessionId,
      lastSequence: event.sequence - 1,
      requireEventMac: true
    })).toThrow(/cannot be verified/);

    expect(() =>
      verifyActiveFSSessionEvent(
        { ...(event as ActiveFSSessionEvent), payloadDigest: "sha-256:bad" },
        { sessionId: session.sessionId, lastSequence: event.sequence - 1, eventMacSecret: secret }
      )
    ).toThrow(/payload digest mismatch/);
    expect(() =>
      verifyActiveFSSessionEvent(event as ActiveFSSessionEvent, {
        sessionId: session.sessionId,
        lastSequence: event.sequence + 1,
        eventMacSecret: secret
      })
    ).toThrow(/sequence gap/);
    expect(() =>
      verifyActiveFSSessionEvent(
        { ...(event as ActiveFSSessionEvent), eventMac: { algorithm: "hmac-sha-256", value: "bad" } },
        { sessionId: session.sessionId, lastSequence: event.sequence - 1, eventMacSecret: secret }
      )
    ).toThrow(/MAC mismatch/);
  });
});

async function serve(
  tree: ActiveFSTree,
  auth?: Parameters<typeof startActiveFSServer>[0]["auth"],
  options: Omit<Parameters<typeof startActiveFSServer>[0], "tree" | "auth"> = {}
): Promise<ActiveFSTreeServerHandle> {
  const server = await startActiveFSServer({ tree, auth, ...options });
  servers.push(server);
  return server;
}

function readContent<Meta>(value: string | Uint8Array | ActiveFSTreeReadResult<Meta>): string | Uint8Array {
  const content = typeof value === "object" && value !== null && "content" in value
    ? value.content
    : value;
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return content;
}

function text<Meta>(content: string | Uint8Array | ActiveFSTreeReadResult<Meta>): string {
  const value = readContent(content);
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function bytes<Meta>(content: string | Uint8Array | ActiveFSTreeReadResult<Meta>): Uint8Array {
  const value = readContent(content);
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function mutationOperationId(result: ActiveFSTreeMutationResult): string {
  expect(result).toMatchObject({ operationId: expect.any(String) });
  return (result as { operationId: string }).operationId;
}

function mutationOperationReference(result: unknown): {
  operationId: string;
  operationStatusEndpoint: string;
} {
  expect(result).toMatchObject({
    operationId: expect.any(String),
    operationStatusEndpoint: expect.any(String)
  });
  return result as { operationId: string; operationStatusEndpoint: string };
}

function minimalHandshake(endpoints: ActiveFSSourceEndpoints): ActiveFSTreeHandshake {
  return {
    protocol: "activefs-source",
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    endpoints,
    capabilities: {
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      statable: true,
      listable: true,
      readable: true,
      writable: false,
      mutable: {
        create: false,
        write: false,
        truncate: false,
        delete: false,
        mkdir: false,
        rmdir: false,
        rename: false,
        copy: false,
        updateMetadata: false
      },
      searchable: false,
      commands: [],
      watchable: false,
      rangeReadable: true,
      activefs: { stat: true, list: true, read: true }
    }
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "activefs-source-http-test-"));
  tempDirs.push(path);
  return path;
}

function postJson(
  baseUrl: string,
  endpoint: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(new URL(endpoint, baseUrl), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function readSseChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  while (!/\r?\n\r?\n/.test(buffer)) {
    if (Date.now() - startedAt > 1000) {
      throw new Error("Timed out waiting for SSE chunk");
    }
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value);
  }
  return buffer;
}

async function readSessionEventUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: { type?: string }) => boolean
): Promise<Record<string, any>> {
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  while (Date.now() - startedAt <= 1500) {
    const separator = /\r?\n\r?\n/.exec(buffer);
    if (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data) {
        const event = JSON.parse(data) as Record<string, any>;
        if (predicate(event)) {
          return event;
        }
      }
      continue;
    }
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value);
  }
  throw new Error("Timed out waiting for matching session event");
}
