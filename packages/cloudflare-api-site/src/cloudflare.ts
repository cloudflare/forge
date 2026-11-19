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
import type { Content, Field, Method, Type } from '@cloudflare/forge';

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

//#region Execution targets and samples

/**
 * Cloudflare's execution targets, in tab order. Target ids match renderer keys.
 * The first target is the default when no `?lang=` is selected.
 */
export const CLOUDFLARE_TARGETS: TargetConfig[] = [
  { id: 'cf', kind: 'cli', label: 'cf CLI', language: 'bash' },
  { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
  { id: 'terraform', kind: 'tool', label: 'Terraform', language: 'hcl' },
];

/** Cloudflare's REST base URL and the response envelope key it wraps payloads in. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_RESPONSE_PAYLOAD_KEY = 'result';

function isMultipartMediaType(mediaType: string): boolean {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase().startsWith('multipart/') === true;
}

function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return essence === 'application/json' || essence?.endsWith('+json') === true;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Returns a parameter's name as an environment variable, such as `ZONE_ID` for `zone_id`. */
function toEnvVar(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

/** Reports whether `type` is a schema at all: Forge reads a media type without one as `unknown`. */
function hasSchema(type: Type): boolean {
  return !(type.kind === 'scalar' && type.scalar === 'unknown');
}

/** Returns the media type a curl sample sends: JSON with a schema, else JSON, else anything but multipart. */
function curlContent(contents: readonly Content[]): Content | undefined {
  return (
    contents.find((content) => isJsonMediaType(content.mediaType) && hasSchema(content.type)) ??
    contents.find((content) => isJsonMediaType(content.mediaType)) ??
    contents.find((content) => !isMultipartMediaType(content.mediaType)) ??
    contents[0]
  );
}

/** Returns the fields of `type`: an object's, a model's, or every member's of an intersection. */
function fieldsOf(type: Type, models: ReadonlySet<unknown> = new Set()): readonly Field[] {
  switch (type.kind) {
    case 'object':
      return type.fields;
    case 'intersection':
      return type.members.flatMap((member) => fieldsOf(member, models));
    case 'model':
      return models.has(type.model) ? [] : fieldsOf(type.model.type, new Set([...models, type.model]));
    default:
      return [];
  }
}

/**
 * Returns a representative value of `type`, called `name`, for a request
 * sample: the first value of an enum, else `fallback` (the field's default),
 * else the first member of a union, else an object of the required fields,
 * an array of one element, or a placeholder for a scalar.
 */
function placeholder(type: Type, name: string, fallback: unknown, models: ReadonlySet<unknown>): unknown {
  if (type.kind === 'enum') return type.values[0];
  if (typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean') return fallback;
  switch (type.kind) {
    case 'union': {
      const member = type.members.find((m) => !(m.kind === 'scalar' && m.scalar === 'null')) ?? type.members[0];
      return member ? placeholder(member, name, undefined, models) : `<${name || 'value'}>`;
    }
    case 'model':
      if (models.has(type.model)) return {};
      return placeholder(type.model.type, name, undefined, new Set([...models, type.model]));
    case 'object':
    case 'intersection':
      return Object.fromEntries(
        fieldsOf(type, models)
          .filter((field) => field.required)
          .map((field) => [field.wireName, placeholder(field.type, field.wireName, field.default, models)]),
      );
    case 'array':
      return [placeholder(type.elem, '', undefined, models)];
    case 'scalar':
      if (type.scalar === 'number') return 0;
      if (type.scalar === 'boolean') return true;
      return `<${name || 'value'}>`;
  }
}

/**
 * Returns the JSON a sample sends: the body's required fields, or, when the
 * spec marks none (as for many create and update bodies), the first option's
 * top-level fields, so the sample shows the body's shape instead of `{}`.
 */
function sampleBody(type: Type): unknown {
  const required = placeholder(type, '', undefined, new Set());
  const isEmpty =
    typeof required === 'object' && required !== null && !Array.isArray(required) && Object.keys(required).length === 0;
  if (!isEmpty) return required;
  let shape = type;
  while (fieldsOf(shape).length === 0) {
    const resolved = shape.kind === 'model' ? shape.model.type : shape;
    const first = resolved.kind === 'union' ? resolved.members[0] : undefined;
    if (!first || first === shape) break;
    shape = first;
  }
  const fields = fieldsOf(shape);
  if (fields.length === 0) return required;
  return Object.fromEntries(
    fields.map((field) => [field.wireName, placeholder(field.type, field.wireName, field.default, new Set())]),
  );
}

/** Returns the parameters of `method` sent in the query, as Forge locates them. */
function queryFields(method: Method): readonly Field[] {
  const request = method.request;
  const params = request?.kind === 'intersection' ? request.members[0] : request;
  const fields = params?.kind === 'object' ? params.fields : [];
  return fields.filter((field) => method.location(field)?.in === 'query');
}

/** Returns the curl command that sends `method`, or `null` when it sends a multipart body. */
function renderCurl(method: Method): string | null {
  const url = `${CLOUDFLARE_API_BASE}${method.path.replace(/\{([^}]+)\}/g, (_m, p: string) => `$${toEnvVar(p)}`)}`;
  const verb = method.httpMethod.toUpperCase();
  const head = verb === 'GET' ? `curl ${url}` : `curl -X ${verb} ${url}`;
  const args = [head, '-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"'];
  for (const field of queryFields(method)) {
    if (field.required) args.push(`--url-query "${field.wireName}=$${toEnvVar(field.wireName)}"`);
  }
  if (method.body) {
    const content = curlContent(method.body.contents);
    if (!content || isMultipartMediaType(content.mediaType)) return null;
    args.push(`-H ${shellSingleQuote(`Content-Type: ${content.mediaType}`)}`);
    if (isJsonMediaType(content.mediaType)) {
      if (hasSchema(content.type)) {
        args.push(`-d ${shellSingleQuote(JSON.stringify(sampleBody(content.type)))}`);
      } else args.push('--data-binary @request-body.json');
    } else {
      args.push('--data-binary @request-body');
    }
  }
  return args.join(' \\\n    ');
}

/**
 * Returns the cf command that sends `method`, with the positionals and
 * options it requires, as the cf CLI's own metadata lists them, or `null`
 * when cf generates no command for it. `address` is the method's group path
 * and name.
 */
function renderCf(method: Method, address: readonly string[]): string | null {
  const command = cliCommandFor(method.httpMethod, method.path, address);
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
}

/**
 * Returns each execution target's sample for `method`, in tab order, or
 * `null` for a target that can't express it. `address` is the method's
 * group path and name. Terraform has no sample of its own: `forge-api.ts`
 * writes it from the provider's declarations.
 *
 * API version selection changes documentation only, because the live API
 * doesn't enforce it, so samples send no `api-version`.
 */
export function cloudflareSamples(
  method: Method,
  address: readonly string[],
): { targetId: string; code: string | null }[] {
  const render: Record<string, () => string | null> = {
    cf: () => renderCf(method, address),
    curl: () => renderCurl(method),
    terraform: () => null,
  };
  return CLOUDFLARE_TARGETS.map((target) => {
    let code: string | null = null;
    try {
      code = render[target.id]?.() ?? null;
    } catch {
      // A sample that can't be rendered shows as unavailable, not as a failed build.
    }
    return { targetId: target.id, code };
  });
}

//#endregion
