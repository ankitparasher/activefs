import { describe, expect, it } from "vitest";
import {
  ActiveFSError,
  createActiveFS,
  runDefaultActiveFSTreeCommand,
  type ActiveFSContext,
  type ActiveFSPath,
  type ActiveFSTree,
  type ActiveFSWatchSubscription
} from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import { createHttpSourceClient, type ActiveFSTreeHandshake } from "./index.js";
import {
  ACTIVEFS_SOURCE_PROTOCOL_VERSION,
  activeFSSourceCapabilities,
  createActiveFSSourceService,
  type ActiveFSSourceEndpoints,
  type ActiveFSSourceOperation,
  type ActiveFSSourceService
} from "./fetch.js";

describe("Fetch Source API service", () => {
  it("binds Web Request -> Response operations to arbitrary framework routes", async () => {
    const service = createActiveFSSourceService({
      tree: createMemoryTree({ files: { "/context.md": "fetch hello" } }),
      endpoints: readOnlyEndpoints("https://app.example.com/custom/source")
    });

    const nextRoute = (operation: ActiveFSSourceOperation) => (request: Request) =>
      service.handle(operation, request);

    const handshakeResponse = await nextRoute("handshake")(
      new Request("https://app.example.com/api/activefs/v1/")
    );
    const listResponse = await nextRoute("list")(postRequest(
      "https://app.example.com/routes/list-anywhere",
      { path: "/", ctx: {} }
    ));
    const readResponse = await nextRoute("read")(postRequest(
      "https://app.example.com/a/file-like-route.json",
      { path: "/context.md", ctx: {} }
    ));

    await expect(handshakeResponse.json()).resolves.toMatchObject({
      protocol: "activefs-source",
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      endpoints: {
        stat: "https://app.example.com/custom/source/stat",
        list: "https://app.example.com/custom/source/list",
        read: "https://app.example.com/custom/source/read"
      }
    });
    await expect(listResponse.json()).resolves.toEqual([
      expect.objectContaining({ path: "/context.md", kind: "file" })
    ]);
    await expect(readResponse.json()).resolves.toMatchObject({ content: "fetch hello" });
    expect(listResponse.headers.get("repr-digest")).toMatch(/^sha-256=:/);
  });

  it("derives authoritative context and ignores forged body auth/meta across tree operations", async () => {
    const seen: Array<{ operation: string; context: ActiveFSContext }> = [];
    const resolvedOperations: ActiveFSSourceOperation[] = [];
    const inner = createMemoryTree({
      files: {
        "/alice.md": "alice term",
        "/bob.md": "bob term"
      },
      searchable: true,
      writable: true
    });
    const tree = contextRecordingTree(inner, seen);
    const service = createActiveFSSourceService({
      tree,
      endpoints: fullEndpoints("https://host.example/source"),
      resourceLinks: testResourceLinks("https://host.example"),
      resolveContext: ({ request, operation }) => {
        resolvedOperations.push(operation);
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (token !== "alice" && token !== "bob") {
          throw new ActiveFSError("UNAUTHORIZED", "valid credentials required");
        }
        return {
          context: {
            auth: { subject: token, role: "server-derived" },
            meta: { tenant: `tenant-${token}` }
          },
          isolationKey: `principal:${token}`
        };
      }
    });
    const forged = {
      auth: { subject: "admin", role: "forged" },
      meta: { tenant: "forged" }
    };

    const operations: Array<[ActiveFSSourceOperation, unknown]> = [
      ["list", { path: "/", ctx: forged }],
      ["stat", { path: "/alice.md", ctx: forged }],
      ["read", { path: "/alice.md", ctx: forged }],
      ["search", { path: "/", query: { pattern: "term" }, ctx: forged }],
      ["command", { path: "/", command: "grep", input: { pattern: "term" }, ctx: forged }],
      ["write", { path: "/new.md", content: "new", ctx: forged }],
      ["mkdir", { path: "/dir", ctx: forged }],
      ["copy", { path: "/alice.md", toPath: "/copy.md", ctx: forged }],
      ["rename", { path: "/copy.md", toPath: "/renamed.md", ctx: forged }],
      ["truncate", { path: "/alice.md", options: { length: 5 }, ctx: forged }],
      ["metadata", { path: "/alice.md", options: { mtimeMs: 42 }, ctx: forged }],
      ["delete", { path: "/new.md", ctx: forged }],
      ["rmdir", { path: "/dir", ctx: forged }]
    ];
    for (const [operation, body] of operations) {
      const response = await service.handle(operation, postRequest(
        `https://host.example/routes/${operation}`,
        body,
        "alice"
      ));
      expect(response.status, operation).toBe(200);
    }

    expect(resolvedOperations).toEqual(operations.map(([operation]) => operation));
    expect(seen.length).toBeGreaterThanOrEqual(operations.length);
    for (const record of seen) {
      expect(record.context).toMatchObject({
        auth: { subject: "alice", role: "server-derived" },
        meta: { tenant: "tenant-alice" }
      });
      expect(record.context).not.toMatchObject(forged);
      expect(record.context.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("allows a public handshake while sanitizing protected-route credential failures", async () => {
    const service = createActiveFSSourceService({
      tree: createMemoryTree({ files: { "/visible.md": "ok" } }),
      endpoints: readOnlyEndpoints("https://product.example/ops"),
      resolveContext: ({ operation, request }) => {
        if (operation === "handshake") {
          return { context: {}, isolationKey: "public" };
        }
        const token = request.headers.get("authorization");
        if (token !== "Bearer valid") {
          throw new ActiveFSError("UNAUTHORIZED", `rejected secret ${token}`);
        }
        return { context: { auth: { subject: "valid" } }, isolationKey: "principal:valid" };
      }
    });

    const handshake = await service.handle("handshake", new Request("https://product.example/discovery"));
    const denied = await service.handle("list", postRequest(
      "https://product.example/list",
      { path: "/", ctx: { auth: { subject: "forged" } } },
      "leaked-token"
    ));

    expect(handshake.status).toBe(200);
    expect(denied.status).toBe(401);
    const deniedText = await denied.text();
    expect(deniedText).toContain("Source API credentials are missing or invalid");
    expect(deniedText).not.toContain("leaked-token");
    expect(deniedText).not.toContain("forged");
  });

  it("supports host-owned bearer, cookie, and custom credential resolution once per request", async () => {
    const seenSubjects: string[] = [];
    let resolverCalls = 0;
    const inner = createMemoryTree({ files: { "/visible.md": "ok" } });
    const service = createActiveFSSourceService({
      tree: {
        ...inner,
        list: async (context, path) => {
          seenSubjects.push(String((context.auth as { subject?: string } | undefined)?.subject));
          return inner.list(context, path);
        }
      },
      endpoints: readOnlyEndpoints("https://product.example/ops"),
      resolveContext: ({ request }) => {
        resolverCalls += 1;
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
        const cookie = /(?:^|;\s*)session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
        const custom = request.headers.get("x-api-key") ?? undefined;
        const subject = bearer ?? cookie ?? custom;
        if (!subject) throw new ActiveFSError("UNAUTHORIZED", "credential required");
        return { context: { auth: { subject } }, isolationKey: `credential:${subject}` };
      }
    });
    const credentials: Array<Record<string, string>> = [
      { authorization: "Bearer bearer-user" },
      { cookie: "session=cookie-user" },
      { "x-api-key": "custom-user" }
    ];

    for (const headers of credentials) {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("content-type", "application/json");
      const response = await service.handle("list", new Request("https://product.example/list", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({ path: "/", ctx: { auth: { subject: "forged" } } })
      }));
      expect(response.status).toBe(200);
    }
    const invalid = await service.handle("list", postRequest(
      "https://product.example/list",
      { path: "/", ctx: { auth: { subject: "forged" } } }
    ));
    expect(invalid.status).toBe(401);
    expect(resolverCalls).toBe(4);
    expect(seenSubjects).toEqual(["bearer-user", "cookie-user", "custom-user"]);
  });

  it("rejects request bodies over the configured limit", async () => {
    const service = createActiveFSSourceService({
      tree: createMemoryTree({ files: { "/visible.md": "ok" } }),
      endpoints: readOnlyEndpoints("https://product.example/ops"),
      maxRequestBodyBytes: 64
    });
    const oversized = await service.handle("list", new Request("https://product.example/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "/", ctx: { meta: { padding: "x".repeat(128) } } })
    }));
    const advertisedOversized = await service.handle("list", new Request("https://product.example/list", {
      method: "POST",
      headers: { "content-length": "65", "content-type": "application/json" },
      body: JSON.stringify({ path: "/", ctx: {} })
    }));

    expect(oversized.status).toBe(400);
    expect(advertisedOversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "INVALID_PATH", internalCode: "INVALID_REQUEST" }
    });
  });

  it("keeps identity-specific list/read/search visibility inside the tree", async () => {
    const inner = createMemoryTree<{ subject: string }>({
      files: { "/alice.md": "alice term", "/bob.md": "bob term" },
      searchable: true
    });
    const tree: ActiveFSTree<{ subject: string }> = {
      ...inner,
      list: async (context, path) => {
        const result = await inner.list(context, path);
        return Array.isArray(result)
          ? result.filter((entry) => entry?.path === `/${context.auth?.subject}.md`)
          : result;
      },
      info: async (context, path) => path === "/" || path === `/${context.auth?.subject}.md`
        ? inner.info(context, path)
        : null,
      read: async (context, path, options) => {
        if (path !== `/${context.auth?.subject}.md`) {
          throw new ActiveFSError("NOT_FOUND", "not found", { path });
        }
        return inner.read(context, path, options);
      },
      search: async (context, path, query) => {
        const result = await inner.search(context, path, query);
        return {
          ...result,
          matches: result.matches.filter((match) => match.path === `/${context.auth?.subject}.md`)
        };
      },
      walk: async (context, path) => {
        const result = await tree.list(context, path);
        return Array.isArray(result) ? result.filter(Boolean) : [];
      },
      command: async (context, command, path, input) =>
        runDefaultActiveFSTreeCommand(tree, context, command, path, input)
    };
    const service = identityService(tree);
    const alice = createServiceFetch(service, "alice");
    const bob = createServiceFetch(service, "bob");
    const aliceFs = createActiveFS().mount("/remote", createHttpSourceClient({
      url: "https://product.example/discovery.json?tenant=alice",
      auth: "alice",
      fetch: alice
    }));
    const bobFs = createActiveFS().mount("/remote", createHttpSourceClient({
      url: "https://product.example/discovery.json?tenant=bob",
      auth: "bob",
      fetch: bob
    }));

    await expect(aliceFs.list({}, "/remote")).resolves.toEqual([
      expect.objectContaining({ path: "/remote/alice.md" })
    ]);
    await expect(bobFs.list({}, "/remote")).resolves.toEqual([
      expect.objectContaining({ path: "/remote/bob.md" })
    ]);
    await expect(aliceFs.read({}, "/remote/bob.md")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(aliceFs.stat({}, "/remote/bob.md")).resolves.toBeNull();
    await expect(aliceFs.stat({}, "/remote/missing.md")).resolves.toBeNull();
    await expect(aliceFs.search({}, "/remote", { pattern: "term" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "/remote/alice.md" })]
    });
    await expect(aliceFs.command({}, "ls", "/remote", {})).resolves.toEqual([
      expect.objectContaining({ path: "/remote/alice.md" })
    ]);
    await expect(aliceFs.command({}, "stat", "/remote/bob.md", {})).resolves.toBeNull();
    for (const command of ["grep", "rg"] as const) {
      await expect(aliceFs.command({}, command, "/remote", { pattern: "term" })).resolves.toMatchObject({
        matches: [expect.objectContaining({ path: "/remote/alice.md", excerpt: expect.not.stringContaining("bob") })]
      });
    }
    await expect(aliceFs.command({}, "find", "/remote", {})).resolves.toEqual([
      expect.objectContaining({ path: "/remote/alice.md" })
    ]);
    await expect(aliceFs.command({}, "cat", "/remote/bob.md", {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(aliceFs.command({}, "head", "/remote/alice.md", { lines: 1 })).resolves.toMatchObject({
      content: "alice term"
    });
    await expect(aliceFs.command({}, "tail", "/remote/alice.md", { lines: 1 })).resolves.toMatchObject({
      content: "alice term"
    });
    await expect(aliceFs.command({}, "sed", "/remote/alice.md", {
      pattern: "alice",
      replacement: "visible"
    })).resolves.toMatchObject({ content: "visible term" });

    const fallbackInner = createMemoryTree<{ subject: string }>({
      files: { "/alice.md": "alice fallback", "/bob.md": "bob fallback" },
      searchable: false
    });
    const fallbackTree: ActiveFSTree<{ subject: string }> = {
      ...fallbackInner,
      list: async (context, path) => {
        const result = await fallbackInner.list(context, path);
        return Array.isArray(result)
          ? result.filter((entry) => entry?.path === `/${context.auth?.subject}.md`)
          : result;
      },
      info: async (context, path) => path === "/" || path === `/${context.auth?.subject}.md`
        ? fallbackInner.info(context, path)
        : null,
      read: async (context, path, options) => {
        if (path !== `/${context.auth?.subject}.md`) {
          throw new ActiveFSError("NOT_FOUND", "not found", { path });
        }
        return fallbackInner.read(context, path, options);
      }
    };
    const fallbackService = identityService(fallbackTree);
    const fallbackFs = createActiveFS().mount("/remote", createHttpSourceClient({
      url: "https://product.example/discovery.json",
      auth: "alice",
      fetch: createServiceFetch(fallbackService, "alice")
    }));
    await expect(fallbackFs.search({}, "/remote", { pattern: "fallback" })).resolves.toMatchObject({
      strategy: "scan",
      matches: [expect.objectContaining({ path: "/remote/alice.md" })]
    });
  });

  it("isolates sessions, watch context, changes, and operation status by authenticated scope", async () => {
    let watchContext: ActiveFSContext | undefined;
    let watchPath: ActiveFSPath | undefined;
    const inner = createMemoryTree({ files: { "/watched.md": "old" }, writable: true, watchable: true });
    const tree: ActiveFSTree = {
      ...inner,
      watch: async (context, path): Promise<ActiveFSWatchSubscription> => {
        watchContext = context;
        watchPath = path;
        return { close: () => undefined };
      }
    };
    const service = identityService(tree);

    const createdResponse = await service.handle("createSession", postRequest(
      "https://product.example/session-create",
      { path: "/watched.md", options: { recursive: false }, ctx: { auth: { subject: "forged" } } },
      "alice"
    ));
    const session = await createdResponse.json() as { sessionId: string };

    const bobEvents = await service.handle("sessionEvents", new Request(
      "https://product.example/session-events",
      { headers: { authorization: "Bearer bob" } }
    ), { sessionId: session.sessionId });
    expect(bobEvents.status).toBe(404);

    const bobAck = await service.handle("sessionAck", postRequest(
      "https://product.example/session-ack",
      { lastAppliedSequence: 0 },
      "bob"
    ), { sessionId: session.sessionId });
    const bobActivity = await service.handle("sessionActivity", postRequest(
      "https://product.example/session-activity",
      { paths: ["/watched.md"] },
      "bob"
    ), { sessionId: session.sessionId });
    expect(bobAck.status).toBe(404);
    expect(bobActivity.status).toBe(404);

    const aliceEvents = await service.handle("sessionEvents", new Request(
      "https://product.example/session-events",
      { headers: { authorization: "Bearer alice" } }
    ), { sessionId: session.sessionId });
    expect(aliceEvents.status).toBe(200);
    const reader = aliceEvents.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(watchContext).toMatchObject({ auth: { subject: "alice" } });
    expect(watchPath).toBe("/watched.md");

    const write = await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/watched.md", content: "new", ctx: { auth: { subject: "forged" } } },
      "alice"
    ));
    const mutation = await write.json() as { operationId: string; operationStatusEndpoint: string };
    const bobStatus = await service.handle("operationStatus", new Request(
      mutation.operationStatusEndpoint,
      { headers: { authorization: "Bearer bob" } }
    ), { operationId: mutation.operationId });
    const aliceStatus = await service.handle("operationStatus", new Request(
      mutation.operationStatusEndpoint,
      { headers: { authorization: "Bearer alice" } }
    ), { operationId: mutation.operationId });
    expect(bobStatus.status).toBe(404);
    expect(aliceStatus.status).toBe(200);

    const bobChanges = await service.handle("changes", new Request(
      "https://product.example/changes?since=0",
      { headers: { authorization: "Bearer bob" } }
    ));
    const aliceChanges = await service.handle("changes", new Request(
      "https://product.example/changes?since=0",
      { headers: { authorization: "Bearer alice" } }
    ));
    await expect(bobChanges.json()).resolves.toMatchObject({ latestSequence: 0, changes: [] });
    await expect(aliceChanges.json()).resolves.toMatchObject({
      latestSequence: 1,
      changes: [expect.objectContaining({ path: "/watched.md" })]
    });

    const aliceIdempotent = await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/alice-idempotent.md", content: "a", options: { idempotencyKey: "shared-key" } },
      "alice"
    ));
    const bobIdempotent = await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/bob-idempotent.md", content: "b", options: { idempotencyKey: "shared-key" } },
      "bob"
    ));
    const aliceOperation = await aliceIdempotent.json() as { operationId: string };
    const bobOperation = await bobIdempotent.json() as { operationId: string };
    expect(aliceOperation.operationId).not.toBe(bobOperation.operationId);
  });

  it("fails closed when an authenticated session scope changes", async () => {
    let scope = "scope-v1";
    const tree = createMemoryTree({ files: { "/watched.md": "old" }, watchable: true });
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      resolveContext: ({ request }) => {
        const subject = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (subject !== "alice") throw new ActiveFSError("UNAUTHORIZED", "missing token");
        return {
          context: { auth: { subject } },
          isolationKey: `${subject}:${scope}`,
          revokeSession: scope === "scope-v2"
        };
      },
      resourceLinks: testResourceLinks("https://product.example")
    });
    const created = await service.handle("createSession", postRequest(
      "https://product.example/create",
      { path: "/", ctx: {} },
      "alice"
    ));
    const session = await created.json() as { sessionId: string };

    scope = "scope-v2";
    const ack = await service.handle("sessionAck", postRequest(
      "https://product.example/ack",
      { lastAppliedSequence: 0 },
      "alice"
    ), { sessionId: session.sessionId });
    const reconnect = await service.handle("sessionEvents", new Request(
      "https://product.example/events",
      { headers: { authorization: "Bearer alice" } }
    ), { sessionId: session.sessionId });

    expect(ack.status).toBe(404);
    expect(reconnect.status).toBe(404);
  });

  it("closes watches on session eviction and emits host-driven revocation", async () => {
    let closeCalls = 0;
    const inner = createMemoryTree({ files: { "/watched.md": "old" }, watchable: true });
    const tree: ActiveFSTree = {
      ...inner,
      watch: async (): Promise<ActiveFSWatchSubscription> => ({
        close: () => { closeCalls += 1; }
      })
    };
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      maxRetainedSessions: 1,
      resourceLinks: testResourceLinks("https://product.example")
    });

    const firstCreated = await service.handle("createSession", postRequest(
      "https://product.example/create",
      { path: "/", ctx: {} }
    ));
    const first = await firstCreated.json() as { sessionId: string };
    const firstEvents = await service.handle("sessionEvents", new Request("https://product.example/events"), {
      sessionId: first.sessionId
    });
    const firstReader = firstEvents.body!.getReader();
    await readSseEvent(firstReader);

    await service.handle("createSession", postRequest(
      "https://product.example/create",
      { path: "/", ctx: {} }
    ));
    expect(closeCalls).toBe(1);
    await expect(readSseEvent(firstReader)).resolves.toMatchObject({
      type: "session.revoked",
      payload: { reason: "session retention limit exceeded" }
    });
    await expect(firstReader.read()).resolves.toMatchObject({ done: true });

    const revocableCreated = await service.handle("createSession", postRequest(
      "https://product.example/create",
      { path: "/", ctx: {} }
    ));
    const revocable = await revocableCreated.json() as { sessionId: string };
    const revocableEvents = await service.handle("sessionEvents", new Request("https://product.example/events"), {
      sessionId: revocable.sessionId
    });
    const revocableReader = revocableEvents.body!.getReader();
    await readSseEvent(revocableReader);

    await expect(service.revokeSession(revocable.sessionId, "permissions changed")).resolves.toBe(true);
    const revoked = await readSseEvent(revocableReader);
    expect(revoked).toMatchObject({
      type: "session.revoked",
      payload: { reason: "permissions changed" }
    });
    await expect(revocableReader.read()).resolves.toMatchObject({ done: true });
    expect(closeCalls).toBe(2);
    await expect(service.revokeSession(revocable.sessionId)).resolves.toBe(false);
  });

  it("bounds per-isolation change cursors and signals resync after cursor eviction", async () => {
    const tree = createMemoryTree({ files: {}, writable: true });
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      maxRetainedChanges: 1,
      resolveContext: ({ request }) => {
        const subject = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!subject) throw new ActiveFSError("UNAUTHORIZED", "missing token");
        return { context: { auth: { subject } }, isolationKey: `subject:${subject}` };
      },
      resourceLinks: testResourceLinks("https://product.example")
    });

    await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/alice-1.md", content: "one", ctx: {} },
      "alice"
    ));
    await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/bob.md", content: "bob", ctx: {} },
      "bob"
    ));
    await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/alice-2.md", content: "two", ctx: {} },
      "alice"
    ));

    const stale = await service.handle("changes", new Request(
      "https://product.example/changes?since=0",
      { headers: { authorization: "Bearer alice" } }
    ));
    const fresh = await service.handle("changes", new Request(
      "https://product.example/changes?since=1",
      { headers: { authorization: "Bearer alice" } }
    ));
    const staleBody = await stale.json() as {
      latestSequence: number;
      changes: Array<{ path: string; sequence: number }>;
      truncated: boolean;
    };
    const freshBody = await fresh.json() as typeof staleBody;
    expect(staleBody.latestSequence).toBe(2);
    expect(staleBody).toMatchObject({
      changes: [expect.objectContaining({ path: "/alice-2.md" })],
      truncated: true
    });
    expect(freshBody).toMatchObject({
      changes: [expect.objectContaining({ path: "/alice-2.md" })],
      truncated: false
    });
  });

  it("replays idempotent mutation results without re-executing and rejects key reuse drift", async () => {
    let writeCalls = 0;
    const inner = createMemoryTree({ files: {}, writable: true });
    const originalWrite = inner.write.bind(inner);
    const tree: ActiveFSTree = {
      ...inner,
      write: async (...args) => {
        writeCalls += 1;
        return originalWrite(...args);
      }
    };
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      resourceLinks: testResourceLinks("https://product.example")
    });
    const body = {
      path: "/idempotent.md",
      content: "once",
      ctx: {},
      options: { idempotencyKey: "retry-1" }
    };

    const [first, retry] = await Promise.all([
      service.handle("write", postRequest("https://product.example/write", body)),
      service.handle("write", postRequest("https://product.example/write", body))
    ]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(writeCalls).toBe(1);

    const conflict = await service.handle("write", postRequest(
      "https://product.example/write",
      { ...body, content: "different" }
    ));
    expect(conflict.status).toBe(409);
    expect(writeCalls).toBe(1);
  });

  it("bounds retained isolation scopes and reports a cursor tombstone after scope eviction", async () => {
    const tree = createMemoryTree({ files: {}, writable: true });
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      maxRetainedIsolationScopes: 1,
      resolveContext: ({ request }) => {
        const subject = request.headers.get("authorization")?.replace(/^Bearer /, "");
        if (!subject) throw new ActiveFSError("UNAUTHORIZED", "missing token");
        return { context: { auth: { subject } }, isolationKey: `subject:${subject}` };
      },
      resourceLinks: testResourceLinks("https://product.example")
    });

    await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/alice.md", content: "alice", ctx: {} },
      "alice"
    ));
    await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/bob.md", content: "bob", ctx: {} },
      "bob"
    ));
    const resumed = await service.handle("changes", new Request(
      "https://product.example/changes?since=0",
      { headers: { authorization: "Bearer alice" } }
    ));

    await expect(resumed.json()).resolves.toMatchObject({
      latestSequence: 1,
      changes: [],
      truncated: true
    });
  });

  it("enforces operation-status and session-activity retention bounds", async () => {
    const tree = createMemoryTree({ files: {}, writable: true, watchable: false });
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/ops"),
      maxRetainedOperationStatuses: 1,
      maxSessionActivityBacklog: 1,
      resourceLinks: testResourceLinks("https://product.example")
    });

    const created = await service.handle("createSession", postRequest(
      "https://product.example/create",
      { path: "/", ctx: {} }
    ));
    const session = await created.json() as { sessionId: string };
    const firstActivity = await service.handle("sessionActivity", postRequest(
      "https://product.example/activity",
      { type: "read", path: "/first.md" }
    ), { sessionId: session.sessionId });
    const secondActivity = await service.handle("sessionActivity", postRequest(
      "https://product.example/activity",
      { type: "read", path: "/second.md" }
    ), { sessionId: session.sessionId });
    await expect(firstActivity.json()).resolves.toMatchObject({ backlog: 1 });
    await expect(secondActivity.json()).resolves.toMatchObject({ backlog: 1 });

    const firstWrite = await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/first.md", content: "one", ctx: {} }
    ));
    const secondWrite = await service.handle("write", postRequest(
      "https://product.example/write",
      { path: "/second.md", content: "two", ctx: {} }
    ));
    const firstOperation = await firstWrite.json() as { operationId: string };
    const secondOperation = await secondWrite.json() as { operationId: string };
    const evictedStatus = await service.handle(
      "operationStatus",
      new Request("https://product.example/status"),
      { operationId: firstOperation.operationId }
    );
    const retainedStatus = await service.handle(
      "operationStatus",
      new Request("https://product.example/status"),
      { operationId: secondOperation.operationId }
    );
    expect(evictedStatus.status).toBe(404);
    expect(retainedStatus.status).toBe(200);
  });

  it("replays retained SSE events and fails closed with resync on a replay gap", async () => {
    const tree = createMemoryTree({ files: { "/file.md": "ok" }, watchable: false });
    const service = createActiveFSSourceService({
      tree,
      endpoints: { ...endpointsForTree(tree, "https://product.example/ops"), sessions: "https://product.example/sessions" },
      maxRetainedSessionEvents: 1,
      resolveContext: () => ({ context: { auth: { subject: "alice" } }, isolationKey: "subject:alice" }),
      resourceLinks: {
        session: ({ sessionId }) => ({
          eventEndpoint: `https://product.example/sessions/${sessionId}/events`,
          ackEndpoint: `https://product.example/sessions/${sessionId}/acks`,
          activityEndpoint: `https://product.example/sessions/${sessionId}/activity`
        })
      }
    });
    const created = await service.handle("createSession", postRequest(
      "https://product.example/sessions",
      { path: "/", ctx: {} }
    ));
    const session = await created.json() as { sessionId: string };

    const initial = await service.handle("sessionEvents", new Request("https://product.example/events"), {
      sessionId: session.sessionId
    });
    const initialReader = initial.body!.getReader();
    await readSseEvent(initialReader);
    await readSseEvent(initialReader);
    await initialReader.cancel();

    const reconnect = await service.handle("sessionEvents", new Request("https://product.example/events", {
      headers: { "last-event-id": "0" }
    }), { sessionId: session.sessionId });
    const reconnectReader = reconnect.body!.getReader();
    const gap = await readSseEvent(reconnectReader);
    await reconnectReader.cancel();
    expect(gap).toMatchObject({
      type: "resync.required",
      payload: { reason: "event replay gap" }
    });

    const invalid = await service.handle("sessionEvents", new Request("https://product.example/events", {
      headers: { "last-event-id": "not-a-number" }
    }), { sessionId: session.sessionId });
    expect(invalid.status).toBe(400);
  });

  it("requires explicit concrete links for framework-owned session and mutation routes", async () => {
    const tree = createMemoryTree({ files: { "/file.md": "old" }, writable: true, watchable: true });
    const service = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/arbitrary")
    });

    const session = await service.handle("createSession", postRequest(
      "https://product.example/routes/create-watch",
      { path: "/", ctx: {} }
    ));
    const mutation = await service.handle("write", postRequest(
      "https://product.example/routes/commit-file",
      { path: "/file.md", content: "new", ctx: {} }
    ));

    expect(session.status).toBe(500);
    expect(mutation.status).toBe(500);
    await expect(session.text()).resolves.toContain("Source API service failed");
    await expect(mutation.text()).resolves.toContain("Source API service failed");
    await expect(tree.read({}, "/file.md")).resolves.toMatchObject({ content: "old" });

    const invalidLinks = createActiveFSSourceService({
      tree,
      endpoints: endpointsForTree(tree, "https://product.example/arbitrary"),
      resourceLinks: {
        session: () => ({
          eventEndpoint: "https://user:secret@product.example/events",
          ackEndpoint: "./ack",
          activityEndpoint: "./activity"
        }),
        operationStatus: () => "javascript:alert(1)"
      }
    });
    const invalidSession = await invalidLinks.handle("createSession", postRequest(
      "https://product.example/routes/create-watch",
      { path: "/", ctx: {} }
    ));
    const invalidMutation = await invalidLinks.handle("write", postRequest(
      "https://product.example/routes/commit-file",
      { path: "/file.md", content: "still-old", ctx: {} }
    ));
    expect(invalidSession.status).toBe(500);
    expect(invalidMutation.status).toBe(500);
    await expect(tree.read({}, "/file.md")).resolves.toMatchObject({ content: "old" });
  });
});

