// Collects extension imports for the core channel and test-layout boundary contracts.
import { createRequire } from "node:module";
import type ts from "typescript";
import { unwrapExpression } from "./ts-guard-utils.mts";

const require = createRequire(import.meta.url);
let tsCache: typeof ts | undefined;

function getTypeScript() {
  tsCache ??= require("typescript") as typeof ts;
  return tsCache;
}

/** Find actual module references, never comment prose or unrelated string literals. */
function collectModuleImports(source: string, fileName: string): string[] {
  const ts = getTypeScript();
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  const add = (specifier: string) => imports.add(specifier);

  const addModuleExpression = (expression: ts.Expression | undefined) => {
    if (!expression) {
      return;
    }
    const node = unwrapExpression(expression);
    if (ts.isStringLiteralLike(node)) {
      add(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // Preserve refusal of a literal private-directory prefix with a computed filename.
      add(node.head.text);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      addModuleExpression(node.left);
      addModuleExpression(node.right);
    }
  };

  const walk = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      // Static imports and re-exports, including type-only forms.
      add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      const isRequire =
        (ts.isIdentifier(callee) && callee.text === "require") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          ((callee.expression.text === "module" && callee.name.text === "require") ||
            (callee.expression.text === "require" && callee.name.text === "resolve")));
      if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire) {
        // Dynamic imports (with or without options), require(), templates, and
        // concatenated prefixes all resolve through the first argument.
        addModuleExpression(node.arguments[0]);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addModuleExpression(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      addModuleExpression(node.argument.literal as ts.Expression);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return [...imports];
}

/** Core may not depend on any extension's private source tree. */
export function collectCorePrivateExtensionImports(source: string, fileName: string): string[] {
  return collectModuleImports(source, fileName).filter((specifier) =>
    /(?:^|\/)extensions\/[^/]+\/src(?:\/|$)/u.test(specifier.replaceAll("\\", "/")),
  );
}

/** Keep all relative extension references visible to the test-layout owner's allowlist. */
export function collectRelativeExtensionImports(source: string, fileName: string): string[] {
  return collectModuleImports(source, fileName).filter((specifier) =>
    /^(?:\.\.\/)+extensions\/[^/]+(?:\/|$)/u.test(specifier.replaceAll("\\", "/")),
  );
}
