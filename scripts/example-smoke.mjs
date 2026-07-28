#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

const smokeExpectations = new Map([
  ["hello-source", "hello-source entries:"],
  ["basic-memory", "/hello.md"],
  ["dynamic-users", "recursive matches: 2"],
  ["generated-repo-context", "# Repository Context"],
  ["fs-tree-basic", "fs-tree-basic entries:"],
  ["fs-tree-dynamic-paths", "fs-tree-dynamic-paths search:"],
  ["fs-tree-writable", "fs-tree-writable audit:"],
  ["fs-tree-command-handlers", "fs-tree-command-handlers grep:"],
  ["fetch-source-handler", "\"discoveryUrl\": \"https://app.example.com/api/source-manifest.json\""],
  ["local-bridge-tree", "local-bridge-tree mount: /bridge"],
  ["logs-tree", "log read calls during search: 0"],
  ["ci-artifacts-tree", "ci artifact matches:"],
  ["object-storage-tree", "object reads before content: 0"],
  ["database-tree", "database matches:"],
  ["remote-tree-client", "Source API"],
  ["remote-tree-server", "listening at"],
  ["multi-tree-remote", "/docs"],
  ["remote-mount-monitor", "remote mount monitor trees: 2"],
  ["mcp-demo", "activefs://demo/hello.md"],
  ["mcp-source-remote", "activefs://remote/README.md"],
  ["server-authoritative-write-demo", "\"serverFinal\": true"],
  ["webdav-rclone-mount-demo", "\"sourceUrl\": \"http://127.0.0.1:3900/_activefs/\""]
]);

for (const row of implementedFixtureRows()) {
  if (row.slugs.length === 2 && row.slugs.includes("remote-tree-server") && row.slugs.includes("remote-tree-client")) {
    await smokeRemoteTreePair(row);
    continue;
  }

  if (row.slugs.length !== 1) {
    throw new Error(`Unsupported implemented example row: ${row.line}`);
  }

  await smokeDocumentedCommand(row.slugs[0], row.run);
}

console.log("Example smokes passed.");

async function smokeDocumentedCommand(slug, runCell) {
  const packageName = readExamplePackageName(slug);
  const documentedCommand = parseDocumentedCommand(runCell);
  assertDocumentedNodeCommand(slug, documentedCommand);
  await build(packageName);

  if (slug === "webdav-rclone-mount-demo") {
    const root = await mkdtemp(join(tmpdir(), "activefs-webdav-demo-"));
    try {
      const args = documentedCommand.args.map((arg) => (arg === "/tmp/activefs-demo" ? root : arg));
      const result = await run(documentedCommand.command, args);
      assertOutput(packageName, result, smokeExpectation(slug));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    return;
  }

  const result = await run(documentedCommand.command, documentedCommand.args);
  assertOutput(packageName, result, smokeExpectation(slug));
}

async function smokeRemoteTreePair(row) {
  if (!row.run.includes("ACTIVEFS_REMOTE_URL")) {
    throw new Error(`Remote tree pair row must document ACTIVEFS_REMOTE_URL: ${row.line}`);
  }

  await build(readExamplePackageName("remote-tree-server"));
  await build(readExamplePackageName("remote-tree-client"));

  const server = spawn("node", ["examples/remote-tree-server/dist/index.js"], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let stderr = "";
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    output += chunk;
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const url = await waitForUrl(() => output);
    const client = await run("node", ["examples/remote-tree-client/dist/index.js"], {
      env: { ...process.env, ACTIVEFS_REMOTE_URL: url }
    });
    assertOutput(readExamplePackageName("remote-tree-client"), client, smokeExpectation("remote-tree-client"));
  } finally {
    server.kill("SIGTERM");
    await onceExit(server).catch(() => undefined);
    if (server.exitCode && server.exitCode !== 0 && server.exitCode !== null) {
      throw new Error(`remote-tree-server exited ${server.exitCode}: ${stderr}`);
    }
  }
}

function implementedFixtureRows() {
  const examplesDoc = readWorkspaceFile("docs/examples.md");
  const section = markdownSection(examplesDoc, "Runnable Examples");

  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("| `"))
    .map((line) => {
      const cells = splitMarkdownRow(line);
      return {
        line,
        run: cells[2],
        slugs: Array.from(cells[0].matchAll(/`([^`]+)`/g), (match) => match[1])
      };
    });
}

function readExamplePackageName(slug) {
  const packageJsonPath = `examples/${slug}/package.json`;
  const packageJson = JSON.parse(readWorkspaceFile(packageJsonPath));
  if (packageJson.name !== `@activefs/example-${slug}`) {
    throw new Error(`${packageJsonPath} name must be @activefs/example-${slug}`);
  }
  if (!packageJson.scripts?.build) {
    throw new Error(`${packageJsonPath} must define a build script`);
  }
  if (!existsSync(resolve(rootDir, `examples/${slug}/README.md`))) {
    throw new Error(`examples/${slug}/README.md is missing`);
  }
  return packageJson.name;
}

function parseDocumentedCommand(runCell) {
  const match = /`([^`]+)`/.exec(runCell);
  if (!match) {
    throw new Error(`Run cell must include a command in backticks: ${runCell}`);
  }
  const parts = match[1].trim().split(/\s+/);
  return {
    command: parts[0],
    args: parts.slice(1),
    source: match[1]
  };
}

function assertDocumentedNodeCommand(slug, documentedCommand) {
  if (documentedCommand.command !== "node") {
    throw new Error(`${slug} documented command must start with node: ${documentedCommand.source}`);
  }

  const expectedEntry = `examples/${slug}/dist/index.js`;
  if (!documentedCommand.args.includes(expectedEntry)) {
    throw new Error(`${slug} documented command must run ${expectedEntry}: ${documentedCommand.source}`);
  }
}

function smokeExpectation(slug) {
  const expectation = smokeExpectations.get(slug);
  if (!expectation) {
    throw new Error(`Missing smoke expectation for ${slug}`);
  }
  return expectation;
}

function readWorkspaceFile(path) {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function markdownSection(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`Missing markdown section: ${heading}`);
  }

  const rest = markdown.slice(start);
  const nextHeading = rest.slice(1).search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

async function build(packageName) {
  const result = await run("pnpm", ["--filter", packageName, "build"]);
  if (result.status !== 0) {
    throw new Error(`${packageName} build failed:\n${result.stderr}\n${result.stdout}`);
  }
}

function assertOutput(name, result, expected) {
  if (result.status !== 0) {
    throw new Error(`${name} smoke failed:\n${result.stderr}\n${result.stdout}`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes(expected)) {
    throw new Error(`${name} smoke output did not include ${JSON.stringify(expected)}:\n${combined}`);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });
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
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitForUrl(readOutput) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const match = /listening at (http:\/\/[^\s]+)/.exec(readOutput());
    if (match) {
      return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for remote tree URL. Output:\n${readOutput()}`);
}

function onceExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once("exit", resolve);
  });
}
