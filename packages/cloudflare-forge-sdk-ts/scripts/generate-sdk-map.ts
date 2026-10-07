#!/usr/bin/env tsx
// Emit sdk-map.json: a machine-readable map from OpenAPI operationId to the
// generated SDK call site (accessor chain + method + request/response type
// names). When an upstream operation has no operationId, emit a deterministic
// synthetic key from stable HTTP factors: `generated:<method>:<path>`.
// Downstream consumers (e.g. the cf CLI generator) should join on operationId
// when present, or compute the same synthetic key from method+path when absent,
// to emit typed client calls instead of the raw `.fetch()` passthrough, with
// zero SDK-name derivation guessing.
//
// The map is derived from the SAME generated source as the client, never
// hand-written:
//   - accessor chain  : walk CloudflareApiClient's `*Client` getters, resolving
//                        each `new XClient(...)` via the file's imports (so
//                        duplicate class names across resources stay distinct).
//   - method name      : the public endpoint method name.
//   - request/response : the method's request parameter type and the
//                        HttpResponsePromise<...> type argument, verbatim.
//   - operationId join : every generated method body ends with
//                        handleNonStatusCodeError(err, raw, VERB, PATH); those
//                        literals identify the OpenAPI operation. Fern splits
//                        literal dots next to path parameters into `/.`, which
//                        is repaired before the spec lookup. Parameter-name
//                        overrides are matched by route structure, retaining
//                        the canonical OpenAPI path in the map.
//
// Coverage is asserted against the spec: every non-ignored operation, including
// deprecated operations that Fern still generates, must resolve to an entry or
// generation fails loudly. Runtime resolution of each entry against a
// constructed client is verified separately in scripts/verify-sdk-map.ts
// (against the built dist artifact).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { findRequestParameter } from './sdk-map-ast.ts';
import { createSpecOperationLookup, type SpecOperation } from './sdk-map-paths.ts';

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GENERATED = process.env['FORGE_SDK_GENERATED'] ?? join(PKG_ROOT, 'src', '_generated');
const ROOT_CLIENT = join(GENERATED, 'Client.ts');
// The spec generate-sdk.ts installed for this run. Falls back to the repository
// root, which is where that script resolves an uninstalled spec from.
const FERN_SPEC = join(PKG_ROOT, '..', 'cloudflare-fern-config', 'fern', 'openapi.json');
const ROOT_SPEC = join(PKG_ROOT, '..', '..', 'openapi.json');
const DEFAULT_SPEC = existsSync(FERN_SPEC) ? FERN_SPEC : ROOT_SPEC;
const SPEC = process.env['FORGE_SDK_FERN_SPEC'] ?? DEFAULT_SPEC;
const SOURCE_SPEC = process.env['FORGE_SDK_SOURCE_SPEC'] ?? DEFAULT_SPEC;
const OUT = join(GENERATED, 'sdk-map.json');
const RUNTIME_OUT = join(GENERATED, 'sdk-map.ts');
const TYPES_OUT = join(GENERATED, 'sdk-operation-types.ts');
const GENERATED_INDEX = join(GENERATED, 'index.ts');
const UNRESOLVED_OUT = join(GENERATED, 'sdk-map.unresolved.json');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);

interface AccessorMeta {
  segment: string;
  targetFile: string;
}
interface PublicMeta {
  requestType?: string;
  requestTypeExpression?: string;
  responseType?: string;
  requiredRequestProperties?: string[];
  numericRequestProperties?: string[];
}
interface VerbPath {
  verb: string;
  path: string;
}
interface ClassInfo {
  accessors: AccessorMeta[];
  publicMeta: Map<string, PublicMeta>;
  verbPaths: Map<string, VerbPath>;
  requestBodyProperties: Map<string, string>;
}

interface Endpoint {
  accessor: string[];
  method: string;
  requestType?: string;
  requestTypeExpression?: string;
  responseType?: string;
  requestBodyProperty?: string;
  requiredRequestProperties?: string[];
  numericRequestProperties?: string[];
  queryProperties?: string[];
  verb: string;
  path: string;
}

interface SdkMapEntry {
  accessor: string[];
  method: string;
  httpMethod: string;
  path: string;
  requestType?: string;
  responseType?: string;
  /** Request property containing the JSON payload when Fern wraps it. */
  requestBodyProperty?: string;
  /** Non-optional properties on the generated method's request type. */
  requiredRequestProperties?: string[];
  numericRequestProperties?: string[];
  operationIdSource?: 'synthetic';
}

