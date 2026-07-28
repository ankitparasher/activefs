#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createActiveFS, dir, fsTree, text } from "../packages/core/dist/index.js";
import { startWebDAVServer } from "../packages/mount/dist/index.js";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const outPath = resolve(rootDir, args.out ?? "artifacts/remote/mounted-write-smoke.json");
const servers = [];

try {
  const readonly = await proveReadonlyRejection();
  const writable = await proveWritableCommit();
  const truncateOnly = await proveZeroLengthTruncate();
  const result = {
    version: 1,
    status: "passed",
    readonly,
    writable,
    truncateOnly
  };
  await writeJson(outPath, result);
  console.log(`ActiveFS mounted write smoke passed: ${relativePath(outPath)}`);
} catch (error) {
  const result = {
    version: 1,
    status: "failed",
    error: error instanceof Error ? error.stack ?? error.message : String(error)
  };
  await writeJson(outPath, result);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await Promise.all(servers.map((server) => server.close().catch(() => undefined)));
}

async function proveReadonlyRejection() {
  const filesystem = createActiveFS().mount(
    "/",
    fsTree({
      "/README.txt": text("Read-only mounted tree\n")
    })
  );
  const server = await startWebDAVServer({ filesystem });
  servers.push(server);
  const response = await fetch(new URL("/write-test.txt", server.url), {
    method: "PUT",
    headers: {
      Authorization: basicAuth(server.auth),
      "Content-Type": "text/plain"
    },
    body: "direct webdav write"
  });
  const body = await response.text();
  if (![403, 405, 501].includes(response.status)) {
    throw new Error(`Expected read-only WebDAV PUT to fail with policy/tree denial, got ${response.status}: ${body}`);
  }
  return {
    path: "/write-test.txt",
    statusCode: response.status,
    body: trimForArtifact(body)
  };
}

async function proveWritableCommit() {
  const tree = fsTree({
    "/README.txt": text("Writable mounted tree\n"),
    uploads: dir({}, { writable: true })
  }, {
    writable: true
  });
  const filesystem = createActiveFS().mount("/", tree);
  const server = await startWebDAVServer({
    filesystem,
    policy: {
      schemaVersion: 1,
      defaultAccess: "writable",
      rules: []
    }
  });
  servers.push(server);
  const response = await fetch(new URL("/uploads/write-test.txt", server.url), {
    method: "PUT",
    headers: {
      Authorization: basicAuth(server.auth),
      "Content-Type": "text/plain"
    },
    body: "committed write"
  });
  const body = await response.text();
  if (![200, 201, 204].includes(response.status)) {
    throw new Error(`Expected writable WebDAV PUT to commit, got ${response.status}: ${body}`);
  }
  const read = await tree.read({}, "/uploads/write-test.txt", { encoding: "utf8" });
  const readContent = treeReadContent(read);
  if (readContent !== "committed write") {
    throw new Error(`Writable tree did not receive committed bytes: ${String(readContent)}`);
  }
  return {
    path: "/uploads/write-test.txt",
    statusCode: response.status,
    committed: true
  };
}

async function proveZeroLengthTruncate() {
  const tree = fsTree({
    "/truncate-target.txt": text("content to truncate")
  }, {
    writable: true
  });
  const filesystem = createActiveFS().mount("/", tree);
  const server = await startWebDAVServer({
    filesystem,
    policy: {
      schemaVersion: 1,
      defaultAccess: "readonly",
      rules: [{
        match: { type: "exact", path: "/truncate-target.txt" },
        allow: ["stat", "read", "truncate"]
      }]
    }
  });
  servers.push(server);
  const response = await fetch(new URL("/truncate-target.txt", server.url), {
    method: "PUT",
    headers: {
      Authorization: basicAuth(server.auth),
      "Content-Type": "application/octet-stream"
    },
    body: ""
  });
  const body = await response.text();
  if (response.status !== 204) {
    throw new Error(`Expected zero-byte WebDAV PUT to truncate, got ${response.status}: ${body}`);
  }
  const read = await tree.read({}, "/truncate-target.txt", { encoding: "utf8" });
  const readContent = treeReadContent(read);
  if (readContent !== "") {
    throw new Error(`Truncate-only policy did not empty file: ${String(readContent)}`);
  }
  return {
    path: "/truncate-target.txt",
    statusCode: response.status,
    committed: true,
    length: 0
  };
}

function treeReadContent(read) {
  return read && typeof read === "object" && "content" in read ? read.content : read;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function basicAuth(auth) {
  return `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function trimForArtifact(value) {
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}

function relativePath(path) {
  const normalized = path.startsWith(rootDir) ? path.slice(rootDir.length + 1) : path;
  return normalized || path;
}
