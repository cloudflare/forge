import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FERN_ARTIFACTS_DIRECTORY, fernArtifactDigest, validateFernArtifactDigest } from './content-contract.ts';
import {
  contentArtifactDescriptorSchema,
  contentOperationArtifactSchema,
  type FernContentArtifactDescriptorSchema,
} from './content/schema.ts';

const DECODER = new TextDecoder('utf-8', { fatal: true });
const OPERATIONS_DIRECTORY = 'operations';
const CATALOGS_DIRECTORY = 'catalogs';

/** Exact operation bytes and the digest that addresses them. */
export interface FernOperationArtifactPublication {
  /** Stable semantic operation ID; multiple snapshots may publish this ID at different digests. */
  id: string;
  /** SHA-256 digest of `bytes`, unique to this exact operation snapshot. */
  digest: string;
  /** Schema-validated serialized operation artifact. */
  bytes: Uint8Array<ArrayBuffer>;
}

/** One fully prepared generation published before the eager catalog is activated. */
export interface FernArtifactGeneration {
  /** Digest of the descriptor that references this complete snapshot set. */
  revision: string;
  /** Serialized descriptor bytes whose digest is `revision`. */
  descriptorBytes: Uint8Array<ArrayBuffer>;
  /** One publication per distinct `(semantic ID, digest)` pair; identical snapshots are deduplicated. */
  operations: readonly FernOperationArtifactPublication[];
}

function artifactsRoot(publicDir: URL): string {
  if (publicDir.protocol !== 'file:') {
    throw new Error(`astro-fern: publicDir must be a file URL, received "${publicDir.href}"`);
  }
  return join(fileURLToPath(publicDir), FERN_ARTIFACTS_DIRECTORY);
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`astro-fern: managed artifact file "${path}" must be a regular file`);
  }
  return readFile(path);
}

async function ensureManagedDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`astro-fern: managed artifact directory "${path}" must be a regular directory`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(path, { recursive: true });
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function writeImmutable(path: string, bytes: Uint8Array): Promise<void> {
  const existing = await readOptional(path);
  if (existing) {
    if (!bytesEqual(existing, bytes)) {
      throw new Error(`astro-fern: immutable artifact at "${path}" does not match its content digest`);
    }
    return;
  }

  const staging = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(staging, bytes, { flag: 'wx' });
    await rename(staging, path);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(DECODER.decode(bytes));
  } catch (error) {
    throw new Error(`astro-fern: ${label} is not valid UTF-8 JSON: ${String(error)}`);
  }
}

