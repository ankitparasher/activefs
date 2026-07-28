#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createActiveFS, fsTree, text } from "../packages/core/dist/index.js";
import {
  formatRcloneMountHostReport,
  inspectRcloneMountHost,
  startWebDAVServer
} from "../packages/mount/dist/index.js";

const DEFAULT_MOUNT_READY_TIMEOUT_MS = 120000;
const mountDir = readFlag("--mount");
const proofOut = readFlag("--proof-out");
const mountCheck = process.argv.includes("--mount-check");
const mountReadyTimeoutMs = readPositiveIntegerFlag(
  "--mount-ready-timeout-ms",
  DEFAULT_MOUNT_READY_TIMEOUT_MS
);
const rcloneCheck = process.argv.includes("--rclone-check") || Boolean(mountDir) || mountCheck;
const completedChecks = [];

if (process.argv.includes("--doctor")) {
  printMountDoctor();
  process.exit(0);
}

const filesystem = createActiveFS().mount(
  "/",
  fsTree({
    "/hello.md": text("# Hello ActiveFS\n\nRead through WebDAV and rclone.\n", { type: "text/markdown" }),
    "/docs/readme.md": text("Directory listing is backed by ActiveFS list/info.\n", { type: "text/markdown" })
  })
);

const server = await startWebDAVServer({ filesystem });
const authHeader = basicAuth(server.auth);

