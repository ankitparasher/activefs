import { describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("activefs-mcp CLI", () => {
  it("prints help, version, schema, and dry-run plans", async () => {
    const output = await captureStdout(() => main(["--help"]));
    expect(output).toContain("activefs-mcp [options]");
    expect(output).toContain("--http");
    expect(output).toContain("--state-root");

    await expect(captureStdout(() => main(["--version"]))).resolves.toBe("0.1.1\n");

    const schema = JSON.parse(await captureStdout(() => main(["--print-config-schema"])));
    expect(schema).toMatchObject({ type: "object" });

    const dryRun = JSON.parse(await captureStdout(() => main(["--dry-run", "--demo"])));
    expect(dryRun).toMatchObject({
      name: "activefs-mcp",
      protocolVersion: "2025-11-25",
      remotes: [{ name: "demo", watchable: true }]
    });
    expect(dryRun.tools).toContain("activefs_grep");
    expect(dryRun.prompts).toContain("activefs_browse_remote");
  });

  it("rejects invalid port values before starting transports", async () => {
    await expect(main(["--http", "--port", "bad"])).rejects.toThrow("Invalid --port value");
    await expect(main(["--http", "--port", "-1"])).rejects.toThrow("Invalid --port value");
  });

  it("parses HTTP auth options in dry-run plans", async () => {
    const envToken = JSON.parse(await captureStdout(() => main([
      "--dry-run",
      "--demo",
      "--http",
      "--auth",
      "none",
      "--token",
      "env:ACTIVEFS_MCP_TOKEN",
      "--allow-origin",
      "https://app.example",
      "--allow-host",
      "localhost"
    ])));
    expect(envToken.auth).toMatchObject({
      mode: "none",
      tokenEnv: "ACTIVEFS_MCP_TOKEN"
    });

    const directToken = await captureStdout(() => main([
      "--dry-run",
      "--demo",
      "--transport",
      "http",
      "--auth",
      "bearer",
      "--token",
      "super-secret-token"
    ]));
    const directTokenPlan = JSON.parse(directToken);
    expect(directTokenPlan.auth.mode).toBe("bearer");
    expect(directTokenPlan.auth.token).toBeTruthy();
    expect(directToken).not.toContain("super-secret-token");
  });
});

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await run();
    return spy.mock.calls.map((args) => args.join(" ")).join("\n") + (spy.mock.calls.length ? "\n" : "");
  } finally {
    spy.mockRestore();
  }
}
