#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const mode = process.argv.includes("--format") ? "format" : "lint";
const files = listWorkspaceFiles().filter((file) => existsForRead(file) && shouldCheckFile(file));
const failures = [];
const deprecatedMountPathOption = "--mount" + "-path";
const privateStateRootGuardScripts = new Set([
  "scripts/release" + "-package-smoke.mjs",
  "scripts/local-" + "macos" + "-vm-release" + "-proof.mjs"
]);

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  if (mode === "format") {
    if (!text.endsWith("\n")) {
      failures.push(`${file}: missing final newline`);
    }
    lines.forEach((line, index) => {
      if (/[ \t]$/.test(line)) {
        failures.push(`${file}:${index + 1}: trailing whitespace`);
      }
    });
    continue;
  }

  checkPublicDocsFlowGuardrails(file, text);

  lines.forEach((line, index) => {
    if (/^(<<<<<<<|=======|>>>>>>>)( |$)/.test(line)) {
      failures.push(`${file}:${index + 1}: merge conflict marker`);
    }
    if (/\b(describe|it|test)\.only\s*\(/.test(line)) {
      failures.push(`${file}:${index + 1}: focused test committed`);
    }
    if (/\bconsole\.debug\s*\(/.test(line) && file.startsWith("packages/")) {
      failures.push(`${file}:${index + 1}: console.debug in package source/test`);
    }
    checkPublicSyntaxGuardrails(file, line, index + 1);
  });
}

if (failures.length > 0) {
  console.error(`${mode} check failed:`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

function listWorkspaceFiles() {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((file) => !isSkippedPath(file));
  } catch {
    return walk(".").filter((file) => !isSkippedPath(file));
  }
}

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (isSkippedPath(path)) {
      continue;
    }
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      entries.push(...walk(path));
    } else if (stat.isFile()) {
      entries.push(path);
    }
  }
  return entries;
}

function shouldCheckFile(file) {
  return /\.(?:cjs|css|cts|html|js|json|jsx|md|mjs|ts|tsx|txt|yaml|yml)$/.test(file);
}

function existsForRead(file) {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

function isSkippedPath(file) {
  return /(^|\/)(\.git|\.agents|node_modules|dist|coverage|artifacts)(\/|$)/.test(file) ||
    file === "pnpm-lock.yaml";
}

function checkPublicSyntaxGuardrails(file, line, lineNumber) {
  if (file === "packages/mount/src/index.ts" && /command:\s+`activefs .*--root\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: mount verification guidance should print --state-root, not --root`);
  }

  if (privateStateRootGuardScripts.has(file) && /["']--root["']/.test(line)) {
    failures.push(`${file}:${lineNumber}: private verification commands should use --state-root, not the --root compatibility alias`);
  }

  if (!isPublicDocsFile(file)) {
    return;
  }

  if (/\bpnpm\s+activefs\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: public docs should invoke the activefs binary directly, not through pnpm`);
  }

  if (/\bnpx\s+activefs(?:\s|$)/.test(line)) {
    failures.push(`${file}:${lineNumber}: public docs should use the canonical installed activefs command, not npx activefs`);
  }

  if (/\bnode\s+packages\/cli\/dist\/index\.js\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: use activefs, not the repo dist-path CLI`);
  }

  if (/^\s*(?:activefs\s+|node\s+packages\/cli\/dist\/index\.js\s+)(?:ls|cat)\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: use mounted shell ls/cat or documented activefs list/read`);
  }

  if (/^\s*(?:activefs\s+|node\s+packages\/cli\/dist\/index\.js\s+)grep\s+\/\S+\s+\S+/.test(line)) {
    failures.push(`${file}:${lineNumber}: activefs grep examples must use pattern-first order`);
  }

  if (
    /^\s*(?:activefs\s+|node\s+packages\/cli\/dist\/index\.js\s+)(?:list|stat|read|grep)\b.*\b[A-Za-z][A-Za-z0-9._-]*:\//.test(line)
  ) {
    failures.push(`${file}:${lineNumber}: direct activefs list/stat/read/grep examples must use /remote paths, not remote:/ selectors`);
  }

  if (/\bdirect diagnostic (?:operations|commands|paths|block)\b/i.test(line) || /\bDirect diagnostics:/.test(line)) {
    failures.push(`${file}:${lineNumber}: direct list/stat/read/grep docs should be first-class direct operations, not diagnostic-only paths`);
  }

  if (/\bNormal workflow:\s*configure a remote, mount it/i.test(line)) {
    failures.push(`${file}:${lineNumber}: normal workflow should be direct-first with mount as optional OS-path access`);
  }

  if (isFirstRunDocsFile(file) && /--(?:root|workspace)\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: first-run docs should use discovery or --state-root, not --root/--workspace aliases`);
  }

  if (isPublishedCliGettingStartedFile(file) && /\b--source\s+example\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: published CLI getting-started docs should use the demo remote, not the diagnostic source shortcut`);
  }

  if (isPublishedCliGettingStartedFile(file) && line.includes(deprecatedMountPathOption)) {
    failures.push(`${file}:${lineNumber}: published CLI getting-started docs should use activefs mount or remote add --mount, not the deprecated remote mount-path option`);
  }

  if (isPublishedCliGettingStartedFile(file) && /--(?:root|workspace)\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: published CLI getting-started docs should use discovery or --state-root, not --root/--workspace aliases`);
  }

  if (/Run the example directly first\. To expose the same pattern as a remote/.test(line)) {
    failures.push(`${file}:${lineNumber}: clarify whether an example is a local fixture or a running Source API server before mentioning remote add`);
  }

  if (/\bnode\s+examples\/[^|\n`]+\/dist\/index\.js\b/.test(line) && /\bactivefs\s+remote\s+add\b/.test(line)) {
    failures.push(`${file}:${lineNumber}: do not present a local example command and activefs remote add as one copy-paste flow`);
  }

}

function checkPublicDocsFlowGuardrails(file, text) {
  if (!isFirstRunDocsFile(file)) {
    return;
  }

  if (/activefs list \/repo\nactivefs stat \/repo\/README\.txt\nactivefs read \/repo\/README\.txt\nactivefs grep Source \/repo/.test(text)) {
    failures.push(`${file}: first-run direct CLI docs should split list/stat/read/grep into explained independent checks`);
  }

  if (/activefs mount repo \.\/repo\nls -l \.\/repo\nstat \.\/repo\/README\.txt\ncat \.\/repo\/README\.txt\n(?:grep|rg) -R Source \.\/repo\nfind \.\/repo -name/.test(text)) {
    failures.push(`${file}: first-run mount docs should split mount setup from optional shell checks`);
  }
}

function isPublicDocsFile(file) {
  return file === "README.md" ||
    file === "docs/README.md" ||
    file.startsWith("docs/") ||
    /^examples\/[^/]+\/README\.md$/.test(file) ||
    /^packages\/[^/]+\/README\.md$/.test(file) ||
    isPublishedCliGettingStartedFile(file);
}

function isFirstRunDocsFile(file) {
  return file === "README.md" ||
    file === "docs/README.md" ||
    file === "docs/quickstart.md";
}

function isPublishedCliGettingStartedFile(file) {
  return file === "packages/activefs/README.md" ||
    file === "packages/cli/README.md";
}
