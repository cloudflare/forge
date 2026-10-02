/**
 * Pure extraction of Terraform documentation from public, versioned artifacts:
 *
 * - the provider's committed `docs/` (tfplugindocs output) for descriptions and attributes;
 * - the provider's `examples/` tree (tfplugindocs convention) for HCL and import syntax;
 * - the provider's `internal/services/<service>/{resource,data_source,list_data_source}.go`
 *   for the cloudflare-go client calls each declaration makes;
 * - cloudflare-go `api.md` files, which document the HTTP endpoint of every SDK method.
 *
 * Every input is plain text read from source checkouts: nothing is downloaded or executed.
 * Parsers are strict and report `file:line` on anything unexpected. The generated file is checked
 * against the same zod schema the docs build reads it with (`src/terraform.ts`).
 * No I/O happens here so the logic can be tested against small fixtures.
 */

import { z } from 'astro/zod';
import {
  generatedTerraformDocsSchema,
  terraformRoleSchema,
  type GeneratedTerraformDeclaration,
  type GeneratedTerraformDocs,
  type TerraformAttribute,
  type TerraformDeclarationKind,
  type TerraformRole,
} from '../src/terraform.ts';

/** Parses `value`, throwing a readable error with the paths of the first issues. */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown, label: string, maxIssues = 10): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const { issues } = result.error;
  const shown = z.prettifyError(new z.ZodError(issues.slice(0, maxIssues)));
  const more = issues.length > maxIssues ? `\n…and ${issues.length - maxIssues} more issue(s)` : '';
  throw new Error(`${label} is invalid:\n${shown}${more}`);
}

// ---------------------------------------------------------------------------
// cloudflare-go api.md
// ---------------------------------------------------------------------------