const fileCache = new Map<string, ClassInfo>();
const program = ts.createProgram({
  rootNames: [ROOT_CLIENT],
  options: {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  },
});
const checker = program.getTypeChecker();

// "../resources/emails/client/Client.js" (relative, .js) -> absolute .ts path.
function resolveImport(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  let target = resolve(dirname(fromFile), spec);
  if (target.endsWith('.js')) target = `${target.slice(0, -3)}.ts`;
  else if (!target.endsWith('.ts')) target = `${target}.ts`;
  return existsSync(target) ? target : undefined;
}

// The trailing identifier of `CloudflareApi.Foo` or `Foo`.
function lastName(name: ts.EntityName): string {
  return ts.isQualifiedName(name) ? name.right.text : name.text;
}

function typeRefName(type: ts.TypeNode | undefined): string | undefined {
  return type && ts.isTypeReferenceNode(type) ? lastName(type.typeName) : undefined;
}

function typeExpression(type: ts.TypeNode | undefined, source: ts.SourceFile): string | undefined {
  return type ? type.getText(source) : undefined;
}

// The last type argument of a generic return type, e.g.
// core.HttpResponsePromise<CloudflareApi.Foo> -> "Foo".
function returnTypeArgName(type: ts.TypeNode | undefined): string | undefined {
  if (!type || !ts.isTypeReferenceNode(type) || !type.typeArguments?.length) return undefined;
  return typeRefName(type.typeArguments[type.typeArguments.length - 1]);
}

// Find the handleNonStatusCodeError(err, raw, VERB, PATH) call anywhere within a
// node (it may sit inside a nested closure for paginated endpoints) and return
// its (VERB, PATH) string-literal arguments.
function findVerbPath(node: ts.Node): VerbPath | undefined {
  let found: VerbPath | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'handleNonStatusCodeError' &&
      n.arguments.length >= 4
    ) {
      const verb = n.arguments[2];
      const path = n.arguments[3];
      if (verb === undefined || path === undefined) return;
      if (ts.isStringLiteralLike(verb) && ts.isStringLiteralLike(path)) {
        found = { verb: verb.text.toUpperCase(), path: path.text };
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

// Fern serializes wrapped request bodies by destructuring e.g.
// `{ body: _body } = request` and passing `_body` to
// mergeAdditionalBodyParameters. Flat bodies use `..._body`, while fully-flat
// bodies pass `request` directly. Return only the actual wrapper property.
function findRequestBodyProperty(node: ts.Node): string | undefined {
  let bodyIdentifier: string | undefined;
  const findBodyArgument = (n: ts.Node): void => {
    if (bodyIdentifier) return;
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'mergeAdditionalBodyParameters'
    ) {
      const first = n.arguments[0];
      if (first && ts.isIdentifier(first) && first.text !== 'request') bodyIdentifier = first.text;
      return;
    }
    ts.forEachChild(n, findBodyArgument);
  };
  findBodyArgument(node);
  if (!bodyIdentifier) return undefined;

  let property: string | undefined;
  const findBinding = (n: ts.Node): void => {
    if (property) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer &&
      ts.isIdentifier(n.initializer) &&
      n.initializer.text === 'request'
    ) {
      for (const element of n.name.elements) {
        if (!ts.isIdentifier(element.name) || element.name.text !== bodyIdentifier) continue;
        if (element.dotDotDotToken) return;
        const key = element.propertyName;
        if (key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) property = key.text;
        return;
      }
    }
    ts.forEachChild(n, findBinding);
  };
  findBinding(node);
  return property;
}

