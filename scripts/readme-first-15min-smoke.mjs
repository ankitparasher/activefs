#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const keepTemp = Boolean(args.keepTemp);
const commandLog = [];
const checks = [];
let tempDir;
let activefsBin;
let demoConfigured = false;

try {
  const startedAt = Date.now();
  tempDir = await mkdtemp(join(tmpdir(), "activefs-readme-first-"));
  const workspaceDir = join(tempDir, "workspace");
  await mkdir(workspaceDir, { recursive: true });
  activefsBin = await resolveActiveFSBin();

  await assertCommand("install check: activefs --help", activefsBin.command, [...activefsBin.prefixArgs, "--help"], {
    cwd: workspaceDir,
    includes: "activefs <command>"
  });

  await assertCommand(
    "start demo source: activefs remote add repo --demo",
    activefsBin.command,
    [...activefsBin.prefixArgs, "remote", "add", "repo", "--demo", "--port", "3999"],
    { cwd: workspaceDir, includes: "Configured remote repo" }
  );
  demoConfigured = true;
  await assertCommand("list source: activefs list /repo", activefsBin.command, [...activefsBin.prefixArgs, "list", "/repo"], {
    cwd: workspaceDir,
    includes: "README.txt"
  });
  await assertCommand("read source: activefs read /repo/README.txt", activefsBin.command, [...activefsBin.prefixArgs, "read", "/repo/README.txt"], {
    cwd: workspaceDir,
    includes: "Hello from the ActiveFS demo Source API"
  });
  await assertCommand("search source: activefs grep Source /repo", activefsBin.command, [...activefsBin.prefixArgs, "grep", "Source", "/repo"], {
    cwd: workspaceDir,
    includes: [
      "# activefs grep: scan",
      "/repo/notes/source-api.txt:1:1:Source API exposes a generic HTTP tree service.",
      "/repo/README.txt:1:30:Hello from the ActiveFS demo Source API."
    ]
  });

  await assertCommand("cleanup demo source: activefs remote remove repo", activefsBin.command, [...activefsBin.prefixArgs, "remote", "remove", "repo"], {
    cwd: workspaceDir,
    includes: "repo: removed"
  });
  demoConfigured = false;

  const result = {
    status: "passed",
    durationMs: Date.now() - startedAt,
    tempDir: keepTemp ? tempDir : null,
    checks: checks.length
  };
  console.log(`ActiveFS README-first smoke passed (${result.checks} checks).`);
  if (keepTemp) {
    console.log(`Temp dir: ${tempDir}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (commandLog.length > 0) {
    console.error(renderCommandDebug(commandLog.at(-1)));
  }
  process.exitCode = 1;
} finally {
  if (demoConfigured && activefsBin && tempDir) {
    await run(activefsBin.command, [...activefsBin.prefixArgs, "remote", "remove", "repo", "--force"], {
      cwd: join(tempDir, "workspace"),
      label: "cleanup demo remote",
      timeoutMs: 60000
    }).catch(() => undefined);
  }
  if (tempDir && !keepTemp) {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--keep-temp":
        parsed.keepTemp = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

async function resolveActiveFSBin() {
  if (process.env.ACTIVEFS_BIN) {
    const override = resolve(process.env.ACTIVEFS_BIN);
    await assertReadableFile(override, `ACTIVEFS_BIN does not point to a readable file: ${override}`);
    if (process.platform !== "win32") {
      await chmod(override, 0o755).catch(() => undefined);
    }
    return { command: override, prefixArgs: [] };
  }

  const builtCli = join(rootDir, "packages/activefs/dist/index.js");
  await assertReadableFile(builtCli, "Run `pnpm build` before `pnpm smoke:readme-first`; missing built ActiveFS CLI.");
  return { command: process.execPath, prefixArgs: [builtCli] };
}

async function assertReadableFile(path, message) {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error(message);
  }
}

async function assertCommand(name, command, commandArgs, options) {
  const result = await run(command, commandArgs, {
    cwd: options.cwd,
    label: name,
    timeoutMs: options.timeoutMs ?? 60000
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const expectedTexts = Array.isArray(options.includes) ? options.includes : [options.includes].filter(Boolean);
  for (const expectedText of expectedTexts) {
    if (!output.includes(expectedText)) {
      throw new Error(`${name} did not include expected text: ${expectedText}`);
    }
  }
  checks.push({ name, status: "passed" });
  return result;
}

async function run(command, commandArgs, options = {}) {
  const cwd = options.cwd ?? rootDir;
  const startedAt = Date.now();
  const child = spawn(command, commandArgs, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
    shell: false
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timeout = options.timeoutMs
    ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs)
    : undefined;
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", resolvePromise);
  });
  if (timeout) {
    clearTimeout(timeout);
  }
  const entry = {
    label: options.label ?? command,
    command: [command, ...commandArgs],
    cwd: relative(rootDir, cwd) || ".",
    exitCode,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
    timedOut
  };
  commandLog.push(entry);
  if (timedOut) {
    throw new Error(`${entry.label} timed out after ${options.timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`${entry.label} failed with exit code ${exitCode}`);
  }
  return { stdout, stderr, exitCode };
}

function renderCommandDebug(command) {
  if (!command) {
    return "";
  }
  return [
    `Last command: ${command.command.join(" ")}`,
    `cwd: ${command.cwd}`,
    `exit: ${command.exitCode ?? "running during probe"}`,
    command.stdout ? `stdout:\n${preview(command.stdout)}` : "",
    command.stderr ? `stderr:\n${preview(command.stderr)}` : ""
  ].filter(Boolean).join("\n");
}

function preview(text) {
  const normalized = String(text).trim();
  if (normalized.length <= 1200) {
    return normalized;
  }
  return `${normalized.slice(0, 1200)}\n...`;
}
