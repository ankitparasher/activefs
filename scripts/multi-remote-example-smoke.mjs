#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebDAVServer } from "../packages/mount/dist/index.js";
import { createMultiTreeRemote } from "../examples/multi-tree-remote/dist/index.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const outPath = resolve(rootDir, args.out ?? "artifacts/remote/multi-remote-example-smoke.json");
const remoteNames = ["docs", "logs", "metrics"];
const children = new Set();
const cleanups = new Set();
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

try {
  const remotes = remoteNames.map((name, index) => ({
    name,
    mountPath: `/${name}`,
    port: args.ports?.[index] ?? randomPort(index)
  }));

  await Promise.all(remotes.map(startExampleRemoteTree));

  const trees = Object.fromEntries(
    remotes.map((remote) => [remote.mountPath, `http://127.0.0.1:${remote.port}/activefs`])
  );
  const filesystem = createMultiTreeRemote({ remote: "localhost", trees });
  const direct = await proveDirectMultiTree(filesystem, remotes);

  let webdav;
  if (args.webdavCheck || args.rcloneCheck || args.mountCheck) {
    webdav = await proveWebDAVMultiTree(filesystem, remotes);
  }

  let rclone;
  if (args.rcloneCheck || args.mountCheck) {
    rclone = await proveRcloneMultiTree(webdav.server, remotes, { mountCheck: args.mountCheck });
  }

  const result = {
    version: 1,
    status: "passed",
    remotes: remotes.map((remote) => ({
      name: remote.name,
      mountPath: remote.mountPath,
      treeUrl: `http://127.0.0.1:${remote.port}/activefs`
    })),
    checks: {
      direct,
      webdav: webdav?.result,
      rclone
    }
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`ActiveFS multi-remote example smoke passed: ${relativePath(outPath)}`);
} catch (error) {
  const result = {
    version: 1,
    status: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  };
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await cleanupAll();
}

async function startExampleRemoteTree(remote) {
  const serverPath = join(rootDir, "examples/remote-tree-server/dist/index.js");
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(remote.port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.add(child);
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown && code !== 0) {
      console.error(`Remote tree ${remote.name} exited with ${code}: ${stderr || stdout}`);
    }
  });

  await waitFor(async () => {
    if (stdout.includes("ActiveFS remote tree listening")) {
      return true;
    }
    if (child.exitCode !== null) {
      throw new Error(`Remote tree ${remote.name} exited early: ${stderr || stdout}`);
    }
    return false;
  }, `remote tree ${remote.name} to listen`);

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${remote.port}/activefs/capabilities`)
      .catch(() => null);
    return response?.ok === true;
  }, `remote tree ${remote.name} capabilities`);
}

async function proveDirectMultiTree(filesystem, remotes) {
  const rootEntries = await filesystem.list({}, "/");
  const rootPaths = rootEntries.map((entry) => entry.path).sort();
  assertIncludesAll(rootPaths, remotes.map((remote) => remote.mountPath), "root entries");

  const perRemote = [];
  for (const remote of remotes) {
    const entries = await filesystem.list({}, remote.mountPath);
    const readme = await filesystem.read({}, `${remote.mountPath}/README.txt`);
    const search = await filesystem.search({}, remote.mountPath, { pattern: "Source API" });
    const content = asText(readme.content);
    if (!content.includes("remote ActiveFS tree")) {
      throw new Error(`Unexpected README content for ${remote.name}: ${content}`);
    }
    if (!search.matches.some((match) => match.path === `${remote.mountPath}/notes/source-api.txt`)) {
      throw new Error(`Search did not find Source API result for ${remote.name}`);
    }
    perRemote.push({
      remote: remote.name,
      mountPath: remote.mountPath,
      entries: entries.map((entry) => entry.path).sort(),
      readPath: `${remote.mountPath}/README.txt`,
      searchMatches: search.matches.map((match) => match.path).sort()
    });
  }

  const aggregateSearch = await filesystem.search({}, "/", { pattern: "Source API" });
  return {
    rootEntries: rootPaths,
    perRemote,
    aggregateSearchMatches: aggregateSearch.matches.map((match) => match.path).sort()
  };
}

async function proveWebDAVMultiTree(filesystem, remotes) {
  const server = await startWebDAVServer({ filesystem });
  cleanups.add(() => server.close());
  const authHeader = server.auth
    ? `Basic ${Buffer.from(`${server.auth.username}:${server.auth.password}`).toString("base64")}`
    : undefined;
  const reads = [];

  for (const remote of remotes) {
    const response = await fetch(new URL(`${remote.name}/README.txt`, server.url), {
      headers: authHeader ? { Authorization: authHeader } : {}
    });
    if (!response.ok) {
      throw new Error(`WebDAV GET for ${remote.name} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text.includes("remote ActiveFS tree")) {
      throw new Error(`Unexpected WebDAV README content for ${remote.name}: ${text}`);
    }
    reads.push({ remote: remote.name, path: `/${remote.name}/README.txt`, bytes: Buffer.byteLength(text) });
  }

  return {
    server,
    result: {
      url: server.url,
      reads
    }
  };
}

async function proveRcloneMultiTree(server, remotes, options) {
  const config = await createRcloneConfig(server);
  cleanups.add(config.cleanup);
  const list = await runCommand("rclone", [
    "lsjson",
    "activefs-multi:",
    "--config",
    config.configPath
  ]);
  const listJson = JSON.parse(list.stdout);
  const listedNames = listJson.map((entry) => entry.Name).sort();
  assertIncludesAll(listedNames, remotes.map((remote) => remote.name), "rclone root entries");

  const cat = await runCommand("rclone", [
    "cat",
    `activefs-multi:${remotes[0].name}/README.txt`,
    "--config",
    config.configPath
  ]);
  if (!cat.stdout.includes("remote ActiveFS tree")) {
    throw new Error(`Unexpected rclone cat content: ${cat.stdout}`);
  }

  const result = {
    backendList: listedNames,
    backendCatPath: `${remotes[0].name}/README.txt`,
    mount: undefined
  };

  if (options.mountCheck) {
    result.mount = await proveRcloneMount(config, remotes);
  }
  return result;
}

