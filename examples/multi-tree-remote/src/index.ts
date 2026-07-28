import { createActiveFS } from "@activefs/core";
import { createHttpSourceClient } from "@activefs/source-http";

export interface MultiTreeRemoteConfig {
  remote: string;
  trees: Record<string, string>;
}

export function createMultiTreeRemote(config: MultiTreeRemoteConfig) {
  const fs = createActiveFS();
  for (const [mountPath, url] of Object.entries(config.trees)) {
    // Each remote tree owns its own behavior; this layer only routes by mount prefix.
    fs.mount(mountPath, createHttpSourceClient({ url, name: `${config.remote}:${mountPath}` }));
  }
  return fs;
}

export const exampleConfig: MultiTreeRemoteConfig = {
  remote: "local",
  trees: {
    "/docs": "http://127.0.0.1:3921/_activefs/",
    "/logs": "http://127.0.0.1:4121/_activefs/",
    "/metrics": "http://127.0.0.1:4021/_activefs/"
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = createMultiTreeRemote(exampleConfig);
  const entries = await fs.list({}, "/");
  console.log(entries.map((entry) => `${entry.kind} ${entry.path}`).join("\n"));
}
