# Build a source server

In this tutorial, you will turn current application state into a live
`/status.json` file, serve it through Source API, and read it with the ActiveFS
CLI. The file is computed when it is opened; it is not copied into ActiveFS
first.

```text
current service state -> /status.json -> activefs read /app/status.json
```

## Before you start

You need:

- Node.js 22 or newer;
- npm; and
- the `activefs` CLI on your `PATH`.

Install the CLI if needed:

```bash
npm install -g activefs
```

You do not need an ActiveFS source checkout.

## Create a project

Run these commands in a working directory where you can create a new folder:

```bash
mkdir activefs-source-demo
cd activefs-source-demo
npm init -y
npm install @activefs/core @activefs/source-http
```

## Create the source

Create `server.mjs`:

```js
import { fsTree, json, text } from "@activefs/core";
import { startActiveFSServer } from "@activefs/source-http";

const serviceState = {
  status: "ready",
  build: process.env.BUILD_ID ?? "local",
};

const tree = fsTree({
  README: text("Current service state is available at /status.json.\n"),
  "status.json": json(() => ({
    ...serviceState,
    checkedAt: new Date().toISOString(),
  })),
});

const port = Number(process.env.PORT ?? 3999);
const server = await startActiveFSServer({ tree, port });

console.log(`Source ready at ${server.url}`);
console.log("Leave this process running while you read the tree.");
```

`json(() => ...)` is a lazy file declaration. ActiveFS calls the function for
each read, so the value can come from current process state, a database query,
an API, or generated context.

## Start the source

Keep this command running in the first terminal:

```console
$ node server.mjs

Source ready at http://127.0.0.1:3999/_activefs/
Leave this process running while you read the tree.
```

Use the printed URL exactly. The Node helper chooses `/_activefs/` for its
discovery document, but an application can host that document at any route.

## Connect it to ActiveFS

Open a second terminal in `activefs-source-demo`, then add the source as a
remote named `app`:

```console
$ activefs remote add app http://127.0.0.1:3999/_activefs/

Configured remote app /app -> http://127.0.0.1:3999/_activefs/
```

List the tree:

```console
$ activefs list /app

file      /app/README
file      /app/status.json
```

## Read current state

Read the computed file:

```console
$ activefs read /app/status.json

{
  "status": "ready",
  "build": "local",
  "checkedAt": "2026-07-21T12:00:00.000Z"
}
```

Your timestamp will differ. Run the same command again and `checkedAt` changes
because the source computes the JSON for each read.

You now have the core ActiveFS loop: application state became a small file
tree, and a consumer read only the file it needed through a familiar filesystem
operation.

## Use your real state

Replace `serviceState` with the smallest useful slice of your application. Keep
the first tree easy to discover:

```text
/status.json
/build/current.json
/services/api/health.json
```

The source decides what each path returns and who may read it. ActiveFS does not
take ownership of that data or override source policy.

## Clean up

Remove the configured remote:

```bash
activefs remote remove app
```

Then press `Ctrl-C` in the source-server terminal.

## Troubleshooting

If `activefs` is not found, install the CLI and retry:

```bash
npm install -g activefs
```

If port `3999` is busy, start the source on another port and use the matching
URL. On macOS or Linux:

```bash
PORT=4000 node server.mjs
```

On Windows PowerShell:

```powershell
$env:PORT = "4000"
node server.mjs
```

In the second terminal on any platform, use the matching discovery URL:

```bash
activefs remote add app http://127.0.0.1:4000/_activefs/
```

If the connection fails, confirm that the first terminal is still running and
that you copied its discovery URL exactly.

## Next steps

- [Integrate your product](integrate-your-product.md) to choose a useful data
  slice and hosted route.
- [Add dynamic routes](dynamic-routes.md) when paths depend on IDs or other
  parameters.
- [Test source behavior](../contributing/source-api-conformance.md) before
  shipping an integration.
- [Use the Source API reference](../reference/source-api.md) when you need the
  wire contract.
