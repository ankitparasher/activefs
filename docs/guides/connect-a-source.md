# Connect a source

Use this guide when a source service is already running and has given you a
Source API discovery URL. You will save that URL as a remote, then prove that
you can list and read its files.

If you need to create the service first, follow
[Build a source server](build-a-source-server.md).

## Before you start

You need:

- the `activefs` CLI;
- the exact discovery URL printed or documented by the source service;
- credentials if the source is protected.

Keep these path forms distinct:

- `http://127.0.0.1:3999/_activefs/` is a Source API URL;
- `/repo/README.txt` is a direct ActiveFS path after the remote is connected.

Neither path is a mounted OS folder.

## Add the discovery URL

Save the URL under a short remote name:

```console
$ activefs remote add repo http://127.0.0.1:3999/_activefs/

Configured remote repo /repo -> http://127.0.0.1:3999/_activefs/
```

The name `repo` becomes the first segment of its ActiveFS paths.

If the discovery endpoint requires credentials, save it without the initial
reachability check, configure the credential provider, and then probe it:

```bash
activefs remote add repo https://source.example.com/_activefs/ --no-check
activefs auth set repo --env ACTIVEFS_REPO_TOKEN
activefs remote status repo
```

Set `ACTIVEFS_REPO_TOKEN` in the shell that runs ActiveFS. The auth command
records the provider configuration, not the environment variable's value. See
[Security and identity](security-and-identity.md) for the other supported
credential providers.

## Verify the remote

Probe the saved discovery URL:

```bash
activefs remote status repo
```

Then use direct ActiveFS paths:

```bash
activefs list /repo
activefs read /repo/README.txt
```

If the source is searchable, try:

```bash
activefs grep generated /repo
```

`activefs remote list` shows locally configured remotes without requiring you
to know their paths:

```bash
activefs remote list
```

For the complete option list, see the [CLI reference](../reference/cli.md).

## Fix connection errors

### `Source API discovery URL is not reachable`

Keep the source process running and check the exact URL itself. It must return
the ActiveFS discovery document. Do not add or remove URL path segments unless
the source owner gave you a different discovery URL.

Use `--no-check` only when you intentionally need to record an offline or
credential-protected endpoint before probing it.

### `Unknown ActiveFS remote`

List the current workspace's remotes and use the name shown there:

```bash
activefs remote list
```

If the remote exists in another workspace, run the command from that workspace
or pass the same `--state-root` used when it was added.

## Remove the remote

Remove the local configuration when you no longer need it:

```bash
activefs remote remove repo
```

For a demo remote, this also stops the recorded demo server.

## Next

Use [Search and grep](search-and-grep.md) to search the connected tree directly.
