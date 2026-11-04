/**
 * Cloudflare-specific documentation policy for the Fern docs site.
 *
 * astro-fern is product-agnostic: it knows how to resolve, route and render an
 * OpenAPI spec, but ships no Cloudflare knowledge. Everything Cloudflare-shaped
 * — the acronym-aware label formatter, the API base URL / auth header, the
 * execution-target set, and the `result` response envelope
 * — lives here and is passed to the content recipe in `content.config.ts`.
 *
 * This module has no Astro/runtime dependencies, so its behaviour is unit-tested
 * with `node --experimental-strip-types --test` (see `cloudflare.test.ts`).
 */
import { cliCommandFor } from './cli-arguments.ts';
import {
  createSnippetProvider,
  type FernOperationRoutingPreferenceContext,
  type FernTargetConfig,
  interpolatePath,
  isJsonMediaType,
  placeholderValue,
  type SnippetInput,
  type SnippetOperation,
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

/**
 * Cloudflare's execution targets, in tab order. Target ids match renderer keys.
 * The first target is the default when no `?lang=` is selected.
 */
export const CLOUDFLARE_TARGETS: FernTargetConfig[] = [
  { id: 'cf', kind: 'cli', label: 'cf CLI', language: 'bash' },
  { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
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

// API version selection currently changes documentation only. The live API does
// not enforce it, so emitting api-version or hiding otherwise valid samples would
// imply unsupported behavior. Keep the user-facing notice in CodeSample.astro in
// sync until every renderer can apply SnippetInput.snapshotId faithfully.
// TODO(versioning): Apply SnippetInput.snapshotId once upstream enforcement exists.
/** Cloudflare's per-operation snippet provider for Fern content. */
export const cloudflareSnippets: SnippetProvider = createSnippetProvider(
  {
    cf: { label: 'cf CLI', syntax: 'bash', render: renderCf },
    curl: { label: 'curl', syntax: 'bash', render: renderCurl },
    terraform: { label: 'Terraform', syntax: 'hcl', render: comingSoon },
  },
  CLOUDFLARE_TARGETS.map((target) => target.id),
);

/** Convenience for tests: run the provider and index snippets by target id. */
export function cloudflareSnippetsByTarget(input: SnippetInput): Map<string, string | null> {
  return new Map(cloudflareSnippets(input).map((snippet) => [snippet.targetId, snippet.code]));
}

//#endregion
