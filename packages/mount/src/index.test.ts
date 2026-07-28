import { createActiveFS, file, fsTree, type ActiveFSTree, type ActiveFSTreeReadResult } from "@activefs/core";
import { upsertActiveFSRemote } from "@activefs/config";
import { createMemoryTree } from "@activefs/testing";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeFSMountCachePathKey,
  checkWebDAVEndpoint,
  checkWebDAVRuntimeStatus,
  clearMountCache,
  cleanupMountRuntime,
  collectRcloneMountEvidence,
  createMountLayout,
  createRcloneMountCommand,
  createTemporaryRcloneWebDAVConfig,
  detectRcloneBinary,
  formatRcloneMountHostReport,
  inspectRcloneMountHost,
  loadActiveFSMountConfig,
  mountRcloneWebDAV,
  mountVerificationGuidance,
  readMountCacheSnapshot,
  readRcloneMountStatus,
  readWebDAVRuntimeStatus,
  refreshRcloneMount,
  removeActiveFSMountRemote,
  saveActiveFSMountConfig,
  startWebDAVServer,
  stopMountFreshnessRuntime,
  stopManagedWebDAVRuntime,
  tailMountLogs,
  unmountRcloneMount,
  writeWebDAVRuntimeStatus,
  writeMountFreshnessStatus,
  type MountCommandRunner,
  type RcloneMountStatus,
  type WebDAVServerHandle
} from "./index";
import {
  createActiveFSMountWorkspace,
  parseActiveFSRemoteSpec
} from "./testSupport";

const handles: WebDAVServerHandle[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    await handles.pop()!.close();
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ActiveFS WebDAV adapter", () => {
  it("lists directory entries through PROPFIND", async () => {
    const server = await startWebDAVServer({
      filesystem: createExampleFS(),
      auth: false
    });
    handles.push(server);

    const response = await fetch(server.url, {
      method: "PROPFIND",
      headers: { Depth: "1" }
    });
    const body = await response.text();

    expect(response.status).toBe(207);
    expect(response.headers.get("dav")).toBe("1");
    expect(body).toContain("<D:href>/</D:href>");
    expect(body).toContain("<D:href>/docs/</D:href>");
    expect(body).toContain("<D:href>/hello.md</D:href>");
  });

  it("reads file bytes through GET and metadata through HEAD", async () => {
    const server = await startWebDAVServer({
      filesystem: createExampleFS(),
      auth: false
    });
    handles.push(server);

    const read = await fetch(new URL("/hello.md", server.url));
    const head = await fetch(new URL("/hello.md", server.url), { method: "HEAD" });

    expect(read.status).toBe(200);
    expect(await read.text()).toBe("# Hello\n\nMounted read works.\n");
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("# Hello\n\nMounted read works.\n".length));
  });

  it("reports WebDAV read-cache hits with verified content digests", async () => {
    const activities: string[] = [];
    const server = await startWebDAVServer({
      filesystem: createExampleFS(),
      auth: false,
      readCache: {
        onActivity: (activity) => {
          activities.push(`${activity.operation}:${activity.path}:${activity.source}:${activity.contentHash.length}`);
        }
      }
    });
    handles.push(server);

    const first = await fetch(new URL("/hello.md", server.url));
    const second = await fetch(new URL("/hello.md", server.url));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("# Hello\n\nMounted read works.\n");
    expect(activities).toEqual(["read:/hello.md:cache:64"]);
  });

  it("serves single byte ranges for rclone VFS reads", async () => {
    const server = await startWebDAVServer({
      filesystem: createActiveFS().mount("/", createMemoryTree({ "/bytes.txt": "0123456789" })),
      auth: false
    });
    handles.push(server);

    const partial = await fetch(new URL("/bytes.txt", server.url), {
      headers: { Range: "bytes=2-5" }
    });
    const suffix = await fetch(new URL("/bytes.txt", server.url), {
      headers: { Range: "bytes=-3" }
    });
    const unsatisfiable = await fetch(new URL("/bytes.txt", server.url), {
      headers: { Range: "bytes=99-100" }
    });

    expect(partial.status).toBe(206);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(await partial.text()).toBe("2345");
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 7-9/10");
    expect(await suffix.text()).toBe("789");
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get("content-range")).toBe("bytes */10");
  });

  it("denies write-oriented WebDAV methods when policy is absent", async () => {
    const server = await startWebDAVServer({
      filesystem: createExampleFS(),
      auth: false
    });
    handles.push(server);

    const response = await fetch(new URL("/hello.md", server.url), {
      method: "PUT",
      body: "changed"
    });

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("readonly");
  });

  it("reports OPTIONS and unsupported WebDAV methods explicitly", async () => {
    const server = await startWebDAVServer({
      filesystem: createExampleFS(),
      auth: false
    });
    handles.push(server);

    const options = await fetch(server.url, { method: "OPTIONS" });
    const lock = await fetch(new URL("/hello.md", server.url), { method: "LOCK" });
    const search = await fetch(new URL("/hello.md", server.url), { method: "SEARCH" });

    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toContain("PROPFIND");
    expect(lock.status).toBe(501);
    expect(await lock.text()).toContain("LOCK is not implemented");
    expect(search.status).toBe(501);
    expect(await search.text()).toContain("Unsupported method: SEARCH");
  });

  it("maps WebDAV writes to canonical ActiveFS operations when policy allows them", async () => {
    const filesystem = createActiveFS().mount("/", createMemoryTree({
      files: { "/hello.md": "hello", "/docs/existing.txt": "exists" },
      writable: true
    }));
    const server = await startWebDAVServer({
      filesystem,
      auth: false,
      policy: {
        schemaVersion: 1,
        defaultAccess: "writable",
        rules: []
      }
    });
    handles.push(server);

    const put = await fetch(new URL("/docs/note.txt", server.url), {
      method: "PUT",
      body: "note"
    });
    const mkcol = await fetch(new URL("/empty", server.url), { method: "MKCOL" });
    const copy = await fetch(new URL("/docs/note.txt", server.url), {
      method: "COPY",
      headers: { Destination: new URL("/docs/copied.txt", server.url).href }
    });
    const move = await fetch(new URL("/docs/copied.txt", server.url), {
      method: "MOVE",
      headers: { Destination: new URL("/docs/moved.txt", server.url).href }
    });
    const deleted = await fetch(new URL("/docs/note.txt", server.url), { method: "DELETE" });
    const readMoved = await fetch(new URL("/docs/moved.txt", server.url));

    expect(put.status).toBe(201);
    expect(mkcol.status).toBe(201);
    expect(copy.status).toBe(201);
    expect(move.status).toBe(201);
    expect(deleted.status).toBe(204);
    expect(await readMoved.text()).toBe("note");
  });

  it("maps zero-byte PUT on existing files to truncate when write is not locally allowed", async () => {
    const tree = createMemoryTree({
      files: { "/docs/existing.txt": "existing bytes" },
      writable: true
    });
    const filesystem = createActiveFS().mount("/", tree);
    const server = await startWebDAVServer({
      filesystem,
      auth: false,
      policy: {
        schemaVersion: 1,
        defaultAccess: "readonly",
        rules: [{
          match: { type: "prefix", path: "/docs" },
          allow: ["stat", "list", "read", "truncate"]
        }]
      }
    });
    handles.push(server);

    const truncate = await fetch(new URL("/docs/existing.txt", server.url), {
      method: "PUT",
      body: ""
    });
    const read = await tree.read({}, "/docs/existing.txt", { encoding: "utf8" });

    expect(truncate.status).toBe(204);
    expect(treeReadContent(read)).toBe("");
  });

  it("generates loopback credentials unless auth is explicitly disabled", async () => {
    const server = await startWebDAVServer({
      filesystem: createExampleFS()
    });
    handles.push(server);

    const unauthenticated = await fetch(new URL("/hello.md", server.url));
    const authenticated = await fetch(new URL("/hello.md", server.url), {
      headers: { Authorization: basicAuth(server.auth) }
    });

    expect(server.auth).not.toBe(false);
    expect(unauthenticated.status).toBe(401);
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toContain("Mounted read works");
  });

  it("uses metadata ETags, omits unknown sizes, and caches read bytes", async () => {
    let reads = 0;
    const server = await startWebDAVServer({
      filesystem: createActiveFS().mount("/", createUnknownSizeTree(() => {
        reads += 1;
        return "cached read bytes";
      })),
      auth: false
    });
    handles.push(server);

    const propfind = await fetch(server.url, {
      method: "PROPFIND",
      headers: { Depth: "1" }
    });
    const propfindBody = await propfind.text();
    const head = await fetch(new URL("/unknown.txt", server.url), { method: "HEAD" });
    const firstRead = await fetch(new URL("/unknown.txt", server.url));
    const secondRead = await fetch(new URL("/unknown.txt", server.url));

    expect(propfindBody).toContain("<D:getetag>&quot;sha256:test-content&quot;</D:getetag>");
    expect(propfindBody).not.toContain("<D:getcontentlength>");
    expect(head.headers.get("etag")).toBe("\"sha256:test-content\"");
    expect(head.headers.get("content-length")).toBeNull();
    expect(await firstRead.text()).toBe("cached read bytes");
    expect(await secondRead.text()).toBe("cached read bytes");
    expect(reads).toBe(1);
  });
});

