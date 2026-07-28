import { ActiveFSError, dir, fsTree, text } from "@activefs/core";
import {
  createHttpSourceClient,
  startActiveFSServer,
  type ActiveFSOperationReference
} from "@activefs/source-http";

export async function runServerAuthoritativeWriteDemo(): Promise<{
  serverFinal: true;
  writablePath: string;
  readonlyRejected: true;
  successOperation: string;
  rejectedOperation: string;
  offlineQueue: false;
}> {
  const tree = fsTree({
    "/README.md": text("readonly baseline\n"),
    uploads: dir({}, { writable: true })
  }, {
    name: "write-demo"
  });

  tree.pre("write", ({ path }) => {
    if (!path.startsWith("/uploads/")) {
      throw new ActiveFSError("FORBIDDEN", `Server policy denied write: ${path}`, { path });
    }
  });

  const server = await startActiveFSServer({ tree });
  try {
    const client = createHttpSourceClient({ url: server.url });
    const success = await client.write!({}, "/uploads/accepted.txt", "server final\n", {
      overwrite: true,
      idempotencyKey: "upload-1"
    });
    const successOperation = mutationOperationReference(success);
    const committed = await client.fetchOperationStatus(successOperation);
    let rejectedOperation: ActiveFSOperationReference | undefined;
    try {
      await client.write!({}, "/README.md", "should fail\n", {
        overwrite: true,
        idempotencyKey: "readonly-1"
      });
    } catch (error) {
      if (!(error instanceof ActiveFSError) || error.code !== "FORBIDDEN") {
        throw error;
      }
      rejectedOperation = mutationOperationReference(error);
    }
    if (!rejectedOperation) throw new Error("Expected rejected write to include an operation reference.");
    const rejected = await client.fetchOperationStatus(rejectedOperation);
    if (committed.status !== "succeeded" || rejected.status !== "failed") {
      throw new Error("Expected operation status to resolve committed and rejected writes.");
    }
    return {
      serverFinal: true,
      writablePath: "/uploads/accepted.txt",
      readonlyRejected: true,
      successOperation: committed.operationId,
      rejectedOperation: rejectedOperation.operationId,
      offlineQueue: false
    };
  } finally {
    await server.close();
  }
}

function mutationOperationReference(result: unknown): ActiveFSOperationReference {
  if (
    result &&
    typeof result === "object" &&
    "operationId" in result &&
    typeof result.operationId === "string" &&
    "operationStatusEndpoint" in result &&
    typeof result.operationStatusEndpoint === "string"
  ) {
    return {
      operationId: result.operationId,
      operationStatusEndpoint: result.operationStatusEndpoint
    };
  }
  throw new Error("Expected write to include a concrete operation reference.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runServerAuthoritativeWriteDemo();
  console.log(JSON.stringify(result, null, 2));
}
