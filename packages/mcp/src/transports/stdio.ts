import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadActiveFSMCPConfig,
  type LoadActiveFSMCPConfigOptions
} from "../config.js";
import {
  createActiveFSMCPServer,
  type ActiveFSMCPServerContextProvider,
  type ActiveFSMCPServerHandle
} from "../server.js";
import {
  stdioMCPIdentity,
  type ActiveFSMCPIdentity
} from "../auth.js";
import type { ActiveFSMCPPolicy } from "../policy.js";

export interface ActiveFSMCPStdioServerOptions<Auth = unknown, Meta = unknown>
  extends LoadActiveFSMCPConfigOptions<Auth, Meta> {
  identity?: ActiveFSMCPIdentity;
  context?: ActiveFSMCPServerContextProvider<Auth, Meta>;
  policy?: ActiveFSMCPPolicy<Auth, Meta>;
  installSignalHandlers?: boolean;
}

export async function startActiveFSMCPStdioServer<Auth = unknown, Meta = unknown>(
  options: ActiveFSMCPStdioServerOptions<Auth, Meta> = {}
): Promise<ActiveFSMCPServerHandle<Auth, Meta>> {
  const loaded = await loadActiveFSMCPConfig(options);
  const handle = createActiveFSMCPServer<Auth, Meta>({
    filesystem: loaded.filesystem,
    remotes: loaded.remotes,
    config: {
      ...loaded.config,
      auth: { ...loaded.config.auth, mode: "stdio" }
    },
    adapterOptions: loaded.adapterOptions,
    context: options.context,
    policy: options.policy,
    identity: options.identity ?? stdioMCPIdentity()
  });
  await handle.server.connect(new StdioServerTransport());
  if (options.installSignalHandlers !== false) {
    installShutdownHandlers(handle);
  }
  return handle;
}

function installShutdownHandlers<Auth, Meta>(handle: ActiveFSMCPServerHandle<Auth, Meta>): void {
  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
