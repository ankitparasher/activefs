# activefs

The `activefs` package installs the CLI for a programmable filesystem over live
application data. Use it to browse, search, and read a configured source as a
file tree.

Requires Node.js 22 or newer.

## Install

```bash
npm install -g activefs
activefs --help
```

## Try the demo

Start the explicit read-only demo:

```console
$ activefs remote add repo --demo --port 3999

Configured remote repo /repo -> http://127.0.0.1:3999/_activefs/

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

Clean up when you finish:

```bash
activefs remote remove repo
```

ActiveFS stores project-local configuration and runtime state under
`.activefs/`. Add that directory to `.gitignore`.

## Create a file tree from your own data

The demo uses fixed content, but a source can compute file bytes from current
application state on every read:

```text
path + current source state -> computed bytes
```

Follow [Build a source server](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/build-a-source-server.md)
to expose your own data. When a Source API service already exists, connect its
exact discovery URL:

```bash
activefs remote add docs https://YOUR_HOST/YOUR_DISCOVERY_ROUTE
activefs list /docs
```

The source still controls which data and paths exist, who may access them, how
fresh the results are, and whether a write succeeds.

## Documentation

- [Quickstart](https://github.com/ankitparasher/activefs/blob/HEAD/docs/quickstart.md)
- [Build a source server](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/build-a-source-server.md)
- [Agent tutorial](https://github.com/ankitparasher/activefs/blob/HEAD/docs/examples/agents-and-mcp.md)
- [Choose an access method](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/access-surfaces.md)
- [Windows guide](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/windows.md)
- [Current limits](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/current-limits.md)
- [Changelog](https://github.com/ankitparasher/activefs/blob/HEAD/CHANGELOG.md)
