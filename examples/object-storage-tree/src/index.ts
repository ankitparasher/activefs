import {
  ActiveFSError,
  activeFSContentByteLength,
  createActiveFS,
  file,
  fsTree,
  isActiveFSPathWithin,
  normalizeActiveFSPath,
  sliceActiveFSContent,
  type ActiveFSDirEntry,
  type ActiveFSPath,
  type ActiveFSReadOptions,
  type ActiveFSSearchMatch,
  type ActiveFSSearchQuery,
  type ActiveFSTree,
  type ActiveFSTreeInfo
} from "@activefs/core";

interface StoredObject {
  bucket: string;
  key: string;
  content: string;
  contentType: string;
  etag: string;
  version: string;
}

interface ObjectDiagnostics {
  readonly objectReads: number;
}

interface S3ListObjectsV2Input {
  Bucket: string;
  Prefix?: string;
  Delimiter?: string;
  MaxKeys?: number;
}

interface S3HeadObjectInput {
  Bucket: string;
  Key: string;
}

interface S3GetObjectInput {
  Bucket: string;
  Key: string;
  Range?: string;
}

interface S3ObjectSummary {
  Key?: string;
  Size?: number;
  ETag?: string;
  LastModified?: Date;
}

interface S3ListObjectsV2Output {
  Contents?: S3ObjectSummary[];
  CommonPrefixes?: Array<{ Prefix?: string }>;
}

interface S3HeadObjectOutput {
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  VersionId?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
}

interface S3GetObjectOutput extends S3HeadObjectOutput {
  Body?: S3Body;
}

type S3Body =
  | Uint8Array
  | string
  | {
      transformToByteArray?: () => Promise<Uint8Array>;
      transformToString?: () => Promise<string>;
    };

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface S3CommandFactory {
  listObjectsV2(input: S3ListObjectsV2Input): unknown;
  headObject(input: S3HeadObjectInput): unknown;
  getObject(input: S3GetObjectInput): unknown;
}

export interface S3ObjectStorageTreeOptions {
  bucket: string;
  prefix?: string;
  client: S3CommandClient;
  commands: S3CommandFactory;
}

export interface AwsSdkS3ObjectStorageTreeOptions {
  bucket: string;
  prefix?: string;
  region?: string;
}

const objects: StoredObject[] = [
  {
    bucket: "assets",
    key: "packages/app-1.0.0.txt",
    content: "activefs-object-package-v1\n",
    contentType: "text/plain",
    etag: "etag-assets-app-100",
    version: "v3"
  },
  {
    bucket: "assets",
    key: "reports/usage.csv",
    content: "day,downloads\n2026-06-26,42\n",
    contentType: "text/csv",
    etag: "etag-assets-usage-042",
    version: "v7"
  },
  {
    bucket: "billing",
    key: "exports/invoices-2026-06.csv",
    content: "invoice,total\nINV-1001,125.00\n",
    contentType: "text/csv",
    etag: "etag-billing-invoices-2026-06",
    version: "v2"
  }
];

export function createObjectStorageTree(): {
  tree: ActiveFSTree;
  diagnostics: ObjectDiagnostics;
} {
  let objectReads = 0;

  return {
    diagnostics: {
      get objectReads() {
        return objectReads;
      }
    },
    tree: fsTree(objectStorageDeclarations(() => {
      objectReads += 1;
    }), {
      name: "object-storage-fixture",
      async search({ path, query }) {
        const searchQuery = query!;
        const normalizedPath = normalizeActiveFSPath(path);
        const maxResults = searchQuery.maxResults ?? Number.POSITIVE_INFINITY;
        const matches: ActiveFSSearchMatch[] = [];

        for (const entry of searchableFixtureFiles()) {
          if (!isActiveFSPathWithin(normalizedPath, entry.path)) {
            continue;
          }
          for (const match of searchText(entry.path, entry.content, searchQuery)) {
            if (matches.length >= maxResults) {
              return { matches, complete: false, strategy: "source", incompleteReasons: ["max-results"] };
            }
            matches.push(match);
          }
        }

        return { matches, complete: true, strategy: "source" };
      }
    })
  };
}

