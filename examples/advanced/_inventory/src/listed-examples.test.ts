import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type ImplementedExampleRow = {
  line: string;
  run: string;
  slugs: string[];
};

const rootDir = fileURLToPath(new URL("../../../../", import.meta.url));

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(rootDir, path), "utf8");
}

function implementedFixtureRows(): ImplementedExampleRow[] {
  const examplesDoc = readWorkspaceFile("docs/examples.md");
  const section = markdownSection(examplesDoc, "Runnable Examples");

  return section
    .split("\n")
    .filter((line) => line.trim().startsWith("| `"))
    .map((line) => {
      const cells = splitMarkdownRow(line);
      const slugs = Array.from(cells[0]!.matchAll(/`([^`]+)`/g), (match) => match[1]!);
      return {
        line,
        run: cells[2]!,
        slugs
      };
    });
}

function publicGallerySlugs(): string[] {
  const gallery = readWorkspaceFile("docs/examples/README.md");
  return Array.from(
    new Set(Array.from(gallery.matchAll(/\.\.\/\.\.\/examples\/([a-z0-9-]+)\/README\.md/g), (match) => match[1]!))
  ).sort();
}

function sourceIndexSlugs(): string[] {
  const index = readWorkspaceFile("examples/README.md");
  return Array.from(
    new Set(Array.from(index.matchAll(/\]\(([a-z0-9-]+)\/README\.md\)/g), (match) => match[1]!))
  ).sort();
}

function workspaceExampleSlugs(): string[] {
  return readdirSync(resolve(rootDir, "examples"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => existsSync(resolve(rootDir, "examples", slug, "package.json")))
    .sort();
}

function exampleSmokeScript(): string {
  return readWorkspaceFile("scripts/example-smoke.mjs");
}

function smokeExpectationSlugs(): string[] {
  const smokeScript = readWorkspaceFile("scripts/example-smoke.mjs");
  return Array.from(smokeScript.matchAll(/\["([a-z0-9-]+)",/g), (match) => match[1]!).sort();
}

function documentedCommand(runCell: string): string | undefined {
  return /`([^`]+)`/.exec(runCell)?.[1];
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) {
    throw new Error(`Missing markdown section: ${heading}`);
  }

  const rest = markdown.slice(start);
  const nextHeading = rest.slice(1).search(/\n## /);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

describe("listed examples", () => {
  it("documents every workspace example package as an implemented fixture", () => {
    const listedSlugs = implementedFixtureRows().flatMap((row) => row.slugs).sort();

    expect(listedSlugs).toEqual(workspaceExampleSlugs());
  });

  it("keeps implemented fixture rows wired to packages, tests, and docs-derived smoke coverage", () => {
    const smokeExpectations = new Set(smokeExpectationSlugs());
    const smokeScript = exampleSmokeScript();

    expect(smokeScript).toContain('readWorkspaceFile("docs/examples.md")');
    expect(smokeScript).toContain("parseDocumentedCommand");

    for (const row of implementedFixtureRows()) {
      expect(row.slugs.length, row.line).toBeGreaterThan(0);

      for (const slug of row.slugs) {
        const packageJsonPath = `examples/${slug}/package.json`;
        const packageJson = JSON.parse(readWorkspaceFile(packageJsonPath)) as { name?: string; scripts?: Record<string, string> };

        expect(packageJson.name, packageJsonPath).toBe(`@activefs/example-${slug}`);
        expect(packageJson.scripts?.build, packageJsonPath).toBeDefined();
        expect(existsSync(resolve(rootDir, `examples/${slug}/README.md`)), slug).toBe(true);
        expect(existsSync(resolve(rootDir, `examples/${slug}/src/index.test.ts`)), slug).toBe(true);
        expect(smokeExpectations.has(slug), slug).toBe(true);
      }

      if (row.slugs.length === 1) {
        const command = documentedCommand(row.run);
        expect(command, row.line).toBeDefined();
        expect(command, row.line).toContain(`node examples/${row.slugs[0]}/dist/index.js`);
      } else {
        expect(row.slugs, row.line).toEqual(["remote-tree-server", "remote-tree-client"]);
        expect(row.run, row.line).toContain("ACTIVEFS_REMOTE_URL");
      }
    }
  });

  it("keeps both example indexes complete and pointed at smoke-covered fixtures", () => {
    const listedSlugs = new Set(implementedFixtureRows().flatMap((row) => row.slugs));
    const smokeExpectations = new Set(smokeExpectationSlugs());
    const expectedSlugs = workspaceExampleSlugs();

    expect(publicGallerySlugs()).toEqual(expectedSlugs);
    expect(sourceIndexSlugs()).toEqual(expectedSlugs);

    for (const slug of expectedSlugs) {
      expect(listedSlugs.has(slug), slug).toBe(true);
      expect(smokeExpectations.has(slug), slug).toBe(true);
    }
  });
});
