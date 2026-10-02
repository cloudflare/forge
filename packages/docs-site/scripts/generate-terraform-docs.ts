#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadForgeOpenApi } from '../src/openapi-source.ts';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
const OUTPUT_FILE = new URL('../src/generated/terraform-docs.json', import.meta.url);
type TerraformDeclarationKind = 'resource' | 'data-source' | 'list-data-source';
type TerraformAttributeGroup = 'required' | 'optional' | 'computed';

interface TerraformTypeInput {
  category?: string;
  type?: string;
  elementType?: TerraformTypeInput;
  allowedSubtypes?: string[];
}

interface TerraformAttributeInput {
  kind: 'TerraformDeclAttribute';
  name: string;
  type: TerraformTypeInput;
  description?: string;
  deprecated?: string | boolean;
  sensitive?: boolean;
  requiresReplace?: boolean;
  children?: string[];
}

interface TerraformSourceInput {
  kind: 'TerraformDeclSource';
  name: string;
  methodName: string;
  required?: string[];
  optional?: string[];
  computed?: string[];
}

interface TerraformServiceNodeInput {
  kind: 'TerraformDeclServiceNode';
  resource?: string;
  dataSource?: string;
  listDataSource?: string;
}

type TerraformDeclarationInput = TerraformAttributeInput | TerraformSourceInput | TerraformServiceNodeInput;

interface TerraformResourceInput {
  stainlessPath?: string;
  methods?: Record<string, { endpoint?: string }>;
  subresources?: Record<string, TerraformResourceInput>;
}

interface TerraformSdkInput {
  resources: Record<string, TerraformResourceInput>;
  decls: { terraform: Record<string, TerraformDeclarationInput> };
  snippets: {
    'terraform.default': Record<string, { default?: { content?: string } }>;
  };
  metadata?: { terraform?: unknown };
}

interface OpenApiInput {
  paths: Record<string, Partial<Record<(typeof HTTP_METHODS)[number], { operationId?: string }>>>;
}

interface TerraformAttribute {
  name: string;
  type: string;
  description?: string;
  deprecated?: string;
  sensitive?: boolean;
  requiresReplace?: boolean;
  children?: TerraformAttribute[];
}

interface TerraformDeclaration {
  kind: TerraformDeclarationKind;
  name: string;
  stainlessResource: string;
  methodName: string;
  snippet?: string;
  required: TerraformAttribute[];
  optional: TerraformAttribute[];
  computed: TerraformAttribute[];
}

interface OperationEntry {
  operationId: string;
  declarations: TerraformDeclaration[];
}

function usage() {
  return 'Usage: node --experimental-strip-types scripts/generate-terraform-docs.ts --sdk-json <terraform.json>';
}

export function canonicalTerraformEndpoint(method: string, endpointPath: string): string {
  return `${method.toLowerCase()} ${endpointPath.replaceAll(/\{[^}]+\}/g, '{}')}`;
}

function terraformTypeLabel(type: TerraformTypeInput): string {
  const name = type.type ?? 'unknown';
  if (type.category === 'collection' && type.elementType) return `${name}[${terraformTypeLabel(type.elementType)}]`;
  if (type.category === 'dynamic') {
    const variants = type.allowedSubtypes ?? [];
    return variants.length > 0 ? `Dynamic ${variants.join(' | ')}` : 'Dynamic';
  }
  if (type.category === 'nested')
    return name === 'SingleNested' ? 'Attributes' : `${name.replace(/Nested$/, '')}[Attributes]`;
  return name;
}

function deprecatedMessage(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return value === true ? 'Deprecated.' : undefined;
}

