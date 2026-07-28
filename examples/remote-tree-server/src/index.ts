import {
  bytes,
  dir,
  fsTree,
  text
} from "@activefs/core";
import { startActiveFSServer } from "@activefs/source-http";

export function createRemoteTreeExampleTree() {
  return fsTree({
    "/README.txt": text("Hello from a remote ActiveFS tree.\n"),
    notes: dir({
      "source-api.txt": text("Source API exposes a generic HTTP tree service.\n")
    }),
    bin: dir({
      "sample.bin": bytes(new Uint8Array([0, 1, 2, 3, 255]))
    })
  }, {
    name: "remote-tree-example",
    capabilities: { search: true, searchable: true }
  });
}

export async function startRemoteTreeExampleServer(port = Number(process.env.PORT ?? 3999)) {
  return startActiveFSServer({
    port,
    tree: createRemoteTreeExampleTree(),
    handshake: {
      server: { name: "remote-tree-example", version: "1.0.0" },
      workspace: {
        displayName: "Remote Tree Example",
        suggestedMountPath: "/remote"
      },
      cache: { directoryTtlMs: 60_000 }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await startRemoteTreeExampleServer();
  console.log(`ActiveFS remote tree listening at ${server.url}`);
  console.log("Try: node examples/remote-tree-client/dist/index.js");
}
