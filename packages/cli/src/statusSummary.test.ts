import { createActiveFSRemoteStateLayout, recordActiveFSActivityBacklog, recordActiveFSOperationJournal, saveActiveFSConfig, writeActiveFSSessionState } from "@activefs/config";
import { saveActiveFSMountConfig } from "@activefs/mount";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkActiveFSTreeEndpoint,
  createActiveFSStatusSummary,
  formatSessionStatus,
  writeActiveFSDiagnosticSnapshot
} from "./statusSummary";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ActiveFS status summary helpers", () => {
  it("formats empty and detailed session records", () => {
    expect(formatSessionStatus({ state: "none" })).toBe("state=none");
    expect(formatSessionStatus({
      state: "coherent",
      sessionId: "session-1",
      mode: "session",
      cacheMode: "coherent",
      lastEventId: "12",
      lastEventSequence: 12,
      lastAppliedAck: true,
      lastAckSequence: 11,
      lastFailureReason: "previous timeout",
      lastResyncAt: "2026-06-27T00:00:00.000Z"
    })).toBe(
      "state=coherent, id=session-1, mode=session, cache=coherent, lastEvent=12, " +
      "lastEventSequence=12, lastAppliedAck=true, lastAckSequence=11, " +
      "lastFailure=previous timeout, lastResync=2026-06-27T00:00:00.000Z"
    );
  });

  it("reports exact Source API discovery and unreachable diagnostics", async () => {
    const handshake = makeHandshake();
    const capabilities = handshake.capabilities;
    const handshakeStatus = await checkActiveFSTreeEndpoint({
      endpoint: "https://source.example/activefs/v1",
      name: "docs",
      fetch: jsonFetch({
        "/activefs/v1": handshake
      })
    });
    const capabilitiesStatus = await checkActiveFSTreeEndpoint({
      endpoint: "https://source.example/activefs/v1",
      name: "docs",
      fetch: jsonFetch({
        "/activefs/v1/capabilities": capabilities
      })
    });
    const unreachableStatus = await checkActiveFSTreeEndpoint({
      endpoint: "https://source.example/activefs/v1",
      name: "docs",
      fetch: async () => new Response("down", { status: 503 })
    });

    expect(handshakeStatus).toMatchObject({
      reachable: true,
      protocol: "activefs-source",
      protocolVersion: 1
    });
    expect(capabilitiesStatus).toMatchObject({
      reachable: false,
      diagnostics: expect.stringContaining("404")
    });
    expect(unreachableStatus).toMatchObject({
      reachable: false,
      diagnostics: expect.stringContaining("503")
    });
  });

  it("summarizes remotes, state records, operations, activity backlog, and diagnostic snapshots", async () => {
    const root = await makeTempDir();
    const layout = createActiveFSRemoteStateLayout(root, "docs");
    await saveActiveFSConfig(root, {
      schemaVersion: 1,
      remotes: {
        docs: {
          name: "docs",
          url: "https://source.example/activefs/v1",
          mountPath: "/docs",
          remoteRoot: "/tenant/docs",
          auth: { type: "none" },
          policy: {
            schemaVersion: 1,
            defaultAccess: "writable",
            revision: "policy-1",
            digest: "sha256:policy",
            rules: [{
              access: "writable",
              allow: ["read"],
              match: { type: "prefix", path: "/docs" }
            }]
          },
          adapterCapabilityProfile: "bounded-filesystem-semantics",
          cacheMode: "realtime/coherent",
          activityPolicy: "required",
          insecureHttp: {
            allowed: true,
            devOnly: true,
            loopback: false,
            reason: "allow-insecure-http"
          }
        }
      }
    });
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeActiveFSSessionState(layout, {
      state: "coherent",
      sessionId: "session-identifier-that-is-long",
      mode: "session",
      lastEventId: "event-3",
      lastEventSequence: 3,
      lastAckSequence: 2,
      cacheMode: "realtime/coherent",
      activityPolicy: "required",
      updatedAt: "2026-06-27T00:00:00.000Z"
    });
    await recordActiveFSOperationJournal(layout, {
      operationId: "op-pending",
      operation: "write",
      path: "/docs/a.txt",
      status: "pending",
      startedAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:01.000Z",
      result: {
        content: "redacted",
        nested: { token: "redacted", ok: true }
      }
    });
    await recordActiveFSActivityBacklog(layout, {
      activityId: "activity-1",
      policy: "required",
      sessionId: "session-identifier-that-is-long",
      operation: "read",
      path: "/docs/a.txt",
      timestamp: "2026-06-27T00:00:02.000Z",
      source: "cache",
      result: "succeeded"
    });

    const summary = await createActiveFSStatusSummary({
      rootDir: root,
      reconcileOperations: false,
      fetch: jsonFetch({
        "/activefs/v1": makeHandshake()
      })
    });
    const snapshot = await writeActiveFSDiagnosticSnapshot(join(root, "diagnostics", "status.json"), summary, "health");

    expect(summary.remotes).toHaveLength(1);
    expect(summary.remotes[0]).toMatchObject({
      name: "docs",
      source: { reachable: true },
      auth: { type: "none" },
      policy: { defaultAccess: "writable", revision: "policy-1", digest: "sha256:policy", ruleCount: 1 },
      cache: { mode: "realtime/coherent" },
      session: {
        state: "coherent",
        sessionId: "session-...long",
        lastEventId: "event-3",
        lastEventSequence: 3,
        lastAckSequence: 2
      },
      operations: {
        unresolvedCount: 1,
        ids: ["op-pending"],
        recent: [expect.objectContaining({
          operationId: "op-pending",
          result: { nested: { ok: true } }
        })]
      },
      activity: {
        policy: "required",
        backlogCount: 1,
        files: ["activity-1.json"]
      }
    });
    expect(JSON.stringify(summary.remotes[0].operations.recent[0].result)).not.toContain("redacted");
    expect(snapshot).toMatchObject({ activeScreen: "health", remotes: summary.remotes });
  });

  it("reports selected remote and mount status edge cases", async () => {
    const root = await makeTempDir();
    await saveActiveFSMountConfig(root, {
      version: 1,
      remotes: {
        docs: {
          name: "docs",
          url: "https://source.example/activefs/v1",
          mountpoint: join(root, "mounted")
        }
      }
    });
    const layout = createActiveFSRemoteStateLayout(root, "docs");
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeFile(layout.sessionPath, JSON.stringify({
      state: "failed",
      sessionId: 123,
      cacheMode: "off",
      activityPolicy: "best-effort"
    }));

    await expect(createActiveFSStatusSummary({
      rootDir: root,
      remoteName: "missing",
      fetch: jsonFetch({})
    })).rejects.toThrow("Unknown ActiveFS remote: missing");

    const summary = await createActiveFSStatusSummary({
      rootDir: root,
      remoteName: "docs",
      reconcileOperations: false,
      commandRunner: () => {
        throw new Error("mount probe failed");
      },
      fetch: jsonFetch({
        "/activefs/v1/handshake": makeHandshake()
      })
    });

    expect(summary.remotes).toHaveLength(1);
    expect(summary.remotes[0].mount).toMatchObject({
      state: "failed",
      mounted: false,
      error: "mount probe failed"
    });
    expect(summary.remotes[0].session).toMatchObject({
      state: "failed",
      sessionId: undefined
    });
  });

  it("reconciles unresolved operation journal records from Source API status", async () => {
    const root = await makeTempDir();
    const layout = createActiveFSRemoteStateLayout(root, "docs");
    await saveActiveFSConfig(root, {
      schemaVersion: 1,
      remotes: {
        docs: {
          name: "docs",
          url: "https://source.example/activefs/v1",
          mountPath: "/docs"
        }
      }
    });
    const operationIds = [
      "op-running",
      "op-succeeded",
      "op-conflict",
      "op-unsupported",
      "op-transient",
      "op-rejected",
      "op-unknown",
      "op-missing"
    ];
    for (const operationId of operationIds) {
      await recordActiveFSOperationJournal(layout, {
        operationId,
        operationStatusEndpoint: `https://source.example/activefs/v1/operations/${operationId}`,
        operation: "write",
        path: `/docs/${operationId}.txt`,
        status: "pending",
        startedAt: "2026-06-27T00:00:00.000Z",
        updatedAt: "2026-06-27T00:00:00.000Z"
      });
    }

    const summary = await createActiveFSStatusSummary({
      rootDir: root,
      recentOperationLimit: 20,
      fetch: jsonFetch({
        "/activefs/v1": makeHandshake(),
        "/activefs/v1/operations/op-running": operationStatus("op-running", "running"),
        "/activefs/v1/operations/op-succeeded": operationStatus("op-succeeded", "succeeded", undefined, {
          values: [{ password: "redacted", keep: true }],
          ok: true
        }),
        "/activefs/v1/operations/op-conflict": operationStatus("op-conflict", "failed", "CONFLICT"),
        "/activefs/v1/operations/op-unsupported": operationStatus("op-unsupported", "failed", "UNSUPPORTED_OPERATION"),
        "/activefs/v1/operations/op-transient": operationStatus("op-transient", "failed", "TIMEOUT"),
        "/activefs/v1/operations/op-rejected": operationStatus("op-rejected", "failed", "PERMISSION_DENIED"),
        "/activefs/v1/operations/op-unknown": operationStatus("op-unknown", "failed", "WEIRD_ERROR")
      })
    });

    const statuses = new Map(summary.remotes[0].operations.recent.map((record) => [record.operationId, record]));
    expect(statuses.get("op-running")).toMatchObject({ status: "pending" });
    expect(statuses.get("op-succeeded")).toMatchObject({
      status: "committed",
      result: { values: [{ keep: true }], ok: true }
    });
    expect(statuses.get("op-conflict")).toMatchObject({ status: "conflict" });
    expect(statuses.get("op-unsupported")).toMatchObject({ status: "unsupported" });
    expect(statuses.get("op-transient")).toMatchObject({ status: "transient" });
    expect(statuses.get("op-rejected")).toMatchObject({ status: "rejected" });
    expect(statuses.get("op-unknown")).toMatchObject({ status: "unknown" });
    expect(statuses.get("op-missing")).toMatchObject({ status: "pending" });
    expect(summary.remotes[0].operations.unresolvedCount).toBe(4);
    expect(summary.remotes[0].operations.ids.sort()).toEqual([
      "op-missing",
      "op-running",
      "op-transient",
      "op-unknown"
    ]);
  });
});

