import * as z from "zod/v4";

const remoteNameSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Remote names may contain letters, digits, dots, underscores, and dashes.");

const activeFSPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"), "Paths must not contain NUL bytes.");

const activeFSUriSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      return new URL(value).protocol === "activefs:";
    } catch {
      return false;
    }
  }, "Expected an activefs:// URI.");

const enabledToolsSchema = z.object({
  list: z.boolean().default(true),
  stat: z.boolean().default(true),
  read: z.boolean().default(true),
  grep: z.boolean().default(true),
  write: z.boolean().default(false),
  mkdir: z.boolean().default(false),
  rm: z.boolean().default(false),
  mv: z.boolean().default(false),
  cp: z.boolean().default(false),
  export: z.boolean().default(false)
}).partial();

const authorizationRemoteSchema = z.object({
  read: z.boolean().optional(),
  search: z.boolean().optional(),
  write: z.boolean().optional(),
  subscribe: z.boolean().optional(),
  prompts: z.boolean().optional(),
  paths: z.array(z.object({
    match: z.enum(["exact", "prefix"]).default("prefix"),
    path: activeFSPathSchema,
    read: z.boolean().optional(),
    search: z.boolean().optional(),
    write: z.boolean().optional(),
    subscribe: z.boolean().optional()
  })).optional()
}).passthrough();

const remoteConfigSchema = z.object({
  name: remoteNameSchema,
  url: z.string().url(),
  rootPath: activeFSPathSchema.default("/"),
  title: z.string().optional(),
  watchable: z.boolean().optional(),
  allowInsecureHttp: z.boolean().optional(),
  auth: z.object({
    type: z.enum(["none", "bearer-env"]).default("none"),
    env: z.string().optional(),
    scheme: z.string().default("Bearer")
  }).optional()
});

export const activefsMCPServerConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().default("activefs-mcp"),
  version: z.string().default("0.1.1"),
  workspace: z.string().optional(),
  remotes: z.array(remoteConfigSchema).optional(),
  resources: z.object({
    includeDirectories: z.boolean().default(true),
    maxDepth: z.number().int().min(0).default(8),
    maxResources: z.number().int().min(1).max(100000).default(1000),
    pageSize: z.number().int().min(1).max(1000).default(100)
  }).partial().optional(),
  tools: enabledToolsSchema.optional(),
  prompts: z.object({
    enabled: z.boolean().default(true)
  }).partial().optional(),
  subscriptions: z.object({
    enabled: z.boolean().default(true),
    debounceMs: z.number().int().min(0).max(60000).default(25)
  }).partial().optional(),
  auth: z.object({
    mode: z.enum(["stdio", "bearer", "none"]).default("stdio"),
    tokenEnv: z.string().optional(),
    token: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    allowedHosts: z.array(z.string()).optional(),
    allowInsecureHttp: z.boolean().default(false),
    allowNetworkBind: z.boolean().default(false)
  }).partial().optional(),
  authorization: z.object({
    default: z.enum(["allow", "deny"]).default("allow"),
    remotes: z.record(remoteNameSchema, authorizationRemoteSchema).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    prompts: z.record(z.string(), z.boolean()).optional()
  }).partial().optional()
}).passthrough();

export const activefsListToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.default("/"),
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional(),
  includeNonEnumerable: z.boolean().default(false)
}).partial({ remote: true, cursor: true, includeNonEnumerable: true });

export const activefsStatToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.optional(),
  uri: activeFSUriSchema.optional()
}).refine((value) => value.path || value.uri, "Provide either path or uri.");

export const activefsReadToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.optional(),
  uri: activeFSUriSchema.optional(),
  encoding: z.enum(["utf8", "base64", "binary"]).optional(),
  offset: z.number().int().min(0).optional(),
  length: z.number().int().min(0).optional()
}).refine((value) => value.path || value.uri, "Provide either path or uri.");

export const activefsGrepToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.default("/"),
  query: z.string().min(1),
  caseSensitive: z.boolean().default(false),
  limit: z.number().int().min(1).max(1000).default(100),
  includeNonEnumerable: z.boolean().default(false)
}).partial({ remote: true, caseSensitive: true, includeNonEnumerable: true });

export const activefsWriteToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.optional(),
  uri: activeFSUriSchema.optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
  mimeType: z.string().optional(),
  create: z.boolean().default(true),
  overwrite: z.boolean().default(true),
  idempotencyKey: z.string().optional()
}).refine((value) => value.path || value.uri, "Provide either path or uri.")
  .refine((value) => value.text !== undefined || value.blob !== undefined, "Provide text or blob.");

export const activefsMkdirToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema,
  recursive: z.boolean().default(true),
  idempotencyKey: z.string().optional()
});

export const activefsRmToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.optional(),
  uri: activeFSUriSchema.optional(),
  recursive: z.boolean().default(false),
  idempotencyKey: z.string().optional()
}).refine((value) => value.path || value.uri, "Provide either path or uri.");

export const activefsMvToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  fromPath: activeFSPathSchema.optional(),
  fromUri: activeFSUriSchema.optional(),
  toPath: activeFSPathSchema,
  overwrite: z.boolean().default(false),
  idempotencyKey: z.string().optional()
}).refine((value) => value.fromPath || value.fromUri, "Provide either fromPath or fromUri.");

export const activefsCpToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  fromPath: activeFSPathSchema.optional(),
  fromUri: activeFSUriSchema.optional(),
  toPath: activeFSPathSchema,
  overwrite: z.boolean().default(false),
  recursive: z.boolean().default(false),
  idempotencyKey: z.string().optional()
}).refine((value) => value.fromPath || value.fromUri, "Provide either fromPath or fromUri.");

export const activefsExportToolInputSchema = z.object({
  remote: remoteNameSchema.optional(),
  path: activeFSPathSchema.default("/"),
  maxFiles: z.number().int().min(1).max(10000).default(1000)
}).partial({ remote: true });

export const activefsMCPToolInputSchemas = {
  activefs_list: activefsListToolInputSchema,
  activefs_stat: activefsStatToolInputSchema,
  activefs_read: activefsReadToolInputSchema,
  activefs_grep: activefsGrepToolInputSchema,
  activefs_write: activefsWriteToolInputSchema,
  activefs_mkdir: activefsMkdirToolInputSchema,
  activefs_rm: activefsRmToolInputSchema,
  activefs_mv: activefsMvToolInputSchema,
  activefs_cp: activefsCpToolInputSchema,
  activefs_export: activefsExportToolInputSchema
} as const;

export type ActiveFSMCPServerConfigFile = z.infer<typeof activefsMCPServerConfigSchema>;
export type ActiveFSMCPToolName = keyof typeof activefsMCPToolInputSchemas;

export const activefsMCPServerConfigJsonSchema = activefsMCPServerConfigSchema.toJSONSchema({
  target: "draft-7"
});

export const activefsMCPToolInputJsonSchemas = Object.fromEntries(
  Object.entries(activefsMCPToolInputSchemas).map(([name, schema]) => [
    name,
    schema.toJSONSchema({ target: "draft-7" })
  ])
) as unknown as Record<ActiveFSMCPToolName, Record<string, unknown>>;
