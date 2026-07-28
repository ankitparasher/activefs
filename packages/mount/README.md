# @activefs/mount

Install `@activefs/mount` when host code needs the WebDAV server or rclone mount
lifecycle helpers directly. End users normally use the `activefs` CLI to create
an OS-visible folder.

The package requires Node.js 22 or newer. Creating a real OS mount also requires
rclone and a host backend such as macFUSE, FUSE, or WinFsp.

## Install

```bash
npm install @activefs/mount @activefs/core
```

## Start the WebDAV adapter

This example starts a loopback WebDAV server over a small ActiveFS tree, prints
its URL, and closes it:

```js
import { createActiveFS, fsTree, text } from "@activefs/core";
import { startWebDAVServer } from "@activefs/mount";

const tree = fsTree({
  "/hello.txt": text("hello through WebDAV\n")
});
const activefs = createActiveFS().mount("/", tree);

const server = await startWebDAVServer({
  filesystem: activefs,
  rootPath: "/"
});

try {
  console.log(server.url);
} finally {
  await server.close();
}
```

Output uses an available loopback port:

```text
http://127.0.0.1:<port>/
```

The helper generates local WebDAV credentials by default. Those credentials
protect the adapter endpoint; they are not Source API identity. The tree or
source still makes final access and mutation decisions.

Clients that omit the generated credentials receive `401 Unauthorized`. These
HTTP Basic credentials protect only the WebDAV adapter; they do not configure
upstream Source API or MCP authentication. Basic authentication does not
encrypt the connection, so keep the adapter on loopback or place any
non-loopback endpoint behind TLS.

The equivalent foreground CLI option accepts explicit credentials:

```bash
activefs server start repo --auth alice:local-only
```

That option is not enabled by default for the foreground CLI server. Because
the password may appear in shell history or process listings, avoid using a
long-lived secret on the command line.

Starting the WebDAV adapter does not create an OS mount. Use the CLI mounted
folder workflow when rclone should attach it to a visible path.

## Documentation

- [Mount a remote folder](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/mounted-folder.md)
- [Use ActiveFS on Windows](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/windows.md)
- [Access adapter reference](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/access-adapters.md)
- [Supported environments](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/supported-environments.md)