// The first `new XClient(...)` constructor name within a getter body.
function findConstructedClass(node: ts.Node): string | undefined {
  let name: string | undefined;
  const visit = (n: ts.Node): void => {
    if (name) return;
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      name = n.expression.text;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return name;
}

function parseFile(file: string): ClassInfo {
  const cached = fileCache.get(file);
  if (cached) return cached;

  const source =
    program.getSourceFile(file) ?? ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

  const imports = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const target = resolveImport(file, statement.moduleSpecifier.text);
    if (!target) continue;
    for (const element of bindings.elements) imports.set(element.name.text, target);
  }

  const info: ClassInfo = {
    accessors: [],
    publicMeta: new Map(),
    verbPaths: new Map(),
    requestBodyProperties: new Map(),
  };

  const classDecl = source.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && !!s.name?.text.endsWith('Client'),
  );
  if (!classDecl) {
    throw new Error(`generate-sdk-map: expected a *Client class in generated client file: ${file}`);
  }

  for (const member of classDecl.members) {
    if (ts.isGetAccessorDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
      const ctor = findConstructedClass(member.body);
      const targetFile = ctor ? imports.get(ctor) : undefined;
      if (targetFile?.endsWith('Client.ts')) {
        info.accessors.push({ segment: member.name.text, targetFile });
      }
      continue;
    }
    if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;

    const rawName = member.name.text;
    const baseName = rawName.startsWith('__') ? rawName.slice(2) : rawName;

    if (member.body) {
      const verbPath = findVerbPath(member.body);
      if (verbPath && !info.verbPaths.has(baseName)) info.verbPaths.set(baseName, verbPath);
      const requestBodyProperty = findRequestBodyProperty(member.body);
      if (requestBodyProperty && !info.requestBodyProperties.has(baseName)) {
        info.requestBodyProperties.set(baseName, requestBodyProperty);
      }
    }

    if (!rawName.startsWith('__')) {
      const request = findRequestParameter(member);
      const requestType = request ? typeRefName(request.type) : undefined;
      const requestTypeExpression = request ? typeExpression(request.type, source) : undefined;
      const responseType = returnTypeArgName(member.type);
      const meta: PublicMeta = {};
      if (requestType !== undefined) meta.requestType = requestType;
      if (requestTypeExpression !== undefined) meta.requestTypeExpression = requestTypeExpression;
      if (responseType !== undefined) meta.responseType = responseType;
      if (request !== undefined) {
        const requiredRequestProperties = checker
          .getTypeAtLocation(request)
          .getProperties()
          .filter((property) => (property.flags & ts.SymbolFlags.Optional) === 0)
          .map((property) => property.getName())
          .sort();
        if (requiredRequestProperties.length > 0) meta.requiredRequestProperties = requiredRequestProperties;
        const numericRequestProperties = checker
          .getTypeAtLocation(request)
          .getProperties()
          .filter((property) => {
            const type = checker.getTypeOfSymbolAtLocation(property, request);
            return (type.flags & ts.TypeFlags.NumberLike) !== 0;
          })
          .map((property) => property.getName())
          .sort();
        if (numericRequestProperties.length > 0) meta.numericRequestProperties = numericRequestProperties;
      }
      info.publicMeta.set(baseName, meta);
    }
  }

  fileCache.set(file, info);
  return info;
}

function collectEndpoints(): Endpoint[] {
  const endpoints: Endpoint[] = [];
  const walk = (file: string, chain: string[]): void => {
    const info = parseFile(file);
    for (const [method, verbPath] of info.verbPaths) {
      const meta = info.publicMeta.get(method) ?? {};
      const endpoint: Endpoint = {
        accessor: chain,
        method,
        verb: verbPath.verb,
        path: verbPath.path,
      };
      if (meta.requestType !== undefined) endpoint.requestType = meta.requestType;
      if (meta.requestTypeExpression !== undefined) endpoint.requestTypeExpression = meta.requestTypeExpression;
      if (meta.responseType !== undefined) endpoint.responseType = meta.responseType;
      if (meta.requiredRequestProperties !== undefined) {
        endpoint.requiredRequestProperties = meta.requiredRequestProperties;
      }
      if (meta.numericRequestProperties !== undefined) {
        endpoint.numericRequestProperties = meta.numericRequestProperties;
      }
      const requestBodyProperty = info.requestBodyProperties.get(method);
      if (requestBodyProperty !== undefined) endpoint.requestBodyProperty = requestBodyProperty;
      endpoints.push(endpoint);
    }
    for (const accessor of info.accessors) walk(accessor.targetFile, [...chain, accessor.segment]);
  };
  walk(ROOT_CLIENT, []);
  return endpoints;
}

function syntheticOperationId(method: string, path: string): string {
  return `generated:${method.toLowerCase()}:${path}`;
}