const API_MD_METHOD =
  /<code title="(get|post|put|patch|delete|head|options) ([^"]+)">client\.([\w.]+)\.<a href="[^"]*">(\w+)<\/a>\(/g;

/** Maps `Firewall.AccessRules.New` to `post /{accounts_or_zones}/{account_or_zone_id}/firewall/access_rules/rules`. */
export function parseSdkApiMarkdown(markdown: string, into = new Map<string, string>()): Map<string, string> {
  for (const match of markdown.matchAll(API_MD_METHOD)) {
    const [, method, endpointPath, service, name] = match;
    into.set(`${service}.${name}`, `${method} ${endpointPath}`);
  }
  return into;
}

// ---------------------------------------------------------------------------
// Provider Go sources
// ---------------------------------------------------------------------------

export const SERVICE_FILES: Readonly<Record<string, TerraformDeclarationKind>> = {
  'resource.go': 'resource',
  'data_source.go': 'data-source',
  'list_data_source.go': 'list-data-source',
};

export interface ServiceSource {
  kind: TerraformDeclarationKind;
  /** Full Terraform type name, e.g. `cloudflare_access_rule`. */
  name: string;
  /** cloudflare-go module imported as the client, e.g. `github.com/cloudflare/cloudflare-go/v7`. */
  sdkModule: string | undefined;
  calls: Array<{ call: string; role: TerraformRole }>;
}

const TYPE_NAME = /TypeName\s*=\s*req\.ProviderTypeName\s*\+\s*"(\w+)"/;
const SDK_IMPORT = /"(github\.com\/cloudflare\/cloudflare-go\/v\d+)"/;
const METHOD_DECL = /^func\s+\(\w+\s+\*?\w+\)\s+(\w+)\(/;
const CLIENT_CALL = /\b\w+\.client\.((?:[A-Z]\w*\.)+)([A-Z]\w*)\(/g;
const RESOURCE_ROLES: Readonly<Record<string, TerraformRole>> = {
  Create: 'create',
  Read: 'read',
  Update: 'update',
  Delete: 'delete',
  ImportState: 'import',
};

/** Extracts the Terraform type name and cloudflare-go calls from one generated service file. */
export function parseServiceSource(
  source: string,
  kind: TerraformDeclarationKind,
  providerTypeName = 'cloudflare',
): ServiceSource | undefined {
  const suffix = source.match(TYPE_NAME)?.[1];
  if (!suffix) return undefined;
  const calls: ServiceSource['calls'] = [];
  let role: TerraformRole = kind === 'resource' ? 'other' : 'read';
  for (const line of source.split('\n')) {
    const declared = line.match(METHOD_DECL)?.[1];
    if (declared && kind === 'resource') role = RESOURCE_ROLES[declared] ?? 'other';
    for (const match of line.matchAll(CLIENT_CALL)) {
      const service = match[1]!.slice(0, -1);
      const method = match[2]!.replace(/AutoPaging$/, '');
      calls.push({ call: `${service}.${method}`, role });
    }
  }
  return { kind, name: `${providerTypeName}${suffix}`, sdkModule: source.match(SDK_IMPORT)?.[1], calls };
}

// ---------------------------------------------------------------------------
// tfplugindocs Markdown (`docs/resources/*.md`, `docs/data-sources/*.md`)
// ---------------------------------------------------------------------------

type AttributeGroup = 'required' | 'optional' | 'computed';

export interface ParsedDeclarationDoc {
  /** Terraform type name from the `# name (Resource)` heading. */
  name: string;
  description: string | undefined;
  required: TerraformAttribute[];
  optional: TerraformAttribute[];
  computed: TerraformAttribute[];
}

const SCHEMA_MARKER = '<!-- schema generated by tfplugindocs -->';
const TITLE = /^# (\S+) \((Resource|Data Source)\)$/;
const ROOT_GROUP = /^### (Required|Optional|Read-Only)$/;
const NESTED_GROUP = /^(Required|Optional|Read-Only):$/;
const ANCHOR = /^<a id="(nested[\w-]+)"><\/a>$/;
const NESTED_TITLE = /^### Nested Schema for `([\w.]+)`$/;
const ITEM = /^- `(\w+)` \(/;
const NESTED_REFERENCE = /\s*\(see \[below for nested (?:schema|block)\]\(#(nested[\w-]+)\)\)$/;
const WRITE_ONLY_FLAG = /^\[Write-only\]\([^)\s]+\)$/;
const GROUP_NAMES: Readonly<Record<string, AttributeGroup>> = {
  Required: 'required',
  Optional: 'optional',
  'Read-Only': 'computed',
};

interface RawItem {
  line: number;
  group: AttributeGroup;
  name: string;
  spec: string;
  text: string[];
}

/** Returns the index just past the parenthesis that closes the one at `open`, or -1. */
function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return index + 1;
  }
  return -1;
}

/**
 * Parses one tfplugindocs page. The layout is generated by `tfplugindocs` (`schemamd`), so anything
 * that does not fit it fails with `file:line` instead of being silently skipped.
 */
export function parseDeclarationMarkdown(markdown: string, file: string): ParsedDeclarationDoc {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const fail = (index: number, message: string): never => {
    throw new Error(`${file}:${index + 1}: ${message}`);
  };

  let titleIndex = lines.findIndex((line) => TITLE.test(line));
  if (titleIndex < 0) fail(0, 'missing `# <name> (Resource|Data Source)` heading');
  const name = lines[titleIndex]!.match(TITLE)![1]!;
  const markerIndex = lines.indexOf(SCHEMA_MARKER);
  if (markerIndex < 0) fail(titleIndex, `missing \`${SCHEMA_MARKER}\``);

  const descriptionEnd = lines.findIndex((line, index) => index > titleIndex && line.startsWith('## '));
  const description = lines
    .slice(titleIndex + 1, descriptionEnd < 0 || descriptionEnd > markerIndex ? markerIndex : descriptionEnd)
    .join('\n')
    .trim();

  let index = markerIndex + 1;
  while (lines[index]?.trim() === '') index += 1;
  if (lines[index] !== '## Schema') fail(index, 'expected `## Schema` after the tfplugindocs marker');
  titleIndex = index;

  const root: RawItem[] = [];
  const sections = new Map<string, { line: number; items: RawItem[] }>();
  let items = root;
  let inRoot = true;
  let group: AttributeGroup | undefined;
  let item: RawItem | undefined;

  for (index = titleIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('## ')) break; // e.g. `## Import`
    const anchor = line.match(ANCHOR)?.[1];
    const rootGroup = line.match(ROOT_GROUP)?.[1];
    const nestedGroup = line.match(NESTED_GROUP)?.[1];
    const itemStart = line.match(ITEM);

    if (anchor) {
      let next = index + 1;
      while (lines[next]?.trim() === '') next += 1;
      if (!NESTED_TITLE.test(lines[next] ?? ''))
        fail(next, `expected \`### Nested Schema for\` after anchor ${anchor}`);
      if (sections.has(anchor)) fail(index, `duplicate anchor ${anchor}`);
      items = [];
      sections.set(anchor, { line: index, items });
      inRoot = false;
      group = undefined;
      item = undefined;
      index = next;
    } else if (rootGroup || nestedGroup) {
      if (rootGroup && !inRoot) fail(index, `\`### ${rootGroup}\` inside a nested schema`);
      if (nestedGroup && inRoot) fail(index, `\`${nestedGroup}:\` outside a nested schema`);
      group = GROUP_NAMES[(rootGroup ?? nestedGroup)!];
      item = undefined;
    } else if (itemStart) {
      if (!group) fail(index, 'attribute before any Required/Optional/Read-Only group');
      const open = itemStart[0].length - 1;
      const close = closingParenthesis(line, open);
      if (close < 0) fail(index, 'unbalanced parentheses in attribute type');
      item = {
        line: index,
        group: group!,
        name: itemStart[1]!,
        spec: line.slice(open + 1, close - 1),
        text: [line.slice(close).trim()],
      };
      items.push(item);
    } else if (item) {
      item.text.push(line); // multi-line description
    } else if (line.trim() !== '') {
      fail(index, `unexpected line in schema: ${JSON.stringify(line.slice(0, 80))}`);
    }
  }

  const used = new Set<string>();
  const convert = (raw: RawItem, ancestors: readonly string[]): TerraformAttribute => {
    const [type, ...flags] = raw.spec.split(', ');
    if (!type) fail(raw.line, `missing type for ${raw.name}`);
    for (const flag of flags) {
      if (flag !== 'Sensitive' && flag !== 'Deprecated' && !WRITE_ONLY_FLAG.test(flag)) {
        fail(raw.line, `unknown attribute flag ${JSON.stringify(flag)}`);
      }
    }
    let text = raw.text.join('\n').trim();
    const reference = text.match(NESTED_REFERENCE)?.[1];
    if (reference) text = text.slice(0, text.length - text.match(NESTED_REFERENCE)![0].length).trim();
    let children: TerraformAttribute[] = [];
    if (reference) {
      const section = sections.get(reference);
      if (!section) fail(raw.line, `${raw.name} references missing nested schema #${reference}`);
      if (ancestors.includes(reference)) fail(raw.line, `nested schema cycle at #${reference}`);
      used.add(reference);
      children = section!.items
        .map((child) => convert(child, [...ancestors, reference]))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    return {
      name: raw.name,
      type: type!,
      ...(text ? { description: text } : {}),
      ...(flags.includes('Deprecated') ? { deprecated: 'Deprecated.' } : {}),
      ...(flags.includes('Sensitive') ? { sensitive: true } : {}),
      ...(children.length > 0 ? { children } : {}),
    };
  };

  const groups: Record<AttributeGroup, TerraformAttribute[]> = { required: [], optional: [], computed: [] };
  for (const raw of root) groups[raw.group].push(convert(raw, []));
  for (const [anchor, section] of sections) {
    if (!used.has(anchor)) fail(section.line, `nested schema #${anchor} is not referenced by any attribute`);
  }
  for (const group of Object.values(groups)) group.sort((left, right) => left.name.localeCompare(right.name));
  return { name, description: description || undefined, ...groups };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function declarationKey(kind: TerraformDeclarationKind, name: string): string {
  return `${kind}:${name}`;
}

export interface BuildTerraformDocsInput {
  provider: GeneratedTerraformDocs['source']['provider'];
  sdks: GeneratedTerraformDocs['source']['sdks'];
  services: ServiceSource[];
  /** SDK module path -> (`Service.Method` -> endpoint). */
  sdkEndpoints: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Reads a file from the provider checkout (e.g. `docs/resources/x.md`), or undefined when missing. */
  readProviderFile: (relativePath: string) => string | undefined;
  providerTypeName?: string;
}

/** Provider-relative paths of a declaration's documentation and examples (tfplugindocs layout). */
export function declarationFiles(kind: TerraformDeclarationKind, name: string, providerTypeName = 'cloudflare') {
  const shortName = name.slice(providerTypeName.length + 1);
  return kind === 'resource'
    ? {
        doc: `docs/resources/${shortName}.md`,
        example: `examples/resources/${name}/resource.tf`,
        importExample: `examples/resources/${name}/import.sh`,
      }
    : { doc: `docs/data-sources/${shortName}.md`, example: `examples/data-sources/${name}/data-source.tf` };
}

export function buildTerraformDocs(input: BuildTerraformDocsInput): GeneratedTerraformDocs {
  const declarations: Record<string, GeneratedTerraformDeclaration> = {};
  const endpoints = new Map<string, Map<string, Set<TerraformRole>>>();
  const unresolvedCalls: GeneratedTerraformDocs['unresolvedCalls'] = [];
  const unlinked: string[] = [];
  const undocumented: string[] = [];
  const sorted = [...input.services].sort(
    (left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind),
  );

  for (const service of sorted) {
    const key = declarationKey(service.kind, service.name);
    if (declarations[key]) throw new Error(`Duplicate Terraform declaration ${key}`);
    const files = declarationFiles(service.kind, service.name, input.providerTypeName);
    const markdown = input.readProviderFile(files.doc);
    // tfplugindocs documents every registered declaration; service code without a page is not shipped.
    if (markdown === undefined) {
      undocumented.push(key);
      continue;
    }
    const doc = parseDeclarationMarkdown(markdown, files.doc);
    if (doc.name !== service.name) {
      throw new Error(`${files.doc}: documents ${doc.name}, expected ${service.name}`);
    }
    const example = input.readProviderFile(files.example)?.trimEnd();
    const importExample = files.importExample ? input.readProviderFile(files.importExample)?.trimEnd() : undefined;
    declarations[key] = {
      kind: service.kind,
      name: service.name,
      ...(doc.description ? { description: doc.description } : {}),
      ...(example ? { example } : {}),
      ...(importExample ? { importExample } : {}),
      required: doc.required,
      optional: doc.optional,
      computed: doc.computed,
    };

    const methods = service.sdkModule ? input.sdkEndpoints.get(service.sdkModule) : undefined;
    let linked = false;
    for (const { call, role } of service.calls) {
      const endpoint = methods?.get(call);
      if (!endpoint) {
        unresolvedCalls.push({ declaration: key, call: `${service.sdkModule ?? '<no sdk import>'} ${call}` });
        continue;
      }
      linked = true;
      const links = endpoints.get(endpoint) ?? new Map<string, Set<TerraformRole>>();
      links.set(key, (links.get(key) ?? new Set()).add(role));
      endpoints.set(endpoint, links);
    }
    if (!linked) unlinked.push(key);
  }

  const endpointRecord = Object.fromEntries(
    [...endpoints]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([endpoint, links]) => [
        endpoint,
        [...links]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([declaration, roles]) => ({
            declaration,
            roles: terraformRoleSchema.options.filter((role) => roles.has(role)),
          })),
      ]),
  );
  const declarationCount = Object.keys(declarations).length;
  // Validate against the contract the docs build reads, so a bad file never gets written.
  return parseWith(
    generatedTerraformDocsSchema,
    {
      format: 2,
      source: { provider: input.provider, sdks: input.sdks },
      stats: {
        declarations: declarationCount,
        linkedDeclarations: declarationCount - unlinked.length,
        endpoints: Object.keys(endpointRecord).length,
        unresolvedCalls: unresolvedCalls.length,
      },
      unlinked,
      undocumented,
      unresolvedCalls,
      declarations,
      endpoints: endpointRecord,
    },
    'Generated Terraform docs',
  );
}
