import { describe, expect, it } from "vitest";
import { runFetchSourceHandlerExample } from "./index";

describe("fetch-source-handler example", () => {
  it("serves discovery and protected tree operations through Request -> Response handlers", async () => {
    const result = await runFetchSourceHandlerExample();
    expect(result.discoveryUrl).toBe("https://app.example.com/api/source-manifest.json");
    expect(result.handshake).toMatchObject({
      protocol: "activefs-source",
      endpoints: { read: "https://app.example.com/api/tree/read" }
    });
    expect(result.config).toMatchObject({
      schemaVersion: 1,
      workspace: { displayName: "Product context", suggestedMountPath: "/context" },
      revisions: { config: "example-config-1" }
    });
    expect(result.list).toEqual([expect.objectContaining({ path: "/context.md" })]);
    expect(result.read).toMatchObject({ content: "Product-hosted Source API through a Fetch route.\n" });
  });
});
