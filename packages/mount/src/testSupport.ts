import { upsertActiveFSRemote, type ActiveFSRemoteConfig } from "@activefs/config";
import { writeFile } from "node:fs/promises";
import {
  createMountLayout,
  ensureMountLayout,
  loadActiveFSMountConfig,
  readWebDAVRuntimeStatus,
  writeRcloneWebDAVConfig,
  writeWebDAVRuntimeStatus,
  type ActiveFSMountConfig,
  type ActiveFSMountLayout,
  type ActiveFSMountRemote,
  type MountCommandRunner,
  type WebDAVRuntimeStatus
} from "./index";

/**
 * Development-only helper for exercising low-level rclone/WebDAV mount state.
 *
 * This is intentionally source-relative test support, not part of the
 * published `@activefs/mount` API. User-facing setup should go through unified
 * ActiveFS remote config and the CLI.
 */
export function parseActiveFSRemoteSpec(spec: string): ActiveFSMountRemote {
  const separator = spec.indexOf("=");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`Mount target must be in name=url form: ${spec}`);
  }

  const name = spec.slice(0, separator).trim();
  const rawUrl = spec.slice(separator + 1).trim();
  validateRemoteName(name);

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Mount target ${name} must use an http:// or https:// WebDAV adapter URL.`);
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : undefined;
  const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
  parsed.username = "";
  parsed.password = "";

  return {
    name,
    url: parsed.toString(),
    username,
    password,
    vendor: "other"
  };
}

/**
 * Development-only helper for mount adapter tests that need prebuilt runtime
 * layout without invoking the CLI.
 */
export async function createActiveFSMountWorkspace(
  rootDir: string,
  remotes: ActiveFSMountRemote[],
  options: { rcloneBinary?: string; commandRunner?: MountCommandRunner } = {}
): Promise<{ config: ActiveFSMountConfig; layouts: ActiveFSMountLayout[] }> {
  if (remotes.length === 0) {
    throw new Error("At least one --remote name=url value is required.");
  }

  const config = await loadActiveFSMountConfig(rootDir);
  const layouts: ActiveFSMountLayout[] = [];
  for (const remote of remotes) {
    validateRemoteName(remote.name);
    const layout = createMountLayout(rootDir, remote.name, { mountpoint: remote.mountpoint });
    await ensureMountLayout(layout);
    await writeWebDAVCredentials(layout, remote);
    await writeWebDAVRuntimeStatus(layout, {
      remote: remote.name,
      state: "unknown",
      url: remote.url,
      auth: credentialSummary(remote)
    });
    await writeRcloneWebDAVConfig(remote, layout.rcloneConfigPath, options);
    await writeMountStatus(layout, {
      remote: remote.name,
      state: "configured",
      mounted: false,
      webdav: await readWebDAVRuntimeStatus(layout),
      message: "Mount layout configured."
    });
    const redacted = redactRemote(remote);
    config.remotes[remote.name] = redacted;
    await upsertActiveFSRemote(rootDir, unifiedRemoteFromMount(redacted));
    layouts.push(layout);
  }
  return { config, layouts };
}

function validateRemoteName(remoteName: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remoteName)) {
    throw new Error(`Invalid ActiveFS remote name: ${remoteName}`);
  }
}

function unifiedRemoteFromMount(remote: ActiveFSMountRemote): ActiveFSRemoteConfig {
  return {
    name: remote.name,
    url: remote.sourceUrl ?? remote.url,
    username: remote.username,
    hasCredentials: remote.hasCredentials,
    vendor: remote.vendor ?? "other",
    mountpoint: remote.mountpoint,
    remoteRoot: remote.remoteRoot,
    managedWebDAV: remote.managedWebDAV,
    policy: remote.policy,
    adapterCapabilityProfile: remote.adapterCapabilityProfile ?? "bounded-filesystem-semantics",
    cacheMode: remote.cacheMode ?? "off",
    activityPolicy: remote.activityPolicy ?? "best-effort"
  };
}

function redactRemote(remote: ActiveFSMountRemote): ActiveFSMountRemote {
  const redacted: ActiveFSMountRemote = {
    name: remote.name,
    url: remote.url,
    sourceUrl: remote.sourceUrl,
    vendor: remote.vendor ?? "other"
  };
  if (remote.username) {
    redacted.username = remote.username;
  }
  if (remote.password || remote.hasCredentials) {
    redacted.hasCredentials = true;
  }
  if (remote.managedWebDAV) {
    redacted.managedWebDAV = { ...remote.managedWebDAV };
  }
  if (remote.mountpoint) {
    redacted.mountpoint = remote.mountpoint;
  }
  if (remote.remoteRoot) {
    redacted.remoteRoot = remote.remoteRoot;
  }
  if (remote.policy) {
    redacted.policy = remote.policy;
  }
  if (remote.adapterCapabilityProfile) {
    redacted.adapterCapabilityProfile = remote.adapterCapabilityProfile;
  }
  if (remote.cacheMode) {
    redacted.cacheMode = remote.cacheMode;
  }
  if (remote.activityPolicy) {
    redacted.activityPolicy = remote.activityPolicy;
  }
  return redacted;
}

function credentialSummary(remote: ActiveFSMountRemote): WebDAVRuntimeStatus["auth"] {
  return {
    username: remote.username,
    hasPassword: Boolean(remote.password || remote.hasCredentials)
  };
}

async function writeWebDAVCredentials(
  layout: ActiveFSMountLayout,
  remote: ActiveFSMountRemote
): Promise<void> {
  if (!remote.username && !remote.password) {
    return;
  }
  await writeFile(
    layout.webdavCredentialsPath,
    `${JSON.stringify({
      remote: remote.name,
      username: remote.username,
      password: remote.password,
      updatedAt: new Date().toISOString()
    }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

async function writeMountStatus(
  layout: ActiveFSMountLayout,
  status: Record<string, unknown>
): Promise<void> {
  await writeFile(
    layout.mountStatusPath,
    `${JSON.stringify({
      rootDir: layout.rootDir,
      vfsDir: layout.vfsDir,
      configPath: layout.rcloneConfigPath,
      logFile: layout.rcloneLogPath,
      updatedAt: new Date().toISOString(),
      ...status
    }, null, 2)}\n`
  );
}
