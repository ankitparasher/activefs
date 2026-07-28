import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveFSError, type ActiveFS, type ActiveFSTree, type ActiveFSTreeCommand } from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";
import { startActiveFSServer, type ActiveFSTreeServerHandle } from "@activefs/source-http";
import {
  createMountLayout,
  type MountCommandRunner,
  type RcloneMountChild,
  type RcloneMountProcessSpawner
} from "@activefs/mount";
import { createExampleActiveFS } from "./example.js";
import {
  activeFSTuiTestInternals,
  createActiveFSTuiController,
  runActiveFSTui,
  type TuiSnapshot
} from "./tui.js";
import { createActiveFSTuiRuntime } from "./tuiSources.js";

const tempDirs: string[] = [];
const sourceServers: ActiveFSTreeServerHandle[] = [];

afterEach(async () => {
  await Promise.all(sourceServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map(removeTempDir));
});

describe("ActiveFS TUI controller", () => {
  it("browses, previews, copies, and exports the fake example tree", async () => {
    const tempDir = await makeTempDir();
    const copied: string[] = [];
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir: join(tempDir, ".activefs"),
      exportDir: join(tempDir, "exported"),
      writeClipboard: (text) => {
        copied.push(text);
      }
    });

    controller.setScreen("browser");
    const snapshot = await controller.refresh();
    const helloIndex = snapshot.browser.entries.findIndex((entry) => entry.path === "/hello.md");
    expect(helloIndex).toBeGreaterThanOrEqual(0);
    controller.moveSelection(helloIndex, snapshot.browser.entries.length);

    await expect(controller.copySelectedVirtualPath()).resolves.toBe("/hello.md");
    const manifest = await controller.exportSelectedPath(join(tempDir, "selected"));

    expect(copied).toEqual(["/hello.md"]);
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["/hello.md"]);
    await expect(readFile(join(tempDir, "selected", "hello.md"), "utf8")).resolves.toContain("Hello ActiveFS");
  });

  it("searches from the current browser path and opens selected results", async () => {
    const tempDir = await makeTempDir();
    const copied: string[] = [];
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir: join(tempDir, ".activefs"),
      writeClipboard: (text) => {
        copied.push(text);
      }
    });

    await controller.search("ActiveFS");
    let snapshot = await controller.refresh();

    expect(snapshot.screen).toBe("search");
    expect(snapshot.search).toMatchObject({
      root: "/",
      pattern: "ActiveFS",
      complete: true
    });
    expect(snapshot.search.matches.length).toBeGreaterThan(0);
    await expect(controller.copySelectedSearchPath()).resolves.toBe(snapshot.search.matches[0]?.path);
    expect(copied).toEqual([snapshot.search.matches[0]?.path]);

    await controller.openSearchSelection();
    snapshot = await controller.refresh();

    expect(snapshot.screen).toBe("browser");
    expect(snapshot.status).toContain("Selected");
  });

  it("saves redacted diagnostics for Source API and operation internals", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    await mkdir(join(rootDir, "remotes", "docs", "journal"), { recursive: true });
    await writeFile(
      join(rootDir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        remotes: {
          docs: {
            name: "docs",
            mountPath: "/docs",
            url: "http://127.0.0.1:3999/activefs/v1/",
            auth: { type: "private-bearer-token" },
            policy: {
              defaultAccess: "writable",
              rules: []
            }
          }
        }
      })
    );
    await writeFile(
      join(rootDir, "remotes", "docs", "journal", "op-1.json"),
      JSON.stringify({
        schemaVersion: 1,
        operationId: "op-1",
        remoteName: "docs",
        operation: "write",
        path: "/secret.md",
        status: "pending",
        startedAt: "2026-06-25T00:00:00.000Z",
        updatedAt: "2026-06-25T00:00:00.000Z",
        result: {
          token: "super-secret-token",
          content: "raw file bytes",
          nested: {
            keep: "ok",
            authorization: "Bearer nope"
          }
        }
      })
    );
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      fetch: okFetch()
    });

    const path = await controller.saveDiagnosticSnapshot();
    const snapshot = JSON.parse(await readFile(path, "utf8"));
    const text = JSON.stringify(snapshot);

    expect(snapshot.remotes[0]).toMatchObject({
      name: "docs",
      source: { reachable: true },
      auth: { type: "private-bearer-token" },
      operations: { unresolvedCount: 1 }
    });
    expect(text).toContain("\"keep\":\"ok\"");
    expect(text).not.toContain("super-secret-token");
    expect(text).not.toContain("raw file bytes");
    expect(text).not.toContain("Bearer nope");
  });

  it("loads a real local source provider without browsing the mounted VFS", async () => {
    const tempDir = await makeTempDir();
    const sourceDir = join(tempDir, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "note.txt"), "local tree bytes");
    const runtime = createActiveFSTuiRuntime([`local:/workspace=${sourceDir}`]);
    const controller = createActiveFSTuiController({
      ...runtime,
      rootDir: join(tempDir, ".activefs")
    });

    controller.setScreen("browser");
    let snapshot = await controller.refresh();
    const workspaceIndex = snapshot.browser.entries.findIndex((entry) => entry.path === "/workspace");
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    controller.moveSelection(workspaceIndex, snapshot.browser.entries.length);
    await controller.openBrowserSelection();

    snapshot = await controller.refresh();
    expect(snapshot.browser.source).toMatchObject({
      kind: "local",
      mountPath: "/workspace",
      detail: sourceDir
    });
    const noteIndex = snapshot.browser.entries.findIndex((entry) => entry.path === "/workspace/note.txt");
    expect(noteIndex).toBeGreaterThanOrEqual(0);
    controller.moveSelection(noteIndex, snapshot.browser.entries.length);
    snapshot = await controller.refresh();
    expect(snapshot.browser.preview).toContain("local tree bytes");
  });

  it("loads persisted ActiveFS remotes and exposes settings", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const server = await startActiveFSServer({
      tree: createMemoryTree({
        files: {
          "/README.txt": "remote tree bytes"
        }
      })
    });
    sourceServers.push(server);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        remotes: {
          docs: {
            name: "docs",
            mountPath: "/docs",
            url: server.url
          }
        }
      })
    );
    const runtime = createActiveFSTuiRuntime([], { rootDir });
    const controller = createActiveFSTuiController({
      ...runtime,
      rootDir
    });

    controller.setScreen("browser");
    let snapshot = await controller.refresh();
    expect(snapshot.sources).toEqual([
      expect.objectContaining({
        kind: "http",
        mountPath: "/docs",
        detail: server.url
      })
    ]);
    const docsIndex = snapshot.browser.entries.findIndex((entry) => entry.path === "/docs");
    controller.moveSelection(docsIndex, snapshot.browser.entries.length);
    await controller.openBrowserSelection();
    snapshot = await controller.refresh();
    expect(snapshot.browser.preview).toContain("remote tree bytes");

    controller.setScreen("settings");
    snapshot = await controller.refresh();
    expect(snapshot.settings).toMatchObject({
      sourceCount: 1,
      mountRemoteCount: 1,
      rootDir
    });
  });

  it("fails closed without configuration and labels explicit source specs consistently", async () => {
    expect(() => createActiveFSTuiRuntime()).toThrow("No ActiveFS sources are configured");

    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const sourceDir = join(tempDir, "source");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "note.txt"), "local bytes");

    await mkdir(rootDir, { recursive: true });
    await writeFile(join(rootDir, "config.json"), "{");
    expect(() => createActiveFSTuiRuntime([], { rootDir })).toThrow("No ActiveFS sources are configured");

    await writeFile(join(rootDir, "config.json"), JSON.stringify({ schemaVersion: 2, remotes: {} }));
    expect(() => createActiveFSTuiRuntime([], { rootDir })).toThrow("No ActiveFS sources are configured");

    await writeFile(join(rootDir, "config.json"), JSON.stringify({
      schemaVersion: 1,
      remotes: {
        missingUrl: { mountPath: "/missing" },
        missingMount: { url: "http://source.example/activefs/v1/" }
      }
    }));
    expect(() => createActiveFSTuiRuntime([], { rootDir })).toThrow("No ActiveFS sources are configured");

    expect(createActiveFSTuiRuntime(["example"]).sources[0]).toMatchObject({
      id: "example",
      kind: "example",
      mountPath: "/"
    });

    const server = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/remote.txt": "remote bytes" } })
    });
    sourceServers.push(server);

    expect(createActiveFSTuiRuntime([`local=${sourceDir}`]).sources[0]).toMatchObject({
      id: "local:local",
      kind: "local",
      mountPath: "/local",
      detail: sourceDir
    });
    expect(createActiveFSTuiRuntime([`local:/=${sourceDir}`]).sources[0]).toMatchObject({
      id: "local:root",
      kind: "local",
      mountPath: "/"
    });
    expect(createActiveFSTuiRuntime([`http=${server.url}`]).sources[0]).toMatchObject({
      id: "http:remote",
      kind: "http",
      mountPath: "/remote",
      detail: server.url
    });
    expect(createActiveFSTuiRuntime([`http:/=${server.url}`]).sources[0]).toMatchObject({
      id: "http:root",
      kind: "http",
      mountPath: "/"
    });
    expect(createActiveFSTuiRuntime([`http:/docs=${server.url}`, "example"]).sources).toEqual([
      expect.objectContaining({ id: "http:docs", mountPath: "/docs" }),
      expect.objectContaining({ id: "example", mountPath: "/example" })
    ]);
  });

  it("wraps configured ActiveFS remotes with mutation journals", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const inner = createMemoryTree({
      files: { "/a.txt": "alpha" },
      writable: true
    });
    const source: ActiveFSTree = {
      ...inner,
      write: async (context, path, content, options) => {
        if (path === "/blocked.txt") {
          throw new ActiveFSError("FORBIDDEN", "blocked by source", { path });
        }
        if (path === "/conflict.txt") {
          throw new ActiveFSError("CONFLICT", "conflict from tree", { path });
        }
        if (path === "/unsupported.txt") {
          throw new ActiveFSError("UNSUPPORTED", "unsupported by tree", { path });
        }
        if (path === "/transient.txt") {
          throw new ActiveFSError("TRANSIENT", "temporary tree issue", { path });
        }
        if (path === "/missing.txt") {
          throw new ActiveFSError("NOT_FOUND", "missing in tree", { path });
        }
        return inner.write!(context, path, content, options);
      }
    };
    const server = await startActiveFSServer({ tree: source });
    sourceServers.push(server);
    await mkdir(rootDir, { recursive: true });
    await writeFile(
      join(rootDir, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        remotes: {
          docs: {
            name: "docs",
            mountPath: "/docs",
            url: server.url
          }
        }
      })
    );

    const runtime = createActiveFSTuiRuntime([], { rootDir });

    await runtime.filesystem.write({}, "/docs/new.txt", "new", { idempotencyKey: "write-1" });
    await runtime.filesystem.mkdir({}, "/docs/folder", { idempotencyKey: "mkdir-1" });
    await runtime.filesystem.write({}, "/docs/folder/a.txt", "a", { idempotencyKey: "write-2" });
    await runtime.filesystem.copy({}, "/docs/folder/a.txt", "/docs/folder/b.txt", { idempotencyKey: "copy-1" });
    await runtime.filesystem.rename({}, "/docs/folder/b.txt", "/docs/folder/c.txt", { idempotencyKey: "rename-1" });
    await runtime.filesystem.truncate({}, "/docs/folder/c.txt", { length: 1, idempotencyKey: "truncate-1" });
    await runtime.filesystem.updateMetadata({}, "/docs/folder/c.txt", { mtimeMs: 42, idempotencyKey: "meta-1" });
    await runtime.filesystem.delete({}, "/docs/folder/a.txt", { idempotencyKey: "delete-1" });
    await runtime.filesystem.rmdir({}, "/docs/folder", { recursive: true, idempotencyKey: "rmdir-1" });
    await expect(
      runtime.filesystem.write({}, "/docs/blocked.txt", "no", { idempotencyKey: "blocked-1" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runtime.filesystem.write({}, "/docs/conflict.txt", "no", { idempotencyKey: "conflict-1" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      runtime.filesystem.write({}, "/docs/unsupported.txt", "no", { idempotencyKey: "unsupported-1" })
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      runtime.filesystem.write({}, "/docs/transient.txt", "no", { idempotencyKey: "transient-1" })
    ).rejects.toMatchObject({ code: "TRANSIENT" });
    await expect(
      runtime.filesystem.write({}, "/docs/missing.txt", "no", { idempotencyKey: "missing-1" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const journalDir = join(rootDir, "remotes", "docs", "journal");
    const journals = await Promise.all(
      (await readdir(journalDir)).map(async (file) => JSON.parse(await readFile(join(journalDir, file), "utf8")))
    );
    expect(journals.map((entry) => entry.operation)).toEqual(expect.arrayContaining([
      "write",
      "mkdir",
      "copy",
      "rename",
      "truncate",
      "updateMetadata",
      "delete"
    ]));
    expect(journals).toContainEqual(expect.objectContaining({
      operation: "write",
      path: "/blocked.txt",
      status: "rejected",
      lastFailureReason: "blocked by source"
    }));
    expect(journals).toContainEqual(expect.objectContaining({
      operation: "write",
      path: "/conflict.txt",
      status: "conflict",
      lastFailureReason: "conflict from tree"
    }));
    expect(journals).toContainEqual(expect.objectContaining({
      operation: "write",
      path: "/unsupported.txt",
      status: "unsupported",
      lastFailureReason: "unsupported by tree"
    }));
    expect(journals).toContainEqual(expect.objectContaining({
      operation: "write",
      path: "/transient.txt",
      status: "transient",
      lastFailureReason: "temporary tree issue"
    }));
    expect(journals).toContainEqual(expect.objectContaining({
      operation: "write",
      path: "/missing.txt",
      status: "unknown",
      lastFailureReason: "missing in tree"
    }));
    expect(journals.some((entry) => entry.operationId.startsWith("idempotency:"))).toBe(true);
  });

  it("rejects invalid TUI source specs before building runtimes", () => {
    expect(() => createActiveFSTuiRuntime(["bad"])).toThrow("Unsupported TUI source spec");
    expect(() => createActiveFSTuiRuntime(["local"])).toThrow("Local TUI sources must use");
    expect(() => createActiveFSTuiRuntime(["local:bad=/tmp"])).toThrow("Local TUI sources must use");
    expect(() => createActiveFSTuiRuntime(["http"])).toThrow("HTTP TUI sources must use");
    expect(() => createActiveFSTuiRuntime(["httpx=http://example.test"])).toThrow("HTTP TUI sources must use");
  });

  it("handles controller fallback states without host side effects", async () => {
    const tempDir = await makeTempDir();
    const opened: string[] = [];
    const defaultController = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      openPath: (path) => {
        opened.push(path);
      }
    });
    expect(defaultController.activeScreen).toBe("health");
    defaultController.cycleScreen(-1);
    expect(defaultController.activeScreen).toBe("settings");
    defaultController.moveSelection(4, 0);
    expect(defaultController.selectedIndex()).toBe(0);

    const rootDir = join(tempDir, ".activefs");
    const ghostFilesystem = {
      stat: async (_context: unknown, path: string) =>
        path === "/"
          ? {
              name: "",
              path: "/",
              kind: "directory" as const,
              capabilities: { stat: true, list: true, read: true }
            }
          : null,
      list: async () => [
        {
          name: "ghost.txt",
          path: "/ghost.txt",
          kind: "file" as const,
          enumerable: false
        }
      ],
      read: async () => ({ content: "", encoding: "utf8" as const })
    } as unknown as ActiveFS;
    const ghostController = createActiveFSTuiController({
      filesystem: ghostFilesystem,
      sources: [],
      rootDir
    });
    ghostController.setScreen("browser");
    ghostController.cycleBrowserSource(1);
    let snapshot = await ghostController.refresh();
    expect(snapshot.browser.source).toBeUndefined();
    expect(snapshot.browser.preview).toBe("Path not found.");
    await ghostController.openBrowserSelection();
    snapshot = await ghostController.refresh();
    expect(snapshot.status).toBe("Previewing /ghost.txt.");

    const offlinePreviewFilesystem = {
      stat: async (_context: unknown, path: string) => {
        if (path === "/") {
          return {
            name: "",
            path: "/",
            kind: "directory" as const,
            capabilities: { stat: true, list: true, read: true }
          };
        }
        throw new Error("fetch failed");
      },
      list: async () => [
        {
          name: "docs",
          path: "/docs",
          kind: "directory" as const
        }
      ],
      read: async () => ({ content: "", encoding: "utf8" as const })
    } as unknown as ActiveFS;
    const offlinePreviewController = createActiveFSTuiController({
      filesystem: offlinePreviewFilesystem,
      rootDir
    });
    offlinePreviewController.setScreen("health");
    snapshot = await offlinePreviewController.refresh();
    expect(snapshot.screen).toBe("health");
    expect(snapshot.browser.entries.map((entry) => entry.path)).toEqual(["/docs"]);
    expect(snapshot.browser.preview).toBe("Preview unavailable: fetch failed");

    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      openPath: (path) => {
        opened.push(path);
      },
      fetch: okFetch()
    });
    await controller.addRemote("local:/local=http://127.0.0.1:3999/activefs/v1");
    await controller.editRemote("local", "renamed:/renamed=http://127.0.0.1:4000/activefs/v1");
    await controller.removeRemote("missing");
    await controller.openMountedPath("renamed");
    const afterOpen = await controller.refresh();
    expect(afterOpen.status).toContain("Opened");
    expect(opened.at(-1)).toContain(join(rootDir, "remotes", "renamed", "vfs"));
    const unmounted = await controller.unmount("renamed");
    expect(unmounted.state).toBe("unmounted");
  });

  it("renders TUI screens and helpers across populated and empty states", () => {
    const rootDir = "/tmp/activefs-tui-render";
    const base = makeSnapshot({
      rootDir,
      exportDir: `${rootDir}/exports`
    });
    const { renderScreen } = activeFSTuiTestInternals;

    expect(renderScreen(base, 0).detail).toContain("Keys");
    expect(renderScreen(base, 0).detail).toContain("No ActiveFS remotes configured");
    expect(renderScreen({ ...base, screen: "remotes" }, 0).detail).toContain("No remotes configured");
    const remoteSnapshot = makeSnapshot({
      screen: "health",
      debug: true,
      remotes: [
        makeRemoteSummary({
          name: "docs",
          endpoint: "http://127.0.0.1:3847/activefs/v1/",
          source: makeSourceStatus({
            endpoint: "http://127.0.0.1:3847/activefs/v1/",
            reachable: false,
            diagnostics: "connection refused"
          }),
          auth: { type: "bearer-env" },
          policy: { defaultAccess: "writable", revision: "policy-1", digest: "sha256:abc", ruleCount: 2 },
          adapterCapabilityProfile: "full-filesystem-semantics",
          cache: { mode: "content", fileCount: 2, byteSize: 1536 },
          session: {
            state: "connected",
            sessionId: "session-1",
            cacheMode: "content",
            lastAppliedAck: 7
          },
          mount: {
            remote: "docs",
            state: "webdav-down",
            mounted: false,
            rootDir,
            configPath: createMountLayout(rootDir, "docs").rcloneConfigPath,
            vfsDir: createMountLayout(rootDir, "docs").vfsDir,
            logFile: createMountLayout(rootDir, "docs").rcloneLogPath,
            webdav: {
              remote: "docs",
              state: "down",
              url: "http://127.0.0.1:3847/",
              error: "connection refused",
              updatedAt: "2026-06-25T00:00:00.000Z"
            },
            freshness: {
              remote: "docs",
              mode: "session",
              active: true,
              updatedAt: "2026-06-25T00:00:00.000Z"
            },
            updatedAt: "2026-06-25T00:00:00.000Z"
          },
          operations: {
            unresolvedCount: 1,
            ids: ["op-1"],
            recent: [
              {
                operationId: "op-1",
                operation: "write",
                path: "/draft.md",
                status: "pending",
                updatedAt: "2026-06-25T00:00:00.000Z"
              }
            ]
          },
          activity: { policy: "required", backlogCount: 1, files: ["activity-1.json"] }
        })
      ],
      settings: {
        rootDir,
        exportDir: `${rootDir}/exports`,
        sourceCount: 1,
        mountRemoteCount: 1,
        debug: true
      }
    });
    const health = renderScreen(remoteSnapshot, 0);
    expect(health.items[0]).toContain("source unreachable");
    expect(health.detail).toContain("tab/shift-tab screens");
    expect(health.detail).toContain("Source API: unreachable");
    expect(health.detail).toContain("WebDAV: down");
    expect(health.detail).toContain("rclone: webdav-down");
    expect(health.detail).toContain("unresolved operations: 1");

    const remoteDetail = renderScreen({ ...remoteSnapshot, screen: "remotes" }, 0);
    expect(remoteDetail.detail).toContain("discovery URL: http://127.0.0.1:3847/activefs/v1/");
    expect(remoteDetail.detail).toContain("reachable: no");
    expect(remoteDetail.detail).toContain("diagnostics: connection refused");
    expect(remoteDetail.detail).toContain("auth: bearer-env");
    expect(remoteDetail.detail).toContain("policy: writable, 2 rules, revision policy-1, digest sha256:abc");
    expect(remoteDetail.detail).toContain("session: state=connected");
    expect(remoteDetail.detail).toContain("WebDAV: down");
    expect(remoteDetail.detail).toContain("recent operations");
    const plainRemote = renderScreen(makeSnapshot({
      screen: "remotes",
      remotes: [
        makeRemoteSummary({
          name: "plain",
          endpoint: "http://127.0.0.1:3848/activefs/v1/",
          source: makeSourceStatus({
            endpoint: "http://127.0.0.1:3848/activefs/v1/",
            reachable: true
          })
        })
      ]
    }), 0);
    expect(plainRemote.detail).toContain("reachable: yes");
    expect(plainRemote.detail).toContain("auth: none");
    expect(plainRemote.detail).toContain("WebDAV: none");

    expect(renderScreen({ ...base, screen: "mounts" }, 0).detail).toBe("No configured mounts.");
    const layout = createMountLayout(rootDir, "docs");
    const mountSnapshot = makeSnapshot({
      screen: "mounts",
      mounts: [
        {
          name: "docs",
          status: {
            remote: "docs",
            state: "mounted",
            mounted: true,
            rootDir,
            configPath: layout.rcloneConfigPath,
            vfsDir: layout.vfsDir,
            logFile: layout.rcloneLogPath,
            rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
            webdav: {
              remote: "docs",
              state: "up",
              url: "http://127.0.0.1:3847/",
              updatedAt: "2026-06-25T00:00:00.000Z"
            },
            lastRefresh: {
              ok: false,
              path: "/docs",
              recursive: true,
              updatedAt: "2026-06-25T00:00:00.000Z"
            },
            error: "mount failed",
            updatedAt: "2026-06-25T00:00:00.000Z"
          }
        }
      ]
    });
    const mounted = renderScreen(mountSnapshot, 0);
    expect(mounted.items[0]).toContain("mounted mounted");
    expect(mounted.detail).toContain("rclone RC: 127.0.0.1:5572");
    expect(mounted.detail).toContain("error: mount failed");
    const waitingMount = renderScreen(makeSnapshot({
      screen: "mounts",
      mounts: [
        {
          name: "docs",
          status: {
            remote: "docs",
            state: "unmounted",
            mounted: false,
            rootDir,
            configPath: layout.rcloneConfigPath,
            vfsDir: layout.vfsDir,
            logFile: layout.rcloneLogPath,
            message: "not mounted",
            updatedAt: "2026-06-25T00:00:00.000Z"
          }
        }
      ]
    }), 0);
    expect(waitingMount.detail).toContain("not mounted");

    expect(renderScreen({ ...base, screen: "cache" }, 0).detail).toContain("No cache directories");
    const cacheSnapshot = makeSnapshot({
      screen: "cache",
      debug: true,
      cache: [{ remote: "docs", mode: "content", byteSize: 1536, fileCount: 2, debugPath: `${rootDir}/cache` }]
    });
    expect(renderScreen(cacheSnapshot, 0).detail).toContain("debug path");

    const browserSnapshot = makeSnapshot({
      screen: "browser",
      debug: true,
      browser: {
        path: "/docs",
        source: {
          id: "docs",
          label: "Docs",
          kind: "http",
          mountPath: "/docs",
          detail: "http://127.0.0.1:3847/activefs/v1/"
        },
        stat: { name: "docs", path: "/docs", kind: "directory" },
        entries: [
          { name: "folder", path: "/docs/folder", kind: "directory" },
          {
            name: "draft.md",
            path: "/docs/draft.md",
            kind: "file",
            enumerable: false,
            capabilities: { search: true }
          }
        ],
        selectedPath: "/docs/draft.md",
        preview: "FILE /docs/draft.md\nhello"
      }
    });
    const browser = renderScreen(browserSnapshot, 1);
    expect(browser.items).toEqual(expect.arrayContaining([
      expect.stringContaining("/ folder"),
      expect.stringContaining("draft.md")
    ]));
    expect(browser.items[1]).toContain("dyn idx");
    expect(browser.detail).toContain("source detail");
    expect(renderScreen({ ...browserSnapshot, browser: { ...browserSnapshot.browser, source: undefined } }, 5).detail)
      .toContain("selected: /docs");

    const searchSnapshot = makeSnapshot({
      screen: "search",
      search: {
        root: "/docs",
        pattern: "hello",
        strategy: "scan",
        complete: true,
        matches: [
          { path: "/docs/draft.md", line: 2, column: 4, excerpt: "hello world" }
        ]
      }
    });
    const search = renderScreen(searchSnapshot, 0);
    expect(search.items[0]).toContain("/docs/draft.md:2:4");
    expect(search.detail).toContain("hidden/non-enumerable: excluded");
    expect(search.detail).toContain("selected: /docs/draft.md");

    expect(renderScreen({ ...base, screen: "logs" }, 0).detail).toBe("No remotes configured.");
    const logs = renderScreen(makeSnapshot({
      screen: "logs",
      logs: [{ remote: "docs", webdav: "", rclone: "" }]
    }), 0);
    expect(logs.detail).toContain("(no WebDAV log entries)");
    expect(logs.detail).toContain("(no rclone log entries)");

    const settings = renderScreen(makeSnapshot({
      screen: "settings",
      settings: {
        rootDir,
        exportDir: `${rootDir}/exports`,
        sourceCount: 2,
        mountRemoteCount: 1,
        debug: true
      }
    }), 0);
    expect(settings.detail).toContain("debug: on");

    expect(activeFSTuiTestInternals.renderTabs("cache")).toContain("[Cache]");
    expect(activeFSTuiTestInternals.helpText()).toContain("ActiveFS TUI");
    expect(activeFSTuiTestInternals.helpText()).toContain("save redacted diagnostics snapshot");
    expect(activeFSTuiTestInternals.renderFooter(base)).toContain("tab screens");
    expect(activeFSTuiTestInternals.renderFooter(base)).toContain("/ search");
    expect(activeFSTuiTestInternals.expandBlessedKeys(["R", "q"])).toEqual(["R", "S-r", "q"]);
    expect(activeFSTuiTestInternals.normalizeBlessedKey(undefined, { name: "undefined" })).toBeUndefined();
    expect(activeFSTuiTestInternals.normalizeBlessedKey(undefined, { full: "C-c" })).toBe("C-c");
    expect(activeFSTuiTestInternals.normalizeBlessedKey("x", {})).toBe("x");
    expect(activeFSTuiTestInternals.normalizeBlessedKey(undefined, { name: "return", sequence: "\r" })).toBe("enter");
    expect(activeFSTuiTestInternals.normalizeBlessedKey(undefined, { name: "enter", sequence: "\n" })).toBe("linefeed");
    expect(activeFSTuiTestInternals.normalizeBlessedKey(undefined, {
      name: "a",
      ctrl: true,
      meta: true,
      shift: true
    })).toBe("C-M-S-a");
    expect(activeFSTuiTestInternals.currentItemCount(remoteSnapshot)).toBe(1);
    expect(activeFSTuiTestInternals.currentItemCount(mountSnapshot)).toBe(1);
    expect(activeFSTuiTestInternals.currentItemCount(cacheSnapshot)).toBe(1);
    expect(activeFSTuiTestInternals.currentItemCount(browserSnapshot)).toBe(2);
    expect(activeFSTuiTestInternals.currentItemCount(searchSnapshot)).toBe(1);
    expect(activeFSTuiTestInternals.currentItemCount({ ...base, screen: "logs", logs: [{ remote: "docs", webdav: "w", rclone: "r" }] })).toBe(1);
    expect(activeFSTuiTestInternals.currentItemCount({ ...base, screen: "settings" })).toBe(4);
    expect(activeFSTuiTestInternals.contentPreview(new Uint8Array(Buffer.from("hello")))).toBe("hello");
    expect(activeFSTuiTestInternals.contentPreview("x".repeat(17_000))).toContain("...");
    expect(activeFSTuiTestInternals.compareEntries(
      { name: "dir", path: "/dir", kind: "directory" },
      { name: "file", path: "/file", kind: "file" }
    )).toBeLessThan(0);
    expect(activeFSTuiTestInternals.compareEntries(
      { name: "b", path: "/b", kind: "file" },
      { name: "a", path: "/a", kind: "file" }
    )).toBeGreaterThan(0);
    expect(activeFSTuiTestInternals.pathToDirectoryName("/")).toBe("root");
    expect(activeFSTuiTestInternals.pathToDirectoryName("/a/b")).toBe("a__b");
    expect(activeFSTuiTestInternals.formatBytes(42)).toBe("42 B");
    expect(activeFSTuiTestInternals.formatBytes(1536)).toBe("1.5 KiB");
    expect(activeFSTuiTestInternals.formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
  });

  it("launches the blessed TUI against fake terminal streams, switches tabs, and quits", async () => {
    const tempDir = await makeTempDir();
    const terminal = createFakeTerminal();
    const runtime = createActiveFSTuiRuntime(["example"]);
    const running = runActiveFSTui({
      ...runtime,
      rootDir: join(tempDir, ".activefs"),
      input: terminal.input,
      output: terminal.output
    });

    await waitForTerminalText(terminal, "Health");
    await waitForTerminalText(terminal, "tab screens");
    expect(visibleTerminalText(terminal)).not.toContain(" Help ");
    terminal.input.write("\t\t\t\t");
    await waitForTerminalText(terminal, "[Browser]");
    terminal.input.write("q");
    await running;

    expect(terminal.text()).toContain("Browser");
  });

  it("drives remote add/test and browser export through fake terminal streams", async () => {
    const tempDir = await makeTempDir();
    const terminal = createFakeTerminal();
    const runtime = createActiveFSTuiRuntime(["example"]);
    const exportDir = join(tempDir, "exported");
    const running = runActiveFSTui({
      ...runtime,
      rootDir: join(tempDir, ".activefs"),
      exportDir,
      input: terminal.input,
      output: terminal.output,
      fetch: okFetch()
    });

    await waitForTerminalText(terminal, "Health");
    sendTerminalKey(terminal, "tab", "\t");
    await waitForTerminalText(terminal, "[Remotes]");
    sendTerminalKey(terminal, "a", "a");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    terminal.input.write("local=http://127.0.0.1:3847\r");
    await waitForTerminalText(terminal, "Added remote local");

    sendTerminalKey(terminal, "enter", "\r");
    await waitForTerminalText(terminal, "Source API reachable");

    sendTerminalKey(terminal, "tab", "\t");
    sendTerminalKey(terminal, "tab", "\t");
    sendTerminalKey(terminal, "tab", "\t");
    await waitForTerminalText(terminal, "[Browser]");
    for (let index = 0; index < 3; index += 1) {
      sendTerminalKey(terminal, "j", "j");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    sendTerminalKey(terminal, "enter", "\r");
    await waitForTerminalText(terminal, "Previewing /hello.md.");
    sendTerminalKey(terminal, "m", "m");
    await waitForTerminalText(terminal, "Exported", 3000);
    sendTerminalKey(terminal, "q", "q");
    await running;

    await expect(readFile(join(exportDir, "hello.md", "hello.md"), "utf8")).resolves.toContain("Hello ActiveFS");
  });

  it("shows remote, cache, and log state from public mount layouts", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      fetch: okFetch()
    });

    await controller.addRemote("local:/local=http://127.0.0.1:3999/activefs/v1");
    const layout = createMountLayout(rootDir, "local");
    await mkdir(join(layout.cacheDir, "content"), { recursive: true });
    await writeFile(join(layout.cacheDir, "content", "a.bin"), "cache");
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeFile(join(layout.runtimeDir, "webdav.log"), "{\"method\":\"GET\"}\n");
    await writeFile(layout.rcloneLogPath, "rclone log line\n");

    const snapshot = await controller.refresh();

    expect(snapshot.remotes[0]).toMatchObject({ name: "local", source: { reachable: true } });
    expect(snapshot.cache[0]?.fileCount).toBe(1);
    expect(snapshot.logs[0]?.webdav).toContain("GET");
    expect(snapshot.logs[0]?.rclone).toContain("rclone log line");

    await controller.clearCache("local");

    const afterClear = await controller.refresh();
    expect(afterClear.cache[0]?.fileCount).toBe(0);
  });

  it("invalidates a mounted path through rclone refresh", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = commandRunnerWithCalls({
      mount: { status: 0, stdout: `rclone on ${join(rootDir, "remotes", "local", "vfs")} type macfuse\n`, stderr: "" },
      rclone: { status: 0, stdout: "ok\n", stderr: "" }
    }, calls);
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      commandRunner: runner,
      platform: "darwin",
      fetch: okFetch()
    });

    await controller.addRemote("local:/local=http://127.0.0.1:3999/activefs/v1");
    const layout = createMountLayout(rootDir, "local");
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeFile(
      layout.mountStatusPath,
      `${JSON.stringify({
        remote: "local",
        state: "mounted",
        rootDir,
        vfsDir: layout.vfsDir,
        configPath: layout.rcloneConfigPath,
        logFile: layout.rcloneLogPath,
        mounted: true,
        rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`
    );
    await writeFile(
      layout.rcloneRcCredentialsPath,
      JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
    );

    await controller.invalidatePath("local", "/docs");

    expect(calls.some((call) => call.command === "rclone" && call.args.includes("vfs/refresh"))).toBe(true);
    expect(calls.some((call) => call.args.includes("dir=docs"))).toBe(true);
  });

  it("starts, remounts, and reports failed mounts through injected mount hooks", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[]; child: FakeMountChild }> = [];
    const layout = createMountLayout(rootDir, "local");
    const runner = commandRunnerWithCalls({
      mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" },
      rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
      umount: { status: 0, stdout: "", stderr: "" }
    }, calls);
    const processSpawner: RcloneMountProcessSpawner = (command, args) => {
      const child = new FakeMountChild(4000 + spawned.length);
      spawned.push({ command, args, child });
      return child;
    };
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      commandRunner: runner,
      mountProcessSpawner: processSpawner,
      waitForMountActive: async () => true,
      enableRcloneRc: false,
      platform: "darwin",
      fetch: okFetch()
    });

    await controller.addRemote("local:/local=http://127.0.0.1:3999/activefs/v1");
    const mounted = await controller.mount("local");
    expect(mounted.state).toBe("mounted");
    expect(spawned[0]).toMatchObject({ command: "rclone" });
    expect(spawned[0]?.args).toContain("mount");

    calls.length = 0;
    const remounted = await controller.remount("local");
    expect(remounted.state).toBe("mounted");
    expect(calls.some((call) => call.command === "umount" && call.args[0] === layout.vfsDir)).toBe(true);
    expect(spawned).toHaveLength(2);

    const failingController = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      commandRunner: runner,
      mountProcessSpawner: processSpawner,
      waitForMountActive: async () => false,
      enableRcloneRc: false,
      platform: "darwin",
      fetch: okFetch()
    });
    const failed = await failingController.mount("local");
    expect(failed.state).toBe("failed");
    expect(spawned[2]?.child.killed).toBe(true);
  });

  it("reports WebDAV-down mount state in TUI snapshots", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const layout = createMountLayout(rootDir, "local");
    const controller = createActiveFSTuiController({
      filesystem: createExampleActiveFS(),
      rootDir,
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" }
      }),
      fetch: async () => {
        throw new Error("connection refused");
      }
    });
    await controller.addRemote("local:/local=http://127.0.0.1:3999/activefs/v1");
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeFile(
      layout.mountStatusPath,
      `${JSON.stringify({
        remote: "local",
        state: "mounted",
        rootDir,
        vfsDir: layout.vfsDir,
        configPath: layout.rcloneConfigPath,
        logFile: layout.rcloneLogPath,
        mounted: true,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`
    );

    const snapshot = await controller.refresh();

    expect(snapshot.mounts[0]?.status.state).toBe("webdav-down");
    expect(snapshot.mounts[0]?.status.webdav?.error).toContain("connection refused");
  });
});

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "activefs-tui-"));
  tempDirs.push(path);
  return path;
}