function resolveAttribute(
  declarations: Record<string, TerraformDeclarationInput>,
  reference: string,
  ancestors: ReadonlySet<string> = new Set(),
): TerraformAttribute {
  if (ancestors.has(reference)) throw new Error(`Terraform declaration cycle at ${reference}`);
  const declaration = declarations[reference];
  if (!declaration || declaration.kind !== 'TerraformDeclAttribute') {
    throw new Error(`Expected ${reference} to be a TerraformDeclAttribute`);
  }
  const nextAncestors = new Set(ancestors).add(reference);
  const children = (declaration.children ?? []).map((child) => resolveAttribute(declarations, child, nextAncestors));
  return {
    name: declaration.name,
    type: terraformTypeLabel(declaration.type),
    ...(typeof declaration.description === 'string' && declaration.description
      ? { description: declaration.description }
      : {}),
    ...(deprecatedMessage(declaration.deprecated) ? { deprecated: deprecatedMessage(declaration.deprecated) } : {}),
    ...(declaration.sensitive === true ? { sensitive: true } : {}),
    ...(declaration.requiresReplace === true ? { requiresReplace: true } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function terraformResourceNodes(
  resources: Record<string, TerraformResourceInput>,
): Map<string, TerraformResourceInput> {
  const nodes = new Map<string, TerraformResourceInput>();
  function visit(entries: Record<string, TerraformResourceInput>): void {
    for (const resource of Object.values(entries)) {
      if (resource.stainlessPath) {
        nodes.set(resource.stainlessPath.replace(/^\(resource\) /, ''), resource);
      }
      if (resource.subresources) visit(resource.subresources);
    }
  }
  visit(resources);
  return nodes;
}

function openApiOperations(document: OpenApiInput): Map<string, string> {
  const operations = new Map<string, string>();
  for (const [endpointPath, pathItem] of Object.entries(document.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const operationId = operation.operationId;
      if (typeof operationId !== 'string' || !operationId) continue;
      const key = canonicalTerraformEndpoint(method, endpointPath);
      if (operations.has(key))
        throw new Error(`OpenAPI endpoint key ${key} is ambiguous after parameter normalization`);
      operations.set(key, operationId);
    }
  }
  return operations;
}

export function extractTerraformDocs(sdkJson: TerraformSdkInput, openapi: OpenApiInput) {
  const declarations = sdkJson.decls.terraform;
  const snippets = sdkJson.snippets['terraform.default'];
  const resources = terraformResourceNodes(sdkJson.resources);
  const operations = openApiOperations(openapi);
  const outputOperations = new Map<string, OperationEntry>();
  const unmatched: Array<{ kind: TerraformDeclarationKind; name: string; endpoint: string }> = [];
  let missingSnippets = 0;

  const serviceNodes = Object.entries(declarations)
    .filter((entry): entry is [string, TerraformServiceNodeInput] => entry[1].kind === 'TerraformDeclServiceNode')
    .sort(([left], [right]) => left.localeCompare(right));

  for (const [servicePath, serviceNode] of serviceNodes) {
    const stainlessResource = servicePath.replace(/^\(resource\) /, '');
    const resource = resources.get(stainlessResource);
    if (!resource) throw new Error(`No Terraform SDK resource found for ${servicePath}`);
    const methods = resource.methods ?? {};

    const sources: Array<[TerraformDeclarationKind, unknown]> = [
      ['resource', serviceNode.resource],
      ['data-source', serviceNode.dataSource],
      ['list-data-source', serviceNode.listDataSource],
    ];
    for (const [kind, sourceReferenceValue] of sources) {
      if (typeof sourceReferenceValue !== 'string') continue;
      const sourceReference = sourceReferenceValue;
      const source = declarations[sourceReference];
      if (source?.kind !== 'TerraformDeclSource') {
        throw new Error(`Expected ${sourceReference} to be a TerraformDeclSource`);
      }
      const methodName = source.methodName;
      const method = methods[methodName];
      if (!method?.endpoint) {
        throw new Error(`Terraform method ${stainlessResource}.${methodName} has no endpoint`);
      }
      const separator = method.endpoint.indexOf(' ');
      if (separator < 1) throw new Error(`Invalid Terraform endpoint ${method.endpoint}`);
      const key = canonicalTerraformEndpoint(method.endpoint.slice(0, separator), method.endpoint.slice(separator + 1));
      const operationId = operations.get(key);
      if (!operationId) {
        unmatched.push({ kind, name: source.name, endpoint: method.endpoint });
        continue;
      }
      const snippet = snippets[sourceReference]?.default?.content;
      if (typeof snippet !== 'string' || !snippet) missingSnippets += 1;
      const resolveGroup = (name: TerraformAttributeGroup): TerraformAttribute[] => {
        const references = source[name];
        if (!Array.isArray(references)) throw new Error(`Terraform source ${sourceReference}.${name} is not an array`);
        return references.map((reference) => resolveAttribute(declarations, String(reference)));
      };
      const declaration: TerraformDeclaration = {
        kind,
        name: source.name,
        stainlessResource,
        methodName,
        ...(typeof snippet === 'string' && snippet ? { snippet } : {}),
        required: resolveGroup('required'),
        optional: resolveGroup('optional'),
        computed: resolveGroup('computed'),
      };
      const entry = outputOperations.get(key) ?? { operationId, declarations: [] };
      if (entry.operationId !== operationId) throw new Error(`Conflicting operation IDs for ${key}`);
      entry.declarations.push(declaration);
      outputOperations.set(key, entry);
    }
  }

  const orderedOperations = Object.fromEntries(
    [...outputOperations]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [
        key,
        {
          operationId: entry.operationId,
          declarations: entry.declarations.sort(
            (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
          ),
        },
      ]),
  );
  const declarationCount = Object.values(orderedOperations).reduce(
    (count, operation) => count + operation.declarations.length,
    0,
  );
  return {
    format: 1,
    source: {
      terraform: sdkJson.metadata?.terraform ?? {},
    },
    stats: {
      operations: Object.keys(orderedOperations).length,
      declarations: declarationCount,
      missingSnippets,
      unmatched: unmatched.length,
    },
    unmatched,
    operations: orderedOperations,
  };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'sdk-json': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const sdkJsonPath = values['sdk-json'];
  if (!sdkJsonPath) throw new Error(`Missing --sdk-json\n\n${usage()}`);
  const [sdkJson, openapi] = await Promise.all([
    readJson<TerraformSdkInput>(sdkJsonPath),
    loadForgeOpenApi() as Promise<OpenApiInput>,
  ]);
  const output = extractTerraformDocs(sdkJson, openapi);
  await writeFile(OUTPUT_FILE, `${JSON.stringify(output)}\n`, 'utf8');
  const relativeOutput = path.relative(process.cwd(), fileURLToPath(OUTPUT_FILE));
  console.log(
    `generate-terraform-docs: wrote ${relativeOutput} (${output.stats.operations} operations, ${output.stats.declarations} declarations, ${output.stats.unmatched} unmatched, ${output.stats.missingSnippets} missing snippets)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
