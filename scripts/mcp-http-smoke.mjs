#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = resolve(repoRoot, "packages/mcp/dist/cli.js");
if (!existsSync(cliPath)) {
  throw new Error("Missing packages/mcp/dist/cli.js. Run pnpm build before smoke:mcp:http.");
}

const { Client } = await import(pathToFileURL(resolve(repoRoot, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
const { StreamableHTTPClientTransport } = await import(pathToFileURL(resolve(repoRoot, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js")).href);

const token = "activefs-mcp-smoke-token";
const child = spawn(process.execPath, [
  cliPath,
  "--transport", "http",
  "--demo",
  "--host", "127.0.0.1",
  "--port", "0",
  "--token", token
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += Buffer.from(chunk).toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += Buffer.from(chunk).toString("utf8");
});

try {
  const url = await waitForUrl();
  const client = new Client({ name: "activefs-mcp-http-smoke", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: { authorization: `Bearer ${token}` }
    }
  }));
  assert(client.getServerCapabilities()?.resources, "missing resources capability");
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === "activefs://demo/hello.md"), "missing demo resource");
  const read = await client.readResource({ uri: "activefs://demo/hello.md" });
  assert(read.contents[0]?.text?.includes("Hello ActiveFS MCP"), "failed to read demo resource");
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "activefs_grep"), "missing grep tool");
  const grep = await client.callTool({
    name: "activefs_grep",
    arguments: { remote: "demo", path: "/", query: "MCP" }
  });
  assert(!grep.isError, "grep tool returned an error");
  await client.close();
  child.kill("SIGTERM");
  console.log(JSON.stringify({
    ok: true,
    transport: "http",
    url,
    resources: resources.resources.length,
    tools: tools.tools.length
  }));
} catch (error) {
  child.kill("SIGTERM");
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  throw error;
}

async function waitForUrl() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const match = /listening on (http:\/\/[^\s]+)/.exec(stdout);
    if (match) {
      return match[1];
    }
    if (child.exitCode !== null) {
      throw new Error(`activefs-mcp exited before listening. stdout=${stdout.trim()} stderr=${stderr.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for activefs-mcp HTTP URL. stdout=${stdout.trim()} stderr=${stderr.trim()}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
