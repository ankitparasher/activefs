#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const promptWorkDir = [".prompts", "dev"].join(".") + "/";
const skippedPrefixes = [
  ".agents/",
  ".codex/",
  ".git/",
  promptWorkDir,
  "artifacts/",
  "coverage/",
  "dist/",
  "node_modules/"
];

const files = workspaceFiles()
  .filter((file) => existsSync(resolve(rootDir, file)))
  .filter((file) => file.endsWith(".md"))
  .filter((file) => !isSkipped(file))
  .sort();

const failures = [];
let checkedLinks = 0;

for (const file of files) {
  const absoluteFile = resolve(rootDir, file);
  const markdown = readFileSync(absoluteFile, "utf8");
  const scanText = stripFencedCode(markdown);

  for (const link of localMarkdownLinks(scanText)) {
    checkedLinks += 1;
    const target = resolveLinkTarget(file, link.target);
    if (!target) {
      continue;
    }

    if (!isInsideRoot(target.absolutePath)) {
      failures.push(`${file}:${link.line}: link leaves the repository: ${link.target}`);
      continue;
    }

    const resolved = resolveExistingTarget(target.absolutePath);
    if (!resolved) {
      failures.push(`${file}:${link.line}: missing link target: ${link.target}`);
      continue;
    }

    if (target.anchor && extname(resolved) === ".md" && !markdownAnchors(resolved).has(target.anchor)) {
      failures.push(`${file}:${link.line}: missing anchor ${JSON.stringify(target.anchor)} in ${relative(rootDir, resolved)}`);
    }
  }
}

const publicExportConfigPath = resolve(rootDir, ".public-export.json");
const publicExportConfig = existsSync(publicExportConfigPath)
  ? JSON.parse(readFileSync(publicExportConfigPath, "utf8"))
  : { exclude: [] };
const publicDocs = files
  .filter((file) => file.startsWith("docs/") && file.endsWith(".md"))
  .filter((file) => !publicExportConfig.exclude.some((pattern) => matchesPattern(file, pattern)));
const routedPublicDocs = reachableMarkdownFiles("docs/README.md", new Set(publicDocs));

for (const file of publicDocs) {
  if (!routedPublicDocs.has(file)) {
    failures.push(`${file}: public documentation is not reachable from docs/README.md`);
  }
}

if (failures.length > 0) {
  console.error("Docs link check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Docs links passed: ${files.length} markdown files, ${checkedLinks} local links.`);

function workspaceFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: rootDir,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || "git ls-files failed");
  }

  return result.stdout.split("\n").map((file) => file.trim()).filter(Boolean);
}

function isSkipped(file) {
  return skippedPrefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
}

function stripFencedCode(markdown) {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return "";
    }
    return inFence ? "" : line;
  }).join("\n");
}

function localMarkdownLinks(markdown) {
  const links = [];
  const pattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown))) {
    const rawTarget = match[1].trim();
    const target = normalizeRawTarget(rawTarget);
    if (!target || isExternalTarget(target) || target.startsWith("#")) {
      continue;
    }
    links.push({
      target,
      line: markdown.slice(0, match.index).split("\n").length
    });
  }
  return links;
}

function normalizeRawTarget(target) {
  if (!target) {
    return undefined;
  }
  if (target.startsWith("<") && target.endsWith(">")) {
    return target.slice(1, -1);
  }
  return /^(\S+)\s+["'][^"']+["']$/.exec(target)?.[1] ?? target;
}

function isExternalTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//") || target.startsWith("/");
}

function resolveLinkTarget(sourceFile, target) {
  const [pathPart, anchorPart] = target.split("#");
  if (!pathPart) {
    return undefined;
  }

  const decodedPath = decodePath(pathPart);
  const anchor = anchorPart ? decodePath(anchorPart) : undefined;
  return {
    absolutePath: resolve(rootDir, dirname(sourceFile), decodedPath),
    anchor
  };
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isInsideRoot(path) {
  const rel = relative(rootDir, path);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

function resolveExistingTarget(path) {
  if (!existsSync(path)) {
    return undefined;
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const readme = resolve(path, "README.md");
    return existsSync(readme) ? readme : undefined;
  }
  return path;
}

function reachableMarkdownFiles(entrypoint, allowedFiles) {
  const reached = new Set();
  const queue = [entrypoint];

  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || reached.has(file) || !allowedFiles.has(file)) {
      continue;
    }
    reached.add(file);

    const markdown = stripFencedCode(readFileSync(resolve(rootDir, file), "utf8"));
    for (const link of localMarkdownLinks(markdown)) {
      const target = resolveLinkTarget(file, link.target);
      if (!target || !isInsideRoot(target.absolutePath)) {
        continue;
      }
      const resolved = resolveExistingTarget(target.absolutePath);
      if (!resolved || extname(resolved) !== ".md") {
        continue;
      }
      const relativeTarget = relative(rootDir, resolved).split(sep).join("/");
      if (allowedFiles.has(relativeTarget) && !reached.has(relativeTarget)) {
        queue.push(relativeTarget);
      }
    }
  }

  return reached;
}

function matchesPattern(file, pattern) {
  if (pattern.endsWith("/") && !pattern.includes("*")) {
    const prefix = pattern.slice(0, -1);
    return file === prefix || file.startsWith(`${prefix}/`);
  }
  return globToRegExp(pattern).test(file);
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function markdownAnchors(path) {
  const anchors = new Set();
  const counts = new Map();
  const markdown = readFileSync(path, "utf8");
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const base = slugifyHeading(match[2]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function slugifyHeading(heading) {
  return heading
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~[\]]/g, "")
    .replace(/\([^)]*\)/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}
