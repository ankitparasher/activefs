# Build dynamic routes

Use a dynamic route when a source can resolve a concrete path but should not
enumerate every possible value. For example, `/users/ada.md` can be readable
without listing every user under `/users`.

This guide builds that behavior and verifies it through the direct CLI.

## Create the project

You need Node.js 22 or newer and the `activefs` CLI.

```bash
mkdir activefs-dynamic-routes-demo
cd activefs-dynamic-routes-demo
npm init -y
npm install @activefs/core @activefs/source-http
```

The ActiveFS source checkout also contains a tested version in
`examples/dynamic-users`.

## Create the source

Create `server.mjs`:

```js
import {
  ActiveFSError,
  activeFSContentByteLength,
  dir,
  fsTree,
} from "@activefs/core";
import { startActiveFSServer } from "@activefs/source-http";

const users = new Map([
  ["ada", { name: "Ada Lovelace", role: "Analyst" }],
  ["grace", { name: "Grace Hopper", role: "Compiler pioneer" }],
]);

const tree = fsTree({
  users: dir({}, { enumerable: false }),
}, {
  name: "dynamic-users",
});

tree.path("/users/:id.md")
  .file({ enumerable: false, type: "text/markdown" })
  .setInfo(({ params, path }) => {
    const user = users.get(params.id);
    return user ? fileInfo(params.id, path, user) : null;
  })
  .setRead(({ params, path }) => {
    const user = users.get(params.id);
    if (!user) {
      throw new ActiveFSError("NOT_FOUND", `Path not found: ${path}`, { path });
    }
    return {
      content: renderUser(params.id, user),
      info: fileInfo(params.id, path, user),
    };
  });

const port = Number(process.env.PORT ?? 3999);
const server = await startActiveFSServer({ port, tree });

console.log(server.url);
console.log("Try /users/ada.md or /users/grace.md. Press Ctrl-C to stop.");

function renderUser(id, user) {
  return `# ${user.name}\n\nRole: ${user.role}\nID: ${id}\n`;
}

function fileInfo(id, path = `/users/${id}.md`, user = users.get(id)) {
  const content = renderUser(id, user);
  return {
    path,
    name: `${id}.md`,
    kind: "file",
    enumerable: false,
    type: "text/markdown",
    size: activeFSContentByteLength(content),
  };
}
```

The route's `setInfo` handler decides whether an exact path exists. Its
`setRead` handler produces the bytes. Both receive the parsed `id` parameter.
The `enumerable: false` declarations keep the user IDs out of directory
listings.

For the full handler contract, see the
[ActiveFSTree reference](../reference/activefs-tree.md).

## Run and connect the source

Start the server:

```console
$ node server.mjs

http://127.0.0.1:3999/_activefs/
Try /users/ada.md or /users/grace.md. Press Ctrl-C to stop.
```

In a second terminal, save the printed discovery URL:

```bash
activefs remote add profiles http://127.0.0.1:3999/_activefs/
```

The URL is the HTTP discovery endpoint. The resulting
`/profiles/users/ada.md` value is a direct ActiveFS path.

## Read a known route

Name the concrete route:

```console
$ activefs read /profiles/users/ada.md

# Ada Lovelace

Role: Analyst
ID: ada
```

Now list its parent:

```bash
activefs list /profiles/users
```

The listing does not include `ada.md` or `grace.md`. That is intentional: the
paths are resolvable when named, but not enumerable from their parent.

## Use the route through other access methods

Direct reads can name a concrete route. Operations that discover paths by
recursive listing, including ActiveFS scan search, cannot discover hidden user
IDs. A source-owned search handler can return authorized concrete routes when
that is safe.

You can export a known route by naming it explicitly:

```bash
activefs export /profiles/users/ada.md --to work/ada-profile
```

TUI, MCP, mounted folders, and export discover paths differently. Use
[Choose how to use an ActiveFS tree](access-surfaces.md) before exposing a
dynamic route through another adapter.

## Check production behavior

For a real source:

- authorize every concrete path inside the source;
- treat route parameters as untrusted input;
- avoid enumerating identifiers merely because a parent was listed;
- return the same safe not-found behavior for paths whose existence must stay
  private;
- add tree-native search only when it can return authorized results.

## Fix common failures

### The file does not appear in `activefs list`

That is expected for this example. Read the exact path instead.

### `activefs read` returns not found

Check the concrete path against the route pattern and confirm the backing
`users` map contains that ID.

### Scan search misses the route

Scan traverses enumerable entries. Implement a source-owned search handler if
authorized dynamic routes must be searchable.

## Clean up

```bash
activefs remote remove profiles
```

Stop `server.mjs` with `Ctrl-C`.

## Next

Use the [Source API protocol reference](../reference/source-api.md) when you are
ready to verify the exact transport contract for the tree.
