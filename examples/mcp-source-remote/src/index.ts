import {
  dir,
  fsTree,
  text
} from "@activefs/core";
import {
  createActiveFSMCPServer,
  loadActiveFSMCPConfig
} from "@activefs/mcp";
import { startActiveFSServer } from "@activefs/source-http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface MCPSourceRemoteExampleResult {
  sourceUrl: string;
  resources: string[];
  readText: string;
  grepMatchUris: string[];
}

export function createMCPSourceRemoteTree() {
  return fsTree({
    "/README.md": text("# Remote MCP Source\n", { type: "text/markdown" }),
    docs: dir({
      "guide.md": text("MCP reads this file through a Source API remote.\n", {
        type: "text/markdown"
      })
    })
  }, {
    name: "mcp-source-remote",
    capabilities: { search: true, searchable: true, watch: true, watchable: true }
  });
}

export async function runMCPSourceRemoteExample(): Promise<MCPSourceRemoteExampleResult> {
  const source = await startActiveFSServer({
    tree: createMCPSourceRemoteTree(),
    port: 0,
    handshake: {
      server: { name: "mcp-source-remote", version: "0.1.0" },
      workspace: { displayName: "MCP Source Remote Example" }
    }
  });

  try {
    const loaded = await loadActiveFSMCPConfig({
      config: {
        remotes: [
          {
            name: "remote",
            url: source.url,
            rootPath: "/"
          }
        ],
        resources: { maxDepth: 4, maxResources: 100, pageSize: 50 }
      }
    });
    const handle = createActiveFSMCPServer({
      filesystem: loaded.filesystem,
      remotes: loaded.remotes,
      config: loaded.config,
      adapterOptions: loaded.adapterOptions
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    const client = new Client({ name: "activefs-mcp-source-remote-example", version: "0.1.0" });
    await client.connect(clientTransport);

    try {
      const resources = await client.listResources();
      const read = await client.readResource({ uri: "activefs://remote/README.md" });
      const grep = await client.callTool({
        name: "activefs_grep",
        arguments: { remote: "remote", path: "/", query: "Source API" }
      });
      const structured = grep.structuredContent as { matches?: Array<{ uri?: string }> } | undefined;
      return {
        sourceUrl: source.url,
        resources: resources.resources.map((resource) => resource.uri).sort(),
        readText: resourceText(read.contents[0]),
        grepMatchUris: (structured?.matches ?? []).map((match) => match.uri).filter((uri): uri is string => Boolean(uri))
      };
    } finally {
      await client.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
    }
  } finally {
    await source.close();
  }
}

function resourceText(content: { text?: string; blob?: string } | undefined): string {
  return content && "text" in content ? content.text ?? "" : "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runMCPSourceRemoteExample();
  console.log(JSON.stringify(result, null, 2));
}
