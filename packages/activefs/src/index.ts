#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  main as runActiveFSCLI,
  type CliMainOptions
} from "@activefs/cli";

export async function main(argv: string[], options: CliMainOptions = {}): Promise<void> {
  await runActiveFSCLI(argv, options);
}

if (isDirectRun()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

function isDirectRun(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]));
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}
