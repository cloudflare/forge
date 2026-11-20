/** Media type helpers. */

export interface ParsedMediaType {
  type: string;
  subtype: string;
}

export function parseMediaType(mediaType: string): ParsedMediaType | undefined {
  const essence = mediaType.split(';')[0]!.trim().toLowerCase();
  const parts = essence.split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return undefined;
  }
  return { type: parts[0]!, subtype: parts[1]! };
}

export function isMultipartMediaType(mediaType: string): boolean {
  return parseMediaType(mediaType)?.type === 'multipart';
}