async function proveRcloneMount(config, remotes) {
  const mountDir = await mkdtemp(join(tmpdir(), "activefs-multi-vfs-"));
  cleanups.add(() => rm(mountDir, { recursive: true, force: true }));
  const child = spawn("rclone", [
    "mount",
    "activefs-multi:",
    mountDir,
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
    "INFO"
  ], {
    detached: true,
    stdio: "ignore"
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  child.unref();
  cleanups.add(async () => {
    await unmount(mountDir).catch(() => undefined);
    killChild(child);
  });

  const readPath = join(mountDir, remotes[0].name, "README.txt");
  try {
    await waitFor(async () => {
      const result = await runCommand("ls", [mountDir], { timeoutMs: 5000 }).catch(() => null);
      if (!result) {
        return false;
      }
      return remotes.every((remote) => result.stdout.split(/\s+/).includes(remote.name));
    }, "multi-remote rclone mount root entries");

    const cat = await runCommand("cat", [readPath], { timeoutMs: 10000 });
    if (!cat.stdout.includes("remote ActiveFS tree")) {
      throw new Error(`Unexpected mounted README content: ${cat.stdout}`);
    }
    const find = await runCommand("find", [mountDir, "-maxdepth", "3", "-type", "f"], { timeoutMs: 15000 });
    return {
      mountDir,
      readPath,
      rootEntries: remotes.map((remote) => remote.name),
      findStdoutBytes: Buffer.byteLength(find.stdout)
    };
  } catch (error) {
    const logTail = await readTail(config.logFile, 80);
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`multi-remote rclone mount probe failed:\n${detail}\n\nrclone log tail:\n${logTail}`);
  }
}

async function createRcloneConfig(server) {
  const workDir = await mkdtemp(join(tmpdir(), "activefs-multi-rclone-"));
  const configPath = join(workDir, "rclone.conf");
  const cacheDir = join(workDir, "cache");
  const logFile = join(workDir, "rclone.log");
  await mkdir(cacheDir, { recursive: true });
  const authLines = server.auth
    ? [
        `user = ${server.auth.username}`,
        `pass = ${obscurePassword(server.auth.password)}`
      ]
    : [];
  await writeFile(configPath, [
    "[activefs-multi]",
    "type = webdav",
    `url = ${server.url}`,
    "vendor = other",
    ...authLines,
    ""
  ].join("\n"));
  return {
    configPath,
    cacheDir,
    logFile,
    cleanup: () => rm(workDir, { recursive: true, force: true })
  };
}

function runCommand(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let settled = false;
    let stdout = "";
    let stderr = "";
    let killTimer;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
          reject(new Error(`${command} ${commandArgs.join(" ")} timed out after ${options.timeoutMs}ms`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      children.delete(child);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) {
        children.delete(child);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      children.delete(child);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${commandArgs.join(" ")} failed with ${code}: ${stderr || stdout}`));
    });
  });
}

async function readTail(path, lineCount) {
  try {
    const text = await readFile(path, "utf8");
    return text.split("\n").slice(-lineCount).join("\n");
  } catch (error) {
    return `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function unmount(targetDir) {
  try {
    await runCommand("umount", [targetDir]);
  } catch {
    await runCommand("diskutil", ["unmount", targetDir]);
  }
}

async function cleanupAll() {
  shuttingDown = true;
  const cleanupFns = [...cleanups].reverse();
  cleanups.clear();
  for (const cleanup of cleanupFns) {
    await cleanup().catch(() => undefined);
  }
  for (const child of children) {
    killChild(child);
  }
  children.clear();
}

async function shutdown(signal) {
  await cleanupAll();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

async function waitFor(check, description) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    if (await check()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function assertIncludesAll(actual, expected, label) {
  const missing = expected.filter((item) => !actual.includes(item));
  if (missing.length > 0) {
    throw new Error(`${label} missing ${missing.join(", ")} from ${actual.join(", ")}`);
  }
}

function obscurePassword(password) {
  const result = spawnSync("rclone", ["obscure", password], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "rclone obscure failed.");
  }
  return result.stdout.trim();
}

function killChild(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function asText(content) {
  return typeof content === "string" ? content : Buffer.from(content).toString("utf8");
}

function randomPort(offset) {
  return 39000 + offset * 100 + Math.floor(Math.random() * 50);
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function relativePath(path) {
  return path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--out":
        parsed.out = requireValue(argv, ++index, arg);
        break;
      case "--ports":
        parsed.ports = requireValue(argv, ++index, arg)
          .split(",")
          .map((part) => Number.parseInt(part.trim(), 10));
        if (parsed.ports.length !== remoteNames.length || parsed.ports.some((port) => !Number.isFinite(port))) {
          throw new Error(`--ports must provide ${remoteNames.length} comma-separated numeric ports.`);
        }
        break;
      case "--webdav-check":
        parsed.webdavCheck = true;
        break;
      case "--rclone-check":
        parsed.rcloneCheck = true;
        parsed.webdavCheck = true;
        break;
      case "--mount-check":
        parsed.mountCheck = true;
        parsed.rcloneCheck = true;
        parsed.webdavCheck = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}`);
  }
  return value;
}
