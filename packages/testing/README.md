# @activefs/testing

Install `@activefs/testing` in tests that need an in-memory tree, generated
fixtures, or the shared `ActiveFSTree` conformance suite. Do not use its fixture
trees as application storage.

The package requires Node.js 22 or newer. The `./conformance` entrypoint has a
Vitest peer dependency.

## Install

```bash
npm install @activefs/core
npm install -D @activefs/testing vitest
```

## Use an in-memory fixture

```js
import { createActiveFS } from "@activefs/core";
import { createMemoryTree } from "@activefs/testing";

const tree = createMemoryTree({
  "/hello.md": "# Hello\n",
  "/notes/todo.txt": "ship it\n"
});
const activefs = createActiveFS().mount("/", tree);

const result = await activefs.read({}, "/hello.md");
console.log(result.content);
```

Output:

```text
# Hello
```

`createMemoryTree` can opt into search, mutation, range-read, and watch behavior
for tests. Create a new tree per test when mutations are enabled.

## Register the conformance suite

The `./conformance` entrypoint registers Vitest tests for any tree
implementation:

```js
import { createMemoryTree } from "@activefs/testing";
import { runActiveFSTreeConformance } from "@activefs/testing/conformance";

runActiveFSTreeConformance("my tree", () => createMemoryTree({
  files: { "/hello.txt": "hello\n" },
  searchable: true
}), {
  filePath: "/hello.txt",
  expectedContent: "hello",
  searchPattern: "hello"
});
```

Save this in a Vitest test file. Replace the memory-tree factory with your own
isolated tree factory, then add optional write and context assertions when your
tree supports those behaviors.

## Documentation

- [Test and validate a source](https://github.com/ankitparasher/activefs/blob/HEAD/docs/contributing/source-api-conformance.md)
- [ActiveFSTree authoring](https://github.com/ankitparasher/activefs/blob/HEAD/docs/reference/activefs-tree.md)
- [Example gallery](https://github.com/ankitparasher/activefs/blob/HEAD/docs/examples/README.md)
