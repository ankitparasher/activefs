import { normalizeActiveFSPath, type ActiveFSPath } from "@activefs/core";
import { validateActiveFSSourceDiscoveryUrl } from "./protocol.js";

export * from "./protocol.js";
export * from "./client.js";
export * from "./service.js";
export * from "./node.js";

/** Product-neutral configured Source API remote. */
export interface ActiveFSTreeRemote {
  name: string;
  mountPath: ActiveFSPath;
  /** Exact discovery URL. */
  url: string;
  /** Explicit development-only opt-in for non-loopback HTTP discovery. */
  allowInsecureHttp?: boolean;
}

/** Parses `name=url` or `name:/mount=url` without rewriting the discovery URL. */
export function parseActiveFSTreeRemoteSpec(
  spec: string,
  options: { allowInsecureHttp?: boolean } = {}
): ActiveFSTreeRemote {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Source remote must be in name=url or name:/mount=url form: ${spec}`);
  }
  const left = spec.slice(0, separator).trim();
  const rawUrl = spec.slice(separator + 1).trim();
  const mountSeparator = left.indexOf(":");
  const name = mountSeparator >= 0 ? left.slice(0, mountSeparator) : left;
  validateSourceRemoteName(name);
  const mountPath = mountSeparator >= 0
    ? normalizeActiveFSPath(left.slice(mountSeparator + 1))
    : normalizeActiveFSPath(`/${name}`);
  return {
    name,
    mountPath,
    url: validateActiveFSSourceDiscoveryUrl(rawUrl, options),
    allowInsecureHttp: options.allowInsecureHttp || undefined
  };
}

function validateSourceRemoteName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid ActiveFS remote name: ${name}`);
  }
}
