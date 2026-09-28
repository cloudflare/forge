import { createHash } from 'node:crypto';

type SdkMethodMetadata = {
  operationId?: string;
  'x-fern-sdk-group-name': string;
  'x-fern-sdk-method-name': string;
  'x-fern-ignore'?: boolean;
};

function fernMethodName(value: string): string {
  const words = value.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const joined = words
    .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase()}${word.slice(1)}`))
    .join('');
  return joined ? `${joined[0]?.toLowerCase()}${joined.slice(1)}` : 'operation';
}

/**
 * Ensure every generated method name is unique within its SDK/CLI group.
 *
 * Upstream metadata occasionally assigns generic names such as `get` or
 * `create` to multiple operations. Rename every member of a collision from its
 * operationId so the result is deterministic and independent of traversal
 * order. This runs in Forge so all downstream consumers see the same names.
 */
export function ensureUniqueSdkMethodNames<T extends SdkMethodMetadata>(
  metadataByOperationId: Map<string, T[]>,
): number {
  type Entry = { metadata: T; identity: string; hashIdentity: string };
  const byKey = new Map<string, Entry[]>();

  for (const [mapIdentity, variants] of metadataByOperationId) {
    variants.forEach((metadata, index) => {
      if (metadata['x-fern-ignore']) return;
      const group = metadata['x-fern-sdk-group-name'].split('.').map(fernMethodName).join('\0');
      const method = fernMethodName(metadata['x-fern-sdk-method-name']);
      const key = `${group}\0${method}`;
      const entries = byKey.get(key) ?? [];
      const operationIdentity = metadata.operationId ?? mapIdentity;
      const identity = index === 0 ? operationIdentity : `${operationIdentity}-alias-${index}`;
      entries.push({
        metadata,
        identity,
        hashIdentity: `${mapIdentity}\0${identity}`,
      });
      byKey.set(key, entries);
    });
  }

  const collisions = [...byKey.values()].filter((entries) => entries.length > 1);
  const collidingEntries = new Set(collisions.flat());
  const used = new Set([...byKey.entries()].filter(([, entries]) => entries.length === 1).map(([key]) => key));
  let renamed = 0;
  const candidates = [...collidingEntries]
    .map((entry) => ({ entry, base: fernMethodName(entry.identity) }))
    .sort((a, b) => a.entry.hashIdentity.localeCompare(b.entry.hashIdentity));
  const baseCounts = new Map<string, number>();
  for (const { base } of candidates) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);

  for (const { entry, base } of candidates) {
    const group = entry.metadata['x-fern-sdk-group-name'].split('.').map(fernMethodName).join('\0');
    let next = base;
    let key = `${group}\0${fernMethodName(next)}`;
    if ((baseCounts.get(base) ?? 0) > 1 || used.has(key)) {
      const hash = createHash('sha256').update(entry.hashIdentity).digest('hex');
      let suffixLength = 8;
      do {
        const suffix = hash.slice(0, suffixLength);
        next = `${base}${suffix[0]?.toUpperCase()}${suffix.slice(1)}`;
        key = `${group}\0${fernMethodName(next)}`;
        suffixLength += 2;
      } while (used.has(key) && suffixLength <= hash.length);
      if (used.has(key)) throw new Error(`Could not derive a unique SDK method name for ${entry.identity}`);
    }
    used.add(key);
    if (entry.metadata['x-fern-sdk-method-name'] === next) continue;
    entry.metadata['x-fern-sdk-method-name'] = next;
    renamed += 1;
  }

  return renamed;
}
