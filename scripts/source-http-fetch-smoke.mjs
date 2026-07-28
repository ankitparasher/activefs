#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const fetchArtifacts = [
  new URL("../packages/source-http/dist/fetch.js", import.meta.url),
  new URL("../packages/source-http/dist/fetch.cjs", import.meta.url)
];
const artifacts = [
  ...(await collectModuleGraph(fetchArtifacts[0])),
  fetchArtifacts[1],
  ...(await collectModuleGraph(new URL("../packages/core/dist/index.js", import.meta.url))),
  new URL("../packages/core/dist/index.cjs", import.meta.url)
];
const forbidden = [
  [/(?:from\s+|require\(|import\()["']node:/, "Node built-in import"],
  [/\bBuffer\b/, "Node Buffer global"],
  [/\bprocess\./, "Node process global"]
];

for (const artifact of artifacts) {
  const source = await readFile(artifact, "utf8");
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(source, pattern, `${label} leaked into ${artifact.pathname}`);
  }
}

const fetchEntry = await import(pathToFileURL(fetchArtifacts[0].pathname).href);
assert.equal(typeof fetchEntry.createActiveFSSourceService, "function");
assert.equal(typeof fetchEntry.assertActiveFSSourceHandshake, "function");

const tree = {
  name: "fetch-smoke",
  capabilities: {
    stat: true,
    list: true,
    read: true,
    search: false,
    watch: false,
    writable: false
  },
  info: async (_context, path) => path === "/"
    ? { path: "/", name: "", kind: "directory" }
    : path === "/hello.txt"
      ? { path, name: "hello.txt", kind: "file", size: 5 }
      : null,
  list: async () => [{ path: "/hello.txt", name: "hello.txt", kind: "file", size: 5 }],
  read: async () => ({ content: "hello" })
};
const service = fetchEntry.createActiveFSSourceService({
  tree,
  endpoints: {
    stat: "https://product.example/tree/stat",
    list: "https://product.example/tree/list",
    read: "https://product.example/tree/read",
    command: "https://product.example/tree/command"
  }
});
const response = await service.handle("read", new Request("https://product.example/anything", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "/hello.txt", ctx: {} })
}));
assert.equal(response.status, 200);
assert.equal((await response.json()).content, "hello");
assert.match(response.headers.get("repr-digest") ?? "", /^sha-256=:/);

console.log("ActiveFS Fetch Source API import smoke passed.");

async function collectModuleGraph(entry, seen = new Map()) {
  if (seen.has(entry.href)) return [...seen.values()];
  seen.set(entry.href, entry);
  const source = await readFile(entry, "utf8");
  for (const match of source.matchAll(/(?:from\s+|import\()["'](\.\.?\/[^"']+)["']/g)) {
    await collectModuleGraph(new URL(match[1], entry), seen);
  }
  return [...seen.values()];
}
