import { ActiveFSError, fsTree, text } from "@activefs/core";
import {
  createActiveFSSourceService,
  type ActiveFSSourceOperation
} from "@activefs/source-http/fetch";

const source = createActiveFSSourceService({
  tree: fsTree({
    "/context.md": text("Product-hosted Source API through a Fetch route.\n")
  }, {
    name: "fetch-source-handler",
    capabilities: { search: false, searchable: false, watch: false, watchable: false }
  }),
  endpoints: {
    stat: "https://app.example.com/api/tree/stat",
    list: "https://app.example.com/api/tree/list",
    read: "https://app.example.com/api/tree/read",
    command: "https://app.example.com/api/tree/command",
    capabilities: "https://app.example.com/api/tree/capabilities",
    config: "https://app.example.com/api/tree/config"
  },
  handshake: {
    workspace: { displayName: "Product context", suggestedMountPath: "/context" },
    cache: { contentTtlMs: 30_000, directoryTtlMs: 10_000 },
    revisions: { config: "example-config-1" }
  },
  resolveContext: ({ operation, request }) => {
    if (operation === "handshake" || operation === "capabilities" || operation === "config") {
      return { context: {}, isolationKey: "public-discovery" };
    }
    if (request.headers.get("authorization") !== "Bearer example-token") {
      throw new ActiveFSError("UNAUTHORIZED", "A valid product credential is required");
    }
    return {
      context: {
        auth: { subject: "user-123" },
        meta: { tenant: "tenant-456" }
      },
      isolationKey: "principal-scope-789"
    };
  }
});

/** Bind each function to any application-owned route, including a Next App Router route file. */
export const handleDiscoveryGET = (request: Request) => source.handle("handshake", request);
export const handleCapabilitiesGET = (request: Request) => source.handle("capabilities", request);
export const handleConfigGET = (request: Request) => source.handle("config", request);
export const handleStatPOST = (request: Request) => source.handle("stat", request);
export const handleListPOST = (request: Request) => source.handle("list", request);
export const handleReadPOST = (request: Request) => source.handle("read", request);
export const handleCommandPOST = (request: Request) => source.handle("command", request);

export async function runFetchSourceHandlerExample() {
  const discoveryUrl = "https://app.example.com/api/source-manifest.json";
  const handshake = await responseJson(handleDiscoveryGET(new Request(discoveryUrl)));
  const config = await responseJson(handleConfigGET(new Request("https://app.example.com/api/tree/config")));
  const list = await responseJson(callProtected("list", "https://app.example.com/api/tree/list", {
    path: "/",
    ctx: { auth: { subject: "forged-admin" } }
  }));
  const read = await responseJson(callProtected("read", "https://app.example.com/api/tree/read", {
    path: "/context.md",
    ctx: { auth: { subject: "forged-admin" } }
  }));
  return { discoveryUrl, handshake, config, list, read };
}

function callProtected(operation: ActiveFSSourceOperation, url: string, body: unknown): Promise<Response> {
  return source.handle(operation, new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer example-token",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  }));
}

async function responseJson(response: Promise<Response>): Promise<unknown> {
  const resolved = await response;
  if (!resolved.ok) throw new Error(`Fetch Source API example failed with HTTP ${resolved.status}`);
  return resolved.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await runFetchSourceHandlerExample(), null, 2));
}
