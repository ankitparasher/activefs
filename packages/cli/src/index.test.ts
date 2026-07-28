import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "@activefs/cli";
import { createActiveFS, file, fsTree, text, type ActiveFSTree, type ActiveFSTreeMutationResult } from "@activefs/core";
import {
  activeFSMountCachePathKey,
  startWebDAVServer,
  type MountCommandRunner,
  type RcloneMountProcessSpawner,
  type WebDAVServerHandle
} from "@activefs/mount";
import { createMemoryTree } from "@activefs/testing";
import { createHttpSourceClient, startActiveFSServer, type ActiveFSTreeServerHandle } from "@activefs/source-http";

const tempDirs: string[] = [];
const sourceServers: ActiveFSTreeServerHandle[] = [];
const webDAVServers: WebDAVServerHandle[] = [];

afterEach(async () => {
  await Promise.all(sourceServers.splice(0).map((server) => server.close()));
  await Promise.all(webDAVServers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("activefs CLI remote setup", () => {
  it("adds an ActiveFS remote", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");

    await main(["remote", "add", "local", "http://127.0.0.1:3999/activefs/v1", "--state-root", rootDir, "--no-check"]);

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    expect(config.remotes.local).toMatchObject({
      name: "local",
      mountPath: "/local",
      url: "http://127.0.0.1:3999/activefs/v1"
    });
    expect(config.remotes.local.protocol).toBeUndefined();
  });

  it("starts the shipped Source API demo from remote add --demo", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const launches: Array<{ remoteName: string; port: number; url: string }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main([
        "remote",
        "add",
        "demo",
        "--demo",
        "--port",
        "3999",
        "--workspace",
        rootDir,
        "--no-check"
      ], {
        demoSourceDaemonLauncher: async (request) => {
          launches.push({
            remoteName: request.remoteName,
            port: request.port,
            url: request.url
          });
          return { pid: 4242, url: request.url };
        }
      });

      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      const runtime = JSON.parse(await readFile(join(rootDir, "remotes", "demo", "runtime", "source-demo.json"), "utf8"));
      expect(launches).toEqual([
        {
          remoteName: "demo",
          port: 3999,
          url: "http://127.0.0.1:3999/_activefs/"
        }
      ]);
      expect(config.remotes.demo).toMatchObject({
        name: "demo",
        mountPath: "/demo",
        url: "http://127.0.0.1:3999/_activefs/"
      });
      expect(runtime).toMatchObject({
        remote: "demo",
        kind: "source-api-demo",
        state: "up",
        pid: 4242,
        url: "http://127.0.0.1:3999/_activefs/"
      });
      expect(logs).toContain("Configured remote demo /demo -> http://127.0.0.1:3999/_activefs/");
      expect(logs).toContain("demo: Source API listening at http://127.0.0.1:3999/_activefs/ (pid 4242)");
      expect(logs).toContain("next: activefs list /demo");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("stops a recorded Source API demo runtime from remote remove", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const terminated: number[] = [];
    let running = true;

    await main([
      "remote",
      "add",
      "demo",
      "--demo",
      "--port",
      "3999",
      "--workspace",
      rootDir,
      "--no-check"
    ], {
      demoSourceDaemonLauncher: async (request) => ({ pid: 4242, url: request.url })
    });
    await main(["remote", "remove", "demo", "--workspace", rootDir], {
      processExists: (pid) => pid === 4242 && running,
      terminateProcess: (pid) => {
        terminated.push(pid);
        running = false;
        return true;
      }
    });

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    expect(terminated).toEqual([4242]);
    expect(config.remotes.demo).toBeUndefined();
    await expect(readFile(join(rootDir, "remotes", "demo", "runtime", "source-demo.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for demo shutdown before removing remote state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimePath = join(rootDir, "remotes", "demo", "runtime", "source-demo.json");
    let running = true;

    await main([
      "remote",
      "add",
      "demo",
      "--demo",
      "--port",
      "3999",
      "--workspace",
      rootDir,
      "--no-check"
    ], {
      demoSourceDaemonLauncher: async (request) => ({ pid: 4242, url: request.url })
    });
    await main(["remote", "remove", "demo", "--workspace", rootDir], {
      processExists: () => running,
      terminateProcess: () => true,
      waitForProcessExit: async () => {
        await writeFile(runtimePath, `${JSON.stringify({ state: "down" })}\n`);
        running = false;
        return true;
      }
    });

    await expect(readFile(runtimePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps remote state when a demo process does not stop before removal", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimePath = join(rootDir, "remotes", "demo", "runtime", "source-demo.json");

    await main([
      "remote",
      "add",
      "demo",
      "--demo",
      "--port",
      "3999",
      "--workspace",
      rootDir,
      "--no-check"
    ], {
      demoSourceDaemonLauncher: async (request) => ({ pid: 4242, url: request.url })
    });

    await expect(main([
      "remote",
      "remove",
      "demo",
      "--workspace",
      rootDir
    ], {
      processExists: () => true,
      terminateProcess: () => true,
      waitForProcessExit: async () => false
    })).rejects.toThrow("did not exit");

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    expect(config.remotes.demo).toBeDefined();
    expect(runtime).toMatchObject({ remote: "demo", state: "up", pid: 4242 });
  });

  it("keeps remote state when demo termination is rejected before removal", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimePath = join(rootDir, "remotes", "demo", "runtime", "source-demo.json");

    await main([
      "remote",
      "add",
      "demo",
      "--demo",
      "--port",
      "3999",
      "--workspace",
      rootDir,
      "--no-check"
    ], {
      demoSourceDaemonLauncher: async (request) => ({ pid: 4242, url: request.url })
    });

    await expect(main([
      "remote",
      "remove",
      "demo",
      "--workspace",
      rootDir
    ], {
      processExists: () => true,
      terminateProcess: () => false
    })).rejects.toThrow("Failed to stop demo Source API runtime pid 4242");

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
    expect(config.remotes.demo).toBeDefined();
    expect(runtime).toMatchObject({ remote: "demo", state: "up", pid: 4242 });
  });

  it("clears an inactive demo marker when a name is reused for a normal remote", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    let running = true;

    try {
      await main([
        "remote",
        "add",
        "repo",
        "--demo",
        "--port",
        "3999",
        "--workspace",
        rootDir,
        "--no-check"
      ], {
        demoSourceDaemonLauncher: async (request) => ({ pid: 4242, url: request.url })
      });
      await main(["remote", "remove", "repo", "--workspace", rootDir], {
        processExists: () => running,
        terminateProcess: () => {
          running = false;
          return true;
        }
      });
      logs.length = 0;

      await main([
        "remote",
        "add",
        "repo",
        "http://127.0.0.1:4000/activefs/v1/",
        "--workspace",
        rootDir,
        "--no-check"
      ], {
        processExists: () => false
      });
      await main(["remote", "remove", "repo", "--workspace", rootDir], {
        processExists: () => false
      });

      expect(logs.some((line) => line.startsWith("demo:"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("serves the shipped Source API demo fixture", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main(["demo-source-api", "--port", "0", "--root", rootDir, "--remote", "demo"], {
        waitForInterrupt: async (close) => {
          const runtime = JSON.parse(
            await readFile(join(rootDir, "remotes", "demo", "runtime", "source-demo.json"), "utf8")
          );
          const client = createHttpSourceClient({ url: runtime.url, name: "demo" });
          await expect(client.list({}, "/")).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ path: "/README.txt", kind: "file" }),
            expect.objectContaining({ path: "/notes", kind: "directory" }),
            expect.objectContaining({ path: "/bin", kind: "directory" })
          ]));
          await expect(client.read({}, "/README.txt")).resolves.toMatchObject({
            content: "Hello from the ActiveFS demo Source API.\n"
          });
          await expect(client.search!({}, "/", { pattern: "Source API" })).resolves.toMatchObject({
            strategy: "scan",
            matches: expect.arrayContaining([
              expect.objectContaining({ path: "/notes/source-api.txt" }),
              expect.objectContaining({ path: "/README.txt" })
            ])
          });
          await close();
        }
      });

      const stopped = JSON.parse(await readFile(join(rootDir, "remotes", "demo", "runtime", "source-demo.json"), "utf8"));
      expect(logs.some((line) => line.startsWith("ActiveFS demo Source API serving at "))).toBe(true);
      expect(stopped).toMatchObject({ remote: "demo", kind: "source-api-demo", state: "down" });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("defaults remote add state root to .activefs", async () => {
    const tempDir = await makeTempDir();
    const previousCwd = process.cwd();
    process.chdir(tempDir);

    try {
      await main(["remote", "add", "local", "http://127.0.0.1:3999/activefs/v1", "--no-check", "--manage-webdav"]);

      const rootDir = join(tempDir, ".activefs");
      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      expect(config.remotes.local).toMatchObject({
        name: "local",
        url: "http://127.0.0.1:3999/activefs/v1",
        managedWebDAV: {
          enabled: true,
          host: "127.0.0.1"
        }
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("prints protocol-free JSON for ActiveFS remote add with managed mount adapter state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main([
        "remote",
        "add",
        "json",
        "http://127.0.0.1:3999/activefs/v1",
        "--root",
        rootDir,
        "--manage-webdav",
        "--no-check",
        "--json"
      ]);

      const output = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      expect(output.remote).toMatchObject({
        name: "json",
        url: "http://127.0.0.1:3999/activefs/v1"
      });
      expect(output.remote.protocol).toBeUndefined();
      expect(config.remotes.json.protocol).toBeUndefined();
      expect(config.remotes.json.managedWebDAV).toMatchObject({
        enabled: true,
        host: "127.0.0.1"
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("adds ActiveFS remotes with default Source API handshake checks", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const sourceServer = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/note.txt": "source" } }),
      handshake: {
        workspace: { displayName: "Docs Workspace", suggestedMountPath: "/suggested-docs" },
        cache: { contentTtlMs: 1_000, directoryTtlMs: 2_000 },
        revisions: { config: "config-1" }
      }
    });
    const devServer = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/hello.md": "hello" } })
    });
    sourceServers.push(sourceServer, devServer);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main([
        "remote",
        "add",
        "docs",
        sourceServer.url,
        "--workspace",
        rootDir
      ]);
      await main(["remote", "add", "dev", devServer.url, "--workspace", rootDir]);
      await main(["remote", "status", "--workspace", rootDir, "--json"]);

      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      const status = JSON.parse([...logs].reverse().find((line) => line.startsWith("{"))!);
      expect(config.remotes.docs).toMatchObject({
        name: "docs",
        mountPath: "/docs",
        url: sourceServer.url,
        watchable: true,
        sourceHints: {
          displayName: "Docs Workspace",
          suggestedMountPath: "/suggested-docs",
          capabilities: { readable: true, watchable: true },
          cache: { contentTtlMs: 1_000, directoryTtlMs: 2_000 },
          revisions: { config: "config-1" }
        }
      });
      expect(config.remotes.dev).toMatchObject({
        name: "dev",
        mountPath: "/dev",
        url: devServer.url,
        watchable: true
      });
      expect(config.remotes.docs.protocol).toBeUndefined();
      expect(config.remotes.dev.protocol).toBeUndefined();
      expect(status.remotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "docs" }),
        expect.objectContaining({ name: "dev" })
      ]));
      expect(logs.filter((line) => line.includes("check:")).every((line) => line.includes("reachable"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("requires explicit dev override for non-loopback HTTP ActiveFS remotes", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await expect(main([
        "remote",
        "add",
        "bad",
        "http://source.example/activefs/v1",
        "--workspace",
        rootDir,
        "--no-check"
      ])).rejects.toThrow("--allow-insecure-http");

      await main([
        "remote",
        "add",
        "loopback",
        "http://localhost:3999/activefs/v1",
        "--workspace",
        rootDir,
        "--no-check"
      ]);
      await main([
        "remote",
        "add",
        "loopback-ipv6",
        "http://[::1]:3999/activefs/v1",
        "--workspace",
        rootDir,
        "--no-check"
      ]);
      await main([
        "remote",
        "add",
        "dev",
        "http://source.example/activefs/v1",
        "--workspace",
        rootDir,
        "--allow-insecure-http",
        "--no-check"
      ]);
      await main(["remote", "status", "dev", "--workspace", rootDir, "--json"], { fetch: okFetch() });
      await main(["status", "dev", "--workspace", rootDir, "--json"], { fetch: okFetch() });
      await main(["doctor", "--mounts", "--workspace", rootDir, "--json"], {
        commandRunner: commandRunnerWithCalls({
          rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
          mount: { status: 0, stdout: "", stderr: "" }
        }),
        fetch: okFetch()
      });

      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      const jsonLogs = logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      expect(config.remotes.loopback.insecureHttp).toMatchObject({
        reason: "loopback-development",
        loopback: true
      });
      expect(config.remotes["loopback-ipv6"].insecureHttp).toMatchObject({
        reason: "loopback-development",
        loopback: true
      });
      expect(config.remotes.dev.insecureHttp).toMatchObject({
        reason: "allow-insecure-http",
        loopback: false,
        devOnly: true
      });
      expect(jsonLogs[0].remotes[0].insecureHttp.reason).toBe("allow-insecure-http");
      expect(jsonLogs[1].remotes[0].insecureHttp.reason).toBe("allow-insecure-http");
      expect(jsonLogs[2].insecureHttpRemotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "dev", reason: "allow-insecure-http" })
      ]));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records a mountpoint and starts an internal mount from remote add --mount", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];

    await main([
      "remote",
      "add",
      "local",
      "http://127.0.0.1:3999/activefs/v1",
      "--workspace",
      rootDir,
      "--activity-policy",
      "required",
      "--no-check",
      "--mount",
      mountpoint
    ], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${mountpoint} type macfuse\n`, stderr: "" }
      }, calls),
      waitForMountActive: async () => true,
      mountProcessSpawner: fakeSpawner(4321, spawned),
      platform: "darwin",
      fetch: okFetch(),
      webDAVDaemonLauncher: async () => ({ pid: 2468, url: "http://127.0.0.1:3847/" })
    });

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    expect(config.remotes.local.mountpoint).toBe(mountpoint);
    expect(config.remotes.local.activityPolicy).toBe("required");
    expect(config.remotes.local.protocol).toBeUndefined();
    expect(config.remotes.local.url).toBe("http://127.0.0.1:3999/activefs/v1");
    expect(config.mountpoints[mountpoint]).toMatchObject({ remote: "local" });
    expect(spawned.some((call) => call.command === "rclone" && call.args.includes(mountpoint))).toBe(true);
  });

  it("starts the managed WebDAV daemon through the default CLI server path", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const mountSpawns: Array<{ command: string; args: string[] }> = [];
    const daemonSpawns: Array<{
      command: string;
      args: string[];
      detached?: boolean;
      stdio?: unknown;
    }> = [];

    await main([
      "remote",
      "add",
      "local",
      "http://127.0.0.1:3999/activefs/v1",
      "--workspace",
      rootDir,
      "--no-check",
      "--mount",
      mountpoint,
      "--no-freshness"
    ], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        "/opt/activefs-rclone": { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
      }),
      waitForMountActive: async () => true,
      mountProcessSpawner: fakeSpawner(4321, mountSpawns),
      daemonProcessSpawner: (command, args, options) => {
        daemonSpawns.push({
          command,
          args,
          detached: options.detached,
          stdio: options.stdio
        });
        return {
          pid: 2468,
          unref: () => undefined
        };
      },
      platform: "darwin",
      fetch: okFetch()
    });

    const webdavStatus = JSON.parse(
      await readFile(join(rootDir, "remotes", "local", "runtime", "webdav.json"), "utf8")
    );
    const rcloneConfig = await readFile(join(rootDir, "remotes", "local", "runtime", "rclone.conf"), "utf8");

    expect(daemonSpawns).toHaveLength(1);
    expect(daemonSpawns[0]).toMatchObject({
      command: process.execPath,
      detached: true,
      stdio: "ignore"
    });
    expect(daemonSpawns[0]!.args[0]).toEqual(expect.any(String));
    expect(daemonSpawns[0]!.args.slice(1)).toEqual([
      "server",
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--root",
      rootDir,
      "--remote",
      "local"
    ]);
    expect(daemonSpawns[0]!.args).not.toContain("webdav");
    expect(webdavStatus).toMatchObject({
      remote: "local",
      pid: 2468,
      url: "http://127.0.0.1:0/"
    });
    expect(["up", "down"]).toContain(webdavStatus.state);
    expect(rcloneConfig).toContain("url = http://127.0.0.1:0/");
    expect(mountSpawns.some((call) => call.command === "rclone" && call.args.includes(mountpoint))).toBe(true);
  });

  it("lists and removes remotes using upward state-root discovery", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const nestedDir = join(tempDir, "repo", "nested");
    const mountpoint = join(tempDir, "mounted");
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await mkdir(nestedDir, { recursive: true });
      await main(["remote", "add", "local", "http://127.0.0.1:3999/activefs/v1", "--workspace", rootDir, "--no-check"]);
      const configPath = join(rootDir, "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.remotes.local.mountpoint = mountpoint;
      config.mountpoints = {
        [mountpoint]: { remote: "local", stateRoot: tempDir, mountpoint }
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      const remoteStateMarker = join(rootDir, "remotes", "local", "cache", "marker.txt");
      await mkdir(join(rootDir, "remotes", "local", "cache"), { recursive: true });
      await writeFile(remoteStateMarker, "state\n");

      logs.length = 0;
      await main(["remote", "list", "--state-root", rootDir, "--json"]);
      expect(JSON.parse(logs[0]!).remotes[0]).toMatchObject({ name: "local", mountpoint });

      process.chdir(nestedDir);
      logs.length = 0;
      await main(["remote", "list", "--json"]);
      await main(["remote", "remove", "local", "--json"], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: "", stderr: "" }
        }),
        platform: "darwin",
        fetch: okFetch()
      });

      const listed = JSON.parse(logs[0]!);
      const removed = JSON.parse(logs[1]!);
      const nextConfig = JSON.parse(await readFile(configPath, "utf8"));
      expect(listed.rootDir.endsWith("/.activefs")).toBe(true);
      expect(listed.remotes[0]).toMatchObject({ name: "local", mountpoint });
      expect(listed.remotes[0].protocol).toBeUndefined();
      expect(removed).toMatchObject({ remote: "local", removed: true });
      expect(nextConfig.remotes.local).toBeUndefined();
      expect(nextConfig.mountpoints?.[mountpoint]).toBeUndefined();
      await expect(readFile(remoteStateMarker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      process.chdir(previousCwd);
      logSpy.mockRestore();
    }
  });

  it("configures, reports, and clears auth providers without storing env tokens", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main(["remote", "add", "local", "http://127.0.0.1:3999/activefs/v1", "--workspace", rootDir, "--no-check"]);
      await main(["auth", "set", "local", "--workspace", rootDir, "--env", "ACTIVEFS_TOKEN"]);
      await main(["auth", "status", "local", "--workspace", rootDir, "--json"]);
      await main(["auth", "set", "local", "--workspace", rootDir, "--cookie-provider", "[\"cookie-command\"]"]);
      await main(["auth", "clear", "local", "--workspace", rootDir]);

      const status = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      expect(status.auth).toMatchObject({ type: "bearer-env", env: "ACTIVEFS_TOKEN" });
      expect(JSON.stringify(config)).not.toContain("env-token");
      expect(config.remotes.local.auth).toMatchObject({ type: "none" });
      expect(logs).toContain("local: auth cookie-provider");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("starts WebDAV through the protocol-neutral server command", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main(["server", "start", "dev", "--workspace", rootDir, "--source", "example", "--port", "0"], {
        waitForInterrupt: async (close) => {
          expect(logs.some((line) => line.startsWith("ActiveFS mount server serving at "))).toBe(true);
          const runtime = JSON.parse(await readFile(join(rootDir, "remotes", "dev", "runtime", "webdav.json"), "utf8"));
          expect(runtime).toMatchObject({ remote: "dev", state: "up", reachable: true });
          await close();
        }
      });

      const stopped = JSON.parse(await readFile(join(rootDir, "remotes", "dev", "runtime", "webdav.json"), "utf8"));
      expect(stopped).toMatchObject({ remote: "dev", state: "down", reachable: false });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("creates and lists ActiveFS remote config separate from mount adapter state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1");
      await main(["remote", "list", "--root", rootDir, "--json"]);

      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      const listed = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      expect(config.remotes.docs).toMatchObject({
        name: "docs",
        mountPath: "/docs",
        url: "http://127.0.0.1:3999/activefs/v1"
      });
      expect(config.remotes.docs.protocol).toBeUndefined();
      expect(listed.remotes[0]).toMatchObject({ name: "docs", mountPath: "/docs" });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("inspects MCP with the normal remote-first CLI grammar", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1", ["--watchable"]);
      await addSourceRemote(rootDir, "logs", "/logs", "http://127.0.0.1:3998/activefs/v1");

      await main(["mcp", "docs", "inspect", "--root", rootDir]);
      const remoteFirst = JSON.parse(logs.at(-1)!);
      expect(remoteFirst).toMatchObject({
        remote: "docs",
        transport: "stdio",
        rootDir,
        remotes: [
          expect.objectContaining({
            name: "docs",
            rootPath: "/docs"
          })
        ],
        subscriptions: expect.objectContaining({
          advertised: true
        })
      });
      expect(remoteFirst.remotes).toHaveLength(1);
      expect(remoteFirst.tools).toContain("activefs_read");

      logs.length = 0;
      await main(["mcp", "inspect", "logs", "--root", rootDir, "--http"]);
      const actionFirst = JSON.parse(logs.at(-1)!);
      expect(actionFirst).toMatchObject({
        remote: "logs",
        transport: "http",
        remotes: [
          expect.objectContaining({
            name: "logs",
            rootPath: "/logs"
          })
        ]
      });

      await expect(main(["mcp", "missing", "inspect", "--root", rootDir]))
        .rejects.toThrow("Unknown ActiveFS MCP remote: missing");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints MCP client config snippets for Claude, Codex, and generic agents", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1", ["--watchable"]);

      await main(["mcp", "docs", "config", "claude", "--root", rootDir]);
      const claude = JSON.parse(logs.at(-1)!);
      expect(claude.mcpServers["activefs-docs"]).toEqual({
        command: "activefs",
        args: ["mcp", "docs", "start", "--state-root", rootDir]
      });

      logs.length = 0;
      await main(["mcp", "docs", "config", "codex", "--root", rootDir]);
      expect(logs.join("\n")).toContain("[mcp_servers.activefs-docs]");
      expect(logs.join("\n")).toContain("command = \"activefs\"");
      expect(logs.join("\n")).toContain(`args = ["mcp", "docs", "start", "--state-root", "${rootDir}"]`);

      logs.length = 0;
      await main(["mcp", "docs", "config", "generic", "--root", rootDir]);
      const generic = JSON.parse(logs.at(-1)!);
      expect(generic).toMatchObject({
        name: "activefs-docs",
        transport: "stdio",
        command: "activefs",
        args: ["mcp", "docs", "start", "--state-root", rootDir],
        remotes: [
          expect.objectContaining({
            name: "docs",
            watchable: true
          })
        ]
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports MCP status and stop without requiring invented transport flags", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1");

      await main(["mcp", "docs", "stop", "--root", rootDir]);
      expect(logs).toContain("docs: not_recorded");
      expect(logs.join("\n")).toContain("Stdio MCP servers are normally started and stopped by the MCP client");

      logs.length = 0;
      await main(["mcp", "docs", "status", "--root", rootDir, "--json"]);
      const output = JSON.parse(logs.at(-1)!);
      expect(output).toMatchObject({
        action: "status",
        remotes: [
          {
            remote: "docs",
            state: "not_recorded"
          }
        ]
      });

      const runtimeDir = join(rootDir, "remotes", "docs", "runtime");
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(runtimeDir, "mcp.json"), `${JSON.stringify({
        remote: "docs",
        state: "up",
        transport: "http",
        url: "http://127.0.0.1:8765/mcp",
        pid: 4242,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`);

      logs.length = 0;
      const probeCalls: string[] = [];
      await main(["mcp", "docs", "status", "--root", rootDir, "--json"], {
        processExists: (pid) => pid === 4242,
        fetch: (async (input) => {
          probeCalls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
          return {
            status: 401,
            ok: false,
            headers: new Headers()
          } as Response;
        }) as typeof fetch
      });
      const running = JSON.parse(logs.at(-1)!);
      expect(probeCalls).toEqual(["http://127.0.0.1:8765/mcp"]);
      expect(running.remotes[0]).toMatchObject({
        remote: "docs",
        state: "up",
        transport: "http",
        pid: 4242,
        reachable: true
      });

      const terminated: number[] = [];
      logs.length = 0;
      await main(["mcp", "docs", "stop", "--root", rootDir, "--json"], {
        processExists: (pid) => pid === 4242,
        terminateProcess: (pid) => {
          terminated.push(pid);
          return true;
        }
      });
      const stopped = JSON.parse(logs.at(-1)!);
      expect(terminated).toEqual([4242]);
      expect(stopped.remotes[0]).toMatchObject({
        remote: "docs",
        state: "down",
        message: "Requested stop for MCP runtime pid 4242."
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("runs remote add, list, read, and grep through an arbitrary discovery route", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const tree = createMemoryTree({
      searchable: true,
      files: {
        "/README.txt": "remote needle hello",
        "/nested/detail.txt": "nested detail"
      }
    });
    const server = await startActiveFSServer({
      tree,
      routes: { handshake: "/product/source-manifest.json" }
    });
    sourceServers.push(server);
    const logs: string[] = [];
    const writes: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await main([
        "remote",
        "add",
        "docs",
        server.url,
        "--state-root",
        rootDir,
        "--mount-path",
        "/docs"
      ]);
      logs.length = 0;

      await main(["list", "/docs", "--root", rootDir]);
      await main(["stat", "/docs/README.txt", "--root", rootDir]);
      await main(["read", "/docs/README.txt", "--root", rootDir]);
      await main(["grep", "needle", "/docs", "--root", rootDir, "--json"]);

      expect(logs.some((line) => line.includes("file") && line.includes("/docs/README.txt"))).toBe(true);
      expect(JSON.parse(logs.find((line) => line.includes("\"kind\""))!)).toMatchObject({
        path: "/docs/README.txt",
        kind: "file"
      });
      expect(writes.join("")).toBe("remote needle hello");
      const grep = JSON.parse(logs.at(-1)!);
      expect(grep.matches).toEqual([
        expect.objectContaining({
          path: "/docs/README.txt",
          excerpt: "remote needle hello"
        })
      ]);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("uses a remote optional grep handler through the ActiveFS Source API", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const tree = fsTree({
      "diagram.png": text("binary placeholder").setGrep(({ path, input }) => ({
        matches: [{ path, excerpt: `OCR:${input.pattern}` }],
        complete: true,
        strategy: "source"
      }))
    });
    const server = await startActiveFSServer({ tree });
    sourceServers.push(server);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "images", "/images", server.url);
      logs.length = 0;
      await main(["grep", "architecture", "/images/diagram.png", "--root", rootDir, "--json"]);

      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        strategy: "source",
        complete: true,
        matches: [{ path: "/images/diagram.png", excerpt: "OCR:architecture" }]
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints direct local-source diagnostics with default paths, binary reads, and truncated text grep", async () => {
    const tempDir = await makeTempDir();
    const sourceDir = join(tempDir, "source");
    const logs: string[] = [];
    const writes: Uint8Array[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
      return true;
    }) as typeof process.stdout.write);

    try {
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, "a.txt"), "needle alpha\n");
      await writeFile(join(sourceDir, "b.txt"), "needle beta\n");
      await writeFile(join(sourceDir, "bytes.bin"), new Uint8Array([0, 1, 2, 255]));

      await main(["list", "--source", `local=${sourceDir}`]);
      await main(["read", "/local/bytes.bin", "--source", `local=${sourceDir}`]);
      await main(["export", "/local", "--source", `local=${sourceDir}`, "--to", join(tempDir, "exported")]);
      await main(["grep", "needle", "/local", "--source", `local=${sourceDir}`, "--limit", "1"]);

      expect(logs.some((line) => line.includes("directory") && line.includes("/local"))).toBe(true);
      expect(logs).toContain(`Exported 3 files to ${join(tempDir, "exported")}`);
      expect(Buffer.concat(writes.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(logs).toContain("# activefs grep: source incomplete");
      expect(logs.some((line) => line.includes("/local/a.txt:1:1:needle alpha"))).toBe(true);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("guards export target selection for unknown remotes, host roots, and relative host paths", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const relativeSource = join(tempDir, "relative-source");
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await mkdir(relativeSource, { recursive: true });
      await writeFile(join(relativeSource, "one.txt"), "one");
      await writeFile(join(relativeSource, "two.txt"), "two");

      await expect(main(["export", "missing:/", "--root", rootDir, "--to", join(tempDir, "missing-export")]))
        .rejects.toThrow("Unknown ActiveFS remote: missing");
      await expect(main(["export", "/", "--to", join(tempDir, "root-export")]))
        .rejects.toThrow("Refusing ambiguous host-root export");
      await main(["export", "/", "--root", rootDir, "--source", "example", "--to", join(tempDir, "state-root-export")]);

      process.chdir(tempDir);
      await main(["export", "relative-source", "--to", "relative-export"]);

      expect(logs.some((line) => line.startsWith(`Exported `) && line.endsWith(` to ${join(tempDir, "state-root-export")}`)))
        .toBe(true);
      expect(logs).toContain("Exported 2 files to relative-export");
      await expect(readFile(join(tempDir, "relative-export", "one.txt"), "utf8")).resolves.toBe("one");
    } finally {
      process.chdir(previousCwd);
      logSpy.mockRestore();
    }
  });

  it("applies configured auth providers to Source API direct commands and status checks", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const previousToken = process.env.ACTIVEFS_TEST_SOURCE_TOKEN;
    process.env.ACTIVEFS_TEST_SOURCE_TOKEN = "source-token";
    const server = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/secure.txt": "secret bytes" } }),
      auth: { type: "bearer", token: "source-token" }
    });
    sourceServers.push(server);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main([
        "remote",
        "add",
        "docs",
        server.url,
        "--workspace",
        rootDir,
        "--no-check"
      ]);
      await main(["auth", "set", "docs", "--workspace", rootDir, "--env", "ACTIVEFS_TEST_SOURCE_TOKEN"]);
      logs.length = 0;

      await main(["list", "/docs", "--workspace", rootDir]);
      await main(["remote", "status", "docs", "--workspace", rootDir, "--json"]);

      const status = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      expect(logs.some((line) => line.includes("/docs/secure.txt"))).toBe(true);
      expect(status.remotes[0]).toMatchObject({
        name: "docs",
        check: { reachable: true }
      });
      expect(status.remotes[0].protocol).toBeUndefined();
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACTIVEFS_TEST_SOURCE_TOKEN;
      } else {
        process.env.ACTIVEFS_TEST_SOURCE_TOKEN = previousToken;
      }
      logSpy.mockRestore();
    }
  });

  it("exports a live tree with an explicit manifest", async () => {
    const tempDir = await makeTempDir();
    const sourceDir = join(tempDir, "source");
    const outDir = join(tempDir, "exported");
    const rootDir = join(tempDir, ".activefs");
    const previousCwd = process.cwd();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await mkdir(sourceDir, { recursive: true });
      await mkdir(rootDir, { recursive: true });
      await writeFile(join(rootDir, "config.json"), JSON.stringify({ version: 1, remotes: {} }));
      await writeFile(join(sourceDir, "hello.txt"), "hello export");
      process.chdir(tempDir);
      await expect(main(["export", "/", "--to", join(tempDir, "root-export")])).rejects.toThrow("Refusing ambiguous host-root export");
      await main(["export", sourceDir, "--to", outDir]);
      const manifest = JSON.parse(await readFile(join(outDir, "activefs-export-manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        consistency: "live",
        failures: []
      });
      expect(manifest.files[0]).toMatchObject({ path: "/hello.txt", size: "hello export".length });
      expect(logs.some((line) => line.includes("Exported 1 file"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      logSpy.mockRestore();
    }
  });

  it("exports configured ActiveFS remotes with auth providers", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const outDir = join(tempDir, "exported-source");
    const previousToken = process.env.ACTIVEFS_TEST_EXPORT_TOKEN;
    process.env.ACTIVEFS_TEST_EXPORT_TOKEN = "export-token";
    const server = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/secure.txt": "secret export" } }),
      auth: { type: "bearer", token: "export-token" }
    });
    sourceServers.push(server);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", server.url);
      await main(["auth", "set", "docs", "--root", rootDir, "--env", "ACTIVEFS_TEST_EXPORT_TOKEN"]);

      await main(["export", "docs:/", "--to", outDir, "--root", rootDir]);

      await expect(readFile(join(outDir, "secure.txt"), "utf8")).resolves.toBe("secret export");
      const manifest = JSON.parse(await readFile(join(outDir, "activefs-export-manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        schemaVersion: 1,
        sourcePath: "docs:/",
        consistency: "live",
        failures: []
      });
      expect(manifest.files[0]).toMatchObject({ path: "/secure.txt", size: "secret export".length });
      expect(logs.some((line) => line.includes("Exported 1 file"))).toBe(true);
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACTIVEFS_TEST_EXPORT_TOKEN;
      } else {
        process.env.ACTIVEFS_TEST_EXPORT_TOKEN = previousToken;
      }
      logSpy.mockRestore();
    }
  });

  it("exports configured ActiveFS remotes as revision-pinned only when revisions match", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const outDir = join(tempDir, "exported-revision");
    const server = await startActiveFSServer({
      tree: createRevisionedTree("rev-1")
    });
    sourceServers.push(server);

    await addSourceRemote(rootDir, "docs", "/docs", server.url);
    await main(["export", "docs:/", "--to", outDir, "--root", rootDir, "--tree-revision", "rev-1"]);

    const manifest = JSON.parse(await readFile(join(outDir, "activefs-export-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourcePath: "docs:/",
      consistency: "revision-pinned",
      treeRevision: "rev-1",
      warnings: [],
      failures: [],
      files: [
        expect.objectContaining({
          path: "/a.txt",
          revision: "rev-1",
          size: "alpha".length
        })
      ]
    });

    await expect(main([
      "export",
      "docs:/",
      "--to",
      join(tempDir, "exported-wrong-revision"),
      "--root",
      rootDir,
      "--tree-revision",
      "rev-2"
    ])).rejects.toThrow("Exported file is not at requested tree revision: /a.txt");
  });

  it("serves multiple configured ActiveFS remotes through one WebDAV namespace", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const repoServer = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/a.txt": "repo bytes" }, writable: true })
    });
    const logsServer = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/events.txt": "log bytes" } })
    });
    sourceServers.push(repoServer, logsServer);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "repo", "/repo", repoServer.url);
      await addSourceRemote(rootDir, "logs", "/logs", logsServer.url);
      await addWebDAVRemote(rootDir, "dev");
      const configPath = join(rootDir, "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.remotes.dev.policy = {
        schemaVersion: 1,
        defaultAccess: "writable",
        rules: []
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

      await main(["server", "start", "dev", "--port", "0", "--root", rootDir], {
        waitForInterrupt: async (close) => {
          const serving = logs.find((line) => line.startsWith("ActiveFS mount server serving at "));
          const url = serving!.slice("ActiveFS mount server serving at ".length);
          const repoRead = await fetch(new URL("/repo/a.txt", url));
          const logsRead = await fetch(new URL("/logs/events.txt", url));
          expect(await repoRead.text()).toBe("repo bytes");
          expect(await logsRead.text()).toBe("log bytes");
          const write = await fetch(new URL("/repo/new.txt", url), {
            method: "PUT",
            body: "new bytes"
          });
          expect(write.status).toBe(201);
          await close();
        }
      });
      const journalDir = join(rootDir, "remotes", "repo", "journal");
      const journal = JSON.parse(await readFile(join(journalDir, (await readdir(journalDir))[0]!), "utf8"));
      expect(journal).toMatchObject({
        operation: "write",
        path: "/new.txt",
        status: "committed"
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints grep JSON with limit and case-insensitive defaults", async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main(["grep", "activefs", "/", "--source", "example", "--json", "--limit", "1"]);
      const output = JSON.parse(logs[0]!);
      expect(output).toMatchObject({
        path: "/",
        query: {
          pattern: "activefs",
          caseSensitive: false,
          maxResults: 1
        },
        strategy: "scan",
        complete: false
      });
      expect(output.matches).toHaveLength(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("exposes command-aware ls, cat, head, tail, sed, rg, and find aliases", async () => {
    const logs: string[] = [];
    const writes: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await main(["ls", "/", "--source", "example"]);
      await main(["cat", "/hello.md", "--source", "example"]);
      await main(["head", "/hello.md", "--lines", "1", "--source", "example"]);
      await main(["tail", "/hello.md", "--lines", "1", "--source", "example"]);
      await main(["sed", "/hello.md", "ActiveFS", "filesystem", "--global", "--source", "example"]);
      await main(["rg", "activefs", "/", "--json", "--limit", "1", "--source", "example"]);
      await main(["find", "/search", "--source", "example"]);

      expect(logs.some((line) => line.includes("/hello.md"))).toBe(true);
      expect(writes).toContain("# Hello ActiveFS\n\nThis file is served by an in-memory tree.\n");
      expect(writes).toContain("# Hello ActiveFS\n");
      expect(writes).toContain("This file is served by an in-memory tree.\n");
      expect(writes).toContain("# Hello filesystem\n\nThis file is served by an in-memory tree.\n");
      expect(JSON.parse(logs.find((line) => line.startsWith("{") && line.includes('"query"'))!))
        .toMatchObject({ strategy: "scan", complete: false });
      expect(logs).toContain("/search/indexed.md");
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  it("fails closed when a direct command has no configured source", async () => {
    const tempDir = await makeTempDir();
    await expect(main(["list", "/", "--root", join(tempDir, ".activefs")]))
      .rejects.toThrow("No ActiveFS sources are configured");
  });

  it("runs status, refresh, and unmount lifecycle commands with fake rclone commands", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addWebDAVRemote(rootDir);
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          pid: 1234,
          mounted: true,
          rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(runtimeDir, "rclone-rc-credentials.json"),
        JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
      );

      const runner = commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" },
        rclone: { status: 0, stdout: "ok\n", stderr: "" },
        umount: { status: 0, stdout: "", stderr: "" }
      }, calls);

      await main(["mount", "status", "local", "--root", rootDir], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["refresh", "local:/docs", "--root", rootDir, "--recursive"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["unmount", "local", "--root", rootDir], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });

      expect(logs.some((line) => line.includes("local: mounted"))).toBe(true);
      expect(logs.some((line) => line === "  mount: mounted")).toBe(true);
      expect(logs.some((line) => line.includes("rc: 127.0.0.1:5572"))).toBe(true);
      expect(logs.some((line) => line.includes("local: refreshed /docs recursively"))).toBe(true);
      expect(logs.some((line) => line.includes("local: unmounted"))).toBe(true);
      expect(calls.some((call) => call.command === "rclone" && call.args.includes("vfs/refresh"))).toBe(true);
      expect(calls.some((call) => call.command === "umount" && call.args[0] === vfsDir)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints JSON for doctor, mount status, and refresh", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const runner = commandRunnerWithCalls({
      rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
      mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
    });

    try {
      await addWebDAVRemote(rootDir);
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(runtimeDir, "rclone-rc-credentials.json"),
        JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
      );

      logs.length = 0;
      await main(["doctor", "--mounts", "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "aix",
        fetch: okFetch()
      });
      await main(["mount", "status", "local", "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["refresh", "local:/docs", "--root", rootDir, "--recursive", "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });

      const doctor = JSON.parse(logs[0]!);
      const status = JSON.parse(logs[1]!);
      const refresh = JSON.parse(logs[2]!);
      expect(doctor.host.backend).toBe("unsupported");
      expect(status.remotes[0].state).toBe("mounted");
      expect(refresh.ok).toBe(true);
      expect(refresh.path).toBe("/docs");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("uses mount/server labels for unreachable mounted-folder status", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addWebDAVRemote(rootDir);
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );

      await main(["mount", "status", "local", "--root", rootDir], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
        }),
        platform: "darwin",
        fetch: async () => {
          throw new Error("fetch failed");
        }
      });

      expect(logs).toContain("local: server-down (mounted)");
      expect(logs.some((line) => line.startsWith("  server: down"))).toBe(true);
      expect(logs.some((line) => line.includes("webdav"))).toBe(false);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints help, empty workspace text, and validates user-facing command errors", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await main([]);
      await main(["help"]);
      await main(["--help"]);
      await main(["-h"]);
      await main(["tui", "--help"]);
      await main(["list", "/", "--source", "example"]);
      await main(["grep", "/", "ActiveFS", "--source", "example", "--case-sensitive", "--limit", "1", "--include-non-enumerable"]);
      await main(["remote", "list", "--root", rootDir]);
      await main(["mount", "status", "--root", rootDir]);
      await main(["cache", "status", "--root", rootDir]);
      await main(["logs", "--root", rootDir]);

      await main(["remote", "add", "local", "http://127.0.0.1:3999/activefs/v1", "--root", rootDir, "--no-check"]);
      await expect(main(["unknown"])).rejects.toThrow("Unknown command");
      await expect(main(["stat", "/missing.txt", "--source", "example"])).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(main(["grep", "--source", "example"])).rejects.toThrow("Usage: activefs grep");
      await expect(main(["grep", "ActiveFS", "--source", "example", "--limit", "0"])).rejects.toThrow("positive integer");
      await expect(
        main(["remote", "add", "bad", "http://127.0.0.1:3847", "--root", rootDir, "--protocol", "bad"])
      ).rejects.toThrow("omit --protocol");
      await expect(
        main(["remote", "add", "bad", "http://127.0.0.1:3847", "--root", rootDir, "--activity-policy", "always"])
      ).rejects.toThrow("--activity-policy");
      await expect(main(["remote", "add", "bad", "not-a-url", "--root", rootDir]))
        .rejects.toThrow("Invalid Source API discovery URL");
      await expect(main(["remote", "add", "offline", "http://127.0.0.1:3999/activefs/v1", "--root", rootDir], {
        fetch: async () => {
          throw new Error("connect ECONNREFUSED");
        }
      })).rejects.toThrow("--no-check");
      await expect(main(["remote", "nonsense"])).rejects.toThrow("Usage: activefs remote");
      await expect(main(["remote", "remove", "local", "--root", rootDir, "--unexpected"]))
        .rejects.toThrow("Usage: activefs remote remove");
      await expect(main(["remote", "status", "missing", "--root", rootDir])).rejects.toThrow("activefs remote list");
      await expect(main(["status", "missing", "--root", rootDir])).rejects.toThrow("configured remotes and mountpoints");
      await expect(main(["auth", "set", "missing", "--root", rootDir, "--env", "TOKEN"])).rejects.toThrow("Unknown ActiveFS remote");
      await expect(
        main(["auth", "set", "local", "--root", rootDir, "--env", "TOKEN", "--static-header", "X:TOKEN"])
      ).rejects.toThrow("Usage: activefs auth set");
      await expect(main(["auth", "set", "local", "--root", rootDir, "--static-header", "broken"])).rejects.toThrow("--static-header");
      await expect(main(["auth", "status", "missing", "--root", rootDir])).rejects.toThrow("Unknown ActiveFS remote");
      await expect(main(["auth", "clear", "missing", "--root", rootDir])).rejects.toThrow("Unknown ActiveFS remote");
      await expect(main(["webdav", "serve"])).rejects.toThrow("Unknown command");
      await expect(main(["watch", "/", "--out", "copied"])).rejects.toThrow("activefs watch is no longer a public command");
      await expect(main(["server", "start", "--auth", "bad", "--source", "example"])).rejects.toThrow("username:password");
      await expect(main(["server", "start", "--protocol", "source-api"])).rejects.toThrow("--protocol must be webdav");
      await expect(main(["server", "nonsense"])).rejects.toThrow("Usage: activefs server");
      await expect(main(["cache", "nonsense"])).rejects.toThrow("Usage: activefs cache");
      await expect(main(["doctor", "--bad"])).rejects.toThrow("Usage: activefs doctor");
      await expect(main(["sync"])).rejects.toThrow("Usage: activefs sync");
      await expect(main(["sync", "remote", "nonsense"])).rejects.toThrow("Usage: activefs sync");

      const helpText = logs.join("\n");
      expect(helpText).toContain("activefs <command>");
      expect(helpText).toContain("activefs mount [remote] [mountpoint] [--read-only] [--cache]");
      expect(helpText).toContain("activefs server start [remote] [--host 127.0.0.1] [--port 3847] [--auth username:password]");
      expect(helpText).toContain("--auth enables optional HTTP Basic authentication");
      expect(helpText).toContain("this does not configure Source API or MCP authentication");
      expect(helpText).toContain("Command-line passwords may appear in shell history or process listings");
      expect(helpText.match(/activefs mount \[remote\]/g)).toHaveLength(4);
      expect(helpText).toContain("ActiveFS developer/operator terminal UI");
      expect(helpText).toContain("Health    Source API");
      expect(helpText).toContain("d                 save redacted diagnostics snapshot");
      expect(helpText).not.toContain("activefs webdav");
      expect(helpText).not.toContain("activefs watch");
      expect(logs.some((line) => line.includes("/hello.md"))).toBe(true);
      expect(logs.some((line) => line.startsWith("# activefs grep:"))).toBe(true);
      expect(logs).toContain("No ActiveFS remotes configured.");
      expect(logs).toContain("No ActiveFS remotes configured.");
      expect(logs).toContain("No ActiveFS mounts configured.");
      expect(logs).toContain("No ActiveFS caches configured.");
      expect(logs).toContain("No ActiveFS logs configured.");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints rich status, cache, and log text for configured runtime state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const cacheDir = join(rootDir, "remotes", "local", "cache");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      const mountpoint = join(tempDir, "mounted");
      await addWebDAVRemote(rootDir, "local");
      const configPath = join(rootDir, "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.remotes.local.mountpoint = mountpoint;
      config.mountpoints = {
        [mountpoint]: { remote: "local", stateRoot: tempDir, mountpoint }
      };
      config.remotes.local.auth = { type: "static-header", header: "x-token", env: "ACTIVEFS_TOKEN" };
      config.remotes.local.policy = {
        schemaVersion: 1,
        defaultAccess: "writable",
        revision: "rev-1",
        digest: "sha-256:policy",
        rules: [{ match: { path: "/uploads/**" }, access: "writable" }]
      };
      config.remotes.local.cacheMode = "realtime/coherent";
      config.remotes.local.adapterCapabilityProfile = "full-filesystem-semantics";
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await mkdir(join(cacheDir, "content"), { recursive: true });
      await mkdir(join(runtimeDir), { recursive: true });
      await writeFile(join(cacheDir, "content", "a.bin"), "abc");
      await writeFile(join(runtimeDir, "webdav.log"), "webdav one\nwebdav two\n");
      await writeFile(join(runtimeDir, "rclone.log"), "rclone one\nrclone two\n");
      await writeFile(join(runtimeDir, "session.json"), JSON.stringify({
        state: "coherent",
        sessionId: "session-1",
        lastEventSequence: 2,
        lastAckSequence: 2
      }));
      await mkdir(join(rootDir, "remotes", "local", "journal"), { recursive: true });
      await writeFile(join(rootDir, "remotes", "local", "journal", "operation.json"), JSON.stringify({
        operationId: "op-1",
        status: "pending"
      }));
      await mkdir(join(rootDir, "remotes", "local", "activity"), { recursive: true });
      await writeFile(join(rootDir, "remotes", "local", "activity", "backlog.json"), "{}");
      await writeMountedStatus(rootDir, "local");
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir: mountpoint,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );

      await main(["status", "--root", rootDir], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: `rclone on ${mountpoint} type macfuse\n`, stderr: "" }
        }),
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["cache", "status", "local", "--root", rootDir]);
      await main(["logs", "local", "--root", rootDir, "--lines", "1"]);

      const text = logs.join("\n");
      expect(text).toContain("local: activefs (mounted)");
      expect(text).toContain("policy: writable, 1 rule, revision rev-1, digest sha-256:policy");
      expect(text).toContain("cache: realtime/coherent, 1 files, 3 bytes");
      expect(text).toContain("session: state=coherent, id=session-1");
      expect(text).toContain("operations: 1 unresolved");
      expect(text).toContain("activity: best-effort, 1 backlog file");
      expect(text).toContain("content: 1 files, 3 bytes");
      expect(text).toContain("webdav two");
      expect(text).toContain("rclone two");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reconciles committed Source API operation journal entries during status", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const server = await startActiveFSServer({
      tree: createMemoryTree({
        files: {},
        writable: true
      })
    });
    sourceServers.push(server);
    const client = createHttpSourceClient({ url: server.url });
    const writeResult = await client.write!({}, "/committed.txt", "ok");
    const operationId = mutationOperationId(writeResult);
    const operationStatusEndpoint = mutationOperationStatusEndpoint(writeResult);
    expect(operationId).toBeDefined();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", server.url);
      const journalDir = join(rootDir, "remotes", "docs", "journal");
      await mkdir(journalDir, { recursive: true });
      const journalPath = join(journalDir, `${operationId}.json`);
      await writeFile(journalPath, JSON.stringify({
        schemaVersion: 1,
        remoteName: "docs",
        operationId,
        operationStatusEndpoint,
        operation: "write",
        path: "/committed.txt",
        status: "pending",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }));

      await main(["status", "docs", "--root", rootDir, "--json"], { fetch });

      const status = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      const journal = JSON.parse(await readFile(journalPath, "utf8"));
      expect(status.remotes[0].operations).toMatchObject({
        unresolvedCount: 0,
        ids: []
      });
      expect(journal.status).toBe("committed");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("routes sync watch through Source API sessions and records freshness state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const server = await startActiveFSServer({
      tree: createMemoryTree({ files: { "/note.txt": "watch" }, watchable: true })
    });
    sourceServers.push(server);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", server.url);
      await addWebDAVRemote(rootDir, "local");
      await main([
        "sync",
        "local",
        "watch",
        "--root",
        rootDir,
        "--source-remote",
        "docs"
      ], {
        waitForInterrupt: async (close) => {
          expect(logs).toContain("docs: invalidation session");
          await close();
        },
        fetch
      });

      const freshness = JSON.parse(await readFile(join(rootDir, "remotes", "local", "runtime", "freshness.json"), "utf8"));
      expect(freshness).toMatchObject({
        remote: "local",
        mode: "stopped",
        active: false,
        sources: ["docs"]
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("fails cache watch closed when Source API session SSE cannot start", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const failingFetch = (async () => new Response(JSON.stringify({
      error: {
        name: "ActiveFSTreeUnavailableError",
        code: "SOURCE_UNAVAILABLE",
        message: "sessions down"
      }
    }), {
      status: 503,
      headers: { "content-type": "application/json" }
    })) as typeof fetch;

    await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1");
    await addWebDAVRemote(rootDir, "local");
    const configPath = join(rootDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.remotes.docs.cacheMode = "realtime/coherent";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(main([
      "cache",
      "watch",
      "local",
      "--root",
      rootDir,
      "--source-remote",
      "docs"
    ], {
      fetch: failingFetch
    })).rejects.toThrow("Source API session SSE for docs is unavailable");

    const freshness = JSON.parse(await readFile(join(rootDir, "remotes", "local", "runtime", "freshness.json"), "utf8"));
    const session = JSON.parse(await readFile(join(rootDir, "remotes", "docs", "runtime", "session.json"), "utf8"));
    const updatedConfig = JSON.parse(await readFile(configPath, "utf8"));
    expect(freshness).toMatchObject({
      remote: "local",
      mode: "unavailable",
      active: false,
      sources: ["docs"]
    });
    expect(session).toMatchObject({
      state: "failed",
      mode: "session",
      cacheMode: "off"
    });
    expect(updatedConfig.remotes.docs.cacheMode).toBe("off");
  });

  it("covers command aliases, selection errors, and protocol validation", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await expect(main([
        "remote",
        "add",
        "bad",
        "http://127.0.0.1:3847",
        "--root",
        rootDir,
        "--protocol",
        "ftp"
      ])).rejects.toThrow("omit --protocol");
      await expect(main([
        "remote",
        "add",
        "bad",
        "http://127.0.0.1:3847",
        "--root",
        rootDir,
        "--protocol",
        "webdav"
      ])).rejects.toThrow("omit --protocol");
      await expect(main([
        "remote",
        "add",
        "bad",
        "http://127.0.0.1:3847",
        "--root",
        rootDir,
        "--activity-policy",
        "always"
      ])).rejects.toThrow("--activity-policy must be");
      await expect(main(["server", "start", "--root", rootDir, "--protocol", "source-api"]))
        .rejects.toThrow("--protocol must be webdav");

      await addWebDAVRemote(rootDir, "one");
      await expect(main(["mount", "one", "--root", rootDir], {
        commandRunner: commandRunnerWithCalls({}),
        fetch: okFetch()
      })).rejects.toThrow("Run activefs doctor --mounts");
      await addWebDAVRemote(rootDir, "two", "http://127.0.0.1:3848");
      logs.length = 0;
      await main(["remote", "ls", "--root", rootDir]);
      await expect(main(["mount", "--root", rootDir], {
        commandRunner: commandRunnerWithCalls({ mount: { status: 0, stdout: "", stderr: "" } })
      })).rejects.toThrow("Select a remote: one, two");
      await expect(main(["mount", "missing", "--root", rootDir])).rejects.toThrow("Unknown ActiveFS mount remote");
      await expect(main(["status", "missing", "--root", rootDir])).rejects.toThrow("Unknown ActiveFS remote or mountpoint");
      await expect(main(["cache", "watch", "local", "--root", rootDir, "--source-remote", "missing"]))
        .rejects.toThrow("Unknown ActiveFS remote");
      await expect(main(["sync", "local", "watch", "--root", rootDir, "--poll-interval", "10"]))
        .rejects.toThrow("--poll-interval is not supported");
      await expect(main(["logs", "one", "--root", rootDir, "--lines", "0"])).rejects.toThrow("positive integer");
      await expect(main(["refresh", "bad", "--root", rootDir])).rejects.toThrow("remote:/path");

      expect(logs.join("\n")).toContain("one: http://127.0.0.1:3847 (namespace /one)");
      expect(logs.join("\n")).toContain("two: http://127.0.0.1:3848 (namespace /two)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("supports top-level sync status and refresh spellings", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const runner = commandRunnerWithCalls({
      rclone: { status: 0, stdout: "ok\n", stderr: "" },
      mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
    }, calls);

    try {
      await addWebDAVRemote(rootDir);
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(runtimeDir, "rclone-rc-credentials.json"),
        JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
      );

      logs.length = 0;
      await main(["sync", "local", "status", "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["sync", "status", "local", "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["sync", "local", "refresh", "/docs", "--root", rootDir, "--recursive", "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });
      await main(["sync", "refresh", "local", "/notes", "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });

      const outputs = logs.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
      expect(outputs[0].remotes[0]).toMatchObject({ remote: "local", state: "mounted" });
      expect(outputs[1].remotes[0]).toMatchObject({ remote: "local", state: "mounted" });
      expect(outputs[2]).toMatchObject({ remote: "local", path: "/docs", recursive: true, ok: true });
      expect(outputs[3]).toMatchObject({ remote: "local", path: "/notes", recursive: false, ok: true });
      expect(calls.filter((call) => call.command === "rclone" && call.args.includes("vfs/refresh"))).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("prints top-level status for a remote or configured mountpoint", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");
    const remoteDir = join(rootDir, "remotes", "local");
    const runtimeDir = join(remoteDir, "runtime");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const runner = commandRunnerWithCalls({
      mount: { status: 0, stdout: `rclone on ${mountpoint} type macfuse\n`, stderr: "" }
    });

    try {
      await addWebDAVRemote(rootDir);
      const configPath = join(rootDir, "config.json");
      const config = JSON.parse(await readFile(configPath, "utf8"));
      config.remotes.local.mountpoint = mountpoint;
      config.remotes.local.auth = { type: "bearer-env", env: "ACTIVEFS_TOKEN" };
      config.remotes.local.activityPolicy = "required";
      config.remotes.local.policy = {
        schemaVersion: 1,
        defaultAccess: "writable",
        revision: "policy-1",
        digest: "sha-256:policy",
        rules: []
      };
      config.mountpoints = {
        [mountpoint]: { remote: "local", stateRoot: tempDir, mountpoint }
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      await mkdir(join(remoteDir, "journal"), { recursive: true });
      await mkdir(join(remoteDir, "activity"), { recursive: true });
      await writeFile(join(remoteDir, "journal", "op-1.json"), JSON.stringify({
        operationId: "op-1",
        status: "pending"
      }));
      await writeFile(join(remoteDir, "activity", "activity-1.json"), "{}");
      await writeFile(
        join(runtimeDir, "session.json"),
        JSON.stringify({
          state: "coherent",
          sessionId: "session-1",
          lastEventId: "session-1:7",
          lastAckSequence: 6,
          lastResyncAt: "2026-06-25T00:00:00.000Z"
        })
      );
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir: mountpoint,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );

      logs.length = 0;
      await main(["status", mountpoint, "--root", rootDir, "--json"], {
        commandRunner: runner,
        platform: "darwin",
        fetch: okFetch()
      });

      const status = JSON.parse(logs[0]!);
      expect(status.remotes[0]).toMatchObject({
        name: "local",
        mountpoint,
        auth: { type: "bearer-env", env: "ACTIVEFS_TOKEN" },
        policy: {
          defaultAccess: "writable",
          revision: "policy-1",
          digest: "sha-256:policy",
          ruleCount: 0
        },
        adapterCapabilityProfile: "full-filesystem-semantics",
        cache: { mode: "off" },
        mount: { state: "mounted", mounted: true },
        session: {
          state: "coherent",
          sessionId: "session-1",
          lastEventId: "session-1:7",
          lastAckSequence: 6
        },
        operations: { unresolvedCount: 1, ids: ["op-1"] },
        activity: { policy: "required", backlogCount: 1, files: ["activity-1.json"] }
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("starts and remounts configured mounts through injected rclone hooks", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawned: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    const runner = commandRunnerWithCalls({
      rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
      mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" },
      umount: { status: 0, stdout: "", stderr: "" }
    }, calls);
    const spawner: RcloneMountProcessSpawner = (command, args) => {
      spawned.push({ command, args });
      return {
        pid: 4321 + spawned.length,
        once: () => undefined,
        kill: () => true,
        unref: () => undefined
      };
    };

    try {
      await addWebDAVRemote(rootDir);
      await main(["mount", "local", "--root", rootDir], {
        commandRunner: runner,
        mountProcessSpawner: spawner,
        waitForMountActive: async () => true,
        platform: "darwin",
        fetch: okFetch(),
        webDAVDaemonLauncher: async () => ({ pid: 2468, url: "http://127.0.0.1:3847/" })
      });
      await main(["remount", "local", "--root", rootDir], {
        commandRunner: runner,
        mountProcessSpawner: spawner,
        waitForMountActive: async () => true,
        platform: "darwin",
        fetch: okFetch(),
        webDAVDaemonLauncher: async () => ({ pid: 2469, url: "http://127.0.0.1:3847/" })
      });

      expect(spawned).toHaveLength(2);
      expect(spawned.every((call) => call.command === "rclone")).toBe(true);
      expect(spawned[0]?.args).toContain("mount");
      expect(calls.some((call) => call.command === "umount" && call.args[0] === vfsDir)).toBe(true);
      expect(logs.filter((line) => line.includes("local: mounted"))).toHaveLength(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("records a visible mountpoint passed to mount after remote add", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");
    const spawned: Array<{ command: string; args: string[] }> = [];

    await addWebDAVRemote(rootDir);
    await main(["mount", "local", mountpoint, "--root", rootDir], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${mountpoint} type macfuse\n`, stderr: "" }
      }),
      mountProcessSpawner: fakeSpawner(4321, spawned),
      waitForMountActive: async () => true,
      platform: "darwin",
      fetch: okFetch(),
      webDAVDaemonLauncher: async () => ({ pid: 2468, url: "http://127.0.0.1:3847/" })
    });

    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    expect(config.remotes.local.mountpoint).toBe(mountpoint);
    expect(config.remotes.local.managedWebDAV).toMatchObject({ enabled: true });
    expect(config.mountpoints[mountpoint]).toMatchObject({ remote: "local" });
    expect(spawned.some((call) => call.command === "rclone" && call.args.includes(mountpoint))).toBe(true);
    expect(spawned.some((call) => {
      const index = call.args.indexOf("--vfs-cache-mode");
      return index >= 0 && call.args[index + 1] === "off";
    })).toBe(true);
  });

  it("enables the mounted adapter cache only when requested", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");
    const spawned: Array<{ command: string; args: string[] }> = [];

    await addWebDAVRemote(rootDir);
    await main(["mount", "local", mountpoint, "--root", rootDir, "--cache"], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${mountpoint} type macfuse\n`, stderr: "" }
      }),
      mountProcessSpawner: fakeSpawner(4321, spawned),
      waitForMountActive: async () => true,
      platform: "darwin",
      fetch: okFetch(),
      webDAVDaemonLauncher: async () => ({ pid: 2468, url: "http://127.0.0.1:3847/" })
    });

    expect(spawned.some((call) => {
      const index = call.args.indexOf("--vfs-cache-mode");
      return index >= 0 && call.args[index + 1] === "full";
    })).toBe(true);
  });

  it("can remove an empty visible mountpoint after unmount", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");

    await mkdir(mountpoint, { recursive: true });
    await addWebDAVRemote(rootDir);
    const configPath = join(rootDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.remotes.local.mountpoint = mountpoint;
    config.mountpoints = {
      [mountpoint]: { remote: "local", stateRoot: tempDir, mountpoint }
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const staleRcCredentialsPath = join(rootDir, "remotes", "local", "runtime", "rclone-rc-credentials.json");
    await writeFile(
      staleRcCredentialsPath,
      JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret" })
    );

    await main(["unmount", "local", "--root", rootDir], {
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      platform: "darwin",
      fetch: okFetch()
    });

    await expect(stat(mountpoint)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(staleRcCredentialsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the visible mountpoint after unmount when requested", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const mountpoint = join(tempDir, "mounted");

    await mkdir(mountpoint, { recursive: true });
    await addWebDAVRemote(rootDir);
    const configPath = join(rootDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.remotes.local.mountpoint = mountpoint;
    config.mountpoints = {
      [mountpoint]: { remote: "local", stateRoot: tempDir, mountpoint }
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await main(["unmount", "local", "--root", rootDir, "--keep-mountpoint"], {
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: "", stderr: "" }
      }),
      platform: "darwin",
      fetch: okFetch()
    });

    expect((await stat(mountpoint)).isDirectory()).toBe(true);
  });

  it("reuses a recorded internal WebDAV adapter when mounting", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const spawned: Array<{ command: string; args: string[] }> = [];

    await addWebDAVRemote(rootDir);
    await writeFile(
      join(runtimeDir, "webdav.json"),
      `${JSON.stringify({
        remote: "local",
        state: "up",
        url: "http://127.0.0.1:48123/",
        pid: 4242,
        reachable: true,
        updatedAt: new Date().toISOString()
      }, null, 2)}\n`
    );

    await main(["mount", "local", "--root", rootDir], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        "/opt/activefs-rclone": { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
      }),
      mountProcessSpawner: fakeSpawner(7777, spawned),
      waitForMountActive: async () => true,
      platform: "darwin",
      fetch: okFetch(),
      webDAVDaemonLauncher: async () => {
        throw new Error("should reuse recorded adapter");
      }
    });

    const rcloneConfig = await readFile(join(runtimeDir, "rclone.conf"), "utf8");
    expect(rcloneConfig).toContain("url = http://127.0.0.1:48123/");
    expect(spawned).toHaveLength(1);
  });

  it("rejects invalid managed WebDAV adapter targets before mounting", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    await addWebDAVRemote(rootDir, "local", "http://127.0.0.1:3847", ["--manage-webdav"]);
    const configPath = join(rootDir, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));

    config.remotes.local.managedWebDAV = { enabled: true, host: "0.0.0.0" };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await expect(main(["mount", "local", "--root", rootDir], {
      commandRunner: commandRunnerWithCalls({}),
      fetch: okFetch()
    })).rejects.toThrow("loopback adapters");

    config.remotes.local.managedWebDAV = { enabled: true, host: "127.0.0.1", port: -1 };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await expect(main(["mount", "local", "--root", rootDir], {
      commandRunner: commandRunnerWithCalls({}),
      fetch: okFetch()
    })).rejects.toThrow("invalid port");
  });

  it("launches automatic freshness watch when mounting with ActiveFS remotes", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const daemonSpawns: Array<{
      command: string;
      args: string[];
      detached?: boolean;
      stdio?: unknown;
    }> = [];
    const spawner: RcloneMountProcessSpawner = () => ({
      pid: 5001,
      once: () => undefined,
      kill: () => true,
      unref: () => undefined
    });

    await addSourceRemote(rootDir, "docs", "/docs", "http://127.0.0.1:3999/activefs/v1");
    await addWebDAVRemote(rootDir);
    await main(["mount", "local", "--root", rootDir, "--rclone", "/opt/activefs-rclone"], {
      commandRunner: commandRunnerWithCalls({
        rclone: { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        "/opt/activefs-rclone": { status: 0, stdout: "rclone v1.70.0\n", stderr: "" },
        mount: { status: 0, stdout: `rclone on ${vfsDir} type macfuse\n`, stderr: "" }
      }),
      mountProcessSpawner: spawner,
      waitForMountActive: async () => true,
      platform: "darwin",
      fetch: okFetch(),
      webDAVDaemonLauncher: async () => ({ pid: 2468, url: "http://127.0.0.1:3847/" }),
      daemonProcessSpawner: (command, args, options) => {
        daemonSpawns.push({
          command,
          args,
          detached: options.detached,
          stdio: options.stdio
        });
        return {
          pid: 6001,
          unref: () => undefined
        };
      }
    });

    const freshness = JSON.parse(
      await readFile(join(rootDir, "remotes", "local", "runtime", "freshness.json"), "utf8")
    );
    expect(daemonSpawns).toHaveLength(1);
    expect(daemonSpawns[0]).toMatchObject({
      command: process.execPath,
      detached: true,
      stdio: "ignore"
    });
    expect(daemonSpawns[0]!.args[0]).toEqual(expect.any(String));
    expect(daemonSpawns[0]!.args.slice(1)).toEqual([
      "cache",
      "watch",
      "local",
      "--root",
      rootDir,
      "--source-remote",
      "docs",
      "--source-remote",
      "local",
      "--rclone",
      "/opt/activefs-rclone"
    ]);
    expect(freshness).toMatchObject({
      remote: "local",
      mode: "starting",
      active: true,
      pid: 6001,
      sources: ["docs", "local"]
    });
  });

  it("prints and mutates cache and log state", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const remoteDir = join(rootDir, "remotes", "local");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addWebDAVRemote(rootDir, "local");
      await writeFile(join(remoteDir, "cache", "content", "read.bin"), "cache bytes");
      await writeFile(join(remoteDir, "runtime", "webdav.log"), "webdav first\nwebdav last\n");
      await writeFile(join(remoteDir, "runtime", "rclone.log"), "rclone first\nrclone last\n");

      await main(["cache", "status", "local", "--root", rootDir, "--json"]);
      await main(["logs", "local", "--root", rootDir, "--lines", "1", "--json"]);
      await main(["cache", "clear", "local", "--root", rootDir, "--json"]);

      const jsonLogs = logs.filter((line) => line.startsWith("{"));
      const cacheStatus = JSON.parse(jsonLogs[0]!);
      const logStatus = JSON.parse(jsonLogs[1]!);
      const cacheClear = JSON.parse(jsonLogs[2]!);

      expect(cacheStatus.remotes[0].sections.content.fileCount).toBe(1);
      expect(logStatus.remotes[0]).toMatchObject({
        webdav: "webdav last",
        rclone: "rclone last"
      });
      expect(cacheClear.remotes[0].clearedFiles).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("clears a path-scoped cache key and refreshes rclone when mounted", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const remoteDir = join(rootDir, "remotes", "local");
    const layoutRuntimeDir = join(remoteDir, "runtime");
    const calls: Array<{ command: string; args: string[] }> = [];
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addWebDAVRemote(rootDir);
      const key = activeFSMountCachePathKey("/docs");
      const otherKey = activeFSMountCachePathKey("/other");
      await mkdir(join(remoteDir, "cache", "content", key), { recursive: true });
      await mkdir(join(remoteDir, "cache", "content", otherKey), { recursive: true });
      await writeFile(join(remoteDir, "cache", "content", key, "read.bin"), "docs cache");
      await writeFile(join(remoteDir, "cache", "content", otherKey, "read.bin"), "other cache");
      await writeFile(
        join(layoutRuntimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir: join(remoteDir, "vfs"),
          configPath: join(layoutRuntimeDir, "rclone.conf"),
          logFile: join(layoutRuntimeDir, "rclone.log"),
          mounted: true,
          rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(layoutRuntimeDir, "rclone-rc-credentials.json"),
        JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
      );

      await main(["cache", "clear", "local", "--root", rootDir, "--path", "/docs", "--json"], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: `rclone on ${join(remoteDir, "vfs")} type macfuse\n`, stderr: "" },
          rclone: { status: 0, stdout: "ok\n", stderr: "" }
        }, calls),
        platform: "darwin",
        fetch: okFetch()
      });

      const cleared = JSON.parse(logs.find((line) => line.startsWith("{"))!);
      expect(cleared.remotes[0]).toMatchObject({
        remote: "local",
        path: "/docs",
        clearedFiles: 1,
        refresh: { ok: true }
      });
      await expect(exists(join(remoteDir, "cache", "content", key, "read.bin"))).resolves.toBe(false);
      await expect(exists(join(remoteDir, "cache", "content", otherKey, "read.bin"))).resolves.toBe(true);
      expect(calls.some((call) => call.command === "rclone" && call.args.includes("vfs/refresh"))).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("watches Source API invalidation events and refreshes mounted cache paths", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const remoteDir = join(rootDir, "remotes", "local");
    const previousToken = process.env.ACTIVEFS_TEST_WATCH_TOKEN;
    process.env.ACTIVEFS_TEST_WATCH_TOKEN = "watch-token";
    const tree = createMemoryTree({
      files: { "/note.txt": "old" },
      writable: true,
      watchable: true
    });
    const server = await startActiveFSServer({
      tree,
      auth: { type: "bearer", token: "watch-token" }
    });
    sourceServers.push(server);
    const calls: Array<{ command: string; args: string[] }> = [];
    const fetchCalls: Array<{ method: string; path: string }> = [];
    const fallbackFetch = okFetch();
    const sourceOrigin = new URL(server.url).origin;
    let resolveSessionReady!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });
    const trackingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === sourceOrigin) {
        fetchCalls.push({ method: init?.method ?? "GET", path: url.pathname });
        if (init?.method === "POST" && /\/sessions\/[^/]+\/acks$/.test(url.pathname)) {
          resolveSessionReady();
        }
        return fetch(input, init);
      }
      return fallbackFetch(input, init);
    }) as typeof fetch;
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addSourceRemote(rootDir, "docs", "/docs", server.url);
      await main(["auth", "set", "docs", "--root", rootDir, "--env", "ACTIVEFS_TEST_WATCH_TOKEN"]);
      await addWebDAVRemote(rootDir);
      await writeMountedStatus(rootDir, "local");
      const key = activeFSMountCachePathKey("/docs/note.txt");
      await mkdir(join(remoteDir, "cache", "content", key), { recursive: true });
      await writeFile(join(remoteDir, "cache", "content", key, "read.bin"), "stale");

      await main(["cache", "watch", "local", "--root", rootDir, "--source-remote", "docs"], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: `rclone on ${join(remoteDir, "vfs")} type macfuse\n`, stderr: "" },
          rclone: { status: 0, stdout: "ok\n", stderr: "" }
        }, calls),
        platform: "darwin",
        fetch: trackingFetch,
        waitForInterrupt: async (close) => {
          await sessionReady;
          await tree.write!({}, "/note.txt", "new", { overwrite: true });
          await waitFor(
            () => calls.some((call) => call.command === "rclone" && call.args.includes("dir=docs/note.txt")),
            8000
          );
          await close();
        }
      });

      expect(logs.some((line) => line === "docs: invalidation session")).toBe(true);
      expect(fetchCalls.some((call) => call.method === "POST" && call.path.endsWith("/sessions"))).toBe(true);
      expect(fetchCalls.some((call) => call.method === "GET" && /\/sessions\/[^/]+\/events$/.test(call.path))).toBe(true);
      expect(fetchCalls.some((call) => call.method === "POST" && /\/sessions\/[^/]+\/acks$/.test(call.path))).toBe(true);
      expect(fetchCalls.some((call) => call.method === "POST" && /\/sessions\/[^/]+\/activity$/.test(call.path))).toBe(true);
      await expect(exists(join(remoteDir, "cache", "content", key, "read.bin"))).resolves.toBe(false);
      await expect(exists(join(rootDir, "remotes", "docs", "activity"))).resolves.toBe(false);
    } finally {
      if (previousToken === undefined) {
        delete process.env.ACTIVEFS_TEST_WATCH_TOKEN;
      } else {
        process.env.ACTIVEFS_TEST_WATCH_TOKEN = previousToken;
      }
      logSpy.mockRestore();
    }
  });

  it("records activity backlog and disables cache trust when required session activity reporting fails", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const remoteDir = join(rootDir, "remotes", "local");
    const tree = createMemoryTree({
      files: { "/note.txt": "old" },
      writable: true,
      watchable: true
    });
    const server = await startActiveFSServer({ tree });
    sourceServers.push(server);
    const fallbackFetch = okFetch();
    const sourceOrigin = new URL(server.url).origin;
    const activityCalls: string[] = [];
    let resolveSessionReady!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });
    const failingActivityFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== sourceOrigin) {
        return fallbackFetch(input, init);
      }
      if (init?.method === "POST" && /\/sessions\/[^/]+\/acks$/.test(url.pathname)) {
        resolveSessionReady();
      }
      if (/\/sessions\/[^/]+\/activity$/.test(url.pathname)) {
        activityCalls.push(url.pathname);
        return new Response("{\"error\":{\"name\":\"ActiveFSTreeUnavailableError\",\"code\":\"SOURCE_UNAVAILABLE\",\"message\":\"activity down\"}}\n", {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const calls: Array<{ command: string; args: string[] }> = [];

    await addSourceRemote(rootDir, "docs", "/docs", server.url, ["--activity-policy", "required"]);
    await addWebDAVRemote(rootDir);
    await writeMountedStatus(rootDir, "local");
    const key = activeFSMountCachePathKey("/docs/note.txt");
    await mkdir(join(remoteDir, "cache", "content", key), { recursive: true });
    await writeFile(join(remoteDir, "cache", "content", key, "read.bin"), "stale");

    await main(["cache", "watch", "local", "--root", rootDir, "--source-remote", "docs"], {
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${join(remoteDir, "vfs")} type macfuse\n`, stderr: "" },
        rclone: { status: 0, stdout: "ok\n", stderr: "" }
      }, calls),
      platform: "darwin",
      fetch: failingActivityFetch,
      waitForInterrupt: async (close) => {
        await sessionReady;
        await tree.write!({}, "/note.txt", "new", { overwrite: true });
        await waitFor(() => activityCalls.length > 0, 8000);
        await close();
      }
    });

    const activityDir = join(rootDir, "remotes", "docs", "activity");
    const activityFile = join(activityDir, (await readdir(activityDir))[0]!);
    const activity = JSON.parse(await readFile(activityFile, "utf8"));
    const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
    const session = JSON.parse(await readFile(join(rootDir, "remotes", "docs", "runtime", "session.json"), "utf8"));

    expect(activity).toMatchObject({
      policy: "required",
      operation: "cache.invalidate",
      path: "/note.txt",
      lastError: "activity down"
    });
    expect(config.remotes.docs.cacheMode).toBe("off");
    expect(session).toMatchObject({
      state: "untrusted",
      cacheMode: "off",
      activityPolicy: "required"
    });
  });

  it("does not report session activity when activity policy is off", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const remoteDir = join(rootDir, "remotes", "local");
    const tree = createMemoryTree({
      files: { "/note.txt": "old" },
      writable: true,
      watchable: true
    });
    const server = await startActiveFSServer({ tree });
    sourceServers.push(server);
    const fallbackFetch = okFetch();
    const sourceOrigin = new URL(server.url).origin;
    const activityCalls: string[] = [];
    let resolveSessionReady!: () => void;
    const sessionReady = new Promise<void>((resolve) => {
      resolveSessionReady = resolve;
    });
    const trackingFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== sourceOrigin) {
        return fallbackFetch(input, init);
      }
      if (init?.method === "POST" && /\/sessions\/[^/]+\/acks$/.test(url.pathname)) {
        resolveSessionReady();
      }
      if (/\/sessions\/[^/]+\/activity$/.test(url.pathname)) {
        activityCalls.push(url.pathname);
      }
      return fetch(input, init);
    }) as typeof fetch;
    const calls: Array<{ command: string; args: string[] }> = [];

    await addSourceRemote(rootDir, "docs", "/docs", server.url, ["--activity-policy", "off"]);
    await addWebDAVRemote(rootDir);
    await writeMountedStatus(rootDir, "local");

    await main(["cache", "watch", "local", "--root", rootDir, "--source-remote", "docs"], {
      commandRunner: commandRunnerWithCalls({
        mount: { status: 0, stdout: `rclone on ${join(remoteDir, "vfs")} type macfuse\n`, stderr: "" },
        rclone: { status: 0, stdout: "ok\n", stderr: "" }
      }, calls),
      platform: "darwin",
      fetch: trackingFetch,
      waitForInterrupt: async (close) => {
        await sessionReady;
        await tree.write!({}, "/note.txt", "new", { overwrite: true });
        await waitFor(
          () => calls.some((call) => call.command === "rclone" && call.args.includes("dir=docs/note.txt")),
          8000
        );
        await close();
      }
    });

    expect(activityCalls).toHaveLength(0);
    await expect(exists(join(rootDir, "remotes", "docs", "activity"))).resolves.toBe(false);
  });

  it("records managed WebDAV config and exposes status, stop, and cleanup helpers", async () => {
    const tempDir = await makeTempDir();
    const rootDir = join(tempDir, ".activefs");
    const runtimeDir = join(rootDir, "remotes", "local", "runtime");
    const vfsDir = join(rootDir, "remotes", "local", "vfs");
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });

    try {
      await addWebDAVRemote(rootDir, "local", "http://127.0.0.1:3847", ["--manage-webdav"]);
      const config = JSON.parse(await readFile(join(rootDir, "config.json"), "utf8"));
      expect(config.remotes.local.managedWebDAV).toMatchObject({
        enabled: true,
        host: "127.0.0.1"
      });
      expect(config.remotes.local.managedWebDAV.port).toBeUndefined();

      await writeFile(
        join(runtimeDir, "webdav.json"),
        `${JSON.stringify({
          remote: "local",
          state: "up",
          url: "http://127.0.0.1:3847/",
          pid: 4242,
          reachable: true,
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(runtimeDir, "mount.json"),
        `${JSON.stringify({
          remote: "local",
          state: "mounted",
          rootDir,
          vfsDir,
          configPath: join(runtimeDir, "rclone.conf"),
          logFile: join(runtimeDir, "rclone.log"),
          mounted: true,
          rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
          webdav: {
            remote: "local",
            state: "up",
            url: "http://127.0.0.1:3847/",
            pid: 4242,
            reachable: true,
            updatedAt: new Date().toISOString()
          },
          updatedAt: new Date().toISOString()
        }, null, 2)}\n`
      );
      await writeFile(
        join(runtimeDir, "rclone-rc-credentials.json"),
        JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
      );

      logs.length = 0;
      await main(["server", "status", "local", "--root", rootDir, "--json"], {
        fetch: okFetch()
      });
      await main(["server", "stop", "local", "--root", rootDir, "--json"], {
        processExists: (pid) => pid === 4242,
        terminateProcess: (pid) => pid === 4242
      });
      await main(["mount", "cleanup", "local", "--root", rootDir, "--json"], {
        commandRunner: commandRunnerWithCalls({
          mount: { status: 0, stdout: "", stderr: "" }
        }),
        processExists: () => false,
        fetch: okFetch()
      });

      const webdavStatus = JSON.parse(logs[0]!);
      const stop = JSON.parse(logs[1]!);
      const cleanup = JSON.parse(logs[2]!);
      expect(webdavStatus.remotes[0].state).toBe("up");
      expect(stop.remotes[0].state).toBe("down");
      expect(cleanup.remotes[0].actions.some((action: { kind: string }) => action.kind === "rc-credentials-removed")).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

});

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "activefs-cli-"));
  tempDirs.push(path);
  return path;
}

async function addSourceRemote(
  rootDir: string,
  name: string,
  mountPath: string,
  url: string,
  extraArgs: string[] = []
): Promise<void> {
  await main([
    "remote",
    "add",
    name,
    url,
    "--state-root",
    rootDir,
    "--mount-path",
    mountPath,
    "--no-check",
    ...extraArgs
  ]);
}

async function addWebDAVRemote(
  rootDir: string,
  name = "local",
  url = "http://127.0.0.1:3847",
  extraArgs: string[] = []
): Promise<void> {
  await main([
    "remote",
    "add",
    name,
    url,
    "--state-root",
    rootDir,
    "--mount-path",
    `/${name}`,
    "--no-check",
    ...extraArgs
  ]);
  await mkdir(join(rootDir, "remotes", name, "runtime"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "cache", "meta"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "cache", "content"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "cache", "search"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "cache", "manifests"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "cache", "rclone"), { recursive: true });
  await mkdir(join(rootDir, "remotes", name, "vfs"), { recursive: true });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error("Timed out waiting for condition");
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

async function writeMountedStatus(rootDir: string, remoteName: string): Promise<void> {
  const remoteDir = join(rootDir, "remotes", remoteName);
  const runtimeDir = join(remoteDir, "runtime");
  const vfsDir = join(remoteDir, "vfs");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "mount.json"),
    `${JSON.stringify({
      remote: remoteName,
      state: "mounted",
      rootDir,
      vfsDir,
      configPath: join(runtimeDir, "rclone.conf"),
      logFile: join(runtimeDir, "rclone.log"),
      mounted: true,
      rc: { addr: "127.0.0.1:5572", username: "activefs-rc", hasPassword: true },
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`
  );
  await writeFile(
    join(runtimeDir, "rclone-rc-credentials.json"),
    JSON.stringify({ addr: "127.0.0.1:5572", username: "activefs-rc", password: "secret-rc" })
  );
}

function okFetch(): typeof fetch {
  return (async () => ({
    status: 204,
    ok: true,
    headers: new Headers()
  } as Response)) as typeof fetch;
}

function mutationOperationId(result: ActiveFSTreeMutationResult): string {
  if (result && typeof result === "object" && "operationId" in result && typeof result.operationId === "string") {
    return result.operationId;
  }
  throw new Error("Expected tree mutation to include an operation id.");
}

function mutationOperationStatusEndpoint(result: ActiveFSTreeMutationResult): string {
  if (result && typeof result === "object" && "operationStatusEndpoint" in result &&
    typeof result.operationStatusEndpoint === "string") {
    return result.operationStatusEndpoint;
  }
  throw new Error("Expected tree mutation to include an operation status endpoint.");
}

function createRevisionedTree(revision: string): ActiveFSTree {
  return fsTree<unknown, unknown>({
    "/a.txt": file({
      content: "alpha",
      info: () => ({
        name: "a.txt",
        path: "/a.txt",
        kind: "file",
        size: "alpha".length,
        enumerable: true,
        revision,
        data: { stateHash: `file:${revision}` }
      })
    })
  }, {
    name: "revisioned",
    info: () => ({
      name: "",
      path: "/",
      kind: "directory",
      enumerable: true,
      revision,
      data: { stateHash: `dir:${revision}` }
    })
  });
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

function fakeSpawner(
  pid: number,
  calls: Array<{ command: string; args: string[] }> = []
): RcloneMountProcessSpawner {
  return (command, args) => {
    calls.push({ command, args });
    return {
    pid,
    once: () => undefined,
    kill: () => undefined,
    unref: () => undefined
    };
  };
}
