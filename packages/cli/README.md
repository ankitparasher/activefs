# @activefs/cli

Install `@activefs/cli` when a Node.js test, tool, or host application needs to
invoke the ActiveFS CLI implementation in process. If you want the user-facing
`activefs` command, install the `activefs` package instead.

This package also contains the TUI implementation. It requires Node.js 22 or
newer.

## Install

```bash
npm install @activefs/cli
```

## Invoke the CLI from code

The root export provides `main(argv, options)`. This smallest example prints the
same help text as the command-line binary without starting a child process:

```js
import { main } from "@activefs/cli";

await main(["--help"]);
```

Pass arguments after the executable name. For example, a host that already has
a configured `repo` remote can run:

```js
await main(["list", "/repo"]);
```

`main` rejects with command-handler errors. The executable wrapper turns those
errors into user-facing messages and non-zero exit codes; an embedding host
decides how to handle them.

## Choose this package when

- a test needs the CLI entrypoint without spawning a process;
- a host tool needs the injectable `main(argv, options)` boundary; or
- an application intentionally embeds the ActiveFS terminal UI.

Use `@activefs/core` instead when application code only needs programmable
filesystem operations. Use the `activefs` package for the installed CLI.

## Documentation

- [CLI reference](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/cli.md)
- [Quickstart](https://github.com/ankitparasher/activefs/blob/HEAD/docs/quickstart.md)
- [Choose an access method](https://github.com/ankitparasher/activefs/blob/HEAD/docs/guides/access-surfaces.md)
