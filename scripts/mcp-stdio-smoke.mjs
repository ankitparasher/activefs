#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = resolve(repoRoot, "packages/mcp/dist/cli.js");
if (!existsSync(cliPath)) {
  throw new Error("Missing packages/mcp/dist/cli.js. Run pnpm build before smoke:mcp:stdio.");
}

const { Client } = await import(pathToFileURL(resolve(repoRoot, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(resolve(repoRoot, "packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js")).href);

const client = new Client({ name: "activefs-mcp-stdio-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cliPath, "--transport", "stdio", "--demo"],
  cwd: repoRoot,
  stderr: "pipe"
});

const stderrChunks = [];
transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

try {
  await client.connect(transport);
  assert(client.getServerCapabilities()?.resources, "missing resources capability");
  assert(client.getServerCapabilities()?.tools, "missing tools capability");
  const resources = await client.listResources();
  assert(resources.resources.some((resource) => resource.uri === "activefs://demo/hello.md"), "missing demo resource");
  const read = await client.readResource({ uri: "activefs://demo/hello.md" });
  assert(read.contents[0]?.text?.includes("Hello ActiveFS MCP"), "failed to read demo resource");
  const templates = await client.listResourceTemplates();
  assert(templates.resourceTemplates.some((template) => template.uriTemplate === "activefs://demo/{path}"), "missing resource template");
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === "activefs_grep"), "missing grep tool");
  const grep = await client.callTool({
    name: "activefs_grep",
    arguments: { remote: "demo", path: "/", query: "MCP" }
  });
  assert(!grep.isError, "grep tool returned an error");
  const prompts = await client.listPrompts();
  assert(prompts.prompts.some((prompt) => prompt.name === "activefs_search_then_read"), "missing prompt");
  await client.close();
  console.log(JSON.stringify({
    ok: true,
    transport: "stdio",
    resources: resources.resources.length,
    tools: tools.tools.length,
    prompts: prompts.prompts.length
  }));
} catch (error) {
  const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
  if (stderr) {
    console.error(stderr);
  }
  throw error;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