describe("rclone mount manager", () => {
  it("projects current ActiveFS remotes into internal managed WebDAV mount targets", async () => {
    const rootDir = await makeTempDir();
    const mountpoint = join(rootDir, "mounted");

    await upsertActiveFSRemote(rootDir, {
      name: "docs",
      url: "https://source.example/activefs/v1",
      mountPath: "/docs",
      mountpoint,
      managedWebDAV: { enabled: true, host: "::1", port: 49123 }
    });

    const config = await loadActiveFSMountConfig(rootDir);

    expect(config.remotes.docs).toMatchObject({
      name: "docs",
      url: "http://[::1]:49123/",
      sourceUrl: "https://source.example/activefs/v1",
      mountpoint,
      managedWebDAV: { enabled: true, host: "::1", port: 49123 },
      adapterCapabilityProfile: "full-filesystem-semantics",
      cacheMode: "off",
      activityPolicy: "best-effort"
    });
  });

  it("creates the mount layout, config, status, and rclone command", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://127.0.0.1:3847");
    const { layouts } = await createActiveFSMountWorkspace(rootDir, [remote]);
    const layout = layouts[0]!;

    expect((await stat(join(rootDir, ".activefs", "remotes", "local", "vfs"))).isDirectory()).toBe(true);
    expect((await stat(join(rootDir, ".activefs", "remotes", "local", "cache", "rclone"))).isDirectory()).toBe(true);
    expect(await readFile(join(rootDir, ".activefs", "config.json"), "utf8")).toContain("\"local\"");
    expect(await readFile(layout.rcloneConfigPath, "utf8")).toContain("type = webdav");

    const status = await readRcloneMountStatus(layout, {
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      })
    });
    expect(status.state).toBe("configured");

    const command = createRcloneMountCommand({
      remote,
      layout: createMountLayout(rootDir, "local"),
      rcloneBinary: "/usr/local/bin/rclone"
    });
    expect(command.command).toBe("/usr/local/bin/rclone");
    expect(command.args).not.toContain("--read-only");
    expect(command.args).toContain(layout.vfsDir);
    expect(command.args).toContain(layout.rcloneCacheDir);
    expect(command.args.slice(
      command.args.indexOf("--vfs-cache-mode"),
      command.args.indexOf("--vfs-cache-mode") + 2
    )).toEqual(["--vfs-cache-mode", "off"]);

    const readOnlyCommand = createRcloneMountCommand({
      remote,
      layout,
      rcloneBinary: "/usr/local/bin/rclone",
      readOnly: true
    });
    expect(readOnlyCommand.args).toContain("--read-only");

    const cachelessCommand = createRcloneMountCommand({
      remote,
      layout,
      vfsCacheMode: "off"
    });
    expect(cachelessCommand.args.slice(
      cachelessCommand.args.indexOf("--vfs-cache-mode"),
      cachelessCommand.args.indexOf("--vfs-cache-mode") + 2
    )).toEqual(["--vfs-cache-mode", "off"]);

    const cachedCommand = createRcloneMountCommand({
      remote,
      layout,
      vfsCacheMode: "full"
    });
    expect(cachedCommand.args.slice(
      cachedCommand.args.indexOf("--vfs-cache-mode"),
      cachedCommand.args.indexOf("--vfs-cache-mode") + 2
    )).toEqual(["--vfs-cache-mode", "full"]);

    const darwinCommand = createRcloneMountCommand({
      remote,
      layout: createMountLayout(rootDir, "local", { mountpoint: join(rootDir, "mounted-docs") }),
      platform: "darwin"
    });
    expect(darwinCommand.args).toContain("--volname");
    expect(darwinCommand.args).toContain("mounted-docs");

    const darwinRootCommand = createRcloneMountCommand({
      remote,
      layout,
      platform: "darwin",
      currentUid: 0,
      currentGid: 0
    });
    expect(darwinRootCommand.args).toContain("--allow-root");
    expect(darwinRootCommand.args.slice(
      darwinRootCommand.args.indexOf("--uid"),
      darwinRootCommand.args.indexOf("--uid") + 2
    )).toEqual(["--uid", "0"]);
    expect(darwinRootCommand.args.slice(
      darwinRootCommand.args.indexOf("--gid"),
      darwinRootCommand.args.indexOf("--gid") + 2
    )).toEqual(["--gid", "0"]);

    const darwinUserCommand = createRcloneMountCommand({
      remote,
      layout,
      platform: "darwin",
      currentUid: 501,
      currentGid: 20
    });
    expect(darwinUserCommand.args).not.toContain("--allow-root");
    expect(darwinUserCommand.args).not.toContain("--uid");
    expect(darwinUserCommand.args).not.toContain("--gid");
  });

  it("exposes cache stats, cache clearing, log tail, and remote removal APIs", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://127.0.0.1:3847");
    const { layouts } = await createActiveFSMountWorkspace(rootDir, [remote]);
    const layout = layouts[0]!;
    await writeFile(join(layout.cacheDir, "content", "content.bin"), "content");
    await writeFile(join(layout.rcloneCacheDir, "rclone.bin"), "rclone");
    await writeFile(join(layout.runtimeDir, "webdav.log"), "webdav 1\nwebdav 2\n");
    await writeFile(layout.rcloneLogPath, "rclone 1\nrclone 2\n");

    const snapshot = await readMountCacheSnapshot(layout);
    expect(snapshot.remote).toBe("local");
    expect(snapshot.fileCount).toBe(2);
    expect(snapshot.byteSize).toBe("content".length + "rclone".length);
    expect(snapshot.sections.content.fileCount).toBe(1);
    expect(snapshot.sections.rclone.fileCount).toBe(1);

    const logs = await tailMountLogs(layout, { maxLines: 1 });
    expect(logs).toMatchObject({
      remote: "local",
      webdav: "webdav 2",
      rclone: "rclone 2"
    });

    const clear = await clearMountCache(layout);
    expect(clear).toMatchObject({
      remote: "local",
      clearedFiles: 2,
      clearedBytes: "content".length + "rclone".length
    });
    await expect(readMountCacheSnapshot(layout)).resolves.toMatchObject({ fileCount: 0, byteSize: 0 });

    const removed = await removeActiveFSMountRemote(rootDir, "local");
    expect(removed.removed).toBe(true);
    expect(removed.config.remotes.local).toBeUndefined();
    await expect(readFile(join(rootDir, ".activefs", "config.json"), "utf8")).resolves.not.toContain("\"local\"");
  });

  it("validates remote specs, clears path-scoped cache keys, and can clean runtime on removal", async () => {
    const rootDir = await makeTempDir();

    expect(() => parseActiveFSRemoteSpec("bad-spec")).toThrow("name=url");
    expect(() => parseActiveFSRemoteSpec("bad=ftp://example.test")).toThrow("http:// or https://");
    expect(() => createMountLayout(rootDir, "bad/name")).toThrow("Invalid ActiveFS remote name");
    await expect(createActiveFSMountWorkspace(rootDir, [])).rejects.toThrow("At least one");

    const { layouts } = await createActiveFSMountWorkspace(rootDir, [
      parseActiveFSRemoteSpec("local=http://127.0.0.1:3847")
    ]);
    const layout = layouts[0]!;
    const key = activeFSMountCachePathKey("/docs/a.txt");
    const other = activeFSMountCachePathKey("/docs/b.txt");
    await mkdir(join(layout.cacheDir, "meta", key), { recursive: true });
    await mkdir(join(layout.cacheDir, "meta", other), { recursive: true });
    await writeFile(join(layout.cacheDir, "meta", key, "entry.json"), "a");
    await writeFile(join(layout.cacheDir, "meta", other, "entry.json"), "b");

    const cleared = await clearMountCache(layout, { path: "/docs/a.txt" });
    expect(cleared).toMatchObject({ remote: "local", path: "/docs/a.txt", clearedFiles: 1 });
    await expect(readFile(join(layout.cacheDir, "meta", key, "entry.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(join(layout.cacheDir, "meta", other, "entry.json"), "utf8")).resolves.toBe("b");

    const removed = await removeActiveFSMountRemote(rootDir, "local", {
      cleanupRuntime: true,
      checkWebDAV: false,
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      })
    });
    expect(removed.cleanup?.actions.map((action) => action.kind)).toContain("noop");
  });

  it("redacts WebDAV passwords from config.json and stores runtime credentials privately", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://alice:secret@127.0.0.1:3847");
    const { layouts } = await createActiveFSMountWorkspace(rootDir, [remote], {
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      })
    });
    const configText = await readFile(join(rootDir, ".activefs", "config.json"), "utf8");
    const credentialsText = await readFile(layouts[0]!.webdavCredentialsPath, "utf8");
    const rcloneConfig = await readFile(layouts[0]!.rcloneConfigPath, "utf8");

    expect(configText).toContain("\"hasCredentials\": true");
    expect(configText).not.toContain("secret");
    expect(credentialsText).toContain("secret");
    expect(rcloneConfig).toContain("user = alice");
    expect(rcloneConfig).toContain("pass = rclone v1.70.0");
    expect(rcloneConfig).not.toContain("secret");
  });

  it("saves redacted mount config and cleans temporary rclone config workspaces", async () => {
    const rootDir = await makeTempDir();
    await saveActiveFSMountConfig(rootDir, {
      version: 1,
      remotes: {
        local: {
          name: "local",
          url: "http://127.0.0.1:3847/",
          username: "alice",
          password: "secret",
          mountpoint: join(rootDir, "mounted")
        }
      }
    });

    const configText = await readFile(join(rootDir, ".activefs", "config.json"), "utf8");
    const loaded = await loadActiveFSMountConfig(rootDir);
    expect(configText).toContain("\"hasCredentials\": true");
    expect(configText).not.toContain("secret");
    expect(loaded.remotes.local).toMatchObject({
      username: "alice",
      hasCredentials: true
    });
    expect(loaded.remotes.local.password).toBeUndefined();

    const temporary = await createTemporaryRcloneWebDAVConfig(
      parseActiveFSRemoteSpec("temp=http://127.0.0.1:3847"),
      {
        commandRunner: commandRunner({
          rclone: { status: 0, stdout: "obscured\n", stderr: "" }
        })
      }
    );
    await expect(readFile(temporary.configPath, "utf8")).resolves.toContain("[temp]");
    await temporary.cleanup();
    await expect(readFile(temporary.configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives rclone-down instead of trusting stale mounted status", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await writeStatus(layout, { state: "mounted", mounted: true });

    const status = await readRcloneMountStatus(layout, {
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      fetch: okFetch()
    });

    expect(status.state).toBe("rclone-down");
    expect(status.mounted).toBe(false);
    expect(status.webdav?.state).toBe("up");
  });

  it("recognizes macOS /private/tmp mount aliases for configured /tmp mountpoints", async () => {
    const rootDir = await mkdtemp(join("/tmp", "activefs-mount-alias-"));
    tempDirs.push(rootDir);
    const layout = createMountLayout(rootDir, "local", { mountpoint: join(rootDir, "mounted") });
    const osReportedMountpoint = layout.vfsDir.replace(/^\/tmp(?=\/|$)/, "/private/tmp");
    await writeStatus(layout, { state: "mounted", mounted: true });

    const status = await readRcloneMountStatus(layout, {
      platform: "darwin",
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      commandRunner: commandRunner({
        mount: { status: 0, stdout: `fuse-t:/mounted on ${osReportedMountpoint} (nfs)\n`, stderr: "" }
      }),
      fetch: okFetch()
    });

    expect(status.state).toBe("mounted");
    expect(status.mounted).toBe(true);
  });

  it("tries macOS /private/tmp mount aliases when unmounting configured /tmp mountpoints", async () => {
    const rootDir = await mkdtemp(join("/tmp", "activefs-unmount-alias-"));
    tempDirs.push(rootDir);
    const layout = createMountLayout(rootDir, "local", { mountpoint: join(rootDir, "mounted") });
    const osReportedMountpoint = layout.vfsDir.replace(/^\/tmp(?=\/|$)/, "/private/tmp");
    const calls: Array<{ command: string; args: string[] }> = [];

    const status = await unmountRcloneMount(layout, {
      platform: "darwin",
      status: {
        remote: "local",
        state: "mounted",
        rootDir: layout.rootDir,
        vfsDir: layout.vfsDir,
        configPath: layout.rcloneConfigPath,
        logFile: layout.rcloneLogPath,
        mounted: true,
        updatedAt: new Date().toISOString()
      },
      commandRunner: (command, args) => {
        calls.push({ command, args });
        return command === "umount" && args[0] === osReportedMountpoint
          ? { status: 0, stdout: "", stderr: "" }
          : { status: 1, stdout: "", stderr: "not mounted there" };
      }
    });

    expect(calls).toEqual([
      { command: "umount", args: [layout.vfsDir] },
      { command: "diskutil", args: ["unmount", layout.vfsDir] },
      { command: "umount", args: [osReportedMountpoint] }
    ]);
    expect(status.state).toBe("unmounted");
    expect(status.mounted).toBe(false);
  });

  it("reports webdav-down when the configured WebDAV endpoint is unreachable", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await writeStatus(layout, { state: "mounted", mounted: true });

    const status = await readRcloneMountStatus(layout, {
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      fetch: async () => {
        throw new Error("connection refused");
      }
    });

    expect(status.state).toBe("webdav-down");
    expect(status.webdav?.reachable).toBe(false);
    expect(status.webdav?.error).toContain("connection refused");
  });

  it("checks the runtime WebDAV URL for dynamically managed ports", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    const runtimeUrl = "http://127.0.0.1:49152/";
    const fetched: string[] = [];
    await writeWebDAVRuntimeStatus(layout, {
      remote: "local",
      state: "up",
      url: runtimeUrl,
      reachable: true
    });
    await writeStatus(layout, { state: "mounted", mounted: true });

    const status = await readRcloneMountStatus(layout, {
      remote: {
        ...parseActiveFSRemoteSpec("local=http://127.0.0.1:0/"),
        managedWebDAV: { enabled: true, host: "127.0.0.1", port: 0 }
      },
      commandRunner: commandRunner({
        mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" }
      }),
      fetch: (async (input) => {
        fetched.push(String(input));
        return {
          status: 204,
          ok: true,
          headers: new Headers()
        } as Response;
      }) as typeof fetch
    });

    expect(fetched).toEqual([runtimeUrl]);
    expect(status.state).toBe("mounted");
    expect(status.webdav?.state).toBe("up");
    expect(status.webdav?.url).toBe(runtimeUrl);
  });

  it("adds loopback rclone RC args without exposing them in status", () => {
    const rootDir = "/tmp/activefs-test";
    const layout = createMountLayout(rootDir, "local");
    const command = createRcloneMountCommand({
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      layout,
      rc: {
        addr: "127.0.0.1:5572",
        username: "activefs-rc",
        password: "secret-rc"
      }
    });

    expect(command.args).toContain("--rc");
    expect(command.args).toContain("--rc-addr");
    expect(command.args).toContain("127.0.0.1:5572");
    expect(command.args).toContain("--rc-user");
    expect(command.args).toContain("activefs-rc");
    expect(command.args).toContain("--rc-pass");
    expect(command.args).toContain("secret-rc");
  });

  it("refreshes mounted paths through rclone RC and marks failures stale", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await writeStatus(layout, {
      state: "mounted",
      mounted: true,
      rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true }
    });
    await writeFile(
      layout.rcloneRcCredentialsPath,
      JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    const success = await refreshRcloneMount(layout, {
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      path: "/docs",
      recursive: true,
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" },
        rclone: { status: 0, stdout: "ok\n", stderr: "" }
      }, calls),
      fetch: okFetch()
    });

    expect(success.ok).toBe(true);
    expect(calls.some((call) => call.args.includes("vfs/refresh"))).toBe(true);
    expect(calls.some((call) => call.args.includes("dir=docs"))).toBe(true);
    expect(calls.some((call) => call.args.includes("recursive=true"))).toBe(true);

    const failure = await refreshRcloneMount(layout, {
      remote: parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      path: "/docs",
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" },
        rclone: { status: 1, stdout: "", stderr: "refresh failed" }
      }),
      fetch: okFetch()
    });

    expect(failure.ok).toBe(false);
    expect(failure.status.state).toBe("stale");
    expect(failure.status.staleReason).toContain("refresh failed");
  });

  it("uses platform-specific unmount commands without requiring RC on Windows", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    const calls: Array<{ command: string; args: string[] }> = [];
    const baseStatus: RcloneMountStatus = {
      remote: "local",
      state: "mounted",
      rootDir: layout.rootDir,
      vfsDir: layout.vfsDir,
      configPath: layout.rcloneConfigPath,
      logFile: layout.rcloneLogPath,
      pid: 1234,
      mounted: true,
      updatedAt: new Date().toISOString()
    };

    const status = await unmountRcloneMount(layout, {
      platform: "win32",
      status: baseStatus,
      commandRunner: commandRunnerWithCalls({
        taskkill: { status: 0, stdout: "", stderr: "" }
      }, calls)
    });

    expect(status.state).toBe("unmounted");
    expect(calls[0]).toEqual({
      command: "taskkill",
      args: ["/PID", "1234", "/T", "/F"]
    });
  });

  it("detects rclone through the configured command runner", () => {
    expect(detectRcloneBinary({
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      })
    })).toBe("rclone");

    expect(detectRcloneBinary({
      rcloneBinary: "/opt/rclone",
      commandRunner: commandRunner({
        "/opt/rclone": { status: 127, stdout: "", stderr: "missing" }
      })
    })).toBeNull();
  });

  it("starts rclone mounts through injected process hooks and records failures", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://127.0.0.1:3847");
    const layout = createMountLayout(rootDir, "local");

    await expect(mountRcloneWebDAV({
      remote,
      layout,
      commandRunner: commandRunner({
        rclone: { status: 127, stdout: "", stderr: "missing" }
      })
    })).rejects.toThrow("rclone is not available");

    const failedChild = fakeMountChild(1234);
    const failed = await mountRcloneWebDAV({
      remote,
      layout,
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      processSpawner: () => failedChild,
      waitForMountActive: async (_mountpoint, childState) => {
        childState.error = new Error("spawn failed");
        return false;
      },
      enableRc: false
    });

    expect(failed.status).toMatchObject({ state: "failed", mounted: false });
    expect(failed.status.error).toContain("spawn failed");
    expect(failedChild.kill).toHaveBeenCalledWith("SIGTERM");

    const mountedLayout = createMountLayout(rootDir, "mounted");
    const mountedChild = fakeMountChild(5678);
    const mounted = await mountRcloneWebDAV({
      remote: { ...remote, name: "mounted" },
      layout: mountedLayout,
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      processSpawner: () => mountedChild,
      waitForMountActive: async () => true
    });

    expect(mounted.status).toMatchObject({ remote: "mounted", state: "mounted", mounted: true, pid: 5678 });
    expect(mounted.status.rc).toMatchObject({ username: "activefs-rc", hasPassword: true });
    expect(mountedChild.unref).toHaveBeenCalled();

    const foregroundLayout = createMountLayout(rootDir, "foreground");
    const foregroundChild = fakeMountChild(6789);
    const foreground = await mountRcloneWebDAV({
      remote: { ...remote, name: "foreground" },
      layout: foregroundLayout,
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${foregroundLayout.vfsDir} type macfuse\n`, stderr: "" }
      }),
      processSpawner: () => foregroundChild,
      foreground: true,
      enableRc: false
    });

    expect(foreground.status).toMatchObject({ remote: "foreground", mounted: true, pid: 6789 });
    expect(foregroundChild.once).toHaveBeenCalledWith("exit", expect.any(Function));
  });

  it("leaves a Windows directory mountpoint absent for rclone and rejects non-empty targets", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://127.0.0.1:3847");
    const mountpoint = join(rootDir, "visible", "repo");
    const layout = createMountLayout(rootDir, "local", { mountpoint });
    await mkdir(mountpoint, { recursive: true });

    let existedWhenSpawned = true;
    const child = fakeMountChild(2468);
    const mounted = await mountRcloneWebDAV({
      remote,
      layout,
      platform: "win32",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      processSpawner: () => {
        existedWhenSpawned = existsSync(mountpoint);
        return child;
      },
      waitForMountActive: async () => true,
      enableRc: false
    });

    expect(existedWhenSpawned).toBe(false);
    expect(mounted.args).toContain(mountpoint);
    expect(mounted.status).toMatchObject({ state: "mounted", mounted: true });

    const blockedMountpoint = join(rootDir, "visible", "non-empty");
    const blockedLayout = createMountLayout(rootDir, "blocked", { mountpoint: blockedMountpoint });
    await mkdir(blockedMountpoint, { recursive: true });
    await writeFile(join(blockedMountpoint, "keep.txt"), "keep");

    await expect(mountRcloneWebDAV({
      remote: { ...remote, name: "blocked" },
      layout: blockedLayout,
      platform: "win32",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      processSpawner: () => fakeMountChild(1357),
      waitForMountActive: async () => true,
      enableRc: false
    })).rejects.toThrow("must not exist or must be empty");
    await expect(readFile(join(blockedMountpoint, "keep.txt"), "utf8")).resolves.toBe("keep");
  });

  it("reports mount refresh, unmount, WebDAV, and freshness edge states", async () => {
    const rootDir = await makeTempDir();
    const remote = parseActiveFSRemoteSpec("local=http://alice:secret@127.0.0.1:3847");
    const layout = createMountLayout(rootDir, "local");
    await writeStatus(layout, { state: "configured", mounted: false });

    const notMounted = await refreshRcloneMount(layout, {
      remote,
      path: "/docs",
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      fetch: okFetch()
    });
    expect(notMounted).toMatchObject({
      ok: false,
      status: {
        state: "stale",
        lastRefresh: { path: "/docs", recursive: false, ok: false }
      }
    });

    await writeStatus(layout, { state: "mounted", mounted: true });
    const missingRc = await refreshRcloneMount(layout, {
      remote,
      path: "/docs",
      commandRunner: commandRunner({
        mount: { status: 0, stdout: `rclone on ${layout.vfsDir} type macfuse\n`, stderr: "" }
      }),
      fetch: okFetch()
    });
    expect(missingRc.error).toContain("RC credentials");

    const alreadyUnmounted = await unmountRcloneMount(layout, {
      status: {
        remote: "local",
        state: "configured",
        rootDir: layout.rootDir,
        vfsDir: layout.vfsDir,
        configPath: layout.rcloneConfigPath,
        logFile: layout.rcloneLogPath,
        mounted: false,
        updatedAt: new Date().toISOString()
      }
    });
    expect(alreadyUnmounted).toMatchObject({ state: "unmounted", message: "Mount point is not active." });

    const failedUnmount = await unmountRcloneMount(layout, {
      platform: "win32",
      status: {
        ...alreadyUnmounted,
        state: "mounted",
        mounted: true,
        pid: 2222
      },
      commandRunner: commandRunner({
        taskkill: { status: 1, stdout: "", stderr: "denied" }
      })
    });
    expect(failedUnmount).toMatchObject({ state: "failed", mounted: true });
    expect(failedUnmount.error).toContain("denied");

    await writeWebDAVRuntimeStatus(layout, {
      remote: "local",
      state: "unknown",
      url: remote.url,
      auth: { username: "alice", hasPassword: true }
    });
    await writeFile(layout.webdavCredentialsPath, JSON.stringify({ username: "alice", password: "secret" }));
    const runtimeStatus = await checkWebDAVRuntimeStatus(layout, undefined, {
      fetch: async (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Basic YWxpY2U6c2VjcmV0");
        return new Response(null, { status: 503 });
      }
    });
    expect(runtimeStatus).toMatchObject({ state: "down", reachable: false, error: "HTTP 503" });

    const endpoint = await checkWebDAVEndpoint(remote, {
      fetch: async () => new Response(null, {
        status: 204,
        headers: { dav: "1", allow: "OPTIONS, PROPFIND, GET" }
      })
    });
    expect(endpoint).toMatchObject({
      reachable: true,
      capabilities: { dav: "1", allow: "OPTIONS, PROPFIND, GET" },
      auth: { username: "alice", hasPassword: true }
    });

    await writeMountFreshnessStatus(layout, {
      remote: "local",
      mode: "session",
      active: true,
      pid: 9999,
      sources: ["docs"]
    });
    const freshnessStopped = await stopMountFreshnessRuntime(layout, {
      processExists: (pid) => pid === 9999,
      terminateProcess: () => false
    });
    expect(freshnessStopped).toMatchObject({
      mode: "stopped",
      active: false,
      message: "Freshness watcher could not be stopped."
    });
  });

  it("persists managed WebDAV metadata in redacted mount config", async () => {
    const rootDir = await makeTempDir();
    await createActiveFSMountWorkspace(rootDir, [{
      ...parseActiveFSRemoteSpec("local=http://127.0.0.1:3847"),
      managedWebDAV: {
        enabled: true,
        host: "127.0.0.1",
        port: 3847
      }
    }]);

    const config = JSON.parse(await readFile(join(rootDir, ".activefs", "config.json"), "utf8"));
    expect(config.remotes.local.managedWebDAV).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 3847
    });
  });

  it("stops managed WebDAV and cleans stale runtime state", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await writeStatus(layout, {
      state: "mounted",
      mounted: true,
      rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
      webdav: {
        remote: "local",
        state: "up",
        url: "http://127.0.0.1:3847/",
        pid: 9999,
        reachable: true,
        updatedAt: new Date().toISOString()
      }
    });
    await writeWebDAVRuntimeStatus(layout, {
      remote: "local",
      state: "up",
      url: "http://127.0.0.1:3847/",
      pid: 9999,
      reachable: true
    });
    await writeFile(
      layout.rcloneRcCredentialsPath,
      JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
    );

    const stopped = await stopManagedWebDAVRuntime(layout, {
      processExists: (pid) => pid === 9999,
      terminateProcess: (pid) => pid === 9999
    });
    expect(stopped.state).toBe("down");
    expect(stopped.error).toContain("stop requested");

    await writeWebDAVRuntimeStatus(layout, {
      remote: "local",
      state: "up",
      url: "http://127.0.0.1:3847/",
      pid: 9999,
      reachable: true
    });
    await writeMountFreshnessStatus(layout, {
      remote: "local",
      mode: "session",
      active: true,
      pid: 9998
    });
    const cleanup = await cleanupMountRuntime(layout, {
      checkWebDAV: false,
      commandRunner: commandRunner({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      processExists: (pid) => pid === 9998,
      terminateProcess: (pid) => pid === 9998
    });

    expect(cleanup.status.state).toBe("unmounted");
    expect(cleanup.status.freshness?.active).toBe(false);
    expect(cleanup.actions.map((action) => action.kind)).toEqual(expect.arrayContaining([
      "webdav-marked-down",
      "freshness-stopped",
      "rc-credentials-removed",
      "mount-status-reset"
    ]));
    await expect(readFile(layout.rcloneRcCredentialsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes WebDAV runtime status atomically during concurrent reads", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await writeWebDAVRuntimeStatus(layout, {
      remote: "local",
      state: "up",
      url: "http://127.0.0.1:3847/",
      reachable: true
    });

    const writes = Array.from({ length: 50 }, async (_unused, index) =>
      writeWebDAVRuntimeStatus(layout, {
        remote: "local",
        state: index % 2 === 0 ? "up" : "down",
        url: "http://127.0.0.1:3847/",
        pid: index,
        reachable: index % 2 === 0,
        error: index % 2 === 0 ? undefined : `error ${index}`
      })
    );
    const reads = Array.from({ length: 100 }, () => readWebDAVRuntimeStatus(layout));

    await expect(Promise.all([...writes, ...reads])).resolves.toHaveLength(150);
    await expect(readWebDAVRuntimeStatus(layout)).resolves.toMatchObject({ remote: "local" });
    const runtimeFiles = await readdir(layout.runtimeDir);
    expect(runtimeFiles.filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("reports corrupt WebDAV runtime status JSON instead of hiding it", async () => {
    const rootDir = await makeTempDir();
    const layout = createMountLayout(rootDir, "local");
    await mkdir(layout.runtimeDir, { recursive: true });
    await writeFile(layout.webdavStatusPath, "{");

    await expect(readWebDAVRuntimeStatus(layout)).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe("rclone mount host inspection", () => {
  it("marks old macFUSE installs as outdated without invoking the macFUSE helper", () => {
    const calledCommands: string[] = [];
    const report = inspectRcloneMountHost({
      platform: "darwin",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }, calledCommands),
      fileExists: (path) =>
        path === "/Library/Filesystems/macfuse.fs" ||
        path === "/Library/Filesystems/macfuse.fs/Contents/Resources/mount_macfuse",
      readTextFile: () => plistVersion("4.0.3")
    });

    expect(report.backend).toBe("macfuse");
    expect(report.canAttemptMount).toBe(false);
    expect(report.dependencies).toContainEqual(expect.objectContaining({
      name: "macFUSE",
      status: "outdated",
      version: "4.0.3"
    }));
    expect(calledCommands).toEqual(["rclone"]);
  });

  it("accepts current macFUSE metadata on macOS", () => {
    const report = inspectRcloneMountHost({
      platform: "darwin",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      fileExists: (path) =>
        path === "/Library/Filesystems/macfuse.fs" ||
        path === "/Library/Filesystems/macfuse.fs/Contents/Resources/mount_macfuse",
      readTextFile: () => plistVersion("5.2.0")
    });

    expect(report.canAttemptMount).toBe(true);
    expect(formatRcloneMountHostReport(report)).toContain("macFUSE: ready 5.2.0");
  });

  it("requires WinFsp on Windows", () => {
    const report = inspectRcloneMountHost({
      platform: "win32",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        where: { status: 1, stdout: "", stderr: "" }
      }),
      fileExists: () => false,
      env: {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)"
      }
    });

    expect(report.backend).toBe("winfsp");
    expect(report.canAttemptMount).toBe(false);
    expect(report.dependencies).toContainEqual(expect.objectContaining({
      name: "WinFsp",
      status: "missing"
    }));
  });

  it("accepts WinFsp from Program Files or PATH", () => {
    const fromProgramFiles = inspectRcloneMountHost({
      platform: "win32",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      fileExists: (path) => path.endsWith("\\WinFsp\\bin\\winfsp-x64.dll"),
      env: {
        ProgramFiles: "C:\\Program Files"
      }
    });
    const fromPath = inspectRcloneMountHost({
      platform: "win32",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        where: { status: 0, stdout: "C:\\WinFsp\\bin\\winfsp-x64.dll\n", stderr: "" }
      }),
      fileExists: () => false,
      env: {}
    });

    expect(fromProgramFiles.canAttemptMount).toBe(true);
    expect(fromPath.canAttemptMount).toBe(true);
  });

  it("recognizes Linux FUSE when /dev/fuse and fusermount are available", () => {
    const report = inspectRcloneMountHost({
      platform: "linux",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        fusermount3: { status: 0, stdout: "fusermount3 version: 3.16.2\n", stderr: "" }
      }),
      fileExists: (path) => path === "/dev/fuse"
    });

    expect(report.backend).toBe("linux-fuse");
    expect(report.canAttemptMount).toBe(true);
    expect(report.dependencies).toContainEqual(expect.objectContaining({
      name: "FUSE",
      status: "ready"
    }));
  });

  it("reports Linux FUSE fallback and missing-device states", () => {
    const fallback = inspectRcloneMountHost({
      platform: "linux",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        fusermount3: { status: 127, stdout: "", stderr: "missing" },
        fusermount: { status: 0, stdout: "", stderr: "fusermount version 2.9\n" }
      }),
      fileExists: (path) => path === "/dev/fuse"
    });
    const missing = inspectRcloneMountHost({
      platform: "linux",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" }
      }),
      fileExists: () => false
    });

    expect(fallback.canAttemptMount).toBe(true);
    expect(fallback.dependencies).toContainEqual(expect.objectContaining({ version: "fusermount version 2.9" }));
    expect(missing.canAttemptMount).toBe(false);
    expect(formatRcloneMountHostReport(missing)).toContain("/dev/fuse is not available");
  });

  it("reports FreeBSD and unsupported mount backends", () => {
    const freebsdReady = inspectRcloneMountHost({
      platform: "freebsd",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount_fusefs: { status: 1, stdout: "usage\n", stderr: "" }
      })
    });
    const freebsdMissing = inspectRcloneMountHost({
      platform: "freebsd",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount_fusefs: { status: 127, stdout: "", stderr: "missing" }
      })
    });
    const unsupported = inspectRcloneMountHost({
      platform: "aix",
      commandRunner: commandRunner({
        rclone: { status: 127, stdout: "", stderr: "missing" }
      })
    });

    expect(freebsdReady.canAttemptMount).toBe(true);
    expect(freebsdMissing.canAttemptMount).toBe(false);
    expect(unsupported.backend).toBe("unsupported");
    expect(unsupported.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "rclone", status: "missing" }),
      expect.objectContaining({ name: "mount backend", status: "missing" })
    ]));
  });

  it("collects cross-platform evidence and verification guidance", async () => {
    const rootDir = await makeTempDir();
    await createActiveFSMountWorkspace(rootDir, [parseActiveFSRemoteSpec("local=http://127.0.0.1:3847")]);
    const evidence = await collectRcloneMountEvidence(rootDir, {
      platform: "linux",
      commandRunner: commandRunner({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        fusermount3: { status: 0, stdout: "fusermount3 version: 3.16.2\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${join(rootDir, ".activefs", "remotes", "local", "vfs")} type fuse.rclone\n`, stderr: "" }
      }),
      fileExists: (path) => path === "/dev/fuse",
      fetch: okFetch()
    });

    expect(evidence.host.backend).toBe("linux-fuse");
    expect(evidence.host.canAttemptMount).toBe(true);
    expect(evidence.activeMounts.lines[0]).toContain("rclone on");
    expect(evidence.remotes[0]?.remote).toBe("local");
    expect(evidence.guidance.prerequisites).toContain("/dev/fuse is available");
    expect(mountVerificationGuidance("win32").commands.some((command) => command.name === "PowerShell read")).toBe(true);
    expect(mountVerificationGuidance("darwin").prerequisites).toContain("macFUSE 5.x or newer is installed");
    expect(mountVerificationGuidance("darwin").notes.join("\n")).toContain("macFUSE bundle version");
    expect(mountVerificationGuidance("linux").notes.join("\n")).toContain("Container smoke tests");
    expect(mountVerificationGuidance("freebsd").prerequisites).toContain("mount_fusefs is available");
    expect(mountVerificationGuidance("aix").backend).toBe("unsupported");
  });
});

