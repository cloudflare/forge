/**
 * Cloudflare-specific documentation policy for the Fern docs site.
 *
 * astro-fern is product-agnostic: it knows how to resolve, route and render an
 * OpenAPI spec, but ships no Cloudflare knowledge. Everything Cloudflare-shaped
 * — the acronym-aware label formatter, the API base URL / auth header, the SDK
 * package names, the execution-target set, and the `result` response envelope
 * — lives here and is passed to the content recipe in `content.config.ts`.
 *
 * This module has no Astro/runtime dependencies, so its behaviour is unit-tested
 * with `node --experimental-strip-types --test` (see `cloudflare.test.ts`).
 */
import {
  createSnippetProvider,
  type FernOperationRoutingPreferenceContext,
  type FernTargetConfig,
  interpolatePath,
  isJsonMediaType,
  placeholderValue,
  type SnippetInput,
  type SnippetOperation,
  type SnippetParam,
  type SnippetProvider,
  type SnippetRequestRepresentation,
  type SnippetRenderer,
  toEnvVar,
} from 'astro-fern';

//#region Label formatter (acronym-aware)

/** Cloudflare/API acronyms upper-cased in display labels (e.g. "dns" → "DNS"). */
const ACRONYMS = new Set([
  'dns',
  'dnssec',
  'ssl',
  'tls',
  'waf',
  'api',
  'url',
  'uri',
  'ip',
  'ipv4',
  'ipv6',
  'acl',
  'tsig',
  'axfr',
  'spf',
  'dmarc',
  'dkim',
  'ca',
  'soa',
  'mx',
  'ns',
  'txt',
  'srv',
  'caa',
  'ptr',
  'cname',
  'http',
  'https',
  'd1',
  'r2',
  'kv',
  'ai',
  'cli',
  'sdk',
  'ttl',
  'cidr',
  'asn',
  'json',
  'html',
  'css',
  'id',
]);

