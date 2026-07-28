import { describe, expect, it } from "vitest";
import { runServerAuthoritativeWriteDemo } from "./index";

describe("server-authoritative-write-demo example", () => {
  it("commits allowed writes and records denied writes through server operation status", async () => {
    const result = await runServerAuthoritativeWriteDemo();

    expect(result).toMatchObject({
      serverFinal: true,
      writablePath: "/uploads/accepted.txt",
      readonlyRejected: true,
      offlineQueue: false
    });
    expect(result.successOperation).toMatch(/^idempotency:/);
    expect(result.rejectedOperation).toMatch(/^idempotency:/);
  });
});
