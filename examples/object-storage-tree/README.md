# Browse object storage as files

This example presents buckets, prefixes, objects, and object metadata as files
and directories. The default fixture proves lazy and ranged reads without
credentials; an optional mode makes real AWS S3 calls.

## Run the fixture

From the repository root:

```bash
pnpm --filter @activefs/example-object-storage-tree build
node examples/object-storage-tree/dist/index.js
```

## Expected fixture result

The command lists package objects, prints ETag and version metadata, and shows:

```text
object reads before content: 0
```

It then performs a ranged content read and reports the updated read count.
Listing, stat, and reading a `.meta.json` sidecar do not fetch object bytes.

## Fixture paths

| ActiveFS path | Result |
|---|---|
| `/objects/assets/packages/app-1.0.0.txt` | Lazy object content |
| `/objects/assets/packages/app-1.0.0.txt.meta.json` | Inspectable metadata |
| `/objects/assets/reports/usage.csv` | Object below a prefix |
| `/objects/billing/exports/invoices-2026-06.csv` | Object in another bucket |

## Run against S3

This command makes real AWS API calls. Use a read-only profile or the standard
AWS SDK environment credential chain:

```bash
ACTIVEFS_S3_BUCKET=my-bucket \
ACTIVEFS_S3_PREFIX=optional/prefix \
AWS_REGION=us-east-1 \
AWS_PROFILE=my-profile \
node examples/object-storage-tree/dist/index.js --s3
```

On Windows PowerShell:

```powershell
$env:ACTIVEFS_S3_BUCKET = "my-bucket"
$env:ACTIVEFS_S3_PREFIX = "optional/prefix"
$env:AWS_REGION = "us-east-1"
$env:AWS_PROFILE = "my-profile"
node examples/object-storage-tree/dist/index.js --s3
```

`ACTIVEFS_S3_BUCKET` is required. `ACTIVEFS_S3_PREFIX` and `AWS_PROFILE` are
optional. The configured bucket appears at `/s3/my-bucket`, with keys below the
optional prefix exposed relative to that path.

The credentials need `s3:ListBucket` and `s3:GetObject` for the selected data.
Expected output includes the first file found, ETag/version values when S3
returns them, and the byte count of a 64-byte preview.

## Limits

Both modes are read-only. The S3 adapter does not request specific object
versions or implement uploads, multipart operations, deletes, bucket policy,
presigned URLs, non-AWS endpoints, or content search. The default example run
never contacts AWS.

## Next

Use [Build a source server](../../docs/guides/build-a-source-server.md) to serve
a provider-backed tree to other processes.
