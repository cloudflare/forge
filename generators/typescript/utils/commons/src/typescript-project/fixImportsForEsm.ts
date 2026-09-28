import { AbsoluteFilePath, join, RelativeFilePath } from "@fern-api/fs-utils";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { ts } from "ts-morph";

// Define the possible import modifications
const ImportModification = {
    NONE: "none",
    ADD_JS_EXTENSION: "add_js_extension",
    REPLACE_TS_WITH_JS: "replace_ts_with_js",
    ADD_INDEX_JS: "add_index_js"
} as const;

type ImportModificationType = (typeof ImportModification)[keyof typeof ImportModification];

interface SpecifierEdit {
    /** Offset of the first character inside the quotes. */
    start: number;
    /** Offset of the closing quote. */
    end: number;
    replacement: string;
}

/**
 * Fixes imports in a TypeScript project to ensure compatibility with ESM (ECMAScript Modules).
 *
 * TypeScript's `tsc` compiler does not generate valid ESM unless the source code follows specific conventions:
 * - All imports must include the `.js` extension.
 * - Folder imports must explicitly reference `index.js`.
 *
 * This function modifies the imports in the project to adhere to these conventions by:
 * - Adding `.js` extensions to imports where necessary.
 * - Replacing folder imports with explicit `index.js` imports.
 * - Ensuring compatibility with the generated ESM output.
 *
 * Each file is parsed once without type checking; specifiers are rewritten in place so the
 * rest of the file text is untouched and only changed files are written back.
 *
 * @param pathToProject - The absolute path to the root of the TypeScript project.
 */
export async function fixImportsForEsm(pathToProject: AbsoluteFilePath): Promise<void> {
    const fileNames = readProjectFileNames(join(pathToProject, RelativeFilePath.of("tsconfig.json")));
    const fileExistenceCache = new Set(fileNames);
    const importModificationCache = new Map<string, ImportModificationType>();

    // Sequential sync IO: generated SDKs can have tens of thousands of files; unbounded
    // concurrent reads exhaust file descriptors and parsing dominates the cost anyway.
    for (const filePath of fileNames) {
        const text = readFileSync(filePath, "utf8");
        const edits = collectEdits(filePath, text, fileExistenceCache, importModificationCache);
        if (edits.length > 0) {
            writeFileSync(filePath, applyEdits(text, edits));
        }
    }
}

function readProjectFileNames(tsConfigFilePath: string): string[] {
    const config = ts.readConfigFile(tsConfigFilePath, ts.sys.readFile);
    if (config.error != null) {
        throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    }
    return ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(tsConfigFilePath),
        undefined,
        tsConfigFilePath
    ).fileNames;
}

function collectEdits(
    filePath: string,
    text: string,
    fileExistenceCache: Set<string>,
    importModificationCache: Map<string, ImportModificationType>
): SpecifierEdit[] {
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, getScriptKind(filePath));
    const edits: SpecifierEdit[] = [];

    const visitSpecifier = (literal: ts.StringLiteral) => {
        const moduleSpecifier = literal.text;
        // Skip if not a relative import or already has .js extension
        if (!moduleSpecifier || !moduleSpecifier.startsWith(".") || moduleSpecifier.endsWith(".js")) {
            return;
        }
        const normalizedPath = getNormalizedPath(moduleSpecifier, filePath);
        let modification = importModificationCache.get(normalizedPath);
        if (modification == null) {
            modification = determineModification(moduleSpecifier, filePath, fileExistenceCache);
            importModificationCache.set(normalizedPath, modification);
        }
        if (modification !== ImportModification.NONE) {
            edits.push({
                start: literal.getStart(sourceFile) + 1,
                end: literal.getEnd() - 1,
                replacement: getModifiedSpecifier(moduleSpecifier, modification)
            });
        }
    };

    // Handle static imports and exports
    for (const statement of sourceFile.statements) {
        if (
            (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
            statement.moduleSpecifier != null &&
            ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            visitSpecifier(statement.moduleSpecifier);
        }
    }

    // Handle dynamic imports; skip the full tree walk for files that cannot contain one
    if (text.includes("import(")) {
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const firstArg = node.arguments[0];
                if (firstArg != null && ts.isStringLiteral(firstArg)) {
                    visitSpecifier(firstArg);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return edits;
}

function getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith(".tsx")) {
        return ts.ScriptKind.TSX;
    }
    if (filePath.endsWith(".js") || filePath.endsWith(".cjs") || filePath.endsWith(".mjs")) {
        return ts.ScriptKind.JS;
    }
    if (filePath.endsWith(".jsx")) {
        return ts.ScriptKind.JSX;
    }
    return ts.ScriptKind.TS;
}

function applyEdits(text: string, edits: SpecifierEdit[]): string {
    edits.sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;
    for (const edit of edits) {
        result += text.slice(cursor, edit.start) + edit.replacement;
        cursor = edit.end;
    }
    return result + text.slice(cursor);
}

// Get the modified import specifier based on modification type
function getModifiedSpecifier(moduleSpecifier: string, modification: ImportModificationType): string {
    switch (modification) {
        case ImportModification.ADD_INDEX_JS:
            return `${moduleSpecifier}/index.js`;
        case ImportModification.ADD_JS_EXTENSION:
            return `${moduleSpecifier}.js`;
        case ImportModification.REPLACE_TS_WITH_JS:
            return moduleSpecifier.slice(0, -3) + ".js";
        default:
            return moduleSpecifier;
    }
}

// Get a normalized path for consistent cache keys
function getNormalizedPath(moduleSpecifier: string, currentFilePath: string): string {
    const currentDir = path.dirname(currentFilePath);
    return join(AbsoluteFilePath.of(currentDir), RelativeFilePath.of(moduleSpecifier)).toString();
}

// Determine import modification using file existence heuristics
function determineModification(
    moduleSpecifier: string,
    currentFilePath: string,
    fileExistenceCache: Set<string>
): ImportModificationType {
    // Case 1: Import with explicit .ts extension
    if (moduleSpecifier.endsWith(".ts")) {
        return ImportModification.REPLACE_TS_WITH_JS;
    }

    const currentDir = path.dirname(currentFilePath);

    // Case 2: Directory import with index file
    const dirPath = join(AbsoluteFilePath.of(currentDir), RelativeFilePath.of(moduleSpecifier));

    if (
        fileExistenceCache.has(join(dirPath, RelativeFilePath.of("index.ts")).toString()) ||
        fileExistenceCache.has(join(dirPath, RelativeFilePath.of("index.js")).toString())
    ) {
        return ImportModification.ADD_INDEX_JS;
    }

    // Case 3: Regular .ts file import
    const tsFilePath = join(AbsoluteFilePath.of(currentDir), RelativeFilePath.of(moduleSpecifier + ".ts")).toString();

    if (fileExistenceCache.has(tsFilePath)) {
        return ImportModification.ADD_JS_EXTENSION;
    }

    return ImportModification.NONE;
}