function makeHandshake() {
  return {
    protocol: "activefs-source",
    protocolVersion: 1,
    endpoints: {
      stat: "https://source.example/activefs/v1/stat",
      list: "https://source.example/activefs/v1/list",
      read: "https://source.example/activefs/v1/read",
      search: "https://source.example/activefs/v1/search",
      command: "https://source.example/activefs/v1/command",
      sessions: "https://source.example/activefs/v1/sessions",
      capabilities: "https://source.example/activefs/v1/capabilities"
    },
    capabilities: {
      protocolVersion: 1,
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
      searchable: true,
      commands: ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"],
      watchable: true,
      rangeReadable: true,
      activefs: {
        stat: true,
        list: true,
        read: true,
        search: true,
        watch: true,
        rangeReadable: true
      }
    }
  };
}

function jsonFetch(routes: Record<string, unknown>): typeof fetch {
  return async (input) => {
    const path = new URL(typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url).pathname;
    if (!(path in routes)) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

function operationStatus(
  operationId: string,
  status: "running" | "succeeded" | "failed",
  code?: string,
  result?: unknown
) {
  return {
    operationId,
    status,
    operation: "write",
    path: `/docs/${operationId}.txt`,
    startedAt: "2026-06-27T00:00:00.000Z",
    completedAt: status === "running" ? undefined : "2026-06-27T00:00:01.000Z",
    result,
    error: code ? { code, message: `${code} message` } : undefined
  };
}

async function makeTempDir(): Promise<string> {
  const path = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "activefs-status-summary-"))
  );
  tempDirs.push(path);
  return path;
}
