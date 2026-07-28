import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface MCPDemoClientOptions {
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface MCPDemoClientResult {
  resources: string[];
  readText: string;
  grepMatchUris: string[];
  prompts: string[];
}

export async function runMCPDemoClient(
  options: MCPDemoClientOptions = {}
): Promise<MCPDemoClientResult> {
  const cwd = options.cwd ?? process.cwd();
  const cliPath = resolve(cwd, "packages/mcp/dist/cli.js");
  const command = options.command ?? process.execPath;
  const args = options.args ?? [cliPath, "--transport", "stdio", "--demo"];
  if (!options.command && !existsSync(cliPath)) {
    throw new Error("Missing packages/mcp/dist/cli.js. Run pnpm build before the MCP demo.");
  }

  const client = new Client({ name: "activefs-mcp-demo-client", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command,
    args,
    cwd,
    stderr: "pipe"
  });
  const stderrChunks: Buffer[] = [];
  transport.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));

  try {
    await client.connect(transport);
    const listed = await client.listResources();
    const read = await client.readResource({ uri: "activefs://demo/hello.md" });
    const grep = await client.callTool({
      name: "activefs_grep",
      arguments: { remote: "demo", path: "/", query: "MCP" }
    });
    const prompts = await client.listPrompts();
    await client.close();

    const structured = grep.structuredContent as { matches?: Array<{ uri?: string }> } | undefined;
    return {
      resources: listed.resources.map((resource) => resource.uri).sort(),
      readText: resourceText(read.contents[0]),
      grepMatchUris: (structured?.matches ?? []).map((match) => match.uri).filter((uri): uri is string => Boolean(uri)),
      prompts: prompts.prompts.map((prompt) => prompt.name).sort()
    };
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (stderr) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
    }
    throw error;
  }
}

function resourceText(content: { text?: string; blob?: string } | undefined): string {
  return content && "text" in content ? content.text ?? "" : "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMCPDemoClient();
  console.log(JSON.stringify(result, null, 2));
}
