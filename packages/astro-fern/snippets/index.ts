/**
 * Generic, product-agnostic code-sample rendering for astro-fern.
 *
 * This package knows how to *drive* a set of snippet renderers over a resolved
 * operation; it deliberately ships **no** concrete renderers. A consumer builds
 * a {@link SnippetProvider} with {@link createSnippetProvider}, passing renderers
 * for its execution targets (curl, an SDK, a CLI, …), and hands it to
 * `defineFernProject`. Anything Cloudflare-specific (the API base URL, auth
 * header, SDK package names) lives in those consumer-supplied renderers.
 *
 * The reusable path helpers below (`interpolatePath`, `placeholderValue`,
 * `buildBodyExample`, `toEnvVar`) are the generic plumbing most HTTP/SDK
 * renderers need, exported so consumers don't re-implement them.
 */

import { unknownRecordSchema } from '../content/schema.ts';

/** A single parameter a renderer needs (subset of the resolved operation). */
export interface SnippetParam {
  /** OpenAPI wire name used by HTTP renderers. */
  name: string;
  /** Generated SDK identifier supplied by a Fern naming extension. */
  sdkName?: string;
  required: boolean;
  type: string;
  enumValues?: Array<string | number | boolean>;
  default?: string | number | boolean;
  /** Object properties, array items, and union alternatives retain their schema shape. */
  children?: SnippetParam[];
  items?: SnippetParam;
  variants?: SnippetParam[];
  /** For body params: the API field path used to nest the value. */
  apiFieldPath?: string[];
}

/** One request-body media type and the schema a snippet renderer should serialize. */
export interface SnippetRequestRepresentation {
  /** Trimmed OpenAPI media-type key; casing and parameters are preserved. */
  mediaType: string;
  /** Resolved request schema; absent when the representation has no schema. */
  schema?: SnippetParam;
}

/** Request-body metadata exposed to execution-target snippet renderers. */
export interface SnippetRequestBody {
  /** Whether callers must supply a body. */
  required: boolean;
  /** Available media types in OpenAPI declaration order. */
  representations: SnippetRequestRepresentation[];
}

/** Route-neutral HTTP operation input supplied to snippet renderers. */
export interface SnippetOperation {
  /** Path template, e.g. "/zones/{zone_id}/dns_records". */
  path: string;
  /** Lower-case HTTP verb. */
  method: string;
  pathParams: SnippetParam[];
  queryParams: SnippetParam[];
  /** Request requiredness and every media-type representation. */
  requestBody?: SnippetRequestBody;
}

/** One rendered execution-target code sample and its presentation metadata. */
export interface Snippet {
  /** The execution-target id this snippet renders, e.g. "curl", "typescript". */
  targetId: string;
  /** Human label for the tab, e.g. "TypeScript". */
  label: string;
  /** Expressive Code language id for syntax highlighting. */
  syntax: string;
  /** Rendered code, or null when this target can't (yet) express the operation. */
  code: string | null;
  /** Documentation snapshot this snippet represents. Absent outside project snapshot generation. */
  snapshotId?: string;
}

/** Complete resolved operation context passed to a {@link SnippetRenderer}. */
export interface SnippetInput {
  op: SnippetOperation;
  /** Accessor path including the product, e.g. ['dns','records']. */
  accessorPath: string[];
  /** SDK/CLI method name, e.g. 'list'. */
  methodName: string;
  /** Documentation snapshot being rendered. Absent outside project snapshot generation. */
  snapshotId?: string;
}

/** Renders one target's code for an operation, or null when it can't express it. */
export type SnippetRenderer = (input: SnippetInput) => string | null;

/** A renderer plus the tab metadata used to present its output. */
export interface SnippetRendererConfig {
  /** Human label for the tab, e.g. "TypeScript". */
  label: string;
  /** Expressive Code language id for syntax highlighting. */
  syntax: string;
  render: SnippetRenderer;
}

/** Renders the full set of snippets for one operation, in a stable target order. */
export type SnippetProvider = (input: SnippetInput) => Snippet[];

/**
 * Build a {@link SnippetProvider} from a map of target-id → renderer. `order`
 * fixes the tab order (defaults to the map's insertion order). A renderer that
 * throws or returns null yields a snippet with `code: null` (a "coming soon"
 * tab), never a build failure.
 */
export function createSnippetProvider(
  renderers: Record<string, SnippetRendererConfig>,
  order?: string[],
): SnippetProvider {
  const ids = order ?? Object.keys(renderers);
  return (input: SnippetInput): Snippet[] =>
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

//#region Reusable renderer helpers

/** Turn a param name into an ENV-style token, e.g. "zone_id" → "ZONE_ID". */
export function toEnvVar(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
}

/**
 * Replace `{param}` slots in a path template. By default each slot becomes a
 * `$ENV_VAR` reference; pass `replacer` to customise (e.g. SDK placeholders).
 */
export function interpolatePath(path: string, replacer: (name: string) => string = (n) => `$${toEnvVar(n)}`): string {
  return path.replace(/\{([^}]+)\}/g, (_m, p: string) => replacer(p));
}

/** A representative placeholder value for a parameter, for request samples. */
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

/** Reconstruct a recursive body example from required fields via `apiFieldPath`. */
export function buildBodyExample(bodyParams: SnippetParam[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const p of bodyParams) {
    if (!p.required) continue;
    const segs = p.apiFieldPath && p.apiFieldPath.length > 0 ? p.apiFieldPath : [p.name];
    let cursor = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const existing = cursor[seg];
      const parsed = unknownRecordSchema.safeParse(existing);
      if (parsed.success) {
        cursor[seg] = parsed.data;
        cursor = parsed.data;
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

//#endregion
