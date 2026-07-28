import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authHeadersFromProvider,
  clearPrivateAuthSecret,
  createActiveFSRemoteStateLayout,
  discoverActiveFSState,
  ensureActiveFSRemoteStateLayout,
  evaluateActiveFSPolicy,
  loadActiveFSConfig,
  normalizePolicyPath,
  parseCommandArgv,
  recordActiveFSActivityBacklog,
  recordActiveFSOperationJournal,
  removeActiveFSActivityBacklogRecord,
  removeActiveFSRemoteConfig,
  resolveActiveFSState,
  saveActiveFSConfig,
  updateActiveFSOperationJournal,
  upsertActiveFSRemote,
  writeActiveFSSessionState,
  writePrivateBearerToken
} from "@activefs/config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ActiveFS unified config", () => {
  it("resolves state root and .activefs state directory", () => {
    const root = "/tmp/activefs-root";
    const fromRoot = resolveActiveFSState(root);
    const fromStateDir = resolveActiveFSState(join(root, ".activefs"));

    expect(fromRoot.stateRoot).toBe(root);
    expect(fromRoot.stateDir).toBe(join(root, ".activefs"));
    expect(fromStateDir.stateRoot).toBe(root);
    expect(fromStateDir.stateDir).toBe(join(root, ".activefs"));
  });

  it("discovers state roots upward and reports missing state", async () => {
    const root = await makeTempDir();
    const nested = join(root, "a", "b");
    await mkdir(nested, { recursive: true });
    await saveActiveFSConfig(root, { schemaVersion: 1, remotes: {} });

    await expect(discoverActiveFSState(nested)).resolves.toMatchObject({
      stateRoot: root,
      stateDir: join(root, ".activefs")
    });
    await expect(discoverActiveFSState(await makeTempDir())).resolves.toBeNull();
  });

  it("returns an empty unified config when the state root has not been initialized", async () => {
    const root = await makeTempDir();

    await expect(loadActiveFSConfig(root)).resolves.toEqual({
      schemaVersion: 1,
      stateRoot: root,
      remotes: {}
    });
  });

  it("normalizes current ActiveFS remotes without persisting discarded protocol markers", async () => {
    const root = await makeTempDir();
    const staleRemoteInput = {
      name: "docs",
      protocol: "source-api",
      url: "https://source.example/activefs/v1",
      mountPath: "docs",
      remoteRoot: "tenant/docs",
      adapterCapabilityProfile: "bounded-filesystem-semantics"
    } as unknown as Parameters<typeof upsertActiveFSRemote>[1];

    const config = await upsertActiveFSRemote(root, staleRemoteInput);
    const configText = await readFile(join(root, ".activefs", "config.json"), "utf8");

    expect(config.remotes.docs).toMatchObject({
      name: "docs",
      url: "https://source.example/activefs/v1",
      mountPath: "/docs",
      remoteRoot: "/tenant/docs",
      adapterCapabilityProfile: "bounded-filesystem-semantics"
    });
    expect((config.remotes.docs as { protocol?: unknown }).protocol).toBeUndefined();
    expect(configText).not.toContain("\"protocol\"");
  });

  it("records mountpoints outside the state root when upserting remotes", async () => {
    const root = await makeTempDir();
    const mountpoint = join(await makeTempDir(), "mounted");

    const config = await upsertActiveFSRemote(root, {
      name: "repo",
      url: "http://127.0.0.1:3847/",
      mountpoint
    });

    expect(config.mountpoints?.[mountpoint]).toMatchObject({
      remote: "repo",
      mountpoint
    });

    const removed = await removeActiveFSRemoteConfig(root, "repo");
    expect(removed).toMatchObject({ removed: true });
    expect(removed.config.mountpoints?.[mountpoint]).toBeUndefined();
  });

  it("creates remote state layouts and rejects unsafe remote names", async () => {
    const root = await makeTempDir();
    const layout = createActiveFSRemoteStateLayout(root, "docs");
    await ensureActiveFSRemoteStateLayout(layout);

    await expect(readdir(layout.runtimeDir)).resolves.toEqual([]);
    expect(() => createActiveFSRemoteStateLayout(root, "../bad")).toThrow("Invalid ActiveFS remote name");
  });

  it("persists operation journal, activity backlog, and session state under per-remote hidden state", async () => {
    const root = await makeTempDir();
    const config = await upsertActiveFSRemote(root, {
      name: "docs",
      url: "https://source.example/activefs/v1/",
      mountPath: "/docs",
      activityPolicy: "required"
    });
    const layout = createActiveFSRemoteStateLayout(root, "docs");

    await recordActiveFSOperationJournal(layout, {
      operationId: "op-1",
      operation: "write",
      path: "/docs/a.txt",
      status: "pending",
      startedAt: "2026-06-25T00:00:00.000Z"
    });
    await updateActiveFSOperationJournal(layout, "op-1", {
      status: "committed",
      completedAt: "2026-06-25T00:00:01.000Z"
    });
    await recordActiveFSActivityBacklog(layout, {
      activityId: "activity-1",
      policy: "required",
      sessionId: "session-1",
      operation: "read",
      path: "/docs/a.txt",
      timestamp: "2026-06-25T00:00:02.000Z",
      source: "cache",
      result: "unknown",
      lastError: "activity endpoint unavailable"
    });
    await writeActiveFSSessionState(layout, {
      state: "untrusted",
      sessionId: "session-1",
      mode: "session",
      cacheMode: "off",
      activityPolicy: "required",
      lastFailureReason: "activity endpoint unavailable"
    });

    const journalFile = join(layout.journalDir, (await readdir(layout.journalDir))[0]!);
    const activityFile = join(layout.activityDir, (await readdir(layout.activityDir))[0]!);
    const journal = JSON.parse(await readFile(journalFile, "utf8"));
    const activity = JSON.parse(await readFile(activityFile, "utf8"));
    const session = JSON.parse(await readFile(layout.sessionPath, "utf8"));

    expect(config.remotes.docs.activityPolicy).toBe("required");
    expect(journal).toMatchObject({ operationId: "op-1", status: "committed", path: "/docs/a.txt" });
    expect(activity).toMatchObject({ policy: "required", operation: "read", source: "cache" });
    expect(session).toMatchObject({ state: "untrusted", cacheMode: "off", activityPolicy: "required" });

    await removeActiveFSActivityBacklogRecord(layout, "activity-1");
    await expect(readdir(layout.activityDir)).resolves.toEqual([]);
  });

  it("uses ordered first-match policy rules with exact, prefix, and glob matchers", () => {
    const policy = {
      schemaVersion: 1 as const,
      defaultAccess: "readonly" as const,
      rules: [
        { match: { type: "exact" as const, path: "/locked.txt" }, access: "readonly" as const },
        { match: { type: "prefix" as const, path: "/writable" }, access: "writable" as const },
        { match: { type: "glob" as const, path: "/docs/**/*.md" }, deny: ["write" as const] }
      ]
    };

    expect(evaluateActiveFSPolicy(policy, "write", "/locked.txt")).toMatchObject({ allowed: false });
    expect(evaluateActiveFSPolicy(policy, "mkdir", "/writable/new")).toMatchObject({ allowed: true });
    expect(evaluateActiveFSPolicy(policy, "write", "/docs/a/readme.md")).toMatchObject({ allowed: false });
    expect(evaluateActiveFSPolicy(undefined, "read", "/anything")).toMatchObject({ allowed: true });
    expect(evaluateActiveFSPolicy(undefined, "write", "/anything")).toMatchObject({ allowed: false });
    expect(normalizePolicyPath("docs/../README.md")).toBe("/README.md");
    expect(() => normalizePolicyPath("bad\\path")).toThrow("must use / separators");
    expect(() => normalizePolicyPath("bad\0path")).toThrow("must not contain NUL bytes");
  });

  it("builds auth headers from env, command, and private-token providers", async () => {
    const root = await makeTempDir();
    const layout = createActiveFSRemoteStateLayout(root, "repo");
    await saveActiveFSConfig(root, { schemaVersion: 1, remotes: {} });
    await writePrivateBearerToken(layout, "stored-token");

    await expect(authHeadersFromProvider(
      { type: "bearer-env", env: "ACTIVEFS_TOKEN" },
      { env: { ACTIVEFS_TOKEN: "env-token" } }
    )).resolves.toEqual({ authorization: "Bearer env-token" });
    await expect(authHeadersFromProvider(
      { type: "token-command", argv: ["token"], scheme: "Bearer" },
      { runCommand: async (argv) => argv[0] === "token" ? "cmd-token" : "" }
    )).resolves.toEqual({ authorization: "Bearer cmd-token" });
    await expect(authHeadersFromProvider(
      { type: "private-bearer-token" },
      { layout }
    )).resolves.toEqual({ authorization: "Bearer stored-token" });
    await expect(authHeadersFromProvider(
      { type: "static-header", header: "x-activefs-token", env: "ACTIVEFS_HEADER" },
      { env: { ACTIVEFS_HEADER: "static-token" } }
    )).resolves.toEqual({ "x-activefs-token": "static-token" });
    await expect(authHeadersFromProvider(
      { type: "headers-command", argv: ["headers"] },
      { runCommand: async () => JSON.stringify({ "x-one": "1", ignored: 2 }) }
    )).resolves.toEqual({ "x-one": "1" });
    await expect(authHeadersFromProvider(
      { type: "cookie-provider", argv: ["cookie"] },
      { runCommand: async () => "sid=abc" }
    )).resolves.toEqual({ cookie: "sid=abc" });

    await clearPrivateAuthSecret(layout);
    await expect(authHeadersFromProvider(
      { type: "private-bearer-token" },
      { layout }
    )).resolves.toEqual({});
  });

  it("parses credential commands as argv arrays without shell expansion", () => {
    expect(parseCommandArgv("[\"cmd\",\"--flag\",\"value\"]")).toEqual(["cmd", "--flag", "value"]);
    expect(parseCommandArgv("cmd --flag value")).toEqual(["cmd", "--flag", "value"]);
    expect(() => parseCommandArgv("[]")).toThrow("non-empty string array");
    expect(() => parseCommandArgv("   ")).toThrow("must not be empty");
  });
});

async function makeTempDir(): Promise<string> {
  const path = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "activefs-config-test-"))
  );
  tempDirs.push(path);
  return path;
}
