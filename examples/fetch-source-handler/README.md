# Bind a Source API to Fetch routes

This example creates Web-standard `Request -> Response` handlers while the host
application chooses every discovery and operation URL. It also replaces forged
request-body context with server-owned `auth` and `meta` values.

## Run

From the repository root:

```bash
pnpm --filter @activefs/example-fetch-source-handler build
node examples/fetch-source-handler/dist/index.js
```

## Expected result

The command prints JSON containing:

- the discovery URL
  `https://app.example.com/api/source-manifest.json`;
- separately advertised stat, list, read, command, capabilities, and config
  URLs;
- a root listing with `/context.md`;
- the protected file content returned with the fixture credential.

## Bind the handlers

A Fetch-compatible router can bind each exported handler to an
application-owned route:

```ts
// Discovery route
import { handleDiscoveryGET } from "./activefs-source";

export const GET = handleDiscoveryGET;
```

Bind protected operations separately:

```ts
// Read operation route
import { handleReadPOST } from "./activefs-source";

export const POST = handleReadPOST;
```

Clients follow the operation URLs advertised by discovery; they do not derive
them from the discovery URL.

## Limits

The executable calls the handlers directly. It does not start a framework
server, so test the routes in your application. `Bearer example-token` and the
returned identity values are fixtures, not production authentication.

## Next

Use [Integrate ActiveFS into a product](../../docs/guides/integrate-your-product.md)
to add these handlers to an application.