try {
  await proveWebDAV(server.url, authHeader);
  completedChecks.push("webdav");
  console.log(`ActiveFS WebDAV smoke server: ${server.url}`);

  if (rcloneCheck) {
    await proveRcloneRemote(server);
    completedChecks.push("rclone-webdav");
  }

  if (mountCheck) {
    const ownsTarget = !mountDir;
    const target = mountDir ? resolve(mountDir) : await mkdtemp(join(tmpdir(), "activefs-vfs-"));
    try {
      await proveRcloneMount(target, server, mountReadyTimeoutMs);
      completedChecks.push("real-mount");
      await writeProof("passed");
    } finally {
      if (ownsTarget) {
        await rm(target, { recursive: true, force: true });
      }
    }
    await server.close();
    process.exit(0);
  }

  if (!mountDir) {
    console.log("HTTP smoke passed. To try a real rclone mount, run:");
    console.log("  pnpm build");
    console.log("  pnpm smoke:mount -- --rclone-check");
    console.log("  pnpm smoke:mount -- --mount-check");
    console.log("  pnpm smoke:mount -- --mount /tmp/activefs-vfs");
    await writeProof("passed");
    await server.close();
    process.exit(0);
  }

  await runRcloneMount(resolve(mountDir), server, authHeader);
} catch (error) {
  await writeProof("failed", error);
  await server.close();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function writeProof(status, error) {
  if (!proofOut) {
    return;
  }
  const outputPath = resolve(proofOut);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    platform: process.platform,
    architecture: process.arch,
    nodeVersion: process.version,
    commit: process.env.GITHUB_SHA ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    checks: completedChecks,
    mountReady: mountCheck ? inspectRcloneMountHost().canAttemptMount : undefined,
    mountReadyTimeoutMs: mountCheck ? mountReadyTimeoutMs : undefined,
    error: error instanceof Error ? error.message : error ? String(error) : undefined
  }, null, 2)}\n`);
  console.log(`ActiveFS mount proof: ${outputPath}`);
}

async function proveWebDAV(url, authorization) {
  const propfind = await fetch(url, {
    method: "PROPFIND",
    headers: { Authorization: authorization, Depth: "1" }
  });
  const listing = await propfind.text();
  if (propfind.status !== 207 || !listing.includes("/hello.md")) {
    throw new Error(`WebDAV PROPFIND smoke failed with HTTP ${propfind.status}.`);
  }

  const read = await fetch(new URL("/hello.md", url), {
    headers: { Authorization: authorization }
  });
  const content = await read.text();
  if (read.status !== 200 || !content.includes("Read through WebDAV")) {
    throw new Error(`WebDAV GET smoke failed with HTTP ${read.status}.`);
  }
}

async function proveRcloneRemote(serverHandle) {
  assertRclone();
  const config = await createRcloneConfig(serverHandle);
  try {
    const list = await runCommand("rclone", [
      "lsjson",
      "activefs-smoke:",
      "--config",
      config.configPath
    ]);
    const entries = JSON.parse(list.stdout);
    if (!entries.some((entry) => entry.Name === "hello.md")) {
      throw new Error(`rclone lsjson did not return hello.md: ${list.stdout}`);
    }

    const cat = await runCommand("rclone", [
      "cat",
      "activefs-smoke:hello.md",
      "--config",
      config.configPath
    ]);
    if (!cat.stdout.includes("Read through WebDAV and rclone")) {
      throw new Error(`rclone cat returned unexpected content: ${cat.stdout}`);
    }

    console.log("rclone WebDAV list/read smoke passed.");
  } finally {
    await config.cleanup();
  }
}

async function runRcloneMount(targetDir, serverHandle) {
  assertRclone();
  assertMountPreflight();
  await prepareMountTarget(targetDir);
  const config = await createRcloneConfig(serverHandle);

  console.log(`Mounting activefs-smoke: at ${targetDir}`);
  console.log("Use another terminal to run:");
  console.log(`  ls ${targetDir}`);
  console.log(`  cat ${join(targetDir, "hello.md")}`);
  console.log("Press Ctrl-C to stop the foreground mount.");

  const child = spawn(
    "rclone",
    [
      "mount",
      "activefs-smoke:",
      targetDir,
      "--config",
      config.configPath,
      "--read-only",
      "--vfs-cache-mode",
      "full",
      "--dir-cache-time",
      "10m",
      "--cache-dir",
      config.cacheDir
    ],
    { stdio: "inherit" }
  );

  const shutdown = async () => {
    child.kill("SIGINT");
    await serverHandle.close();
    await config.cleanup();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  child.on("exit", async (code) => {
    await serverHandle.close();
    await config.cleanup();
    process.exitCode = code ?? 1;
  });
}

async function proveRcloneMount(targetDir, serverHandle, readyTimeoutMs) {
  assertRclone();
  assertMountPreflight();
  await prepareMountTarget(targetDir);
  const config = await createRcloneConfig(serverHandle);
  let child;

  try {
    child = spawn("rclone", [
      "mount",
      "activefs-smoke:",
      targetDir,
      "--config",
      config.configPath,
      "--read-only",
      "--vfs-cache-mode",
      "full",
      "--dir-cache-time",
      "10m",
      "--cache-dir",
      config.cacheDir,
      "--log-file",
      config.logFile,
      "--log-level",
      "DEBUG"
    ], { stdio: "ignore" });
    child.on("error", (error) => {
      child.mountError = error;
    });

    const listing = await waitForMountedListing(
      targetDir,
      child,
      config.logFile,
      readyTimeoutMs
    );
    if (!listing.includes("hello.md")) {
      throw new Error(`Mounted listing did not include hello.md: ${listing.join(", ")}`);
    }
    const content = await readFile(join(targetDir, "hello.md"), "utf8");
    if (!content.includes("Read through WebDAV and rclone")) {
      throw new Error(`Mounted read returned unexpected content: ${content}`);
    }
    console.log(`rclone mount list/read smoke passed at ${targetDir}.`);
  } finally {
    if (child) {
      await stopMountProcess(child, targetDir);
    }
    await config.cleanup();
  }
}

async function waitForMountedListing(targetDir, child, logFile, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.mountError) {
      throw child.mountError;
    }
    if (child.exitCode !== null) {
      const log = await readFile(logFile, "utf8").catch(() => "");
      throw new Error(`rclone mount exited with ${child.exitCode}.${log ? `\n\nrclone mount log:\n${log}` : ""}`);
    }
    const listing = await readdir(targetDir).catch(() => []);
    if (listing.includes("hello.md")) {
      return listing;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const log = await readFile(logFile, "utf8").catch(() => "");
  throw new Error(`rclone mount did not become ready within ${timeoutMs}ms.${log ? `\n\nrclone mount log:\n${log}` : ""}`);
}

async function prepareMountTarget(targetDir) {
  if (process.platform !== "win32") {
    await mkdir(targetDir, { recursive: true });
    return;
  }

  const entries = await readdir(targetDir).catch((error) => {
    if (error?.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (entries?.length) {
    throw new Error(`Windows mount target must be absent or empty: ${targetDir}`);
  }
  if (entries) {
    await rm(targetDir, { recursive: true, force: true });
  }
}

async function stopMountProcess(child, targetDir) {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolvePromise) => child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
    ]);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  if (process.platform !== "win32") {
    await unmount(targetDir).catch(() => undefined);
  }
}

async function createRcloneConfig(serverHandle) {
  const workDir = await mkdtemp(join(tmpdir(), "activefs-rclone-"));
  const configPath = join(workDir, "rclone.conf");
  const cacheDir = join(workDir, "cache");
  const logFile = join(workDir, "rclone-mount.log");
  const obscuredPassword = obscurePassword(serverHandle.auth.password);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    configPath,
    [
      "[activefs-smoke]",
      "type = webdav",
      `url = ${serverHandle.url}`,
      "vendor = other",
      `user = ${serverHandle.auth.username}`,
      `pass = ${obscuredPassword}`,
      ""
    ].join("\n")
  );

  return {
    configPath,
    cacheDir,
    logFile,
    cleanup: () => removeRcloneWorkDir(workDir)
  };
}

async function removeRcloneWorkDir(workDir) {
  const retryableWindowsErrors = new Set(["EBUSY", "ENOTEMPTY", "EPERM"]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(workDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !retryableWindowsErrors.has(error?.code) ||
        attempt === 9
      ) {
        if (process.platform === "win32" && retryableWindowsErrors.has(error?.code)) {
          console.warn(
            `Windows kept an rclone temporary file locked after unmount; leaving ${workDir} for host cleanup.`
          );
          return;
        }
        throw error;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250 * (attempt + 1)));
    }
  }
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPositiveIntegerFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const raw = process.argv[index + 1];
  if (!raw || raw.startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function assertRclone() {
  const result = spawnSync("rclone", ["version"], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error("rclone is not available on PATH.");
  }
}

function printMountDoctor() {
  console.log(formatRcloneMountHostReport(inspectRcloneMountHost()));

  const activeMounts = spawnSync("mount", [], { encoding: "utf8" });
  if (activeMounts.status === 0) {
    const lines = activeMounts.stdout
      .split(/\r?\n/)
      .filter((line) => /activefs|rclone/.test(line));
    if (lines.length > 0) {
      console.log("activefs/rclone mounts:");
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    } else {
      console.log("activefs/rclone mounts: none");
    }
  }
}

function assertMountPreflight() {
  const report = inspectRcloneMountHost();
  if (!report.canAttemptMount) {
    throw new Error(`Host is not ready for an ActiveFS rclone mount:\n${formatRcloneMountHostReport(report)}`);
  }
}

function obscurePassword(password) {
  const result = spawnSync("rclone", ["obscure", password], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error("rclone obscure failed.");
  }
  return result.stdout.trim();
}

function basicAuth(auth) {
  if (!auth) {
    throw new Error("Expected generated WebDAV credentials.");
  }
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

async function unmount(targetDir) {
  try {
    await runCommand("umount", [targetDir], 15000);
    return;
  } catch {
    await runCommand("diskutil", ["unmount", targetDir], 15000);
  }
}

function runCommand(command, args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out.`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${code}: ${stderr || stdout}`));
    });
  });
}
