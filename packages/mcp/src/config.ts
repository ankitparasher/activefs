import {
  ActiveFSError,
  createActiveFS,
  fsTree,
  text,
  bytes,
  normalizeActiveFSPath,
  type ActiveFS,
  type ActiveFSPath
} from "@activefs/core";
import {
  authHeadersFromProvider,
  createActiveFSRemoteStateLayout,
  loadActiveFSConfig as loadWorkspaceActiveFSConfig,
  type ActiveFSAuthProviderConfig
} from "@activefs/config";
import {
  createHttpSourceClient,
  type HttpSourceClientAuth
} from "@activefs/source-http";
import { readFile } from "node:fs/promises";
import {
  activefsMCPServerConfigSchema,
  type ActiveFSMCPServerConfigFile
} from "./schemas.js";
import type { ActiveFSMCPRemote, MCPAdapterOptions } from "./index.js";

export interface LoadActiveFSMCPConfigOptions<Auth = unknown, Meta = unknown> {
  configPath?: string;
  workspace?: string;
  demo?: boolean;
  filesystem?: ActiveFS<Auth, Meta>;
  remotes?: ActiveFSMCPRemote[];
  config?: Partial<ActiveFSMCPServerConfigFile>;
  env?: Record<string, string | undefined>;
}

export interface NormalizedActiveFSMCPServerConfig extends ActiveFSMCPServerConfigFile {
  resources: {
    includeDirectories: boolean;
    maxDepth: number;
    maxResources: number;
    pageSize: number;
  };
  tools: Required<NonNullable<ActiveFSMCPServerConfigFile["tools"]>>;
  prompts: { enabled: boolean };
  subscriptions: { enabled: boolean; debounceMs: number };
  auth: {
    mode: "stdio" | "bearer" | "none";
    tokenEnv?: string;
    token?: string;
    allowedOrigins?: string[];
    allowedHosts?: string[];
    allowInsecureHttp: boolean;
    allowNetworkBind: boolean;
  };
  authorization: NonNullable<ActiveFSMCPServerConfigFile["authorization"]>;
}

export interface LoadedActiveFSMCPConfig<Auth = unknown, Meta = unknown> {
  filesystem: ActiveFS<Auth, Meta>;
  remotes: ActiveFSMCPRemote[];
  config: NormalizedActiveFSMCPServerConfig;
  adapterOptions: Pick<
    MCPAdapterOptions<Auth, Meta>,
    "filesystem" | "remotes" | "includeDirectories" | "maxDepth" | "maxResources" | "resourceTemplates"
  >;
}

export async function loadActiveFSMCPConfig<Auth = unknown, Meta = unknown>(
  options: LoadActiveFSMCPConfigOptions<Auth, Meta> = {}
): Promise<LoadedActiveFSMCPConfig<Auth, Meta>> {
  const fileConfig = options.configPath
    ? activefsMCPServerConfigSchema.parse(JSON.parse(await readFile(options.configPath, "utf8")))
    : undefined;
  const config = normalizeActiveFSMCPServerConfig({
    ...(fileConfig ?? {}),
    ...(options.config ?? {}),
    workspace: options.workspace ?? options.config?.workspace ?? fileConfig?.workspace
  });

  if (options.filesystem) {
    if (!options.remotes?.length) {
      throw new ActiveFSError("INVALID_REQUEST", "Programmatic MCP configuration requires at least one explicit remote descriptor");
    }
    return loaded(options.filesystem, options.remotes, config);
  }

  if (options.demo) {
    const filesystem = createDemoFilesystem<Auth, Meta>();
    return loaded(filesystem, [{ name: "demo", rootPath: "/demo", title: "ActiveFS MCP demo", watchable: true }], config);
  }

  if (config.remotes?.length) {
    const filesystem = createActiveFS<Auth, Meta>();
    const remotes = config.remotes.map((remote) => {
      filesystem.mount(
        `/${remote.name}`,
        createHttpSourceClient<Auth, Meta>({
          name: remote.name,
          url: remote.url,
          allowInsecureHttp: remote.allowInsecureHttp,
          auth: mcpConfigSourceAuth(remote.auth, options.env),
          capabilities: remote.watchable === undefined ? undefined : { watchable: remote.watchable }
        })
      );
      return {
        name: remote.name,
        title: remote.title,
        rootPath: remoteRuntimeRoot(remote.name, remote.rootPath),
        watchable: remote.watchable
      };
    });
    return loaded(filesystem, remotes, config);
  }

  const workspace = config.workspace ?? options.workspace ?? ".";
  const workspaceConfig = await loadWorkspaceActiveFSConfig(workspace);
  const filesystem = createActiveFS<Auth, Meta>();
  const remotes: ActiveFSMCPRemote[] = [];
  for (const remote of Object.values(workspaceConfig.remotes)) {
    filesystem.mount(
      `/${remote.name}`,
      createHttpSourceClient<Auth, Meta>({
        name: remote.name,
        url: remote.url,
        allowInsecureHttp: Boolean(remote.insecureHttp?.allowed),
        auth: workspaceSourceAuth(workspace, remote.name, remote.auth),
        capabilities: remote.watchable === undefined ? undefined : { watchable: remote.watchable }
      })
    );
    remotes.push({
      name: remote.name,
      rootPath: remoteRuntimeRoot(remote.name, remote.remoteRoot ?? "/"),
      title: remote.name,
      watchable: remote.watchable
    });
  }
  if (remotes.length === 0) {
    throw new ActiveFSError(
      "INVALID_REQUEST",
      "No ActiveFS remotes are configured. Add a remote or pass --demo for the explicit MCP demo fixture."
    );
  }
  return loaded(filesystem, remotes, config);
}

