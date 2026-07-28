import { createActiveFS, type ActiveFS } from "@activefs/core";
import { createGeneratedTree, createMemoryTree } from "@activefs/testing";

export function createExampleActiveFS(): ActiveFS {
  return createActiveFS()
    .mount(
      "/",
      createMemoryTree({
        files: {
          "/hello.md": "# Hello ActiveFS\n\nThis file is served by an in-memory tree.\n"
        }
      })
    )
    .mount(
      "/search",
      createMemoryTree({
        searchable: true,
        files: {
          "/indexed.md": "Tree search finds ActiveFS through tree.search.\n"
        }
      })
    )
    .mount(
      "/scan",
      createMemoryTree({
        files: {
          "/notes.md": "ActiveFS scan finds ActiveFS through list plus read.\n",
          "/nested/detail.md": "Recursive scan visits enumerable directories.\n"
        }
      })
    )
    .mount(
      "/generated",
      createGeneratedTree({
        files: {
          "/repo-context.md": () =>
            [
              "# Generated Repo Context",
              "",
              "This file is generated at read time by an example tree.",
              "Core routes semantic filesystem methods and optional command handlers."
            ].join("\n")
        },
        dynamicFiles: {
          "/users/ada.md": () =>
            [
              "# Ada",
              "",
              "Dynamic user profile generated on demand.",
              "Recursive grep skips this non-enumerable route by default."
            ].join("\n"),
          "/users/grace.md": () =>
            [
              "# Grace",
              "",
              "Another dynamic user profile generated on demand."
            ].join("\n")
        }
      })
    );
}
