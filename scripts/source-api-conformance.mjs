#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { bytes, createActiveFS, fsTree, text } from "../packages/core/dist/index.js";
import {
  ACTIVEFS_SOURCE_PROTOCOL_VERSION,
  createHttpSourceClient,
  startActiveFSServer
} from "../packages/source-http/dist/index.js";

const outPath = optionValue(process.argv.slice(2), "--out");
const externalDiscoveryUrl = optionValue(process.argv.slice(2), "--url");
const externalToken = optionValue(process.argv.slice(2), "--token");
const startedAt = performance.now();
const checks = [];
const seenContexts = [];
const seenCommands = [];
const serializableContext = ({ signal: _signal, ...context }) =>
  JSON.parse(JSON.stringify(context));
const commandInfo = (path, kind = "file") => ({
  path,
  name: path === "/" ? "" : path.slice(path.lastIndexOf("/") + 1),
  kind,
  enumerable: true
});
const recordCommand = (command, ctx, input) => {
  seenCommands.push({ command, ctx: serializableContext(ctx), input });
};
const tree = fsTree({
  "/README.txt": text("hello source api needle\n")
    .setRead(({ ctx }) => {
      seenContexts.push(serializableContext(ctx));
      return "hello source api needle\n";
    })
    .setStat(({ ctx, input }) => {
      recordCommand("stat", ctx, input);
      return commandInfo("/README.txt");
    })
    .setCat(({ ctx, input }) => {
      recordCommand("cat", ctx, input);
      return "custom cat\n";
    })
    .setHead(({ ctx, input }) => {
      recordCommand("head", ctx, input);
      return `custom head ${input.lines}\n`;
    })
    .setTail(({ ctx, input }) => {
      recordCommand("tail", ctx, input);
      return `custom tail ${input.lines}\n`;
    })
    .setSed(({ ctx, input }) => {
      recordCommand("sed", ctx, input);
      return `custom sed ${input.pattern} ${input.replacement}\n`;
    })
    .setGrep(({ ctx, input }) => {
      recordCommand("grep", ctx, input);
      return {
        matches: [{ path: "/README.txt", excerpt: `custom grep ${input.pattern}` }],
        complete: true,
        strategy: "source"
      };
    })
    .setRg(({ ctx, input }) => {
      recordCommand("rg", ctx, input);
      return {
        matches: [{ path: "/README.txt", excerpt: `custom rg ${input.pattern}` }],
        complete: true,
        strategy: "source"
      };
    }),
  "/bytes.bin": bytes(new Uint8Array([0, 1, 2, 3, 255]))
}, {
  name: "source-api-conformance",
  writable: true,
  ls: ({ ctx, input }) => {
    recordCommand("ls", ctx, input);
    return [commandInfo("/README.txt"), commandInfo("/bytes.bin")];
  },
  find: ({ ctx, input }) => {
    recordCommand("find", ctx, input);
    return [commandInfo("/", "directory"), commandInfo("/README.txt")];
  }
});
const server = externalDiscoveryUrl
  ? undefined
  : await startActiveFSServer({
    tree,
    auth: { type: "bearer", token: "activefs-conformance-token" }
  });
const discoveryUrl = externalDiscoveryUrl ?? server.url;
const client = createHttpSourceClient({
  url: discoveryUrl,
  auth: externalDiscoveryUrl
    ? externalToken
    : { type: "bearer", token: "activefs-conformance-token" }
});

