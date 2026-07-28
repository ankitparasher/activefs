# ActiveFS

**A programmable filesystem for live application data.**

Turn APIs, databases, generated context, and services into files and
directories that agents and tools can browse, search, and read on demand.

```text
live application data -> programmable file tree -> agents and tools
```

## Try ActiveFS

You need Node.js 22 or newer. Install the CLI, then start the explicit read-only
demo:

```bash
npm install -g activefs
activefs remote add repo --demo --port 3999
```

The demo appears at `/repo` inside ActiveFS. No operating-system mount is
required.

```console
$ activefs list /repo

directory /repo/bin
directory /repo/notes
file      /repo/README.txt

$ activefs read /repo/README.txt

Hello from the ActiveFS demo Source API.

$ activefs grep Source /repo

# activefs grep: scan
/repo/notes/source-api.txt:1:1:Source API exposes a generic HTTP tree service.
/repo/README.txt:1:30:Hello from the ActiveFS demo Source API.
```

## Turn current application data into files

The demo shows how to browse a file tree. In a real application, those files do
not have to contain stored data. ActiveFS can ask your application for the
latest data each time someone reads a file:

```text
normal filesystem: path -> stored bytes
ActiveFS:          path + current source state -> computed bytes
```

For example, opening `/status.json` can run a function that reads the current
service state:

```js
import { fsTree, json } from "@activefs/core";

const serviceState = {
  name: "payments",
  healthy: true,
  queueDepth: 3,
};

const tree = fsTree({
  "status.json": json(() => ({
    ...serviceState,
    generatedAt: new Date().toISOString(),
  })),
});
```

Your application stays in control. It decides what data and paths exist, who can
access them, how fresh the results must be, and whether a write is allowed.
ActiveFS turns those decisions into a file tree that clients can browse and
read.

To connect that tree to ActiveFS, expose it through the Source API—the HTTP
contract for an `ActiveFSTree`. [Build your first
source](docs/guides/build-a-source-server.md) to serve a computed file and read
it through the CLI.

## How agents use an ActiveFS file tree

When application data is available as files and directories, an agent can
explore it gradually. It can start with a small part of the tree, search
within that area, and read only the files needed for the task.

```text
list -> search -> stat when useful -> selective read
```

This keeps each request small and gives the agent a consistent way to explore
different kinds of data.

ActiveFS does not replace every interface. Typed tools are often better for
specific actions. Databases remain better for transactions and joins. Semantic
retrieval may be better when meaning matters more than structure.

## When ActiveFS fits

ActiveFS works best when current data can be organized into a useful file tree
and several kinds of clients need to browse, search, or read it. For example:

- task context assembled on demand from current application state;
- service status, logs, and CI artifacts;
- object storage and database views; and
- product or operational data that agents and tools need to inspect.

ActiveFS is not hosted storage, a database, a synchronization system, a vector
store, or a complete POSIX filesystem. See [use cases](docs/use-cases.md) for
fit and trade-offs.

## Use the same tree as a normal folder (optional)

When a tool, editor, or agent needs an OS-visible path, mount the configured
remote. Mounting requires rclone plus macFUSE on macOS or FUSE on Linux. Check
the host, then use ordinary filesystem commands against `./repo`:

```bash
activefs doctor --mounts
activefs mount repo ./repo

ls ./repo
cat ./repo/README.txt
grep -R Source ./repo

activefs unmount repo
```

An agent or tool that can read local files can now explore `./repo` without an
ActiveFS-specific integration. Windows uses the same remote through PowerShell,
rclone, and WinFsp; follow the [mounted-folder guide](docs/guides/mounted-folder.md)
for platform setup, writes, caching, and troubleshooting.

Clean up when you finish:

```bash
activefs remote remove repo
```

## Choose your next step

Building a computed source is the recommended next step.

- [Build a source from your own data](docs/guides/build-a-source-server.md)
- [Connect an existing Source API](docs/guides/connect-a-source.md)
- [Give an agent selective access](docs/examples/agents-and-mcp.md)
- [Choose an access method](docs/guides/access-surfaces.md)
- [Browse all documentation](docs/README.md)

## Project

- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Contributing](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Apache 2.0 license](LICENSE)
