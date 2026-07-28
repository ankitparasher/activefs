# @activefs/source-http

Install `@activefs/source-http` to expose an `ActiveFSTree` through Source API
v1 or consume a Source API as a tree. The package root contains the Node.js
client and server helpers; `@activefs/source-http/fetch` contains the
Web-standard server entrypoint for Fetch-compatible runtimes.

The package root requires Node.js 22 or newer.

## Install

```bash
npm install @activefs/source-http @activefs/core
```

## Run a Node.js source round trip

```js
import { createActiveFS, fsTree, json } from "@activefs/core";
import {
  createHttpSourceClient,
  startActiveFSServer
} from "@activefs/source-http";

let serviceStatus = { ok: true };
const tree = fsTree({
  "/status.json": json(() => serviceStatus)
});

const server = await startActiveFSServer({ tree });

try {
  const remote = createHttpSourceClient({ url: server.url });
  const activefs = createActiveFS().mount("/remote", remote);
  const result = await activefs.read({}, "/remote/status.json");

  console.log(result.content);
} finally {
  await server.close();
}
```

Output:

```json
{
  "ok": true
}
```

`server.url` is the exact discovery URL. Source API clients follow the operation
URLs advertised by discovery; they do not infer sibling routes. The standalone
Node helper chooses its own default routes, but those paths are not protocol
requirements.

## Use a Fetch-compatible host

Import the route-independent service from the `./fetch` entrypoint:

```js
import { createActiveFSSourceService } from "@activefs/source-http/fetch";
```

Bind each framework route to the corresponding service operation and advertise
the application-owned operation URLs. See the runnable
[Fetch handler example](https://github.com/ankitparasher/activefs/blob/HEAD/examples/fetch-source-handler/README.md).

For a hosted source, authenticate the HTTP request and derive the final ActiveFS
context in `resolveContext`. ActiveFS treats this context as opaque: it forwards
the values without interpreting them. Request-body auth and metadata are
untrusted when that resolver is present. Use a stable, non-secret isolation key
for context-sensitive session and cache state; never use a raw credential or a
reversible identity value.

## Documentation

- [Build a source server](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/build-a-source-server.md)
- [Source API reference](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/source-api.md)
- [HTTP transport reference](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/source-http-transport.md)
- [Security and identity](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/security-and-identity.md)
