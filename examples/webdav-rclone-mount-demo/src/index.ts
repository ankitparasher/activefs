import {
  createMountLayout,
  ensureMountLayout,
  loadActiveFSMountConfig,
  readMountCacheSnapshot,
  readRcloneMountStatus
} from "@activefs/mount";
import { upsertActiveFSRemote } from "@activefs/config";

export async function prepareMountDemo(
  rootDir = ".activefs",
  name = "local",
  sourceUrl = "http://127.0.0.1:3900/_activefs/"
) {
  await upsertActiveFSRemote(rootDir, {
    name,
    url: sourceUrl,
    mountPath: `/${name}`,
    remoteRoot: "/",
    managedWebDAV: { enabled: true, host: "127.0.0.1" },
    adapterCapabilityProfile: "full-filesystem-semantics",
    cacheMode: "off"
  });
  const mountConfig = await loadActiveFSMountConfig(rootDir);
  const remote = mountConfig.remotes[name]!;
  const layout = createMountLayout(rootDir, name);
  await ensureMountLayout(layout);
  // This inspects configured state only; real host mounts live in smoke:mount:*.
  return {
    layout,
    remote,
    status: await readRcloneMountStatus(layout, { remote, checkWebDAV: false }),
    cache: await readMountCacheSnapshot(layout)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await prepareMountDemo(process.argv[2], process.argv[3], process.argv[4]);
  console.log(JSON.stringify(result, null, 2));
}
