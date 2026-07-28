import type {
  ActiveFSContext,
  ActiveFSPath,
  MaybePromise
} from "@activefs/core";
import type { ActiveFSMCPIdentity } from "./auth.js";
import type { ActiveFSMCPServerConfigFile } from "./schemas.js";

export type ActiveFSMCPPolicyOperation =
  | "list"
  | "read"
  | "search"
  | "write"
  | "subscribe";

export interface ActiveFSMCPPolicyRequest<Auth = unknown, Meta = unknown> {
  identity?: ActiveFSMCPIdentity;
  context: ActiveFSContext<Auth, Meta>;
  remote?: string;
  path?: ActiveFSPath;
  uri?: string;
  operation?: ActiveFSMCPPolicyOperation;
  toolName?: string;
  promptName?: string;
}

export interface ActiveFSMCPPolicy<Auth = unknown, Meta = unknown> {
  allowResource?: (request: ActiveFSMCPPolicyRequest<Auth, Meta>) => MaybePromise<boolean>;
  allowTool?: (request: ActiveFSMCPPolicyRequest<Auth, Meta>) => MaybePromise<boolean>;
  allowPrompt?: (request: ActiveFSMCPPolicyRequest<Auth, Meta>) => MaybePromise<boolean>;
  allowSubscribe?: (request: ActiveFSMCPPolicyRequest<Auth, Meta>) => MaybePromise<boolean>;
}

export function createConfigPolicy(
  config: Pick<ActiveFSMCPServerConfigFile, "authorization"> | undefined
): ActiveFSMCPPolicy {
  const authorization = config?.authorization;
  const defaultAllowed = authorization?.default !== "deny";

  return {
    allowResource: (request) => {
      if (!request.remote) {
        return defaultAllowed;
      }
      const remote = authorization?.remotes?.[request.remote];
      return decideRemoteAccess(remote, request.operation ?? "read", request.path, defaultAllowed);
    },
    allowTool: (request) => {
      if (request.toolName && authorization?.tools?.[request.toolName] === false) {
        return false;
      }
      if (!request.remote) {
        return defaultAllowed;
      }
      const remote = authorization?.remotes?.[request.remote];
      return decideRemoteAccess(remote, request.operation ?? operationForTool(request.toolName), request.path, defaultAllowed);
    },
    allowPrompt: (request) => {
      if (request.promptName && authorization?.prompts?.[request.promptName] === false) {
        return false;
      }
      if (!request.remote) {
        return defaultAllowed;
      }
      const remote = authorization?.remotes?.[request.remote];
      return remote?.prompts ?? defaultAllowed;
    },
    allowSubscribe: (request) => {
      if (!request.remote) {
        return defaultAllowed;
      }
      const remote = authorization?.remotes?.[request.remote];
      return decideRemoteAccess(remote, "subscribe", request.path, defaultAllowed);
    }
  };
}

export async function policyAllows<Auth, Meta>(
  policy: ActiveFSMCPPolicy<Auth, Meta> | undefined,
  kind: "resource" | "tool" | "prompt" | "subscribe",
  request: ActiveFSMCPPolicyRequest<Auth, Meta>
): Promise<boolean> {
  if (!policy) {
    return true;
  }
  const handler = kind === "resource"
    ? policy.allowResource
    : kind === "tool"
      ? policy.allowTool
      : kind === "prompt"
        ? policy.allowPrompt
        : policy.allowSubscribe;
  return handler ? Boolean(await handler(request)) : true;
}

export function combinePolicies<Auth, Meta>(
  ...policies: Array<ActiveFSMCPPolicy<Auth, Meta> | undefined>
): ActiveFSMCPPolicy<Auth, Meta> {
  return {
    allowResource: (request) => allPoliciesAllow(policies, "resource", request),
    allowTool: (request) => allPoliciesAllow(policies, "tool", request),
    allowPrompt: (request) => allPoliciesAllow(policies, "prompt", request),
    allowSubscribe: (request) => allPoliciesAllow(policies, "subscribe", request)
  };
}

type RemoteAuthorization = NonNullable<NonNullable<ActiveFSMCPServerConfigFile["authorization"]>["remotes"]>[string];
type PathAuthorization = NonNullable<RemoteAuthorization["paths"]>[number];

async function allPoliciesAllow<Auth, Meta>(
  policies: Array<ActiveFSMCPPolicy<Auth, Meta> | undefined>,
  kind: "resource" | "tool" | "prompt" | "subscribe",
  request: ActiveFSMCPPolicyRequest<Auth, Meta>
): Promise<boolean> {
  for (const policy of policies) {
    if (!(await policyAllows(policy, kind, request))) {
      return false;
    }
  }
  return true;
}

function decideRemoteAccess(
  remote: RemoteAuthorization | undefined,
  operation: ActiveFSMCPPolicyOperation,
  path: ActiveFSPath | undefined,
  fallback: boolean
): boolean {
  const pathRule = path ? firstMatchingPathRule(remote?.paths, path) : undefined;
  const pathDecision = pathRule ? decisionForOperation(pathRule, operation) : undefined;
  if (pathDecision !== undefined) {
    return pathDecision;
  }
  const remoteDecision = remote ? decisionForOperation(remote, operation) : undefined;
  return remoteDecision ?? fallback;
}

function decisionForOperation(
  policy: Pick<RemoteAuthorization, "read" | "search" | "write" | "subscribe">,
  operation: ActiveFSMCPPolicyOperation
): boolean | undefined {
  if (operation === "list" || operation === "read") {
    return policy.read;
  }
  if (operation === "search") {
    return policy.search;
  }
  if (operation === "write") {
    return policy.write;
  }
  if (operation === "subscribe") {
    return policy.subscribe;
  }
  return undefined;
}

function firstMatchingPathRule(
  paths: PathAuthorization[] | undefined,
  path: ActiveFSPath
): PathAuthorization | undefined {
  return paths?.find((rule) => rule.match === "exact"
    ? rule.path === path
    : path === rule.path || path.startsWith(`${rule.path.replace(/\/$/, "")}/`));
}

function operationForTool(toolName: string | undefined): ActiveFSMCPPolicyOperation {
  if (toolName === "activefs_grep") {
    return "search";
  }
  if (
    toolName === "activefs_write" ||
    toolName === "activefs_mkdir" ||
    toolName === "activefs_rm" ||
    toolName === "activefs_mv" ||
    toolName === "activefs_cp" ||
    toolName === "activefs_export"
  ) {
    return "write";
  }
  return "read";
}
