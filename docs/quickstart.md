# Quickstart

In this tutorial, you will start the explicit demo, browse its tree, and see how
the same filesystem model can expose your own current data. You do not need
mount software or a source checkout.

```text
demo data -> programmable tree at /repo -> list -> read -> search
```

## Before you start

You need Node.js 22 or newer.

## Install the CLI

Run these commands from the project where you want ActiveFS to keep its local
configuration:

```bash
npm install -g activefs
activefs --help
```

ActiveFS stores project-local configuration and runtime state under
`.activefs/`. Add `.activefs/` to that project's `.gitignore`.

## Start the demo

Start the shipped read-only demo and save it as a remote named `repo`:

```console
$ activefs remote add repo --demo --port 3999

Configured remote repo /repo -> http://127.0.0.1:3999/_activefs/
```

The demo now has ActiveFS paths under `/repo`. These are paths inside the
programmable tree, not operating-system paths.

## Browse the tree

List the root:

```console
$ activefs list /repo

directory /repo/bin
directory /repo/notes
file      /repo/README.txt
```

Read one file:

```console
$ activefs read /repo/README.txt

Hello from the ActiveFS demo Source API.
```

Search before reading more files:

```console
$ activefs grep Source /repo

# activefs grep: scan
/repo/notes/source-api.txt:1:1:Source API exposes a generic HTTP tree service.
/repo/README.txt:1:30:Hello from the ActiveFS demo Source API.
```

The demo content is only an example. In your application, each file can return
content computed from current source state when someone reads it. An agent can
then list one directory, search for likely matches, and read only the relevant
files.

## Optional: use normal file commands

You have completed the required tutorial. If a tool, editor, or agent needs an
OS-visible path, and `activefs doctor --mounts` reports that the host is ready,
mount the same remote. On macOS or Linux:

```bash
activefs doctor --mounts
activefs mount repo ./repo

ls ./repo
cat ./repo/README.txt
grep -R Source ./repo

activefs unmount repo
```

Here `ls`, `cat`, and `grep` are ordinary shell commands against the mounted
folder. They are not ActiveFS subcommands. An agent or tool that can read local
files can use the same `./repo` tree without an ActiveFS-specific integration.

Mounting requires rclone plus a platform mount backend. Windows users should
follow [Use ActiveFS on Windows](guides/windows.md). The
[mounted-folder guide](guides/mounted-folder.md) covers setup, writes, caching,
search behavior, and troubleshooting.

## Clean up

Remove the remote. ActiveFS waits for the recorded demo server to stop before it
deletes the remote's local state.

```bash
activefs remote remove repo
```

## Continue with your data

[Build your first source](guides/build-a-source-server.md) next. You will create
a `/status.json` file whose contents are computed on every read, serve it, and
open it through ActiveFS.

If this tutorial did not run as shown, use [troubleshooting](troubleshooting.md).
