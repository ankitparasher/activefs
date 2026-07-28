import {
  createActiveFS,
  fsTree,
  text,
  type ActiveFSSearchIncompleteReason,
  type ActiveFSSearchQuery
} from "@activefs/core";

const ciFiles = {
  "/runs/latest/summary.md": [
    "# CI Run 418",
    "",
    "- branch: main",
    "- commit: 8f4c2d1",
    "- status: passed",
    "- coverage: 94.2%",
    ""
  ].join("\n"),
  "/runs/latest/logs/build.log": [
    "install dependencies",
    "compile packages",
    "build completed in 31s"
  ].join("\n") + "\n",
  "/runs/latest/logs/test.log": [
    "vitest run",
    "126 tests passed",
    "coverage threshold satisfied"
  ].join("\n") + "\n",
  "/runs/latest/reports/coverage.md": [
    "# Coverage Report",
    "",
    "Statements: 94.2%",
    "Branches: 88.5%",
    ""
  ].join("\n"),
  "/runs/latest/reports/junit.xml": [
    "<testsuite name=\"activefs\" tests=\"126\" failures=\"0\">",
    "  <testcase classname=\"core\" name=\"routes mounted paths\" />",
    "</testsuite>"
  ].join("\n") + "\n",
  "/runs/latest/screenshots/homepage.png.txt": "placeholder screenshot bytes for smoke tests\n",
  "/runs/latest/artifacts/activefs-0.1.1.tgz.sha256":
    "3ddbdc9ad3d8b0a5f3e7a4a6de9ac7a0f7d7b4a6d2a3b9868b9f2bb1f4a1a418  activefs-0.1.1.tgz\n"
};

export function createCiArtifactsTree() {
  return fsTree(textFileDeclarations(ciFiles), {
    name: "ci-artifacts-fixture",
    search: ({ path, query }) => ({
      ...searchTextFiles(ciFiles, path, query!),
      strategy: "source"
    })
  });
}

export async function runCiArtifactsTreeExample() {
  const fs = createActiveFS().mount("/ci", createCiArtifactsTree());
  const latest = await fs.list({}, "/ci/runs/latest");
  const logs = await fs.list({}, "/ci/runs/latest/logs");
  const summary = await fs.read({}, "/ci/runs/latest/summary.md");
  const matches = await fs.search({}, "/ci/runs/latest", { pattern: "coverage" });

  return {
    latest: latest.map((entry) => entry.path),
    logs: logs.map((entry) => entry.path),
    summaryTitle: textContent(summary).split("\n")[0],
    matches: matches.matches.map((match) => `${match.path}:${match.line ?? 0}`),
    strategy: matches.strategy
  };
}

function textContent(read: { content: string | Uint8Array }): string {
  return typeof read.content === "string" ? read.content : new TextDecoder().decode(read.content);
}

function textFileDeclarations(files: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, text(content)])
  );
}

function searchTextFiles(files: Record<string, string>, rootPath: string, query: ActiveFSSearchQuery) {
  const needle = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
  const maxResults = query.maxResults ?? Number.POSITIVE_INFINITY;
  const matches: Array<{ path: string; line: number; column: number; excerpt: string }> = [];
  for (const [path, content] of Object.entries(files)) {
    if (!isPathWithin(rootPath, path)) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const haystack = query.caseSensitive ? line : line.toLowerCase();
      const column = haystack.indexOf(needle);
      if (column < 0) {
        continue;
      }
      if (matches.length >= maxResults) {
        return {
          matches,
          complete: false,
          incompleteReasons: ["max-results"] as ActiveFSSearchIncompleteReason[]
        };
      }
      matches.push({ path, line: index + 1, column: column + 1, excerpt: line });
    }
  }
  return { matches, complete: true };
}

function isPathWithin(rootPath: string, candidatePath: string) {
  return rootPath === "/" || candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCiArtifactsTreeExample();
  console.log(`ci-artifacts-tree latest: ${result.latest.join(", ")}`);
  console.log(`ci-artifacts-tree logs: ${result.logs.join(", ")}`);
  console.log(`ci-artifacts-tree summary: ${result.summaryTitle}`);
  console.log(`ci-artifacts-tree search strategy: ${result.strategy}`);
  console.log(`ci artifact matches: ${result.matches.length}`);
}
