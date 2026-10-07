import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function clientFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? clientFiles(path) : entry.name === 'Client.ts' ? [path] : [];
  });
}

/** Keep Fern's type namespace separate from its runtime error constructors. */
export function narrowSdkClientErrorImports(source: string, errorNames: ReadonlySet<string>): string {
  const parsed = ts.createSourceFile('Client.ts', source, ts.ScriptTarget.Latest, true);
  const namespaceImport = parsed.statements.find(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      node.importClause?.name === undefined &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamespaceImport(node.importClause.namedBindings) &&
      node.importClause.namedBindings.name.text === 'CloudflareApi' &&
      ts.isStringLiteral(node.moduleSpecifier),
  );
  if (!namespaceImport || !ts.isStringLiteral(namespaceImport.moduleSpecifier)) return source;
  const apiPath = namespaceImport.moduleSpecifier.text;
  if (!apiPath.startsWith('.')) return source;

  // Inspect emitted JavaScript: types and documentation cannot keep the API
  // barrel alive, while unfamiliar runtime uses must remain untouched.
  const emitted = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext, removeComments: true },
    reportDiagnostics: true,
  });
  if (emitted.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) return source;
  const runtime = ts.createSourceFile('Client.js', emitted.outputText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let safe = true;
  let hasConstructors = false;
  const inspect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'CloudflareApi') {
      const parent = node.parent;
      if (ts.isNamespaceImport(parent)) {
        // The original namespace declaration is replaced below.
      } else if (
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        ts.isNewExpression(parent.parent) &&
        parent.parent.expression === parent &&
        errorNames.has(parent.name.text)
      ) {
        hasConstructors = true;
      } else {
        safe = false;
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(runtime);
  if (!safe) return source;

  const edits: Array<{ start: number; end: number; text: string }> = [];
  const inspectSource = (node: ts.Node): void => {
    // Avoid introducing a namespace that collides with an existing binding.
    if (ts.isIdentifier(node) && node.text === 'CloudflareApiErrors') safe = false;
    if (
      ts.isNewExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'CloudflareApi' &&
      errorNames.has(node.expression.name.text)
    ) {
      const identifier = node.expression.expression;
      edits.push({ start: identifier.getStart(parsed), end: identifier.end, text: 'CloudflareApiErrors' });
    }
    ts.forEachChild(node, inspectSource);
  };
  inspectSource(parsed);
  if (!safe) return source;

  const errorsPath = `${apiPath.replace(/\/index(?:\.js)?$/, '').replace(/\/$/, '')}/errors${apiPath.endsWith('.js') ? '/index.js' : ''}`;
  const imports =
    source.slice(namespaceImport.getStart(parsed), namespaceImport.end).replace(/^import\b/, 'import type') +
    (hasConstructors ? `\nimport * as CloudflareApiErrors from ${JSON.stringify(errorsPath)};` : '');
  edits.push({ start: namespaceImport.getStart(parsed), end: namespaceImport.end, text: imports });
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

export function narrowSdkErrorImports(generatedSdkDir: string): number {
  const errorsDir = join(generatedSdkDir, 'api/errors');
  const errorNames = new Set(
    existsSync(errorsDir)
      ? readdirSync(errorsDir)
          .filter((name) => name.endsWith('Error.ts'))
          .map((name) => name.slice(0, -3))
      : [],
  );
  let updated = 0;
  for (const path of clientFiles(generatedSdkDir)) {
    const source = readFileSync(path, 'utf8');
    const narrowed = narrowSdkClientErrorImports(source, errorNames);
    if (source === narrowed) continue;
    writeFileSync(path, narrowed);
    updated++;
  }
  return updated;
}
