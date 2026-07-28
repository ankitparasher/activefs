import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const publicEntrypoints = [
  "packages/core/src/index.ts",
  "packages/config/src/index.ts",
  "packages/source-http/src/index.ts",
  "packages/local/src/index.ts",
  "packages/mount/src/index.ts",
  "packages/mcp/src/index.ts",
  "packages/testing/src/index.ts",
  "packages/testing/src/conformance.ts",
  "packages/cli/src/index.ts"
];

describe("public API docs", () => {
  it("documents every public package export and public method", () => {
    const missing = publicEntrypoints.flatMap((file) => missingDocsForEntrypoint(file));

    expect(missing).toEqual([]);
  });
});

function missingDocsForEntrypoint(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];

  const visit = (node: ts.Node): void => {
    if (isExportedPublicDeclaration(node)) {
      missing.push(...missingDeclarationDocs(file, sourceFile, node));
      missing.push(...missingPublicMethodDocs(file, sourceFile, node));
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return missing;
}

function missingDeclarationDocs(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node
): string[] {
  if (ts.isVariableStatement(node)) {
    const statementHasDocs = hasDocs(node);
    return node.declarationList.declarations
      .filter((declaration) => !statementHasDocs && !hasDocs(declaration))
      .map((declaration) => formatMissing(file, sourceFile, declaration, declaration.name.getText(sourceFile)));
  }

  return hasDocs(node) ? [] : [formatMissing(file, sourceFile, node, declarationName(node))];
}

function missingPublicMethodDocs(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node
): string[] {
  if (!ts.isInterfaceDeclaration(node) && !ts.isClassDeclaration(node)) {
    return [];
  }
  const parentName = node.name?.getText(sourceFile) ?? "<anonymous>";
  return node.members
    .filter((member): member is ts.MethodDeclaration | ts.MethodSignature =>
      (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) &&
      !isPrivateOrProtected(member) &&
      !hasDocs(member)
    )
    .map((member) =>
      formatMissing(file, sourceFile, member, `${parentName}.${member.name.getText(sourceFile)}`)
    );
}

function isExportedPublicDeclaration(node: ts.Node): boolean {
  return (
    (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isVariableStatement(node)
    ) &&
    Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export)
  );
}

function hasDocs(node: ts.Node): boolean {
  return ts.getJSDocCommentsAndTags(node).length > 0;
}

function isPrivateOrProtected(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return Boolean(flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected));
}

function declarationName(node: ts.Node): string {
  const declaration = node as ts.Declaration & { name?: ts.Node };
  return declaration.name && ts.isIdentifier(declaration.name)
    ? declaration.name.text
    : "<anonymous>";
}

function formatMissing(
  file: string,
  sourceFile: ts.SourceFile,
  node: ts.Node,
  name: string
): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${file}:${line + 1} ${name}`;
}
