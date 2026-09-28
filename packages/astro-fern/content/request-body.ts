/** True when a media type carries one JSON value, including structured `+json` types. */
export function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return essence === 'application/json' || essence?.endsWith('+json') === true;
}

/**
 * Picks the representation that should lead documentation: JSON with a schema,
 * then any representation with a schema, then JSON without one, then source order.
 */
export function preferredRequestRepresentation<T extends { mediaType: string; schema: unknown | null }>(
  representations: readonly T[],
): T | undefined {
  return (
    representations.find((representation) => isJsonMediaType(representation.mediaType) && representation.schema) ??
    representations.find((representation) => representation.schema) ??
    representations.find((representation) => isJsonMediaType(representation.mediaType)) ??
    representations[0]
  );
}
