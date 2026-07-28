import {
  ActiveFSError,
  normalizeActiveFSPath,
  type ActiveFSPath
} from "@activefs/core";
import type { ActiveFSMCPRemote } from "./index.js";

export interface ParsedActiveFSMCPUri {
  remote: Required<Pick<ActiveFSMCPRemote, "name" | "rootPath">> & Pick<ActiveFSMCPRemote, "title" | "watchable">;
  path: ActiveFSPath;
}

export function parseActiveFSMCPUri(uri: string, remotes: ActiveFSMCPRemote[]): ParsedActiveFSMCPUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new ActiveFSError("INVALID_PATH", `Invalid ActiveFS MCP URI: ${uri}`, { cause: error });
  }
  if (parsed.protocol !== "activefs:") {
    throw new ActiveFSError("INVALID_PATH", `Unsupported ActiveFS MCP URI scheme: ${uri}`);
  }
  const remoteName = decodeURIComponent(parsed.hostname);
  const remote = remotes.find((candidate) => candidate.name === remoteName);
  if (!remote) {
    throw new ActiveFSError("NOT_FOUND", `Unknown ActiveFS MCP remote: ${remoteName}`);
  }
  return {
    remote: {
      name: remote.name,
      rootPath: normalizeActiveFSPath(remote.rootPath ?? "/"),
      title: remote.title,
      watchable: remote.watchable
    },
    path: normalizeActiveFSPath(decodeURIComponent(parsed.pathname || "/"))
  };
}

export function activeFSMCPResourceUri(remote: string, path: string): string {
  return `activefs://${encodeURIComponent(remote)}${encodeURI(normalizeActiveFSPath(path))}`;
}

export function activeFSMCPRuntimePath(remote: Pick<ActiveFSMCPRemote, "rootPath">, path: string): ActiveFSPath {
  const rootPath = normalizeActiveFSPath(remote.rootPath ?? "/");
  const normalizedPath = normalizeActiveFSPath(path);
  if (rootPath === "/") {
    return normalizedPath;
  }
  if (normalizedPath === "/") {
    return rootPath;
  }
  return normalizeActiveFSPath(`${rootPath}/${normalizedPath.slice(1)}`);
}

export function activeFSMCPRemotePath(remote: Pick<ActiveFSMCPRemote, "rootPath">, runtimePath: string): ActiveFSPath {
  const rootPath = normalizeActiveFSPath(remote.rootPath ?? "/");
  const normalizedPath = normalizeActiveFSPath(runtimePath);
  if (rootPath === "/") {
    return normalizedPath;
  }
  if (normalizedPath === rootPath) {
    return "/";
  }
  if (normalizedPath.startsWith(`${rootPath}/`)) {
    return normalizeActiveFSPath(normalizedPath.slice(rootPath.length));
  }
  return normalizedPath;
}
