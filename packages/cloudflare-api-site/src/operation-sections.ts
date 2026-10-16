/**
 * Single source of truth for an operation page's sections, so the static
 * render and the server-island render agree on which section is which.
 */
import {
  preferredResponse,
  preferredResponseRepresentation,
  preferredRequestRepresentation,
  responsePayloadSchema,
  type RenderedOperationResponseSchema,
  type RenderedOperationSchema,
  type RenderedRequestRepresentationSchema,
  type RenderedResponseRepresentationSchema,
  type RenderedSchemaNodeSchema,
} from 'astro-fern/content';

export type SectionId = 'path' | 'query' | 'body' | 'response';

export interface FieldSection {
  section: SectionId;
  slug: string;
  title: string;
  nodes: RenderedSchemaNodeSchema[];
}

export interface OperationView {
  fieldSections: FieldSection[];
  responseSlug: string;
  response: RenderedSchemaNodeSchema | null;
  responseIsArray: boolean;
  responseStatus: RenderedOperationResponseSchema | null;
  responseRepresentation: RenderedResponseRepresentationSchema | null;
  requestRepresentation: RenderedRequestRepresentationSchema | null;
}

/**
 * Top-level rows for a body/response root: an object's fields, a union's
 * variants, else the node itself. Unwrapping a union root avoids rendering a
 * nameless placeholder row (the "unknown" the union label would sit on) — the
 * variants are the meaningful content, and `responseSummary` supplies the
 * "one of N" framing above them.
 */
export function topLevelNodes(node: RenderedSchemaNodeSchema | null): RenderedSchemaNodeSchema[] {
  if (!node) return [];
  if (node.children && node.children.length > 0) return node.children;
  if (node.variants && node.variants.length > 0) return node.variants;
  return [node];
}

/**
 * Human lead-in shown under the "Returns" heading. Frames arrays and unions
 * ("Array of X", "Array — each item is one of N types:", "One of N types:") and
 * returns null for a plain object/scalar root, whose fields speak for themselves.
 */
export function responseSummary(node: RenderedSchemaNodeSchema | null, isArray: boolean): string | null {
  if (!node) return null;
  const variantCount = node.variants?.length ?? 0;
  const isUnion = variantCount > 0 && !(node.children && node.children.length > 0);
  if (isArray) {
    if (isUnion) return `Array — each item is one of ${variantCount} variants:`;
    const t = cleanTypeName(node.type);
    return t === 'unknown' ? 'Array' : `Array of ${t}`;
  }
  if (isUnion) return `One of ${variantCount} variants:`;
  return null;
}

/**
 * Type label shown on a field row. Unions — and arrays of unions — read as
 * "one of N variants" rather than the raw "one of N" / "one of N[]" the
 * resolver stores; the expansion below the row ("Show array — N variants")
 * already conveys array-ness. A residual untyped node returns null so the
 * badge is omitted entirely instead of printing "unknown".
 */
export function fieldTypeLabel(n: RenderedSchemaNodeSchema): string | null {
  const variants = n.variants ?? n.items?.variants;
  if (variants && variants.length > 0) return `one of ${variants.length} variants`;
  const t = cleanTypeName(n.type);
  return t === 'unknown' ? null : t;
}

// Memoize per operation object so deferred section helpers reuse the same walk.
const viewCache = new WeakMap<RenderedOperationSchema, OperationView>();

export function operationView(op: RenderedOperationSchema): OperationView {
  const cached = viewCache.get(op);
  if (cached) return cached;
  const fieldSections: FieldSection[] = [];
  if (op.pathParams.length > 0) {
    fieldSections.push({ section: 'path', slug: 'path-parameters', title: 'Path parameters', nodes: op.pathParams });
  }
  if (op.queryParams.length > 0) {
    fieldSections.push({
      section: 'query',
      slug: 'query-parameters',
      title: 'Query parameters',
      nodes: op.queryParams,
    });
  }
  const requestRepresentation = preferredRequestRepresentation(op.requestBody?.representations ?? []) ?? null;
  if (op.requestBody) {
    fieldSections.push({
      section: 'body',
      slug: 'body-parameters',
      title: 'Request body',
      nodes: topLevelNodes(requestRepresentation?.schema ?? null),
    });
  }

  const responseStatus = preferredResponse(op.responses) ?? null;
  const responseRepresentation = preferredResponseRepresentation(responseStatus?.representations ?? []) ?? null;
  const responsePayload = responseRepresentation
    ? responsePayloadSchema(responseRepresentation)
    : { schema: null, isArray: false };

  const view: OperationView = {
    fieldSections,
    responseSlug: 'returns',
    response: responsePayload.schema,
    responseIsArray: responsePayload.isArray,
    responseStatus,
    responseRepresentation,
    requestRepresentation,
  };
  viewCache.set(op, view);
  return view;
}

/**
 * Strip the internal api-prefix from a schema name for display,
 * e.g. "dns-records_dns-record-response" -> "dns-record-response". Primitive
 * types (no underscore) pass through unchanged.
 */
export function cleanTypeName(name: string | undefined): string {
  if (typeof name !== 'string' || name.length === 0) return 'unknown';
  const i = name.indexOf('_');
  return i > 0 ? name.slice(i + 1) : name;
}

//#region Server-island support

/** Sections with more than this many total schema nodes are deferred to a server island. */
export const DEFER_THRESHOLD = 150;

/**
 * Total node count across the given subtrees. Iterative (explicit stack) rather
 * than recursive: schema trees for large `oneOf` unions can nest deeply, so this
 * avoids any call-stack growth proportional to schema depth.
 */
export function nodeCount(nodes: RenderedSchemaNodeSchema[]): number {
  let count = 0;
  const stack: RenderedSchemaNodeSchema[] = [...nodes];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n) break;
    count++;
    if (n.children) for (const child of n.children) stack.push(child);
    if (n.items) stack.push(n.items);
    if (n.variants) for (const v of n.variants) stack.push(v);
  }
  return count;
}

/** The top-level nodes for a given section — shared by the static render and the island. */
export function sectionNodes(op: RenderedOperationSchema, section: SectionId): RenderedSchemaNodeSchema[] {
  switch (section) {
    case 'path':
      return op.pathParams;
    case 'query':
      return op.queryParams;
    case 'body':
      return topLevelNodes(operationView(op).requestRepresentation?.schema ?? null);
    case 'response':
      return topLevelNodes(operationView(op).response);
  }
}

//#endregion
