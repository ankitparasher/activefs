# @activefs/core

Install `@activefs/core` to program a live file tree or to use ActiveFS from
application code. It provides the generic tree contract, path router, authoring
helpers, errors, and logical client. It does not include HTTP, MCP, or OS mount
adapters.

The package requires Node.js 22 or newer.

## Install

```bash
npm install @activefs/core
```

## Program a file from current state

`fsTree` can compute file contents when the file is read:

```js
import { createActiveFS, fsTree, json } from "@activefs/core";

let serviceStatus = { ok: true };

const tree = fsTree({
  "/status.json": json(() => serviceStatus)
});

const activefs = createActiveFS().mount("/", tree);
const result = await activefs.read({}, "/status.json");

console.log(result.content);
```

Output:

```json
{
  "ok": true
}
```

Change `serviceStatus` and read the file again to receive the new value. The
factory runs at read time; ActiveFS does not need to copy the value into a new
store first.

## What this package owns

- ActiveFS paths and longest-prefix routing;
- the `ActiveFSTree` contract and helpers such as `fsTree`, `dir`, `text`,
  `bytes`, and `json`;
- generic list, stat, read, search, mutation, and watch contracts; and
- `createActiveFSClient` for promise-based application access.

Core forwards auth and metadata without interpreting them. The tree or source
decides what that context means and makes the final visibility and mutation
decisions. Mounting a tree into the core router is not the same as creating an
OS-visible mounted folder.

## Documentation

- [ActiveFSTree authoring](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/activefs-tree.md)
- [Core API](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/core-api.md)
- [Programmable-tree concepts](https://github.com/ankitparasher/activefs/blob/HEAD/docs/concepts.md)
