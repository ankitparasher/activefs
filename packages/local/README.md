# @activefs/local

Install `@activefs/local` when an application needs to expose a real directory
as an ActiveFS tree or copy a tree into a normal local directory. It provides
local filesystem, export, cache, and file-watch helpers.

The package requires Node.js 22 or newer.

## Install

```bash
npm install @activefs/local @activefs/core
```

## Read a local directory through ActiveFS

Save this as `example.mjs` in a new project and run `node example.mjs`:

```js
import { mkdir, writeFile } from "node:fs/promises";
import { createActiveFS } from "@activefs/core";
import { createLocalTree } from "@activefs/local";

await mkdir("./docs", { recursive: true });
await writeFile("./docs/README.md", "# Local docs\n");

const tree = createLocalTree({
  root: "./docs",
  readonly: true
});
const activefs = createActiveFS().mount("/docs", tree);

const result = await activefs.read({}, "/docs/README.md", {
  encoding: "utf8"
});
console.log(result.content);
```

Output:

```text
# Local docs
```

Local filesystem reads preserve bytes by default. Pass `encoding: "utf8"`
when you want text; omit it when the caller needs binary-safe `Uint8Array`
content.

Use `exportTree` when the required outcome is a copied local directory rather
than a live tree. Export reads current bytes and writes a manifest; it is not a
point-in-time snapshot unless the source provides a stable revision.

The local tree rejects path escapes from its configured root. Mutation is
available only when the tree is not created as read-only.

## Documentation

- [Export a tree](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/export.md)
- [Cache and freshness](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/cache-and-freshness.md)
- [Core API](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/core-api.md)