describe("discovery-driven Source API client", () => {
  it("GETs each configured discovery URL without path normalization and memoizes discovery", async () => {
    for (const discoveryUrl of [
      "https://app.example.com/source",
      "https://app.example.com/source/",
      "https://app.example.com/source.json",
      "https://app.example.com/source?tenant=acme",
      "https://APP.example.com:443/source%2Fmanifest?value=%2f"
    ]) {
      const calls: string[] = [];
      const client = createHttpSourceClient({
        url: discoveryUrl,
        fetch: async (input) => {
          const url = input.toString();
          calls.push(url);
          if (url === discoveryUrl) {
            return new Response(JSON.stringify(handshakeDocument({
              stat: "/operations/stat",
              list: "/operations/list",
              read: "/operations/read"
            })), { status: 200 });
          }
          if (url.endsWith("/operations/list")) return new Response("[]", { status: 200 });
          if (url.endsWith("/operations/read")) return new Response(JSON.stringify({ content: "ok" }), { status: 200 });
          return new Response("not found", { status: 404 });
        }
      });
      await client.list({}, "/");
      await client.read({}, "/file.md");
      expect(calls.filter((url) => url === discoveryUrl)).toHaveLength(1);
      expect(client.discoveryUrl).toBe(discoveryUrl);
    }
  });

  it("GETs the exact file-like, query-bearing discovery URL and uses only advertised endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const discoveryUrl = "https://app.example.com/api/source-config.json?tenant=acme";
    const handshake = handshakeDocument({
      stat: "./operations/stat",
      list: "./operations/list",
      read: "./operations/read"
    });
    const client = createHttpSourceClient({
      url: discoveryUrl,
      fetch: async (input, init) => {
        const url = input.toString();
        calls.push({ url, method: init?.method ?? "GET" });
        if (url === discoveryUrl) {
          return new Response(JSON.stringify(handshake), { status: 200 });
        }
        if (url === "https://app.example.com/api/operations/list") {
          return new Response("[]", { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    await client.list({}, "/");
    expect(calls).toEqual([
      { url: discoveryUrl, method: "GET" },
      { url: "https://app.example.com/api/operations/list", method: "POST" }
    ]);
    expect(client.discoveryUrl).toBe(discoveryUrl);
  });

  it("rejects capability contradictions and undisclosed operation paths", async () => {
    const contradictory = handshakeDocument({
      stat: "./stat",
      list: "./list",
      read: "./read",
      search: "./search"
    });
    contradictory.capabilities.searchable = false;
    const client = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async () => new Response(JSON.stringify(contradictory), { status: 200 })
    });
    await expect(client.fetchHandshake()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("fetches and validates advertised capability and config documents", async () => {
    const endpoints = {
      stat: "./stat",
      list: "./list",
      read: "./read",
      capabilities: "./capabilities",
      config: "./config"
    };
    const handshake = handshakeDocument(endpoints);
    const calls: string[] = [];
    const client = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => {
        const url = input.toString();
        calls.push(url);
        if (url.endsWith("/discovery")) return new Response(JSON.stringify(handshake), { status: 200 });
        if (url.endsWith("/capabilities")) return new Response(JSON.stringify(handshake.capabilities), { status: 200 });
        if (url.endsWith("/config")) {
          return new Response(JSON.stringify({
            schemaVersion: 1,
            protocol: "activefs-source",
            protocolVersion: 1,
            workspace: { displayName: "Docs", suggestedMountPath: "/docs" }
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    await expect(client.fetchCapabilities()).resolves.toEqual(handshake.capabilities);
    await expect(client.fetchConfig()).resolves.toMatchObject({
      workspace: { displayName: "Docs", suggestedMountPath: "/docs" }
    });
    expect(calls.filter((url) => url.endsWith("/discovery"))).toHaveLength(1);

    const malformedConfig = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => input.toString().endsWith("/discovery")
        ? new Response(JSON.stringify(handshake), { status: 200 })
        : new Response(JSON.stringify({ schemaVersion: 2 }), { status: 200 })
    });
    await expect(malformedConfig.fetchConfig()).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const malformedConfigHints = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => input.toString().endsWith("/discovery")
        ? new Response(JSON.stringify(handshake), { status: 200 })
        : new Response(JSON.stringify({
            schemaVersion: 1,
            protocol: "activefs-source",
            protocolVersion: 1,
            workspace: { suggestedMountPath: 42 }
          }), { status: 200 })
    });
    await expect(malformedConfigHints.fetchConfig()).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const malformedCapabilities = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => input.toString().endsWith("/discovery")
        ? new Response(JSON.stringify(handshake), { status: 200 })
        : new Response(JSON.stringify({ protocolVersion: 1 }), { status: 200 })
    });
    await expect(malformedCapabilities.fetchCapabilities()).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const driftingCapabilities = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => {
        if (input.toString().endsWith("/discovery")) {
          return new Response(JSON.stringify(handshake), { status: 200 });
        }
        return new Response(JSON.stringify({
          ...handshake.capabilities,
          searchable: true,
          activefs: { ...handshake.capabilities.activefs, search: true }
        }), { status: 200 });
      }
    });
    await expect(driftingCapabilities.fetchCapabilities()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("refreshes discovery explicitly and replaces the active endpoint map", async () => {
    let generation = 1;
    const calls: string[] = [];
    const client = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => {
        const url = input.toString();
        calls.push(url);
        if (url.endsWith("/discovery")) {
          return new Response(JSON.stringify(handshakeDocument({
            stat: `./v${generation}/stat`,
            list: `./v${generation}/list`,
            read: `./v${generation}/read`
          })), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      }
    });

    await client.list({}, "/");
    generation = 2;
    await client.list({}, "/");
    await client.refreshHandshake();
    await client.list({}, "/");

    expect(calls.filter((url) => url.endsWith("/discovery"))).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith("/v1/list"))).toHaveLength(2);
    expect(calls.filter((url) => url.endsWith("/v2/list"))).toHaveLength(1);
  });

  it("denies cross-origin endpoints by default and never forwards discovery auth implicitly", async () => {
    const handshake = handshakeDocument({
      stat: "https://cdn.example.net/stat",
      list: "https://cdn.example.net/list",
      read: "https://cdn.example.net/read"
    });
    const denied = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      auth: "secret",
      fetch: async () => new Response(JSON.stringify(handshake), { status: 200 })
    });
    await expect(denied.fetchHandshake()).rejects.toMatchObject({ code: "FORBIDDEN" });

    let forwardedAuthorization: string | null = "not-called";
    const allowed = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      auth: "secret",
      allowedEndpointOrigins: ["https://cdn.example.net"],
      fetch: async (input, init) => {
        if (input.toString().includes("app.example.com")) {
          return new Response(JSON.stringify(handshake), { status: 200 });
        }
        forwardedAuthorization = new Headers(init?.headers).get("authorization");
        return new Response("[]", { status: 200 });
      }
    });
    await allowed.list({}, "/");
    expect(forwardedAuthorization).toBeNull();

    const explicitlyAuthenticated = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      auth: "discovery-secret",
      allowedEndpointOrigins: ["https://cdn.example.net"],
      authByOrigin: { "https://cdn.example.net": "cdn-secret" },
      fetch: async (input, init) => {
        if (input.toString().includes("app.example.com")) {
          return new Response(JSON.stringify(handshake), { status: 200 });
        }
        forwardedAuthorization = new Headers(init?.headers).get("authorization");
        return new Response("[]", { status: 200 });
      }
    });
    await explicitlyAuthenticated.list({}, "/");
    expect(forwardedAuthorization).toBe("Bearer cdn-secret");
  });

  it("bounds redirects and rejects disallowed redirect origins and URL schemes", async () => {
    const handshake = handshakeDocument({ stat: "./stat", list: "./list", read: "./read" });
    const redirectedCalls: string[] = [];
    const redirected = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async (input) => {
        const url = input.toString();
        redirectedCalls.push(url);
        return url.endsWith("/discovery")
          ? new Response(null, { status: 302, headers: { location: "./tenant/discovery.json" } })
          : new Response(JSON.stringify(handshake), { status: 200 });
      }
    });
    await redirected.fetchHandshake();
    expect(redirectedCalls).toEqual([
      "https://app.example.com/discovery",
      "https://app.example.com/tenant/discovery.json"
    ]);

    const crossOrigin = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/discovery" }
      })
    });
    await expect(crossOrigin.fetchHandshake()).rejects.toMatchObject({ code: "FORBIDDEN" });

    let redirectCount = 0;
    const unbounded = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      maxRedirects: 1,
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: `./again-${redirectCount += 1}` }
      })
    });
    await expect(unbounded.fetchHandshake()).rejects.toThrow("redirect limit");

    expect(() => createHttpSourceClient({ url: "file:///tmp/discovery.json" })).toThrow("http: or https:");
    expect(() => createHttpSourceClient({ url: "https://app.example.com/discovery#fragment" })).toThrow("fragment");
    expect(() => createHttpSourceClient({ url: "https://user:secret@app.example.com/discovery" })).toThrow("credentials");
    let authCalls = 0;
    let fetchCalls = 0;
    expect(() => createHttpSourceClient({
      url: "http://app.example.com/discovery",
      auth: async () => { authCalls += 1; return { authorization: "Bearer secret" }; },
      fetch: async () => { fetchCalls += 1; return new Response(); }
    })).toThrow("loopback");
    expect(authCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    const badScheme = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      fetch: async () => new Response(JSON.stringify(handshakeDocument({
        stat: "javascript:alert(1)",
        list: "./list",
        read: "./read"
      })), { status: 200 })
    });
    await expect(badScheme.fetchHandshake()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("parses CRLF session SSE and verifies events through the shared client stream", async () => {
    const payload = { path: "/visible.md" };
    const event = {
      id: "session-1:1",
      sessionId: "session-1",
      sequence: 1,
      issuedAt: "2026-07-15T00:00:00.000Z",
      type: "path.invalidated" as const,
      payload,
      payloadDigest: await testSha256Base64(JSON.stringify(payload))
    };
    const handshake = handshakeDocument({
      stat: "./stat",
      list: "./list",
      read: "./read",
      sessions: "./sessions"
    });
    handshake.capabilities.watchable = true;
    handshake.capabilities.activefs = { ...handshake.capabilities.activefs, watch: true };
    const client = createHttpSourceClient({
      url: "https://app.example.com/discovery",
      handshake,
      fetch: async (input) => {
        const url = input.toString();
        if (url.endsWith("/sessions")) {
          return new Response(JSON.stringify({
            sessionId: "session-1",
            createdAt: "2026-07-15T00:00:00.000Z",
            cacheMode: "off",
            eventEndpoint: "./sessions/session-1/events",
            ackEndpoint: "./sessions/session-1/acks",
            activityEndpoint: "./sessions/session-1/activity",
            integrity: { eventChain: "sha-256" }
          }), { status: 201 });
        }
        if (url.endsWith("/events")) {
          return new Response(`id: 1\r\nevent: path.invalidated\r\ndata: ${JSON.stringify(event)}\r\n\r\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" }
          });
        }
        return new Response("not found", { status: 404 });
      }
    });
    const session = await client.createSession({}, "/");
    const received: unknown[] = [];
    const verified = await client.streamSessionEvents(session.sessionId, (value) => {
      received.push(value);
    });

    expect(received).toEqual([event]);
    expect(verified).toMatchObject({ sessionId: "session-1", lastSequence: 1 });
  });

  it("resolves concrete session and operation links against their response URLs", async () => {
    const tree = createMemoryTree({ files: { "/file.md": "old" }, writable: true, watchable: true });
    const capabilities = activeFSSourceCapabilities(tree);
    const handshake: ActiveFSTreeHandshake = {
      protocol: "activefs-source",
      protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
      capabilities,
      endpoints: {
        stat: "./ops/stat",
        list: "./ops/list",
        read: "./ops/read",
        search: "./ops/search",
        command: "./ops/command",
        write: "./ops/write",
        delete: "./ops/delete",
        mkdir: "./ops/mkdir",
        rmdir: "./ops/rmdir",
        rename: "./ops/rename",
        copy: "./ops/copy",
        truncate: "./ops/truncate",
        metadata: "./ops/metadata",
        sessions: "./ops/sessions"
      }
    };
    const client = createHttpSourceClient({
      url: "https://app.example.com/api/discovery.json",
      fetch: async (input) => {
        const url = input.toString();
        if (url.endsWith("/api/discovery.json")) {
          return new Response(JSON.stringify(handshake), { status: 200 });
        }
        if (url.endsWith("/api/ops/sessions")) {
          return new Response(JSON.stringify({
            sessionId: "session-1",
            createdAt: "2026-07-14T00:00:00.000Z",
            cacheMode: "realtime/coherent",
            eventEndpoint: "./session-1/events",
            ackEndpoint: "./session-1/acks",
            activityEndpoint: "./session-1/activity",
            integrity: { eventChain: "sha-256" }
          }), { status: 200 });
        }
        if (url.endsWith("/api/ops/write")) {
          return new Response(JSON.stringify({
            operationId: "operation-1",
            operationStatusEndpoint: "./operations/operation-1",
            created: false
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });

    await expect(client.createSession()).resolves.toMatchObject({
      eventEndpoint: "https://app.example.com/api/ops/session-1/events",
      ackEndpoint: "https://app.example.com/api/ops/session-1/acks",
      activityEndpoint: "https://app.example.com/api/ops/session-1/activity"
    });
    const mutation = await client.write({}, "/file.md", "new") as unknown as {
      operationStatusEndpoint: string;
    };
    expect(mutation.operationStatusEndpoint).toBe("https://app.example.com/api/ops/operations/operation-1");
  });
});

function identityService<Auth = { subject: string }>(tree: ActiveFSTree<Auth>): ActiveFSSourceService<Auth> {
  return createActiveFSSourceService({
    tree,
    endpoints: endpointsForTree(tree, "https://product.example/ops"),
    resolveContext: ({ request }) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
      if (!token) throw new ActiveFSError("UNAUTHORIZED", "missing token");
      return {
        context: { auth: { subject: token } as Auth },
        isolationKey: `subject:${token}`
      };
    },
    resourceLinks: {
      session: ({ sessionId }) => ({
        eventEndpoint: `https://product.example/sessions/${sessionId}/events`,
        ackEndpoint: `https://product.example/sessions/${sessionId}/acks`,
        activityEndpoint: `https://product.example/sessions/${sessionId}/activity`
      }),
      operationStatus: ({ operationId }) => `https://product.example/operations/${operationId}`
    }
  });
}

function testResourceLinks(base: string) {
  return {
    session: ({ sessionId }: { sessionId: string }) => ({
      eventEndpoint: `${base}/sessions/${sessionId}/events`,
      ackEndpoint: `${base}/sessions/${sessionId}/acks`,
      activityEndpoint: `${base}/sessions/${sessionId}/activity`
    }),
    operationStatus: ({ operationId }: { operationId: string }) => `${base}/operations/${operationId}`
  };
}

function createServiceFetch(service: ActiveFSSourceService, token: string): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const operation = url.pathname === "/discovery.json"
      ? "handshake"
      : url.pathname.split("/").at(-1) as ActiveFSSourceOperation;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    const forwarded = new Request(request, { headers });
    return service.handle(operation, forwarded);
  };
}