export function createS3ObjectStorageTree(options: S3ObjectStorageTreeOptions): ActiveFSTree {
  const bucket = options.bucket;
  const rootPrefix = normalizeS3Prefix(options.prefix ?? "");

  return fsTree({}, {
    name: "s3-object-storage",
    capabilities: {
      stat: true,
      list: true,
      read: true,
      rangeReadable: true
    },

    async info({ path }) {
      const parsed = parseS3Path(bucket, rootPrefix, path);
      if (!parsed) {
        return null;
      }
      if (parsed.kind === "root" || parsed.kind === "bucket") {
        return directoryInfo(parsed.sourcePath);
      }

      if (parsed.metadataSidecar) {
        const head = await headS3Object(options, bucket, parsed.actualKey);
        return head ? s3MetadataInfo(bucket, parsed.sourcePath, parsed.actualKey, head) : null;
      }

      const head = await headS3Object(options, bucket, parsed.actualKey);
      if (head) {
        return s3ObjectInfo(bucket, parsed.sourcePath, parsed.actualKey, head);
      }

      return (await s3PrefixExists(options, bucket, ensureTrailingSlash(parsed.actualKey)))
        ? directoryInfo(parsed.sourcePath)
        : null;
    },

    async list({ path }) {
      const parsed = parseS3Path(bucket, rootPrefix, path);
      if (!parsed || parsed.kind === "entry" && parsed.metadataSidecar) {
        throw new ActiveFSError("NOT_DIRECTORY", `Path is not a directory: ${normalizeActiveFSPath(path)}`, {
          path: normalizeActiveFSPath(path)
        });
      }
      if (parsed.kind === "root") {
        return [{
          name: bucket,
          path: normalizeActiveFSPath(`/${bucket}`),
          kind: "directory",
          permissions: { readable: true, searchable: true }
        }];
      }

      const prefix = parsed.kind === "entry" ? ensureTrailingSlash(parsed.actualKey) : parsed.actualPrefix;
      const listed = await options.client.send(options.commands.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: "/"
      })) as S3ListObjectsV2Output;

      return listS3Infos(bucket, rootPrefix, listed);
    },

    async read({ path, options: readOptions }) {
      const rangeOptions = readOptions as ActiveFSReadOptions | undefined;
      const parsed = parseS3Path(bucket, rootPrefix, path);
      if (!parsed || parsed.kind !== "entry") {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${normalizeActiveFSPath(path)}`, {
          path: normalizeActiveFSPath(path)
        });
      }

      const head = await headS3Object(options, bucket, parsed.actualKey);
      if (!head) {
        throw new ActiveFSError("NOT_FOUND", `Path not found: ${parsed.sourcePath}`, {
          path: parsed.sourcePath
        });
      }

      if (parsed.metadataSidecar) {
        const content = s3MetadataContent(bucket, parsed.actualKey, head);
        return {
          content: sliceActiveFSContent(new TextEncoder().encode(content), rangeOptions),
          info: s3MetadataInfo(bucket, parsed.sourcePath, parsed.actualKey, head)
        };
      }

      const response = await options.client.send(options.commands.getObject({
        Bucket: bucket,
        Key: parsed.actualKey,
        Range: rangeOptions?.offset === undefined && rangeOptions?.length === undefined
          ? undefined
          : toHttpRange(rangeOptions)
      })) as S3GetObjectOutput;
      const bytes = await s3BodyToBytes(response.Body);
      const info = s3ObjectInfo(bucket, parsed.sourcePath, parsed.actualKey, {
        ...head,
        ...response
      });
      return {
        content: rangeOptions?.offset === undefined && rangeOptions?.length === undefined
          ? bytes
          : sliceActiveFSContent(bytes, { encoding: rangeOptions?.encoding }),
        info
      };
    }
  });
}

export async function createAwsSdkS3ObjectStorageTree(
  options: AwsSdkS3ObjectStorageTreeOptions
): Promise<ActiveFSTree> {
  // Keep the AWS SDK dependency on the explicit manual S3 path, not the fixture smoke path.
  const aws = await import("@aws-sdk/client-s3");
  return createS3ObjectStorageTree({
    bucket: options.bucket,
    prefix: options.prefix,
    client: new aws.S3Client({ region: options.region }),
    commands: {
      listObjectsV2: (input) => new aws.ListObjectsV2Command(input),
      headObject: (input) => new aws.HeadObjectCommand(input),
      getObject: (input) => new aws.GetObjectCommand(input)
    }
  });
}

export function readS3OptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AwsSdkS3ObjectStorageTreeOptions {
  const bucket = env.ACTIVEFS_S3_BUCKET;
  if (!bucket) {
    throw new ActiveFSError("INVALID_REQUEST", "Set ACTIVEFS_S3_BUCKET to run object-storage-tree --s3.");
  }
  return {
    bucket,
    prefix: env.ACTIVEFS_S3_PREFIX,
    region: env.AWS_REGION
  };
}

export async function runObjectStorageTreeExample() {
  const { tree, diagnostics } = createObjectStorageTree();
  const fs = createActiveFS().mount("/objects", tree);
  const packages = await fs.list({}, "/objects/assets/packages");
  const stat = await fs.stat({}, "/objects/assets/packages/app-1.0.0.txt");
  const metadata = await fs.read({}, "/objects/assets/packages/app-1.0.0.txt.meta.json");
  const readsBeforeContent = diagnostics.objectReads;
  const range = await fs.read({}, "/objects/assets/packages/app-1.0.0.txt", {
    offset: 0,
    length: 9
  });
  const matches = await fs.search({}, "/objects", { pattern: "invoice" });

  return {
    packages: packages.map((entry) => entry.path),
    etag: stat?.etag,
    version: stat?.revision,
    metadata: textContent(metadata).split("\n")[1]?.trim(),
    readsBeforeContent,
    range: textContent(range),
    readsAfterContent: diagnostics.objectReads,
    matches: matches.matches.map((match) => `${match.path}:${match.line ?? 0}`)
  };
}

export async function runS3ObjectStorageTreeExample(
  options: AwsSdkS3ObjectStorageTreeOptions = readS3OptionsFromEnv()
) {
  const tree = await createAwsSdkS3ObjectStorageTree(options);
  const fs = createActiveFS().mount("/s3", tree);
  const bucketPath = normalizeActiveFSPath(`/s3/${options.bucket}`);
  const entries = await fs.list({}, bucketPath);
  const firstFile = await findFirstS3File(fs, bucketPath, entries);
  if (!firstFile) {
    return {
      bucket: options.bucket,
      prefix: options.prefix ?? "",
      entries: entries.map((entry) => entry.path),
      firstFile: null
    };
  }
  const stat = await fs.stat({}, firstFile);
  const metadata = await fs.read({}, `${firstFile}.meta.json`);
  const preview = await fs.read({}, firstFile, { offset: 0, length: 64 });
  return {
    bucket: options.bucket,
    prefix: options.prefix ?? "",
    entries: entries.map((entry) => entry.path),
    firstFile,
    etag: stat?.etag,
    version: stat?.revision,
    metadata: textContent(metadata),
    previewBytes: activeFSContentByteLength(preview.content)
  };
}

async function findFirstS3File(
  fs: ReturnType<typeof createActiveFS>,
  rootPath: ActiveFSPath,
  entries: ActiveFSDirEntry[]
): Promise<ActiveFSPath | null> {
  for (const entry of entries) {
    if (entry.kind === "file" && !entry.path.endsWith(".meta.json")) {
      return entry.path;
    }
  }
  for (const entry of entries) {
    if (entry.kind === "directory") {
      const nested = await findFirstS3File(fs, entry.path, await fs.list({}, entry.path));
      if (nested) {
        return nested;
      }
    }
  }
  return rootPath === "/" ? null : null;
}

function objectPath(object: StoredObject): ActiveFSPath {
  return normalizeActiveFSPath(`/${object.bucket}/${object.key}`);
}

function metadataPath(object: StoredObject): ActiveFSPath {
  return normalizeActiveFSPath(`${objectPath(object)}.meta.json`);
}

function fixtureMetadataContent(object: StoredObject): string {
  return JSON.stringify(
    {
      bucket: object.bucket,
      key: object.key,
      etag: object.etag,
      version: object.version,
      cacheKey: `${object.bucket}/${object.key}@${object.version}`,
      contentType: object.contentType,
      size: new TextEncoder().encode(object.content).byteLength
    },
    null,
    2
  ) + "\n";
}

function objectStorageDeclarations(onObjectRead: () => void) {
  return Object.fromEntries(objects.flatMap((object) => {
    const path = objectPath(object);
    const sidecarPath = metadataPath(object);
    return [
      [
        path,
        file({
          type: object.contentType,
          meta: fixtureObjectData(object),
          content: () => {
            onObjectRead();
            return object.content;
          },
          info: () => fixtureObjectInfo(object, path)
        })
      ],
      [
        sidecarPath,
        file({
          type: "application/json",
          meta: { describes: path },
          content: () => fixtureMetadataContent(object),
          info: () => fixtureMetadataInfo(object, sidecarPath)
        })
      ]
    ];
  }));
}

function searchableFixtureFiles(): Array<{ path: ActiveFSPath; content: string }> {
  return [
    ...objects.map((object) => ({
      path: objectPath(object),
      content: object.content
    })),
    ...objects.map((object) => ({
      path: metadataPath(object),
      content: fixtureMetadataContent(object)
    }))
  ];
}

function fixtureObjectInfo(object: StoredObject, path: ActiveFSPath): ActiveFSTreeInfo {
  return {
    name: path.split("/").at(-1) ?? "",
    path,
    kind: "file",
    size: new TextEncoder().encode(object.content).byteLength,
    type: object.contentType,
    etag: object.etag,
    revision: object.version,
    permissions: { readable: true, searchable: true },
    meta: fixtureObjectData(object)
  };
}

function fixtureMetadataInfo(object: StoredObject, path: ActiveFSPath): ActiveFSTreeInfo {
  const content = fixtureMetadataContent(object);
  return {
    name: path.split("/").at(-1) ?? "",
    path,
    kind: "file",
    size: new TextEncoder().encode(content).byteLength,
    type: "application/json",
    etag: `${object.etag}:metadata`,
    revision: object.version,
    permissions: { readable: true, searchable: true },
    meta: {
      describes: objectPath(object)
    }
  };
}

function fixtureObjectData(object: StoredObject) {
  return {
    bucket: object.bucket,
    key: object.key,
    cacheKey: `${object.bucket}/${object.key}@${object.version}`
  };
}

function directoryInfo(path: ActiveFSPath): NonNullable<ActiveFSTreeInfo> {
  return {
    name: path === "/" ? "" : path.split("/").at(-1) ?? "",
    path,
    kind: "directory",
    permissions: { readable: true, searchable: true }
  };
}

function listS3Infos(
  bucket: string,
  rootPrefix: string,
  listed: S3ListObjectsV2Output
): NonNullable<ActiveFSTreeInfo>[] {
  const entries = new Map<string, NonNullable<ActiveFSTreeInfo>>();
  for (const commonPrefix of listed.CommonPrefixes ?? []) {
    if (!commonPrefix.Prefix) {
      continue;
    }
    const path = s3KeyToSourcePath(bucket, rootPrefix, commonPrefix.Prefix);
    entries.set(path, {
      name: path.split("/").filter(Boolean).at(-1) ?? bucket,
      path,
      kind: "directory",
      permissions: { readable: true, searchable: true }
    });
  }
  for (const object of listed.Contents ?? []) {
    if (!object.Key || object.Key.endsWith("/")) {
      continue;
    }
    const path = s3KeyToSourcePath(bucket, rootPrefix, object.Key);
    entries.set(path, {
      name: path.split("/").at(-1) ?? "",
      path,
      kind: "file",
      size: object.Size,
      mtimeMs: object.LastModified?.getTime(),
      permissions: { readable: true, searchable: true }
    });
    const metadataPath = normalizeActiveFSPath(`${path}.meta.json`);
    entries.set(metadataPath, {
      name: metadataPath.split("/").at(-1) ?? "",
      path: metadataPath,
      kind: "file",
      type: "application/json",
      permissions: { readable: true, searchable: true }
    });
  }
  return [...entries.values()].sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
}

function parseS3Path(bucket: string, rootPrefix: string, path: string):
  | { kind: "root"; sourcePath: ActiveFSPath; actualPrefix: string }
  | { kind: "bucket"; sourcePath: ActiveFSPath; actualPrefix: string }
  | { kind: "entry"; sourcePath: ActiveFSPath; actualKey: string; metadataSidecar: boolean }
  | null {
  const sourcePath = normalizeActiveFSPath(path);
  if (sourcePath === "/") {
    return { kind: "root", sourcePath, actualPrefix: rootPrefix };
  }
  const parts = sourcePath.split("/").filter(Boolean);
  if (parts[0] !== bucket) {
    return null;
  }
  if (parts.length === 1) {
    return { kind: "bucket", sourcePath, actualPrefix: rootPrefix };
  }

  const keyPath = parts.slice(1).join("/");
  const metadataSidecar = keyPath.endsWith(".meta.json");
  const visibleKey = metadataSidecar ? keyPath.slice(0, -".meta.json".length) : keyPath;
  return {
    kind: "entry",
    sourcePath,
    actualKey: `${rootPrefix}${visibleKey}`,
    metadataSidecar
  };
}

async function headS3Object(
  options: S3ObjectStorageTreeOptions,
  bucket: string,
  key: string
): Promise<S3HeadObjectOutput | null> {
  try {
    return await options.client.send(options.commands.headObject({
      Bucket: bucket,
      Key: key
    })) as S3HeadObjectOutput;
  } catch (error) {
    if (isS3NotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function s3PrefixExists(
  options: S3ObjectStorageTreeOptions,
  bucket: string,
  prefix: string
): Promise<boolean> {
  const result = await options.client.send(options.commands.listObjectsV2({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1
  })) as S3ListObjectsV2Output;
  return Boolean(result.Contents?.length || result.CommonPrefixes?.length);
}

function s3ObjectInfo(
  bucket: string,
  sourcePath: ActiveFSPath,
  key: string,
  object: S3HeadObjectOutput
): NonNullable<ActiveFSTreeInfo> {
  return {
    name: sourcePath.split("/").at(-1) ?? "",
    path: sourcePath,
    kind: "file",
    size: object.ContentLength,
    type: object.ContentType,
    etag: stripQuotes(object.ETag),
    revision: object.VersionId ?? stripQuotes(object.ETag),
    mtimeMs: object.LastModified?.getTime(),
    permissions: { readable: true, searchable: true },
    meta: {
      bucket,
      key,
      versionId: object.VersionId,
      cacheKey: `${bucket}/${key}@${object.VersionId ?? stripQuotes(object.ETag) ?? "unknown"}`
    }
  };
}

function s3MetadataInfo(
  bucket: string,
  sourcePath: ActiveFSPath,
  key: string,
  object: S3HeadObjectOutput
): NonNullable<ActiveFSTreeInfo> {
  const content = s3MetadataContent(bucket, key, object);
  return {
    name: sourcePath.split("/").at(-1) ?? "",
    path: sourcePath,
    kind: "file",
    size: new TextEncoder().encode(content).byteLength,
    type: "application/json",
    etag: stripQuotes(object.ETag),
    revision: object.VersionId ?? stripQuotes(object.ETag),
    mtimeMs: object.LastModified?.getTime(),
    permissions: { readable: true, searchable: true },
    meta: {
      describes: sourcePath.slice(0, -".meta.json".length)
    }
  };
}

function s3MetadataContent(bucket: string, key: string, object: S3HeadObjectOutput): string {
  return JSON.stringify(
    {
      bucket,
      key,
      etag: stripQuotes(object.ETag),
      version: object.VersionId,
      cacheKey: `${bucket}/${key}@${object.VersionId ?? stripQuotes(object.ETag) ?? "unknown"}`,
      contentType: object.ContentType,
      size: object.ContentLength,
      lastModified: object.LastModified?.toISOString(),
      metadata: object.Metadata ?? {}
    },
    null,
    2
  ) + "\n";
}

function s3KeyToSourcePath(bucket: string, rootPrefix: string, key: string): ActiveFSPath {
  const visibleKey = rootPrefix && key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : key;
  return normalizeActiveFSPath(`/${bucket}/${visibleKey}`);
}

function normalizeS3Prefix(prefix: string): string {
  const cleaned = prefix.replace(/^\/+/, "");
  return cleaned === "" || cleaned.endsWith("/") ? cleaned : `${cleaned}/`;
}

function ensureTrailingSlash(value: string): string {
  return value === "" || value.endsWith("/") ? value : `${value}/`;
}

function toHttpRange(options: ActiveFSReadOptions): string | undefined {
  if (options.offset === undefined && options.length === undefined) {
    return undefined;
  }
  const start = options.offset ?? 0;
  const end = options.length === undefined ? "" : String(start + options.length - 1);
  return `bytes=${start}-${end}`;
}

async function s3BodyToBytes(body: S3Body | undefined): Promise<Uint8Array> {
  if (!body) {
    return new Uint8Array();
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body.transformToByteArray) {
    return body.transformToByteArray();
  }
  if (body.transformToString) {
    return new TextEncoder().encode(await body.transformToString());
  }
  throw new ActiveFSError("SOURCE_ERROR", "Unsupported S3 response body type.");
}

function searchText(
  path: ActiveFSPath,
  content: string,
  query: ActiveFSSearchQuery
): ActiveFSSearchMatch[] {
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  return content
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      return column === -1
        ? []
        : [{ path, line: index + 1, column: column + 1, excerpt: line.trim() }];
    });
}

function textContent(read: { content: string | Uint8Array }): string {
  return typeof read.content === "string" ? read.content : new TextDecoder().decode(read.content);
}

function stripQuotes(value: string | undefined): string | undefined {
  return value?.replace(/^"|"$/g, "");
}

function isS3NotFound(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const metadata = "$metadata" in error
    ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    : undefined;
  return metadata?.httpStatusCode === 404 ||
    error.name === "NotFound" ||
    error.name === "NoSuchKey" ||
    error.name === "NotFoundException";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--s3")) {
    const result = await runS3ObjectStorageTreeExample();
    console.log(`object-storage-tree s3 bucket: ${result.bucket}`);
    console.log(`object-storage-tree s3 prefix: ${result.prefix}`);
    console.log(`object-storage-tree s3 entries: ${result.entries.join(", ")}`);
    console.log(`object-storage-tree s3 first file: ${result.firstFile ?? "none"}`);
    if (result.firstFile) {
      console.log(`object-storage-tree s3 etag: ${result.etag}`);
      console.log(`object-storage-tree s3 version: ${result.version}`);
      console.log(`object-storage-tree s3 preview bytes: ${result.previewBytes}`);
    }
  } else {
    const result = await runObjectStorageTreeExample();
    console.log(`object-storage-tree packages: ${result.packages.join(", ")}`);
    console.log(`object-storage-tree etag: ${result.etag}`);
    console.log(`object-storage-tree version: ${result.version}`);
    console.log(`object-storage-tree metadata: ${result.metadata}`);
    console.log(`object reads before content: ${result.readsBeforeContent}`);
    console.log(`object-storage-tree range: ${result.range}`);
    console.log(`object reads after content: ${result.readsAfterContent}`);
    console.log(`object storage matches: ${result.matches.length}`);
  }
}
