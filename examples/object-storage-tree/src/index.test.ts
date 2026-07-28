import { createActiveFS } from "@activefs/core";
import { describe, expect, it } from "vitest";
import {
  createS3ObjectStorageTree,
  runObjectStorageTreeExample,
  type S3CommandClient,
  type S3CommandFactory
} from "./index";

describe("object-storage-tree example", () => {
  it("shows fixture metadata, range reads, lazy reads, and search", async () => {
    const result = await runObjectStorageTreeExample();

    expect(result.packages).toEqual([
      "/objects/assets/packages/app-1.0.0.txt",
      "/objects/assets/packages/app-1.0.0.txt.meta.json"
    ]);
    expect(result.etag).toBe("etag-assets-app-100");
    expect(result.version).toBe("v3");
    expect(result.readsBeforeContent).toBe(0);
    expect(result.range).toBe("activefs-");
    expect(result.readsAfterContent).toBe(1);
    expect(result.matches).toContain("/objects/billing/exports/invoices-2026-06.csv:1");
    expect(result.matches).toContain("/objects/billing/exports/invoices-2026-06.csv.meta.json:3");
  });

  it("maps S3 list/head/get calls into bucket, prefix, object, and metadata paths", async () => {
    const client = new FakeS3Client();
    const tree = createS3ObjectStorageTree({
      bucket: "demo-bucket",
      prefix: "fixtures",
      client,
      commands
    });
    const fs = createActiveFS().mount("/s3", tree);

    await expect(fs.list({}, "/s3")).resolves.toEqual([
      expect.objectContaining({ path: "/s3/demo-bucket", kind: "directory" })
    ]);
    await expect(fs.list({}, "/s3/demo-bucket")).resolves.toEqual([
      expect.objectContaining({ path: "/s3/demo-bucket/packages", kind: "directory" }),
      expect.objectContaining({ path: "/s3/demo-bucket/reports", kind: "directory" })
    ]);
    await expect(fs.list({}, "/s3/demo-bucket/packages")).resolves.toEqual([
      expect.objectContaining({ path: "/s3/demo-bucket/packages/app.txt", kind: "file" }),
      expect.objectContaining({ path: "/s3/demo-bucket/packages/app.txt.meta.json", kind: "file" })
    ]);

    await expect(fs.stat({}, "/s3/demo-bucket/packages/app.txt")).resolves.toMatchObject({
      etag: "etag-s3-app",
      revision: "version-1",
      meta: {
        bucket: "demo-bucket",
        key: "fixtures/packages/app.txt"
      }
    });

    const metadata = await fs.read({}, "/s3/demo-bucket/packages/app.txt.meta.json");
    expect(textContent(metadata.content)).toContain("\"version\": \"version-1\"");

    const range = await fs.read({}, "/s3/demo-bucket/packages/app.txt", {
      offset: 0,
      length: 6
    });
    expect(textContent(range.content)).toBe("active");
    expect(client.calls).toContainEqual({
      type: "get",
      input: {
        Bucket: "demo-bucket",
        Key: "fixtures/packages/app.txt",
        Range: "bytes=0-5"
      }
    });
  });
});

const commands: S3CommandFactory = {
  listObjectsV2: (input) => ({ type: "list", input }),
  headObject: (input) => ({ type: "head", input }),
  getObject: (input) => ({ type: "get", input })
};

class FakeS3Client implements S3CommandClient {
  readonly calls: Array<{ type: string; input: unknown }> = [];

  async send(command: unknown): Promise<unknown> {
    const request = command as { type: string; input: Record<string, unknown> };
    this.calls.push(request);
    if (request.type === "list") {
      return this.list(request.input);
    }
    if (request.type === "head") {
      return this.head(request.input);
    }
    if (request.type === "get") {
      const body = "active s3 object bytes\n";
      return {
        ...this.head(request.input),
        Body: request.input.Range === "bytes=0-5" ? body.slice(0, 6) : body
      };
    }
    throw new Error(`Unexpected command: ${request.type}`);
  }

  private list(input: Record<string, unknown>) {
    if (input.Prefix === "fixtures/") {
      return {
        CommonPrefixes: [
          { Prefix: "fixtures/packages/" },
          { Prefix: "fixtures/reports/" }
        ]
      };
    }
    if (input.Prefix === "fixtures/packages/") {
      return {
        Contents: [{
          Key: "fixtures/packages/app.txt",
          Size: 23,
          ETag: "\"etag-s3-app\"",
          LastModified: new Date("2026-06-26T00:00:00.000Z")
        }]
      };
    }
    return { Contents: [] };
  }

  private head(input: Record<string, unknown>) {
    if (input.Key !== "fixtures/packages/app.txt") {
      const error = new Error("not found") as Error & { $metadata: { httpStatusCode: number } };
      error.name = "NotFound";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return {
      ContentLength: 23,
      ContentType: "text/plain",
      ETag: "\"etag-s3-app\"",
      VersionId: "version-1",
      LastModified: new Date("2026-06-26T00:00:00.000Z"),
      Metadata: {
        owner: "activefs"
      }
    };
  }
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}