function contextRecordingTree(
  inner: ActiveFSTree,
  seen: Array<{ operation: string; context: ActiveFSContext }>
): ActiveFSTree {
  return {
    ...inner,
    info: async (context, path) => { seen.push({ operation: "info", context }); return inner.info(context, path); },
    list: async (context, path) => { seen.push({ operation: "list", context }); return inner.list(context, path); },
    read: async (context, path, options) => { seen.push({ operation: "read", context }); return inner.read(context, path, options); },
    search: async (context, path, query) => { seen.push({ operation: "search", context }); return inner.search(context, path, query); },
    command: async (context, command, path, input) => {
      seen.push({ operation: `command:${command}`, context });
      return inner.command(context, command, path, input);
    },
    write: async (context, path, content, options) => {
      seen.push({ operation: "write", context });
      return inner.write(context, path, content, options);
    },
    remove: async (context, path, options) => {
      seen.push({ operation: "remove", context });
      return inner.remove(context, path, options);
    },
    makeDir: async (context, path, options) => {
      seen.push({ operation: "makeDir", context });
      return inner.makeDir(context, path, options);
    },
    move: async (context, from, to, options) => {
      seen.push({ operation: "move", context });
      return inner.move(context, from, to, options);
    },
    copy: async (context, from, to, options) => {
      seen.push({ operation: "copy", context });
      return inner.copy(context, from, to, options);
    },
    truncate: async (context, path, options) => {
      seen.push({ operation: "truncate", context });
      return inner.truncate(context, path, options);
    },
    updateInfo: async (context, path, options) => {
      seen.push({ operation: "updateInfo", context });
      return inner.updateInfo(context, path, options);
    }
  };
}