async function removeTempDir(path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientRemoveError(error)) {
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

function isTransientRemoveError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["EBUSY", "ENOTEMPTY", "EPERM"].includes(String((error as { code?: unknown }).code))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function okFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = String(input instanceof Request ? input.url : input);
    const capabilities = sourceCapabilities();
    if (requestUrl.includes("/operations/")) {
      return jsonResponse({
        operationId: decodeURIComponent(requestUrl.split("/operations/")[1]?.replace(/\/$/, "") ?? "op"),
        status: "running",
        operation: "write",
        path: "/secret.md",
        startedAt: "2026-06-25T00:00:00.000Z"
      });
    }
    if (requestUrl.endsWith("/capabilities") || requestUrl.endsWith("/capabilities/")) {
      return jsonResponse(capabilities);
    }
    if ((init?.method ?? "GET") === "GET") {
      const origin = new URL(requestUrl).origin;
      return jsonResponse({
        protocol: "activefs-source",
        protocolVersion: 1,
        endpoints: {
          stat: `${origin}/ops/stat`,
          list: `${origin}/ops/list`,
          read: `${origin}/ops/read`,
          search: `${origin}/ops/search`,
          command: `${origin}/ops/command`,
          write: `${origin}/ops/write`,
          delete: `${origin}/ops/delete`,
          mkdir: `${origin}/ops/mkdir`,
          rmdir: `${origin}/ops/rmdir`,
          rename: `${origin}/ops/rename`,
          copy: `${origin}/ops/copy`,
          truncate: `${origin}/ops/truncate`,
          metadata: `${origin}/ops/metadata`,
          sessions: `${origin}/ops/sessions`,
          changes: `${origin}/ops/changes`,
          capabilities: `${origin}/capabilities`
        },
        capabilities
      });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function sourceCapabilities() {
  return {
    protocolVersion: 1 as const,
    statable: true,
    listable: true,
    readable: true,
    writable: true,
    mutable: {
      create: true,
      write: true,
      truncate: true,
      delete: true,
      mkdir: true,
      rmdir: true,
      rename: true,
      copy: true,
      updateMetadata: true
    },
    searchable: true,
    commands: ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"] as ActiveFSTreeCommand[],
    watchable: true,
    rangeReadable: true,
    activefs: {
      stat: true,
      list: true,
      read: true,
      search: true,
      create: true,
      write: true,
      truncate: true,
      delete: true,
      mkdir: true,
      rmdir: true,
      rename: true,
      copy: true,
      updateMetadata: true,
      watch: true,
      readable: true,
      writable: true,
      searchable: true,
      watchable: true,
      rangeReadable: true,
      commands: ["ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"] as ActiveFSTreeCommand[]
    }
  };
}

function commandRunnerWithCalls(
  results: Record<string, { status: number; stdout: string; stderr: string }>,
  calls: Array<{ command: string; args: string[] }> = []
): MountCommandRunner {
  return (command, args) => {
    calls.push({ command, args });
    const result = results[command] ?? { status: 127, stdout: "", stderr: "not found" };
    return { ...result };
  };
}

interface FakeTerminal {
  input: PassThrough & {
    isTTY: boolean;
    setRawMode(value: boolean): PassThrough;
    setEncoding(encoding: BufferEncoding): PassThrough;
  };
  output: Writable & {
    isTTY: boolean;
    columns: number;
    rows: number;
  };
  text(): string;
}

function createFakeTerminal(): FakeTerminal {
  const input = new PassThrough() as FakeTerminal["input"];
  input.isTTY = true;
  input.setRawMode = () => input;
  input.setEncoding = () => input;
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    }
  }) as FakeTerminal["output"];
  output.isTTY = true;
  output.columns = 120;
  output.rows = 40;
  return {
    input,
    output,
    text: () => chunks.join("")
  };
}

