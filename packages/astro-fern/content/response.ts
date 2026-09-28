import { isJsonMediaType } from './request-body.ts';

/** Semantic class of an OpenAPI response status or wildcard. */
export type ResponseCategory = 'informational' | 'success' | 'redirect' | 'client-error' | 'server-error' | 'default';

/** Classifies concrete and wildcard OpenAPI response statuses. */
export function classifyResponseStatus(status: string): ResponseCategory {
  if (/^1(?:\d{2}|xx)$/i.test(status)) return 'informational';
  if (/^2(?:\d{2}|xx)$/i.test(status)) return 'success';
  if (/^3(?:\d{2}|xx)$/i.test(status)) return 'redirect';
  if (/^4(?:\d{2}|xx)$/i.test(status)) return 'client-error';
  if (/^5(?:\d{2}|xx)$/i.test(status)) return 'server-error';
  return 'default';
}

/** Prefer 200, then a concrete 2xx, then a 2XX wildcard, then source order. */
export function preferredResponse<T extends { status: string }>(responses: readonly T[]): T | undefined {
  return (
    responses.find(({ status }) => status === '200') ??
    responses.find(({ status }) => /^2\d{2}$/.test(status)) ??
    responses.find(({ status }) => /^2xx$/i.test(status)) ??
    responses[0]
  );
}

/** Prefer JSON with a schema, then any schema, then JSON, then source order. */
export function preferredResponseRepresentation<T extends { mediaType: string; schema: unknown | null }>(
  representations: readonly T[],
): T | undefined {
  return (
    representations.find(({ mediaType, schema }) => isJsonMediaType(mediaType) && schema !== null) ??
    representations.find(({ schema }) => schema !== null) ??
    representations.find(({ mediaType }) => isJsonMediaType(mediaType)) ??
    representations[0]
  );
}

interface PayloadSchemaNode<T> {
  name?: string | undefined;
  type: string;
  children?: readonly T[] | undefined;
  items?: T | undefined;
}

/** Envelope-unwrapped payload schema and whether the wire payload is an array. */
export interface ResponsePayloadSchema<T> {
  /** Selected payload node, or `null` when no response schema is declared. */
  schema: T | null;
  /** Whether the selected payload is wrapped in an array on the wire. */
  isArray: boolean;
}

/** Derives the envelope-unwrapped schema used by documentation renderers. */
export function responsePayloadSchema<T extends PayloadSchemaNode<T>>(representation: {
  schema: T | null;
  payloadKey?: string | undefined;
}): ResponsePayloadSchema<T> {
  const root = representation.schema;
  if (!root) return { schema: null, isArray: false };
  const payload = representation.payloadKey
    ? (root.children?.find(({ name }) => name === representation.payloadKey) ?? root)
    : root;
  const isArray = payload.items !== undefined || payload.type === 'array' || payload.type.endsWith('[]');
  return { schema: payload.items ?? payload, isArray };
}