function readOnlyEndpoints(base: string): ActiveFSSourceEndpoints {
  return {
    stat: `${base}/stat`,
    list: `${base}/list`,
    read: `${base}/read`,
    command: `${base}/command`
  };
}

function fullEndpoints(base: string): ActiveFSSourceEndpoints {
  return {
    ...readOnlyEndpoints(base),
    search: `${base}/search`,
    write: `${base}/write`,
    delete: `${base}/delete`,
    mkdir: `${base}/mkdir`,
    rmdir: `${base}/rmdir`,
    rename: `${base}/rename`,
    copy: `${base}/copy`,
    truncate: `${base}/truncate`,
    metadata: `${base}/metadata`,
    sessions: `${base}/sessions`,
    changes: `${base}/changes`,
    capabilities: `${base}/capabilities`,
    config: `${base}/config`,
    policy: `${base}/policy`
  };
}

function endpointsForTree<Auth, Meta>(tree: ActiveFSTree<Auth, Meta>, base: string): ActiveFSSourceEndpoints {
  const capabilities = activeFSSourceCapabilities(tree);
  return {
    ...readOnlyEndpoints(base),
    ...(capabilities.searchable ? { search: `${base}/search` } : {}),
    ...(capabilities.mutable.write ? { write: `${base}/write` } : {}),
    ...(capabilities.mutable.delete ? { delete: `${base}/delete` } : {}),
    ...(capabilities.mutable.mkdir ? { mkdir: `${base}/mkdir` } : {}),
    ...(capabilities.mutable.rmdir ? { rmdir: `${base}/rmdir` } : {}),
    ...(capabilities.mutable.rename ? { rename: `${base}/rename` } : {}),
    ...(capabilities.mutable.copy ? { copy: `${base}/copy` } : {}),
    ...(capabilities.mutable.truncate ? { truncate: `${base}/truncate` } : {}),
    ...(capabilities.mutable.updateMetadata ? { metadata: `${base}/metadata` } : {}),
    sessions: `${base}/sessions`,
    changes: `${base}/changes`,
    capabilities: `${base}/capabilities`,
    config: `${base}/config`,
    policy: `${base}/policy`
  };
}

function handshakeDocument(endpoints: ActiveFSSourceEndpoints): ActiveFSTreeHandshake {
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

function postRequest(url: string, body: unknown, token?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Record<string, unknown>> {
  const { value, done } = await reader.read();
  if (done || !value) throw new Error("SSE stream ended before an event was received");
  const data = new TextDecoder().decode(value).split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return JSON.parse(data) as Record<string, unknown>;
}

async function testSha256Base64(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return btoa(String.fromCharCode(...digest));
}