function sendTerminalKey(terminal: FakeTerminal, name: string, sequence: string): void {
  terminal.input.emit("keypress", sequence, {
    name,
    sequence,
    full: sequence,
    ctrl: false,
    meta: false,
    shift: name.length === 1 && name.toUpperCase() === name && name.toLowerCase() !== name
  });
}

async function waitForTerminalText(
  terminal: FakeTerminal,
  text: string,
  timeoutMs = 3000
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (terminal.text().includes(text) || visibleTerminalText(terminal).includes(text)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  if (terminal.text().includes(text) || visibleTerminalText(terminal).includes(text)) {
    return;
  }
  throw new Error(`Timed out waiting for terminal text: ${text}\n${visibleTerminalText(terminal).slice(-2000)}`);
}

function visibleTerminalText(terminal: FakeTerminal): string {
  return terminal.text()
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")
    .replace(/\x1b[78]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ");
}

class FakeMountChild implements RcloneMountChild {
  readonly pid: number;
  killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  once(): unknown {
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {
    return undefined;
  }
}

function makeSnapshot(overrides: Partial<TuiSnapshot> = {}): TuiSnapshot {
  const rootDir = overrides.rootDir ?? "/tmp/activefs-tui";
  const exportDir = overrides.exportDir ?? `${rootDir}/exports`;
  const snapshot: TuiSnapshot = {
    screen: "health",
    rootDir,
    exportDir,
    sources: [
      {
        id: "example",
        label: "Example",
        kind: "example",
        mountPath: "/",
        detail: "Built-in fake example tree."
      }
    ],
    health: {
      rootDir,
      generatedAt: "2026-06-25T00:00:00.000Z",
      remotes: []
    },
    remotes: [],
    mounts: [],
    cache: [],
    browser: {
      path: "/",
      stat: { name: "", path: "/", kind: "directory" },
      entries: [],
      selectedPath: "/",
      preview: "DIRECTORY /"
    },
    search: {
      root: "/",
      pattern: "",
      strategy: "idle",
      complete: true,
      matches: []
    },
    logs: [],
    settings: {
      rootDir,
      exportDir,
      sourceCount: 1,
      mountRemoteCount: 0,
      debug: false
    },
    status: "Ready.",
    debug: false,
    ...overrides
  };
  if (!overrides.health) {
    snapshot.health = {
      rootDir: snapshot.rootDir,
      generatedAt: "2026-06-25T00:00:00.000Z",
      remotes: snapshot.remotes
    };
  }
  return snapshot;
}

function makeRemoteSummary(overrides: Partial<TuiSnapshot["remotes"][number]> = {}): TuiSnapshot["remotes"][number] {
  const endpoint = overrides.endpoint ?? "http://127.0.0.1:3847/activefs/v1/";
  return {
    name: "docs",
    endpoint,
    source: makeSourceStatus({ endpoint }),
    auth: { type: "none" },
    policy: {
      defaultAccess: "readonly",
      ruleCount: 0
    },
    cache: {
      mode: "off"
    },
    session: {
      state: "none"
    },
    operations: {
      unresolvedCount: 0,
      ids: [],
      recent: []
    },
    activity: {
      policy: "best-effort",
      backlogCount: 0,
      files: []
    },
    ...overrides
  };
}

function makeSourceStatus(
  overrides: Partial<TuiSnapshot["remotes"][number]["source"]> = {}
): TuiSnapshot["remotes"][number]["source"] {
  return {
    kind: "source-api",
    endpoint: "http://127.0.0.1:3847/activefs/v1/",
    reachable: true,
    checkedAt: "2026-06-25T00:00:00.000Z",
    protocol: "activefs-source",
    protocolVersion: 1,
    capabilities: sourceCapabilities(),
    ...overrides
  };
}
