import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareMountDemo } from "./index";

describe("webdav-rclone-mount-demo example", () => {
  it("prepares mount state without starting a host mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "activefs-webdav-example-test-"));
    try {
      const result = await prepareMountDemo(root, "local", "http://127.0.0.1:3900/_activefs/");

      expect(result.layout.remoteName).toBe("local");
      expect(result.remote).toMatchObject({
        name: "local",
        sourceUrl: "http://127.0.0.1:3900/_activefs/"
      });
      expect(result.status).toMatchObject({
        remote: "local"
      });
      expect(result.cache).toMatchObject({
        remote: "local"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