function createExampleFS() {
  return createActiveFS().mount(
    "/",
    createMemoryTree({
      "/hello.md": "# Hello\n\nMounted read works.\n",
      "/docs/readme.md": "Directory listing works.\n"
    })
  );
}

function createUnknownSizeTree(read: () => string): ActiveFSTree {
  return fsTree<unknown, unknown>({
    "/unknown.txt": file({
      read: () => ({
        content: read(),
        info: {
          name: "unknown.txt",
          path: "/unknown.txt",
          kind: "file",
          data: { contentHash: "sha256:test-content", stateHash: "state-1" }
        }
      }),
      info: () => ({
        name: "unknown.txt",
        path: "/unknown.txt",
        kind: "file",
        data: { contentHash: "sha256:test-content", stateHash: "state-1" }
      })
    })
  }, {
    name: "unknown-size"
  });
}

function treeReadContent(read: ActiveFSTreeReadResult): string | Uint8Array | ArrayBuffer {
  return typeof read === "object" && "content" in read ? read.content : read;
}

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "activefs-mount-"));
  tempDirs.push(path);
  return path;
}

async function writeStatus(layout: ReturnType<typeof createMountLayout>, status: Partial<RcloneMountStatus>): Promise<void> {
  await mkdir(layout.runtimeDir, { recursive: true });
  await writeFile(
    layout.mountStatusPath,
    `${JSON.stringify({
      remote: layout.remoteName,
      rootDir: layout.rootDir,
      vfsDir: layout.vfsDir,
      configPath: layout.rcloneConfigPath,
      logFile: layout.rcloneLogPath,
      updatedAt: new Date().toISOString(),
      ...status
    }, null, 2)}\n`
  );
}

function okFetch(): typeof fetch {
  return (async () => ({
    status: 204,
    ok: true,
    headers: new Headers()
  } as Response)) as typeof fetch;
}

function basicAuth(auth: WebDAVServerHandle["auth"]): string {
  if (!auth) {
    throw new Error("Expected auth credentials.");
  }
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

function commandRunner(
  results: Record<string, { status: number; stdout: string; stderr: string }>,
  calledCommands: string[] = []
): MountCommandRunner {
  return (command) => {
    calledCommands.push(command);
    const result = results[command] ?? { status: 127, stdout: "", stderr: "not found" };
    return { ...result };
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

function fakeMountChild(pid: number) {
  const child = {
    pid,
    once: vi.fn(() => child),
    kill: vi.fn(),
    unref: vi.fn()
  };
  return child as any;
}

function plistVersion(version: string): string {
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<plist version=\"1.0\">",
    "<dict>",
    "<key>CFBundleShortVersionString</key>",
    `<string>${version}</string>`,
    "</dict>",
    "</plist>"
  ].join("\n");
}