export function normalizeActiveFSMCPServerConfig(
  input: Partial<ActiveFSMCPServerConfigFile> = {}
): NormalizedActiveFSMCPServerConfig {
  const parsed = activefsMCPServerConfigSchema.parse(input);
  return {
    ...parsed,
    resources: {
      includeDirectories: true,
      maxDepth: 8,
      maxResources: 1000,
      pageSize: 100,
      ...parsed.resources
    },
    tools: {
      list: true,
      stat: true,
      read: true,
      grep: true,
      write: false,
      mkdir: false,
      rm: false,
      mv: false,
      cp: false,
      export: false,
      ...parsed.tools
    },
    prompts: {
      enabled: true,
      ...parsed.prompts
    },
    subscriptions: {
      enabled: true,
      debounceMs: 25,
      ...parsed.subscriptions
    },
    auth: {
      mode: "stdio",
      allowInsecureHttp: false,
      allowNetworkBind: false,
      ...parsed.auth
    },
    authorization: {
      default: "allow",
      ...parsed.authorization
    }
  };
}

function loaded<Auth, Meta>(
  filesystem: ActiveFS<Auth, Meta>,
  remotes: ActiveFSMCPRemote[],
  config: NormalizedActiveFSMCPServerConfig
): LoadedActiveFSMCPConfig<Auth, Meta> {
  return {
    filesystem,
    remotes,
    config,
    adapterOptions: {
      filesystem,
      remotes,
      includeDirectories: config.resources.includeDirectories,
      maxDepth: config.resources.maxDepth,
      maxResources: config.resources.maxResources,
      resourceTemplates: remotes.map((remote) => ({
        name: `${remote.name} files`,
        title: `${remote.title ?? remote.name} files`,
        uriTemplate: `activefs://${remote.name}/{path}`,
        description: `Files exposed from the ${remote.name} ActiveFS remote.`
      }))
    }
  };
}

function createDemoFilesystem<Auth, Meta>(): ActiveFS<Auth, Meta> {
  const tree = fsTree<Auth, Meta>({
    "/hello.md": text("# Hello ActiveFS MCP\n", { type: "text/markdown", writable: true }),
    "/notes/today.txt": text("MCP can list, read, search, and subscribe to ActiveFS resources.", {
      writable: true
    }),
    "/bytes.bin": bytes(new Uint8Array([0, 1, 255]), { writable: true })
  }, {
    name: "activefs-mcp-demo",
    writable: true,
    capabilities: { write: true, mkdir: true, delete: true, rename: true, copy: true }
  });
  return createActiveFS<Auth, Meta>().mount("/demo", tree);
}

function remoteRuntimeRoot(remoteName: string, remoteRoot: string | undefined): ActiveFSPath {
  const normalizedRemoteRoot = normalizeActiveFSPath(remoteRoot ?? "/");
  return normalizedRemoteRoot === "/"
    ? normalizeActiveFSPath(`/${remoteName}`)
    : normalizeActiveFSPath(`/${remoteName}/${normalizedRemoteRoot.slice(1)}`);
}

function workspaceSourceAuth(
  workspace: string,
  remoteName: string,
  provider: ActiveFSAuthProviderConfig | undefined
): HttpSourceClientAuth | undefined {
  if (!provider || provider.type === "none") {
    return undefined;
  }
  return () => authHeadersFromProvider(provider, {
    layout: createActiveFSRemoteStateLayout(workspace, remoteName)
  });
}

function mcpConfigSourceAuth(
  provider: { type?: "none" | "bearer-env"; env?: string; scheme?: string } | undefined,
  env: Record<string, string | undefined> = process.env
): HttpSourceClientAuth | undefined {
  if (!provider || provider.type === "none") {
    return undefined;
  }
  if (provider.type === "bearer-env") {
    return () => {
      const token = provider.env ? env[provider.env] : undefined;
      return token
        ? { authorization: `${provider.scheme ?? "Bearer"} ${token}` }
        : {} as Record<string, string>;
    };
  }
  return undefined;
}
