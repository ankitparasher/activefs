import { describe, expect, it } from "vitest";
import { createHttpSourceClient } from "@activefs/source-http";
import {
  createMonitoredRemoteMount,
  runRemoteMountMonitorExample,
  startRemoteMountMonitorServer
} from "./index";

describe("remote-mount-monitor example", () => {
  it("creates remote trees and records mounted client activity", async () => {
    const monitor = await startRemoteMountMonitorServer();
    try {
      const tree = monitor.createTree({ name: "docs", suggestedMountPath: "/docs" });
      const mount = await createMonitoredRemoteMount({
        monitorUrl: monitor.url,
        treeId: tree.id,
        mountPath: "/docs",
        label: "test client"
      });

      const entries = await mount.client.readdir("/docs");
      const readme = await mount.client.readFile("/docs/README.md");
      const matches = await mount.client.search("/docs", { pattern: "remote" });
      const state = monitor.state();

      expect(entries.map((entry) => entry.path)).toEqual([
        "/docs/files",
        "/docs/mount.json",
        "/docs/README.md"
      ]);
      expect(readme).toContain("remote mount monitor server");
      expect(matches.matches.length).toBeGreaterThan(0);
      expect(state.trees).toHaveLength(1);
      expect(state.mounts).toMatchObject([
        {
          treeId: tree.id,
          mountPath: "/docs",
          status: "mounted"
        }
      ]);
      expect(state.events.some((event) =>
        event.type === "tree-request" &&
        event.operation === "read" &&
        event.mountId === state.mounts[0]?.id
      )).toBe(true);
      expect(state.events.some((event) => event.type === "client-activity" && event.operation === "readFile")).toBe(true);
    } finally {
      await monitor.close();
    }
  });

  it("infers a connected mount from plain Source API traffic", async () => {
    const monitor = await startRemoteMountMonitorServer();
    try {
      const tree = monitor.createTree({ name: "docs", suggestedMountPath: "/docs" });
      const client = createHttpSourceClient({ url: tree.treeUrl, name: tree.id });

      await client.fetchHandshake();
      expect(monitor.state().mounts).toMatchObject([
        {
          treeId: tree.id,
          mountPath: "/docs",
          status: "unmounted"
        }
      ]);

      await client.list({}, "/");
      const state = monitor.state();
      expect(state.mounts).toMatchObject([
        {
          treeId: tree.id,
          mountPath: "/docs",
          status: "mounted"
        }
      ]);
      expect(state.events.some((event) =>
        event.type === "tree-request" &&
        event.operation === "list" &&
        event.mountId === state.mounts[0]?.id
      )).toBe(true);
    } finally {
      await monitor.close();
    }
  });

  it("marks an inferred mount unmounted when its session stream closes", async () => {
    const monitor = await startRemoteMountMonitorServer();
    try {
      const tree = monitor.createTree({ name: "docs", suggestedMountPath: "/docs" });
      const session = await fetch(`${tree.treeUrl}sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ctx: {}, path: "/" })
      })
        .then((response) => response.json() as Promise<{ sessionId: string }>);
      const controller = new AbortController();
      const events = await fetch(`${tree.treeUrl}sessions/${session.sessionId}/events`, {
        signal: controller.signal
      });
      expect(events.status).toBe(200);
      expect(monitor.state().mounts[0]).toMatchObject({ status: "mounted" });

      controller.abort();
      await events.body?.cancel().catch(() => undefined);
      await waitFor(() => monitor.state().mounts[0]?.status === "unmounted");

      expect(monitor.state().mounts[0]).toMatchObject({ status: "unmounted" });
    } finally {
      await monitor.close();
    }
  });

  it("serves the monitor page and accepts tree creation over HTTP", async () => {
    const monitor = await startRemoteMountMonitorServer();
    try {
      const html = await fetch(monitor.url).then((response) => response.text());
      expect(html).toContain("ActiveFS Remote Mount Monitor");
      expect(html).toContain("EventSource");
      expect(html).toContain("connection-dot");
      expect(html).toContain("event-marker");

      const created = await fetch(`${monitor.url}/api/trees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "reports", suggestedMountPath: "/reports" })
      }).then((response) => response.json() as Promise<{ id: string; treeUrl: string }>);

      expect(created).toMatchObject({
        id: "reports"
      });
      expect(created.treeUrl).toBe(`${monitor.url}/trees/reports/source/`);
    } finally {
      await monitor.close();
    }
  });

  it("runs the deterministic smoke flow", async () => {
    const result = await runRemoteMountMonitorExample();

    expect(result.trees).toEqual(["docs", "reports"]);
    expect(result.mounts).toBe(1);
    expect(result.treeRequestEvents).toBeGreaterThanOrEqual(4);
    expect(result.clientActivityEvents).toBeGreaterThanOrEqual(3);
    expect(result.entries).toContain("/docs/README.md");
    expect(result.matches).toBeGreaterThan(0);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for remote mount monitor state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