async function parseDescriptor(bytes: Uint8Array, revision: string): Promise<FernContentArtifactDescriptorSchema> {
  if ((await fernArtifactDigest(bytes)) !== revision) {
    throw new Error(`astro-fern: artifact descriptor does not match revision "${revision}"`);
  }
  const parsed = contentArtifactDescriptorSchema.safeParse(parseJsonBytes(bytes, 'artifact descriptor'));
  if (!parsed.success) {
    throw new Error(`astro-fern: artifact descriptor does not match its schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

interface DescriptorArtifactReference {
  id: string;
  digest: string;
}

function artifactReferenceKey(id: string, digest: string): string {
  return `${id.length}:${id}${digest}`;
}

function descriptorArtifacts(
  descriptor: FernContentArtifactDescriptorSchema,
): Map<string, DescriptorArtifactReference> {
  const artifacts = new Map<string, DescriptorArtifactReference>();
  for (const product of descriptor.catalog.products) {
    for (const snapshot of product.snapshots) {
      const snapshotEntryIds = new Set<string>();
      for (const section of snapshot.sections) {
        for (const operation of section.operations) {
          if (snapshotEntryIds.has(operation.entryId)) {
            throw new Error(
              `astro-fern: artifact descriptor references operation entry "${operation.entryId}" more than once in snapshot "${snapshot.id}"; keep one catalog reference per snapshot and semantic operation ID`,
            );
          }
          snapshotEntryIds.add(operation.entryId);
          artifacts.set(artifactReferenceKey(operation.entryId, operation.artifactDigest), {
            id: operation.entryId,
            digest: operation.artifactDigest,
          });
        }
      }
    }
  }
  return artifacts;
}

/**
 * Publishes immutable operation blobs and then their descriptor into Astro's
 * public directory. Callers must serialize writes to a shared `publicDir`.
 */
export async function publishFernOperationArtifacts(publicDir: URL, generation: FernArtifactGeneration): Promise<void> {
  validateFernArtifactDigest(generation.revision);
  const descriptor = await parseDescriptor(generation.descriptorBytes, generation.revision);
  const expected = descriptorArtifacts(descriptor);
  const publications = new Map<string, FernOperationArtifactPublication>();

  for (const operation of generation.operations) {
    validateFernArtifactDigest(operation.digest);
    const referenceKey = artifactReferenceKey(operation.id, operation.digest);
    if (publications.has(referenceKey)) {
      throw new Error(
        `astro-fern: generation publishes operation entry "${operation.id}" at digest "${operation.digest}" more than once; remove the duplicate publication before writing artifacts`,
      );
    }
    if ((await fernArtifactDigest(operation.bytes)) !== operation.digest) {
      throw new Error(`astro-fern: operation artifact "${operation.id}" does not match digest "${operation.digest}"`);
    }
    const parsed = contentOperationArtifactSchema.safeParse(
      parseJsonBytes(operation.bytes, `operation artifact "${operation.id}"`),
    );
    if (!parsed.success) {
      throw new Error(`astro-fern: operation artifact "${operation.id}" does not match its schema`);
    }
    if (parsed.data.id !== operation.id) {
      throw new Error(`astro-fern: operation artifact "${operation.id}" contains entry ID "${parsed.data.id}"`);
    }
    publications.set(referenceKey, operation);
  }

  if (publications.size !== expected.size) {
    throw new Error(
      `astro-fern: artifact descriptor references ${expected.size} distinct operation artifact(s), but the generation publishes ${publications.size}; regenerate the descriptor and operation publications together`,
    );
  }
  for (const [referenceKey, reference] of expected) {
    if (!publications.has(referenceKey)) {
      throw new Error(
        `astro-fern: artifact descriptor references operation "${reference.id}" at digest "${reference.digest}" without matching bytes; include that exact { id, digest, bytes } publication in the generation`,
      );
    }
  }

  const root = artifactsRoot(publicDir);
  const operationsDirectory = join(root, OPERATIONS_DIRECTORY);
  const catalogsDirectory = join(root, CATALOGS_DIRECTORY);
  await ensureManagedDirectory(root);
  await ensureManagedDirectory(operationsDirectory);
  await ensureManagedDirectory(catalogsDirectory);

  for (const operation of generation.operations) {
    await writeImmutable(join(operationsDirectory, `${operation.digest}.json`), operation.bytes);
  }
  await writeImmutable(join(catalogsDirectory, `${generation.revision}.json`), generation.descriptorBytes);
}

async function removeUnreferencedFiles(directory: string, retained: ReadonlySet<string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const digest = entry.isFile() && entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : undefined;
    if (!digest || !retained.has(digest)) {
      await rm(join(directory, entry.name), { recursive: true, force: true });
    }
  }
}

/** Retains blobs reachable from the active and immediately prior project revisions. */
export async function pruneFernOperationArtifacts(
  publicDir: URL,
  revision: string,
  previousRevision: string | undefined,
): Promise<void> {
  validateFernArtifactDigest(revision);
  if (previousRevision === revision) return;
  if (previousRevision !== undefined) validateFernArtifactDigest(previousRevision);
  const root = artifactsRoot(publicDir);
  const operationsDirectory = join(root, OPERATIONS_DIRECTORY);
  const catalogsDirectory = join(root, CATALOGS_DIRECTORY);
  await ensureManagedDirectory(root);
  await ensureManagedDirectory(operationsDirectory);
  await ensureManagedDirectory(catalogsDirectory);

  if (previousRevision === undefined) {
    const descriptors = await readdir(catalogsDirectory, { withFileTypes: true });
    const historyIsUnknown = descriptors.some(
      (entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== `${revision}.json`,
    );
    if (historyIsUnknown) return;
  }

  const retainedRevisions = new Set([revision, ...(previousRevision ? [previousRevision] : [])]);
  const retainedOperations = new Set<string>();
  const currentOperations = new Set<string>();

  for (const retainedRevision of retainedRevisions) {
    const path = join(catalogsDirectory, `${retainedRevision}.json`);
    const bytes = await readOptional(path);
    if (!bytes) throw new Error(`astro-fern: retained artifact descriptor "${retainedRevision}" is missing`);
    const descriptor = await parseDescriptor(bytes, retainedRevision);
    for (const { digest } of descriptorArtifacts(descriptor).values()) {
      retainedOperations.add(digest);
      if (retainedRevision === revision) currentOperations.add(digest);
    }
  }

  for (const digest of retainedOperations) {
    if (currentOperations.has(digest)) continue;
    const bytes = await readOptional(join(operationsDirectory, `${digest}.json`));
    if (!bytes || (await fernArtifactDigest(bytes)) !== digest) {
      throw new Error(`astro-fern: prior operation artifact "${digest}" is missing or corrupt`);
    }
  }

  await removeUnreferencedFiles(operationsDirectory, retainedOperations);
  await removeUnreferencedFiles(catalogsDirectory, retainedRevisions);

  const rootEntries = await readdir(root, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (entry.name === OPERATIONS_DIRECTORY || entry.name === CATALOGS_DIRECTORY) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}