function humanizeWord(word: string): string {
  const lower = word.toLowerCase();
  if (ACRONYMS.has(lower)) return lower.toUpperCase();
  // Pluralized acronyms: acls -> ACLs, tsigs -> TSIGs.
  if (lower.endsWith('s') && ACRONYMS.has(lower.slice(0, -1))) return `${lower.slice(0, -1).toUpperCase()}s`;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Acronym-aware identifier → display-label formatter for Fern content. */
export function cloudflareFormatIdentifier(identifier: string): string {
  return identifier.split(/[-_]+/).filter(Boolean).map(humanizeWord).join(' ');
}

//#endregion

//#region Execution targets + snippet renderers

/** Cloudflare's execution targets, in tab order. Target ids match renderer keys. */
const TYPESCRIPT_PACKAGE_NAME = '@cloudflare/forge-sdk-ts';

export const CLOUDFLARE_TARGETS: FernTargetConfig[] = [
  { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
  { id: 'cf', kind: 'cli', label: 'cf CLI', language: 'bash' },
  {
    id: 'typescript',
    kind: 'sdk',
    label: 'TypeScript',
    language: 'typescript',
    packageName: TYPESCRIPT_PACKAGE_NAME,
  },
  { id: 'python', kind: 'sdk', label: 'Python', language: 'python' },
  { id: 'ruby', kind: 'sdk', label: 'Ruby', language: 'ruby' },
  { id: 'go', kind: 'sdk', label: 'Go', language: 'go' },
  { id: 'terraform', kind: 'tool', label: 'Terraform', language: 'hcl' },
];

/** Cloudflare's REST base URL and the response envelope key it wraps payloads in. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_RESPONSE_PAYLOAD_KEY = 'result';

/** Prefers account-scoped operations when approved SDK mappings share one documentation route. */
export function cloudflareOperationRoutingPreference({
  path,
  routingPriority,
}: Pick<FernOperationRoutingPreferenceContext, 'path' | 'routingPriority'>): number {
  // TODO: Remove this temporary account preference once the upstream API SDK addresses distinguish account and zone operations.
  return routingPriority >= 0 && /^\/accounts(?:\/|$)/.test(path) ? 1 : 0;
}

const toSnake = (value: string): string => value.replace(/-/g, '_');

function toLowerCamel(value: string): string {
  const [first = '', ...rest] = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return `${first.charAt(0).toLowerCase()}${first.slice(1)}${rest
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('')}`;
}

function pyLiteral(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)}: ${pyLiteral(entry)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(String(value));
}

function rbLiteral(value: unknown): string {
  if (value === null) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(rbLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, entry]) => `${JSON.stringify(key)} => ${rbLiteral(entry)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(String(value));
}

function isMultipartMediaType(mediaType: string): boolean {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase().startsWith('multipart/') === true;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function httpRequestRepresentation(op: SnippetOperation): SnippetRequestRepresentation | undefined {
  const representations = op.requestBody?.representations ?? [];
  return (
    representations.find(
      (representation) => isJsonMediaType(representation.mediaType) && representation.schema !== undefined,
    ) ??
    representations.find((representation) => isJsonMediaType(representation.mediaType)) ??
    representations.find((representation) => !isMultipartMediaType(representation.mediaType)) ??
    representations[0]
  );
}

interface SdkBodyField {
  name: string;
  value: unknown;
}

function sdkPlaceholderValue(param: SnippetParam): unknown {
  const variant = param.variants?.[0];
  if (variant) return sdkPlaceholderValue(variant);
  if (param.children) {
    return Object.fromEntries(
      param.children
        .filter((child) => child.required)
        .map((child) => [child.sdkName ?? child.name, sdkPlaceholderValue(child)]),
    );
  }
  if (param.items) return [sdkPlaceholderValue(param.items)];
  return placeholderValue(param);
}

/** `undefined` means no body; `null` means the SDK sample cannot express it. */
function sdkBodyFields(op: SnippetOperation): SdkBodyField[] | null | undefined {
  if (!op.requestBody) return undefined;
  const representations = op.requestBody.representations.filter((representation) =>
    isJsonMediaType(representation.mediaType),
  );
  const representation = representations.find((candidate) => candidate.schema);
  if (!representation?.schema) return null;
  if (!representation.schema.children) return null;
  return representation.schema.children
    .filter((param) => param.required)
    .map((param) => ({ name: param.sdkName ?? param.name, value: sdkPlaceholderValue(param) }));
}

const renderCurl: SnippetRenderer = ({ op }) => {
  const url = `${CLOUDFLARE_API_BASE}${interpolatePath(op.path)}`;
  const verb = op.method.toUpperCase();
  const head = verb === 'GET' ? `curl ${url}` : `curl -X ${verb} ${url}`;
  const args = [head, '-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"'];
  for (const param of op.queryParams) {
    if (param.required) args.push(`--url-query "${param.name}=$${toEnvVar(param.name)}"`);
  }
  if (op.requestBody) {
    const representation = httpRequestRepresentation(op);
    if (!representation || isMultipartMediaType(representation.mediaType)) return null;
    args.push(`-H ${shellSingleQuote(`Content-Type: ${representation.mediaType}`)}`);
    if (isJsonMediaType(representation.mediaType)) {
      if (representation.schema) {
        args.push(`-d ${shellSingleQuote(JSON.stringify(placeholderValue(representation.schema)))}`);
      } else args.push('--data-binary @request-body.json');
    } else {
      args.push('--data-binary @request-body');
    }
  }
  return args.join(' \\\n    ');
};

const renderCf: SnippetRenderer = ({ accessorPath, methodName, op }) => {
  if (op.requestBody || op.queryParams.some((param) => param.required)) return null;
  const positionals = op.pathParams.map((param) => `<${param.name}>`).join(' ');
  return ['cf', ...accessorPath, methodName, positionals].filter(Boolean).join(' ');
};

const renderTypeScript: SnippetRenderer = ({ op, accessorPath, methodName }) => {
  const bodyFields = sdkBodyFields(op);
  if (bodyFields === null) return null;
  const accessor = ['client', ...accessorPath.map(toLowerCamel), toLowerCamel(methodName)].join('.');
  const argFields: string[] = [];
  for (const param of op.pathParams) argFields.push(`  ${param.name}: ${JSON.stringify(`<${param.name}>`)},`);
  for (const param of op.queryParams) {
    if (!param.required) continue;
    if (argFields.some((field) => field.trimStart().startsWith(`${param.name}:`))) continue;
    argFields.push(`  ${param.name}: ${JSON.stringify(placeholderValue(param))},`);
  }
  for (const { name, value } of bodyFields ?? []) {
    if (argFields.some((field) => field.trimStart().startsWith(`${name}:`))) continue;
    argFields.push(`  ${name}: ${JSON.stringify(value)},`);
  }
  const args = argFields.length > 0 ? `{\n${argFields.join('\n')}\n}` : '';
  return [
    `import { CloudflareApiClient } from "${TYPESCRIPT_PACKAGE_NAME}";`,
    '',
    'const client = new CloudflareApiClient();',
    '',
    `const result = await ${accessor}(${args});`,
  ].join('\n');
};

// The Python SDK's resource/method names come from the same x-fern-sdk-* metadata
// Fern uses to generate it, so a snake_cased accessor + keyword args is faithful.
const renderPython: SnippetRenderer = ({ op, accessorPath, methodName }) => {
  const bodyFields = sdkBodyFields(op);
  if (bodyFields === null) return null;
  const accessor = ['client', ...accessorPath.map(toSnake), toSnake(methodName)].join('.');
  const args: string[] = [];
  for (const param of op.pathParams) args.push(`    ${toSnake(param.name)}=${JSON.stringify(`<${param.name}>`)},`);
  for (const param of op.queryParams) {
    if (!param.required) continue;
    const name = toSnake(param.name);
    if (args.some((arg) => arg.trimStart().startsWith(`${name}=`))) continue;
    args.push(`    ${name}=${pyLiteral(placeholderValue(param))},`);
  }
  for (const { name, value } of bodyFields ?? []) {
    const top = toSnake(name);
    if (args.some((arg) => arg.trimStart().startsWith(`${top}=`))) continue;
    args.push(`    ${top}=${pyLiteral(value)},`);
  }
  const body = args.length > 0 ? `\n${args.join('\n')}\n` : '';
  return [
    'import os',
    'from cloudflare import Cloudflare',
    '',
    'client = Cloudflare(api_token=os.environ.get("CLOUDFLARE_API_TOKEN"))',
    '',
    `result = ${accessor}(${body})`,
  ].join('\n');
};

// Same faithful pattern as Python: snake_cased accessor + keyword (hash) args.
const renderRuby: SnippetRenderer = ({ op, accessorPath, methodName }) => {
  const bodyFields = sdkBodyFields(op);
  if (bodyFields === null) return null;
  const accessor = ['client', ...accessorPath.map(toSnake), toSnake(methodName)].join('.');
  const args: string[] = [];
  for (const param of op.pathParams) args.push(`  ${toSnake(param.name)}: ${JSON.stringify(`<${param.name}>`)},`);
  for (const param of op.queryParams) {
    if (!param.required) continue;
    const name = toSnake(param.name);
    if (args.some((arg) => arg.trimStart().startsWith(`${name}:`))) continue;
    args.push(`  ${name}: ${rbLiteral(placeholderValue(param))},`);
  }
  for (const { name, value } of bodyFields ?? []) {
    const top = toSnake(name);
    if (args.some((arg) => arg.trimStart().startsWith(`${top}:`))) continue;
    args.push(`  ${top}: ${rbLiteral(value)},`);
  }
  const body = args.length > 0 ? `\n${args.join('\n')}\n` : '';
  return [
    'require "cloudflare"',
    '',
    'client = Cloudflare::Client.new(api_token: ENV["CLOUDFLARE_API_TOKEN"])',
    '',
    `result = ${accessor}(${body})`,
  ].join('\n');
};

// Coming-soon surfaces: their SDKs use params structs / builders (Go) or a
// declarative resource model (Terraform) that can't be faithfully derived
// without the generated SDK. `null` renders a placeholder tab; swap in
// Fern-generated snippets here once available.
const comingSoon: SnippetRenderer = () => null;

// API version selection currently changes documentation only. The live API does
// not enforce it, so emitting api-version or hiding otherwise valid samples would
// imply unsupported behavior. Keep the user-facing notice in CodeSample.astro in
// sync until every renderer can apply SnippetInput.snapshotId faithfully.
// TODO(versioning): Apply SnippetInput.snapshotId once upstream enforcement exists.
/** Cloudflare's per-operation snippet provider for Fern content. */
export const cloudflareSnippets: SnippetProvider = createSnippetProvider(
  {
    curl: { label: 'curl', syntax: 'bash', render: renderCurl },
    cf: { label: 'cf CLI', syntax: 'bash', render: renderCf },
    typescript: { label: 'TypeScript', syntax: 'ts', render: renderTypeScript },
    python: { label: 'Python', syntax: 'python', render: renderPython },
    ruby: { label: 'Ruby', syntax: 'ruby', render: renderRuby },
    go: { label: 'Go', syntax: 'go', render: comingSoon },
    terraform: { label: 'Terraform', syntax: 'hcl', render: comingSoon },
  },
  CLOUDFLARE_TARGETS.map((target) => target.id),
);

/** Convenience for tests: run the provider and index snippets by target id. */
export function cloudflareSnippetsByTarget(input: SnippetInput): Map<string, string | null> {
  return new Map(cloudflareSnippets(input).map((snippet) => [snippet.targetId, snippet.code]));
}

//#endregion