function indexSpec(): { byKey: Map<string, SpecOperation>; expected: Set<string> } {
  const parsed: unknown = JSON.parse(readFileSync(SPEC, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected an OpenAPI object at ${SPEC}, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  const spec = parsed as {
    paths?: Record<string, Record<string, { operationId?: string; 'x-fern-ignore'?: boolean }>>;
  };
  const byKey = new Map<string, SpecOperation>();
  const expected = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || typeof op !== 'object' || op === null) continue;
      const operationId = typeof op.operationId === 'string' ? op.operationId : syntheticOperationId(method, path);
      const entry: SpecOperation = {
        operationId,
        path,
        synthetic: typeof op.operationId !== 'string',
        ignored: op['x-fern-ignore'] === true,
      };
      byKey.set(`${method.toUpperCase()} ${path}`, entry);
      if (!entry.ignored) expected.add(operationId);
    }
  }
  return { byKey, expected };
}

function indexSourceQueryProperties(): Map<string, string[]> {
  const parsed: unknown = JSON.parse(readFileSync(SOURCE_SPEC, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Expected an OpenAPI object at ${SOURCE_SPEC}, got ${parsed === null ? 'null' : typeof parsed}`);
  }
  type Parameter = { $ref?: string; in?: string; name?: string };
  const spec = parsed as {
    components?: { parameters?: Record<string, Parameter> };
    paths?: Record<
      string,
      Record<string, unknown> & {
        parameters?: Parameter[];
      }
    >;
  };
  const resolveParameter = (parameter: Parameter): Parameter | undefined => {
    const name = parameter.$ref?.match(/^#\/components\/parameters\/(.+)$/)?.[1];
    return name ? spec.components?.parameters?.[name] : parameter;
  };
  const result = new Map<string, string[]>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, value] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase()) || typeof value !== 'object' || value === null) continue;
      const op = value as { operationId?: string; parameters?: Parameter[] };
      const operationId = typeof op.operationId === 'string' ? op.operationId : syntheticOperationId(method, path);
      const queryProperties = [...(item.parameters ?? []), ...(op.parameters ?? [])].flatMap((parameter) => {
        const resolved = resolveParameter(parameter);
        return resolved?.in === 'query' && typeof resolved.name === 'string' ? [resolved.name] : [];
      });
      if (queryProperties.length > 0) result.set(operationId, [...new Set(queryProperties)]);
    }
  }
  return result;
}

// Deterministic primary among alias methods sharing one operationId: prefer the
// shortest accessor chain, then lexicographic accessor, then method name.
function preferEndpoint(a: Endpoint, b: Endpoint): Endpoint {
  if (a.accessor.length !== b.accessor.length) return a.accessor.length < b.accessor.length ? a : b;
  const byAccessor = a.accessor.join('.').localeCompare(b.accessor.join('.'));
  if (byAccessor !== 0) return byAccessor < 0 ? a : b;
  return a.method.localeCompare(b.method) <= 0 ? a : b;
}

function emitOperationTypes(chosen: Map<string, Endpoint>): void {
  const operations = [...chosen.entries()]
    .filter((entry): entry is [string, Endpoint & { requestTypeExpression: string }] => {
      return entry[1].requestTypeExpression !== undefined && entry[1].requestTypeExpression !== 'string';
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const queryOperations = operations.filter(([, endpoint]) => (endpoint.queryProperties?.length ?? 0) > 0);
  const lines = [
    "import type { CloudflareApi } from './index.js';",
    '',
    '/** Request types keyed by the OpenAPI operationId used to generate them. */',
    'export interface SdkOperationRequestMap {',
    ...operations.map(
      ([operationId, endpoint]) => `  ${JSON.stringify(operationId)}: ${endpoint.requestTypeExpression};`,
    ),
    '}',
    '',
    '/** Query-only projections of generated SDK request types. */',
    'export interface SdkOperationQueryMap {',
    ...queryOperations.map(([operationId, endpoint]) => {
      const keys = endpoint.queryProperties?.map((property) => JSON.stringify(property)).join(' | ');
      return `  ${JSON.stringify(operationId)}: Pick<${endpoint.requestTypeExpression}, Extract<${keys}, keyof ${endpoint.requestTypeExpression}>>;`;
    }),
    '}',
    '',
    'export type SdkOperationId = keyof SdkOperationRequestMap;',
    'export type SdkQueryOperationId = keyof SdkOperationQueryMap;',
    '',
    'export type SdkRequest<OperationId extends SdkOperationId> =',
    '  SdkOperationRequestMap[OperationId];',
    '',
    'export type SdkQuery<OperationId extends SdkQueryOperationId> =',
    '  SdkOperationQueryMap[OperationId];',
    '',
  ];
  writeFileSync(TYPES_OUT, `${lines.join('\n')}\n`);

  const exportLine =
    'export type { SdkOperationId, SdkOperationQueryMap, SdkOperationRequestMap, SdkQuery, SdkQueryOperationId, SdkRequest } from "./sdk-operation-types.js";';
  const index = readFileSync(GENERATED_INDEX, 'utf8');
  if (!index.includes(exportLine)) writeFileSync(GENERATED_INDEX, `${index.trimEnd()}\n${exportLine}\n`);
}

function emitSdkMapRuntime(): void {
  writeFileSync(
    RUNTIME_OUT,
    `import sdkMapJson from './sdk-map.json' with { type: 'json' };

export interface SdkMapEntry {
  accessor: string[];
  method: string;
  httpMethod: string;
  path: string;
  requestType?: string;
  responseType?: string;
  requestBodyProperty?: string;
  requiredRequestProperties?: string[];
  numericRequestProperties?: string[];
  operationIdSource?: 'synthetic';
}

function isSdkMapEntry(value: unknown): value is SdkMapEntry {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const get = (key: string): unknown => Reflect.get(value, key);
  const accessor = get('accessor');
  const requiredRequestProperties = get('requiredRequestProperties');
  const numericRequestProperties = get('numericRequestProperties');
  return (
    Array.isArray(accessor) &&
    accessor.every((part) => typeof part === 'string') &&
    typeof get('method') === 'string' &&
    typeof get('httpMethod') === 'string' &&
    typeof get('path') === 'string' &&
    (get('requestType') === undefined || typeof get('requestType') === 'string') &&
    (get('responseType') === undefined || typeof get('responseType') === 'string') &&
    (get('requestBodyProperty') === undefined || typeof get('requestBodyProperty') === 'string') &&
    (requiredRequestProperties === undefined ||
      (Array.isArray(requiredRequestProperties) &&
        requiredRequestProperties.every((part) => typeof part === 'string'))) &&
    (numericRequestProperties === undefined ||
      (Array.isArray(numericRequestProperties) &&
        numericRequestProperties.every((part) => typeof part === 'string'))) &&
    (get('operationIdSource') === undefined || get('operationIdSource') === 'synthetic')
  );
}

function parseSdkMap(value: unknown): Record<string, SdkMapEntry> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid sdk-map.json: expected an object');
  }
  const entries = Object.entries(value);
  for (const [operationId, entry] of entries) {
    if (!isSdkMapEntry(entry)) {
      throw new TypeError(\`Invalid sdk-map.json entry: \${operationId}\`);
    }
  }
  return Object.fromEntries(entries);
}

const sdkMap = parseSdkMap(sdkMapJson);

export function getSdkMapEntry(operationId: string): SdkMapEntry | undefined {
  return sdkMap[operationId];
}
`,
  );

  const exportLines = [
    'export { getSdkMapEntry } from "./sdk-map.js";',
    'export type { SdkMapEntry } from "./sdk-map.js";',
  ];
  const index = readFileSync(GENERATED_INDEX, 'utf8');
  const missingExports = exportLines.filter((line) => !index.includes(line));
  if (missingExports.length > 0) {
    writeFileSync(GENERATED_INDEX, `${index.trimEnd()}\n${missingExports.join('\n')}\n`);
  }
}

function main(): void {
  if (!existsSync(ROOT_CLIENT)) {
    throw new Error(`generate-sdk-map: generated client not found: ${ROOT_CLIENT}`);
  }
  if (!existsSync(SPEC)) {
    throw new Error(`generate-sdk-map: transformed spec not found: ${SPEC}`);
  }
  if (!existsSync(SOURCE_SPEC)) {
    throw new Error(`generate-sdk-map: source spec not found: ${SOURCE_SPEC}`);
  }

  const endpoints = collectEndpoints();
  const { byKey, expected } = indexSpec();
  const findSpecOperation = createSpecOperationLookup(byKey);
  const sourceQueryProperties = indexSourceQueryProperties();

  const chosen = new Map<string, Endpoint>();
  const chosenSpec = new Map<string, SpecOperation>();
  const unmatched: string[] = [];
  let aliasCollisions = 0;

  for (const endpoint of endpoints) {
    const op = findSpecOperation(endpoint.verb, endpoint.path);
    if (!op) {
      unmatched.push(`${endpoint.verb} ${endpoint.path} (${[...endpoint.accessor, endpoint.method].join('.')})`);
      continue;
    }
    if (op.ignored) continue;
    const matchedPathEndpoint = { ...endpoint, path: op.path };
    const queryProperties = sourceQueryProperties.get(op.operationId);
    const matchedEndpoint = queryProperties ? { ...matchedPathEndpoint, queryProperties } : matchedPathEndpoint;
    const existing = chosen.get(op.operationId);
    if (!existing) {
      chosen.set(op.operationId, matchedEndpoint);
      chosenSpec.set(op.operationId, op);
    } else {
      aliasCollisions += 1;
      chosen.set(op.operationId, preferEndpoint(existing, matchedEndpoint));
    }
  }

  const missing = [...expected].filter((operationId) => !chosen.has(operationId)).sort();

  // Guard against a systemic regression (e.g. a parser break) that would
  // silently drop large swaths of the surface: tolerate only a tiny tail.
  const MAX_UNRESOLVED = Math.max(5, Math.ceil(expected.size * 0.01));
  if (missing.length > MAX_UNRESOLVED) {
    const sample = missing.slice(0, 25).join('\n  - ');
    throw new Error(
      `generate-sdk-map: ${missing.length} non-ignored operation(s) did not resolve to a generated method ` +
        `(threshold ${MAX_UNRESOLVED}); likely a generator/parser regression:\n  - ${sample}${
          missing.length > 25 ? `\n  … and ${missing.length - 25} more` : ''
        }`,
    );
  }
  if (missing.length > 0) {
    writeFileSync(UNRESOLVED_OUT, `${JSON.stringify(missing, null, 2)}\n`);
  } else {
    rmSync(UNRESOLVED_OUT, { force: true });
  }

  const map: Record<string, SdkMapEntry> = {};
  for (const operationId of [...chosen.keys()].sort()) {
    const endpoint = chosen.get(operationId);
    if (!endpoint) throw new Error(`generate-sdk-map: internal error: missing chosen endpoint for ${operationId}`);
    const specOp = chosenSpec.get(operationId);
    const entry: SdkMapEntry = {
      accessor: endpoint.accessor,
      method: endpoint.method,
      httpMethod: endpoint.verb,
      path: endpoint.path,
    };
    if (endpoint.requestType) entry.requestType = endpoint.requestType;
    if (endpoint.responseType) entry.responseType = endpoint.responseType;
    if (endpoint.requestBodyProperty) entry.requestBodyProperty = endpoint.requestBodyProperty;
    if (endpoint.requiredRequestProperties) entry.requiredRequestProperties = endpoint.requiredRequestProperties;
    if (endpoint.numericRequestProperties) entry.numericRequestProperties = endpoint.numericRequestProperties;
    if (specOp?.synthetic) entry.operationIdSource = 'synthetic';
    map[operationId] = entry;
  }

  writeFileSync(OUT, `${JSON.stringify(map, null, 2)}\n`);
  emitSdkMapRuntime();
  emitOperationTypes(chosen);

  console.log(
    `generate-sdk-map: wrote ${Object.keys(map).length} entr(ies) to ${OUT}\n` +
      `  endpoints parsed: ${endpoints.length}\n` +
      `  expected non-ignored ops: ${expected.size}\n` +
      `  alias collisions resolved: ${aliasCollisions}\n` +
      `  unmatched generated methods: ${unmatched.length}\n` +
      `  unresolved spec ops: ${missing.length}`,
  );
  if (missing.length > 0) {
    console.warn(
      `generate-sdk-map: ${missing.length} non-ignored op(s) unresolved (written to ${UNRESOLVED_OUT}); ` +
        `raise upstream if the generated SDK omitted or corrupted these methods:\n  - ${missing.join('\n  - ')}`,
    );
  }
  if (unmatched.length > 0) {
    console.warn(
      `generate-sdk-map: ${unmatched.length} generated method(s) had no spec match (first 10):\n  - ${unmatched
        .slice(0, 10)
        .join('\n  - ')}`,
    );
  }
}

main();
