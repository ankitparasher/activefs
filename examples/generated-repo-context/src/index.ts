import { createActiveFS } from "@activefs/core";
import { createGeneratedTree } from "@activefs/testing";

export function createGeneratedRepoContextFilesystem(now = () => new Date()) {
  return createActiveFS().mount(
    "/repo",
    createGeneratedTree({
      files: {
        "/context.md": () =>
          [
            "# Repository Context",
            "",
            "- Source: generated example",
            "- Core operations: list, stat, read, search",
            "- Non-goal: domain-specific primitives in core"
          ].join("\n")
      },
      dynamicFiles: {
        // The clock is injected so the example remains easy to test deterministically.
        "/dynamic/build-info.txt": () => `Generated timestamp: ${now().toISOString()}\n`
      }
    })
  );
}

export async function runGeneratedRepoContextExample(now = () => new Date()) {
  const fs = createGeneratedRepoContextFilesystem(now);
  const context = await fs.read({}, "/repo/context.md");
  const buildInfo = await fs.read({}, "/repo/dynamic/build-info.txt");
  return {
    context: textContent(context.content),
    buildInfo: textContent(buildInfo.content)
  };
}

function textContent(content: string | Uint8Array): string {
  return typeof content === "string" ? content : new TextDecoder().decode(content);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runGeneratedRepoContextExample();
  console.log(result.context);
  console.log(result.buildInfo);
}
