/**
 * Holds the site's Cloudflare-specific documentation policy: the
 * acronym-aware label formatter, the API base URL and auth header, the
 * execution targets, and the `result` response envelope. `forge-api.ts`
 * applies it to what Forge reads from the spec.
 *
 * This module has no Astro or runtime dependencies, so its behaviour is
 * unit-tested with `node --experimental-strip-types --test` (see
 * `cloudflare.test.ts`).
 */
import { cliCommandFor } from './cli-arguments.ts';
import {
  createSnippetProvider,
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
} from './snippets.ts';

/** Describes one execution target: a tab of code samples. */
export interface TargetConfig {
  id: string;
  kind: 'http' | 'cli' | 'sdk' | 'tool';
  label: string;
  language: string;
}

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

/** Returns `identifier` as a display label, upper-casing Cloudflare's acronyms, such as `DNS Records` for `dns-records`. */
export function cloudflareFormatIdentifier(identifier: string): string {
  return identifier.split(/[-_]+/).filter(Boolean).map(humanizeWord).join(' ');
}

//#endregion

//#region Execution targets + snippet renderers

/**
 * Cloudflare's execution targets, in tab order. Target ids match renderer keys.
 * The first target is the default when no `?lang=` is selected.
 */
export const CLOUDFLARE_TARGETS: TargetConfig[] = [
  { id: 'cf', kind: 'cli', label: 'cf CLI', language: 'bash' },
  { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
  { id: 'typescript', kind: 'sdk', label: 'TypeScript', language: 'typescript' },
  { id: 'python', kind: 'sdk', label: 'Python', language: 'python' },
  { id: 'go', kind: 'sdk', label: 'Go', language: 'go' },
  { id: 'terraform', kind: 'tool', label: 'Terraform', language: 'hcl' },
];

/** Cloudflare's REST base URL and the response envelope key it wraps payloads in. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_RESPONSE_PAYLOAD_KEY = 'result';

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

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/**
 * The JSON a sample sends: the body's required fields, or, when the spec marks
 * none (as for many create and update bodies), the first option's top-level
 * fields, so the sample shows the body's shape instead of `{}`.
 */
function sampleBody(schema: SnippetParam): unknown {
  const required = placeholderValue(schema);
  if (!isEmptyObject(required)) return required;
  let shape = schema;
  while (!shape.children?.length && shape.variants?.[0]) shape = shape.variants[0];
  const fields = (shape.children ?? []).filter((field) => (field.apiFieldPath?.length ?? 1) <= 1);
  if (fields.length === 0) return required;
  return Object.fromEntries(fields.map((field) => [field.name, placeholderValue(field)]));
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
        args.push(`-d ${shellSingleQuote(JSON.stringify(sampleBody(representation.schema)))}`);
      } else args.push('--data-binary @request-body.json');
    } else {
      args.push('--data-binary @request-body');
    }
  }
  return args.join(' \\\n    ');
};

// The sample is the cf command that sends the operation, with the positionals
// and options it requires, as the cf CLI's own metadata lists them.
const renderCf: SnippetRenderer = ({ accessorPath, methodName, op }) => {
  const command = cliCommandFor(op.method, op.path, [...accessorPath, methodName]);
  if (!command) return null;
  const head = [command.command];
  for (const positional of [...(command.arguments ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (positional.required) head.push(`<${positional.name}>`);
  }
  const lines = [head.join(' ')];
  for (const option of command.options ?? []) {
    if (option.required)
      lines.push(option.type === 'boolean' ? `--${option.name}` : `--${option.name} <${option.name}>`);
  }
  return lines.join(' \\\n    ');
};

// Terraform's declarative resource model can't be derived from a single
// operation. `null` renders a placeholder; CodeSample.astro renders the
// Terraform declarations from the generated provider docs instead.
const comingSoon: SnippetRenderer = () => null;

// The SDK samples are the retired Stainless site's, which `prepareForgeApi`
// (src/forge-api.ts) fills in from `stainless-snippets.json`.
const fromStainless: SnippetRenderer = () => null;

// API version selection currently changes documentation only. The live API does
// not enforce it, so emitting api-version or hiding otherwise valid samples would
// imply unsupported behavior. Keep the user-facing notice in CodeSample.astro in
// sync until every renderer can apply SnippetInput.snapshotId faithfully.
// TODO(versioning): Apply SnippetInput.snapshotId once upstream enforcement exists.
/** Renders Cloudflare's code samples for one operation: cf, curl and Terraform. */
export const cloudflareSnippets: SnippetProvider = createSnippetProvider(
  {
    cf: { label: 'cf CLI', syntax: 'bash', render: renderCf },
    curl: { label: 'curl', syntax: 'bash', render: renderCurl },
    typescript: { label: 'TypeScript', syntax: 'typescript', render: fromStainless },
    python: { label: 'Python', syntax: 'python', render: fromStainless },
    go: { label: 'Go', syntax: 'go', render: fromStainless },
    terraform: { label: 'Terraform', syntax: 'hcl', render: comingSoon },
  },
  CLOUDFLARE_TARGETS.map((target) => target.id),
);

/** Convenience for tests: run the provider and index snippets by target id. */
export function cloudflareSnippetsByTarget(input: SnippetInput): Map<string, string | null> {
  return new Map(cloudflareSnippets(input).map((snippet) => [snippet.targetId, snippet.code]));
}

//#endregion
