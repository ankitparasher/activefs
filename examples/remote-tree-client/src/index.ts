import { createActiveFS } from "@activefs/core";
import { createHttpSourceClient } from "@activefs/source-http";

export function createRemoteTreeExampleClient(url = process.env.ACTIVEFS_REMOTE_URL ?? "http://127.0.0.1:3999/_activefs/") {
  const remote = createHttpSourceClient({ url });
  return {
    url,
    remote,
    // Source API is the transport boundary; ActiveFS still exposes ordinary paths.
    fs: createActiveFS().mount("/remote", remote)
  };
}

export async function runRemoteTreeClientExample(url = process.env.ACTIVEFS_REMOTE_URL ?? "http://127.0.0.1:3999/_activefs/") {
  const { remote, fs } = createRemoteTreeExampleClient(url);
  const capabilities = await remote.fetchCapabilities();
  const entries = await fs.list({}, "/remote");
  const readme = await fs.read({}, "/remote/README.txt");
  const matches = await fs.search({}, "/remote", { pattern: "Source API" });

  return {
    url,
    mount: "/remote",
    capabilities,
    entries: entries.map((entry) => `${entry.kind.padEnd(9)} ${entry.path}`),
    readme: textContent(readme.content),
    matches: matches.matches.map((match) => `${match.path}:${match.line ?? 0}:${match.excerpt ?? ""}`)
  };
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runRemoteTreeClientExample();
  console.log(JSON.stringify({
    url: result.url,
    mount: result.mount,
    capabilities: result.capabilities
  }, null, 2));
  console.log(result.entries.join("\n"));
  console.log(result.readme);
  console.log(result.matches.join("\n"));
}