try {
  await check("exact-discovery-and-advertised-endpoints", async () => {
    const handshake = await client.fetchHandshake();
    assert.equal(client.discoveryUrl, discoveryUrl);
    assert.equal(handshake.protocol, "activefs-source");
    assert.equal(handshake.protocolVersion, ACTIVEFS_SOURCE_PROTOCOL_VERSION);
    for (const operation of ["stat", "list", "read"]) {
      assert.equal(typeof handshake.endpoints[operation], "string");
      assert.ok(handshake.endpoints[operation].length > 0);
    }
  });

  await check("capabilities-protocol-version", async () => {
    const capabilities = await client.fetchCapabilities();
    assert.equal(capabilities.protocolVersion, ACTIVEFS_SOURCE_PROTOCOL_VERSION);
    assert.equal(capabilities.readable, true);
    assert.equal(capabilities.statable, true);
    assert.equal(capabilities.listable, true);
    if (!externalDiscoveryUrl) {
      assert.equal(capabilities.searchable, true);
      assert.equal(capabilities.writable, true);
      assert.equal(capabilities.watchable, true);
      assert.deepEqual(capabilities.commands, [
        "ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"
      ]);
    }
  });

  if (externalDiscoveryUrl) {
    await check("external-root-stat-list-and-read", async () => {
      const root = await client.info({}, "/");
      assert.equal(root?.kind, "directory");
      const entries = await client.list({}, "/");
      assert.ok(Array.isArray(entries));
      const firstFile = entries.find((entry) => entry?.kind === "file" && typeof entry.path === "string");
      if (firstFile) {
        await client.read({}, firstFile.path);
      }
    });
  } else {
    await check("activefs-runtime-adapter-equivalence", async () => {
    const fs = createActiveFS().mount("/remote", client);
    const entries = await fs.list({}, "/remote");
    const read = await fs.read({}, "/remote/README.txt", { encoding: "utf8" });
    const search = await fs.search({}, "/remote", { pattern: "needle" });
    assert.deepEqual(entries.map((entry) => entry.path).sort(), [
      "/remote/README.txt",
      "/remote/bytes.bin"
    ]);
    assert.equal(read.content, "hello source api needle\n");
    assert.equal(search.matches[0]?.path, "/remote/README.txt");
    });

    await check("json-and-base64-read", async () => {
    const text = await client.read({}, "/README.txt", { encoding: "utf8" });
    const bytes = await client.read({}, "/bytes.bin", { offset: 1, length: 3 });
    assert.equal(text.content, "hello source api needle\n");
    assert.deepEqual([...bytes.content], [1, 2, 3]);
    });

  await check("octet-stream-read", async () => {
    const handshake = await client.fetchHandshake();
    const response = await fetch(handshake.endpoints.read, {
      method: "POST",
      headers: {
        accept: "application/octet-stream",
        authorization: "Bearer activefs-conformance-token",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        path: "/bytes.bin",
        ctx: {},
        options: { offset: 2, length: 2 },
        responseFormat: "octet-stream"
      })
    });
    assert.equal(response.status, 200);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3]);
    assert.ok(response.headers.get("x-activefs-stat"));
  });

  await check("opaque-auth-meta-forwarding", async () => {
    const context = {
      auth: { subject: "tree-owned-subject" },
      meta: { requestId: "req-conformance" }
    };
    await client.read(context, "/README.txt", { encoding: "utf8" });
    assert.deepEqual(seenContexts.at(-1), context);
  });

  await check("optional-command-handler-round-trip", async () => {
    const context = {
      auth: { subject: "command-owned-subject" },
      meta: { requestId: "req-command-conformance" }
    };
    const fs = createActiveFS().mount("/remote", client);
    const listed = await fs.command(context, "ls", "/remote", { includeNonEnumerable: true });
    const stated = await fs.command(context, "stat", "/remote/README.txt", {});
    const cat = await fs.command(context, "cat", "/remote/README.txt", {});
    const head = await fs.command(context, "head", "/remote/README.txt", { lines: 2 });
    const tail = await fs.command(context, "tail", "/remote/README.txt", { lines: 3 });
    const sed = await fs.command(context, "sed", "/remote/README.txt", {
      pattern: "needle",
      replacement: "match",
      global: true
    });
    const grep = await fs.command(context, "grep", "/remote/README.txt", { pattern: "needle" });
    const rg = await fs.command(context, "rg", "/remote/README.txt", { pattern: "needle" });
    const found = await fs.command(context, "find", "/remote", { includeNonEnumerable: true });

    assert.deepEqual(listed.map((entry) => entry.path), ["/remote/bytes.bin", "/remote/README.txt"]);
    assert.equal(stated?.path, "/remote/README.txt");
    assert.equal(cat.content, "custom cat\n");
    assert.equal(head.content, "custom head 2\n");
    assert.equal(tail.content, "custom tail 3\n");
    assert.equal(sed.content, "custom sed needle match\n");
    assert.equal(grep.complete, true);
    assert.equal(grep.strategy, "source");
    assert.equal(grep.matches[0]?.path, "/remote/README.txt");
    assert.equal(grep.matches[0]?.excerpt, "custom grep needle");
    assert.equal(rg.complete, true);
    assert.equal(rg.strategy, "source");
    assert.equal(rg.matches[0]?.path, "/remote/README.txt");
    assert.equal(rg.matches[0]?.excerpt, "custom rg needle");
    assert.deepEqual(found.map((entry) => entry.path), ["/remote", "/remote/README.txt"]);
    assert.deepEqual(seenCommands.map(({ command }) => command), [
      "ls", "stat", "cat", "head", "tail", "sed", "grep", "rg", "find"
    ]);
    for (const call of seenCommands) {
      assert.deepEqual(call.ctx, context);
    }
    assert.deepEqual(seenCommands.find(({ command }) => command === "tail")?.input, { lines: 3 });
    assert.deepEqual(seenCommands.find(({ command }) => command === "sed")?.input, {
      pattern: "needle",
      replacement: "match",
      global: true
    });
  });

  await check("write-and-sse-watch", async () => {
    const events = [];
    const subscription = await client.watch({}, "/", (event) => events.push(event), {
      recursive: true
    });
    await client.write({}, "/written.txt", "written through source api", {
      contentType: "text/plain"
    });
    await waitFor(() => events.some((event) => event.path === "/written.txt"));
    await subscription.close();
    const read = await client.read({}, "/written.txt", { encoding: "utf8" });
    assert.equal(read.content, "written through source api");
  });

  await check("external-internal-error-code-mapping", async () => {
    const handshake = await client.fetchHandshake();
    const expected = new Map([
      ["NOT_FOUND", "NOT_FOUND"],
      ["NOT_A_DIRECTORY", "NOT_DIRECTORY"],
      ["IS_DIRECTORY", "NOT_FILE"],
      ["PERMISSION_DENIED", "FORBIDDEN"],
      ["UNSUPPORTED_OPERATION", "UNSUPPORTED"],
      ["INVALID_PATH", "INVALID_PATH"],
      ["RANGE_NOT_SATISFIABLE", "INVALID_PATH"],
      ["SOURCE_UNAVAILABLE", "SOURCE_ERROR"],
      ["TIMEOUT", "SOURCE_ERROR"],
      ["INTERNAL_ERROR", "SOURCE_ERROR"]
    ]);
    for (const [externalCode, internalCode] of expected) {
      const failingClient = createHttpSourceClient({
        url: discoveryUrl,
        handshake,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                name: "ActiveFSError",
                code: externalCode,
                message: externalCode,
                path: "/bad"
              }
            }),
            {
              status: 500,
              headers: { "content-type": "application/json" }
            }
          )
      });
      await assert.rejects(
        () => failingClient.read({}, "/bad"),
        (error) => error?.name === "ActiveFSError" && error.code === internalCode
      );
    }
  });
  }

  const result = {
    version: 1,
    status: "passed",
    discoveryUrl: client.discoveryUrl,
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    checks,
    durationMs: Number((performance.now() - startedAt).toFixed(3))
  };
  await writeResult(result);
  console.log(`ActiveFS Source API conformance passed (${checks.length} checks).`);
} catch (error) {
  const result = {
    version: 1,
    status: "failed",
    protocolVersion: ACTIVEFS_SOURCE_PROTOCOL_VERSION,
    checks,
    error: error instanceof Error ? error.message : String(error),
    durationMs: Number((performance.now() - startedAt).toFixed(3))
  };
  await writeResult(result);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await server?.close();
}

async function check(name, run) {
  const started = performance.now();
  await run();
  checks.push({
    name,
    status: "passed",
    durationMs: Number((performance.now() - started).toFixed(3))
  });
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) {
      throw new Error("Timed out waiting for Source API watch event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function writeResult(result) {
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  }
}

function optionValue(args, option) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}
