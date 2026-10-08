/** Default name of the content collection registered with `fernCollection()`. */
export const DEFAULT_FERN_CONTENT_COLLECTION = 'apiReference';
/** Singleton project-index entry within the Fern content collection. */
export const FERN_PROJECT_ENTRY_ID = 'project';
/** Live Collection containing request-loaded operation payloads. */
export const FERN_OPERATIONS_COLLECTION = 'apiOperations';
/** Public directory reserved for immutable Fern operation artifacts. */
export const FERN_ARTIFACTS_DIRECTORY = '_astro-fern';
/** Increment when artifact serialization or addressing changes incompatibly. */
export const FERN_ARTIFACT_FORMAT_VERSION = 1;
/** Lowercase SHA-256 digest used to address immutable Fern artifacts. */
export const FERN_ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const ENCODER = new TextEncoder();

/** Serializes generated data once; the returned bytes are both hashed and published. */
export function serializeFernArtifact(value: unknown): Uint8Array<ArrayBuffer> {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('astro-fern: artifact data is not JSON-serializable');
  return ENCODER.encode(json);
}

/** Produces a lowercase SHA-256 digest with the Web Crypto API. */
export async function fernArtifactDigest(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? ENCODER.encode(value) : value;
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Rejects values that cannot safely address a content-addressed artifact. */
export function validateFernArtifactDigest(digest: string): void {
  if (!FERN_ARTIFACT_DIGEST_PATTERN.test(digest)) {
    throw new Error(`astro-fern: invalid artifact digest "${digest}"`);
  }
}

function joinPath(...segments: string[]): string {
  return `/${segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .join('/')}`;
}

/** Public URL pathname for one content-addressed operation artifact. */
export function fernOperationArtifactPath(digest: string, base = '/'): string {
  validateFernArtifactDigest(digest);
  return joinPath(base, FERN_ARTIFACTS_DIRECTORY, 'operations', `${digest}.json`);
}

/** Public URL pathname for the descriptor rooted at one project revision. */
export function fernArtifactDescriptorPath(revision: string, base = '/'): string {
  validateFernArtifactDigest(revision);
  return joinPath(base, FERN_ARTIFACTS_DIRECTORY, 'catalogs', `${revision}.json`);
}
