import { describe, expect, it } from "vitest";
import {
  combinePolicies,
  createConfigPolicy,
  policyAllows
} from "@activefs/mcp";

describe("ActiveFS MCP policy", () => {
  it("enforces default deny plus per-remote and per-tool rules", async () => {
    const policy = createConfigPolicy({
      authorization: {
        default: "deny",
        remotes: {
          repo: {
            read: true,
            search: true,
            write: false,
            paths: [
              { match: "prefix", path: "/private", read: false, search: false }
            ]
          }
        },
        tools: {
          activefs_rm: false
        }
      }
    });

    await expect(policyAllows(policy, "resource", {
      context: {},
      remote: "repo",
      path: "/README.md",
      operation: "read"
    })).resolves.toBe(true);
    await expect(policyAllows(policy, "resource", {
      context: {},
      remote: "repo",
      path: "/private/secret.txt",
      operation: "read"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "tool", {
      context: {},
      remote: "repo",
      path: "/README.md",
      operation: "write",
      toolName: "activefs_write"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "tool", {
      context: {},
      remote: "repo",
      path: "/README.md",
      toolName: "activefs_rm"
    })).resolves.toBe(false);
  });

  it("handles prompts, subscriptions, exact paths, default allow, and combined policies", async () => {
    const policy = createConfigPolicy({
      authorization: {
        default: "allow",
        remotes: {
          repo: {
            read: false,
            subscribe: true,
            prompts: false,
            paths: [
              { match: "exact", path: "/public.txt", read: true },
              { match: "prefix", path: "/writeable", write: true }
            ]
          }
        },
        prompts: {
          activefs_search_then_read: false
        }
      }
    });

    await expect(policyAllows(policy, "resource", {
      context: {},
      remote: "repo",
      path: "/public.txt",
      operation: "list"
    })).resolves.toBe(true);
    await expect(policyAllows(policy, "resource", {
      context: {},
      remote: "repo",
      path: "/public.txt/child",
      operation: "read"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "tool", {
      context: {},
      remote: "repo",
      path: "/writeable/new.txt",
      toolName: "activefs_mkdir"
    })).resolves.toBe(true);
    await expect(policyAllows(policy, "tool", {
      context: {},
      remote: "repo",
      path: "/README.md",
      toolName: "activefs_grep"
    })).resolves.toBe(true);
    await expect(policyAllows(policy, "prompt", {
      context: {},
      remote: "repo",
      promptName: "activefs_browse_remote"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "prompt", {
      context: {},
      remote: "other",
      promptName: "activefs_search_then_read"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "subscribe", {
      context: {},
      remote: "repo",
      path: "/anything"
    })).resolves.toBe(true);
    await expect(policyAllows(policy, "resource", {
      context: {},
      path: "/no-remote"
    })).resolves.toBe(true);
    await expect(policyAllows(undefined, "resource", { context: {} })).resolves.toBe(true);

    const combined = combinePolicies(policy, {
      allowResource: () => false
    });
    await expect(policyAllows(combined, "resource", {
      context: {},
      remote: "repo",
      path: "/public.txt",
      operation: "read"
    })).resolves.toBe(false);
  });

  it("falls back predictably for remote-less requests, missing handlers, and mutating tools", async () => {
    const policy = createConfigPolicy({
      authorization: {
        default: "deny",
        remotes: {
          repo: {
            read: true,
            search: false,
            write: true,
            subscribe: false,
            paths: [
              { match: "prefix", path: "/live/", subscribe: true }
            ]
          }
        }
      }
    });

    await expect(policyAllows(policy, "tool", {
      context: {},
      toolName: "activefs_list"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "prompt", {
      context: {},
      promptName: "activefs_browse_remote"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "subscribe", {
      context: {}
    })).resolves.toBe(false);
    await expect(policyAllows({ allowResource: () => true }, "tool", {
      context: {}
    })).resolves.toBe(true);

    for (const toolName of ["activefs_rm", "activefs_mv", "activefs_cp", "activefs_export"]) {
      await expect(policyAllows(policy, "tool", {
        context: {},
        remote: "repo",
        path: "/changes/file.txt",
        toolName
      })).resolves.toBe(true);
    }
    await expect(policyAllows(policy, "tool", {
      context: {},
      remote: "repo",
      path: "/README.md",
      toolName: "activefs_grep"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "subscribe", {
      context: {},
      remote: "repo"
    })).resolves.toBe(false);
    await expect(policyAllows(policy, "subscribe", {
      context: {},
      remote: "repo",
      path: "/live/events.log"
    })).resolves.toBe(true);
  });
});
