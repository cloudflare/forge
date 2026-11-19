/**
 * Renders an operation's code samples, one per execution target. A renderer
 * reads a {@link SnippetOperation}: the operation's path, HTTP method,
 * parameters and request body, which `forge-content.ts` builds from Forge.
 *
 * This module has no Astro or Forge dependencies, so renderers are tested
 * with plain operations (see `cloudflare.test.ts`).
 */

/** Describes one parameter, or one node of a request body's schema. */
export interface SnippetParam {
  /** The name as it is sent. Empty for a body's root. */
  name: string;
  required: boolean;
  /** `string`, `integer`, `number`, `boolean`, `object`, `array`, `null` or `unknown`. */
  type: string;
  enumValues?: Array<string | number | boolean>;
  default?: string | number | boolean;
  /** The fields of an object. */
  children?: SnippetParam[];
  /** The elements of an array. */
  items?: SnippetParam;
  /** The members of a union, in order. */
  variants?: SnippetParam[];
  /** For a field of a body's root, the path that nests its value: `[name]`. */
  apiFieldPath?: string[];
}

/** Describes a request body in one media type. */
export interface SnippetRequestRepresentation {
  /** The media type, as the document writes it. */
  mediaType: string;
  /** The body's schema, or none when the media type has no schema. */
  schema?: SnippetParam;
}

/** Describes an operation's request body. */
export interface SnippetRequestBody {
  /** Whether callers must send a body. */
  required: boolean;
  /** Each media type the body can be sent as. */
  representations: SnippetRequestRepresentation[];
}

/** Describes the operation a sample sends. */
export interface SnippetOperation {
  /** The path template, such as `/zones/{zone_id}/dns_records`. */
  path: string;
  /** The HTTP method, in lower case. */
  method: string;
  pathParams: SnippetParam[];
  queryParams: SnippetParam[];
  requestBody?: SnippetRequestBody;
}

/** Holds what a renderer gets for one operation. */
export interface SnippetInput {
  op: SnippetOperation;
  /** The operation's group path, product first, such as `['dns', 'records']`. */
  accessorPath: string[];
  /** The method's name, such as `list`. */
  methodName: string;
  /** The API version being rendered, when there is one. */
  snapshotId?: string;
}

/** Holds one target's rendered sample, or `null` when the target can't express the operation. */
export interface Snippet {
  targetId: string;
  label: string;
  syntax: string;
  code: string | null;
}

/** Renders one target's sample, or returns `null` when it can't express the operation. */
export type SnippetRenderer = (input: SnippetInput) => string | null;

/** Pairs a renderer with the label and syntax of its tab. */
export interface SnippetRendererConfig {
  label: string;
  syntax: string;
  render: SnippetRenderer;
}

/** Renders every target's sample for one operation, in a stable order. */
export type SnippetProvider = (input: SnippetInput) => Snippet[];

/**
 * Returns a provider that runs `renderers` in the order `order` gives, or
 * the map's order. A renderer that throws gives `null`, never a build
 * failure.
 */
export function createSnippetProvider(
  renderers: Record<string, SnippetRendererConfig>,
  order?: string[],
): SnippetProvider {
  const ids = order ?? Object.keys(renderers);
  return (input) =>
    ids.map((targetId) => {
      const renderer = renderers[targetId];
      if (!renderer) return { targetId, label: targetId, syntax: 'text', code: null };
      let code: string | null = null;
      try {
        code = renderer.render(input);
      } catch {
        code = null;
      }
      return { targetId, label: renderer.label, syntax: renderer.syntax, code };
    });
}

/** Returns a parameter's name as an environment variable, such as `ZONE_ID` for `zone_id`. */
export function toEnvVar(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

/**
 * Returns `path` with each `{param}` replaced, by default with a `$PARAM`
 * environment variable.
 */
export function interpolatePath(path: string, replacer: (name: string) => string = (n) => `$${toEnvVar(n)}`): string {
  return path.replace(/\{([^}]+)\}/g, (_m, p: string) => replacer(p));
}

/** Returns a representative value for a parameter or schema node, for request samples. */
export function placeholderValue(p: SnippetParam): unknown {
  if (p.enumValues && p.enumValues.length > 0) return p.enumValues[0];
  if (p.default !== undefined) return p.default;
  const variant = p.variants?.[0];
  if (variant) return placeholderValue(variant);
  if (p.children) return buildBodyExample(p.children);
  if (p.items) return [placeholderValue(p.items)];
  if (p.type === 'object') return {};
  if (p.type === 'array' || p.type.endsWith('[]')) return [];
  if (p.type === 'number' || p.type === 'integer') return 0;
  if (p.type === 'boolean') return true;
  return `<${p.name || 'value'}>`;
}

/** Returns an object with a value for each required field, nested along each field's `apiFieldPath`. */
export function buildBodyExample(fields: SnippetParam[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const p of fields) {
    if (!p.required) continue;
    const segs = p.apiFieldPath && p.apiFieldPath.length > 0 ? p.apiFieldPath : [p.name];
    let cursor = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const existing = cursor[seg];
      if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>;
      } else {
        const nested: Record<string, unknown> = {};
        cursor[seg] = nested;
        cursor = nested;
      }
    }
    const leaf = segs[segs.length - 1];
    if (leaf) cursor[leaf] = placeholderValue(p);
  }
  return root;
}

/** Reports whether `mediaType` is `application/json` or ends in `+json`. */
export function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return essence === 'application/json' || essence?.endsWith('+json') === true;
}
