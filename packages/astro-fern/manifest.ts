/** Category of an execution target, used by renderers to group HTTP, CLI, SDK, and tool examples. */
export type FernTargetKind = 'http' | 'cli' | 'sdk' | 'tool';

/**
 * Declares one executable representation of an API operation.
 *
 * Target IDs connect manifest configuration to a consumer-supplied snippet
 * renderer. Targets may be declared globally and overridden per product or
 * snapshot.
 */
export interface FernTargetConfig {
  /** Execution-target id, e.g. "curl", "typescript". Matches a snippet renderer key. */
  id: string;
  /** Broad target category used for presentation and downstream tooling. */
  kind: FernTargetKind;
  /** Human-facing tab or selector label. */
  label: string;
  /** Default syntax-highlighter language used when no matching snippet supplies one. */
  language: string;
  /** Package name displayed as metadata for SDK targets, when applicable. */
  packageName?: string;
  /** Package or tool version displayed alongside this target. */
  version?: string;
}

/** Assigns one stable documentation section to an exact OpenAPI tag. */
export interface FernSectionConfig {
  /** Stable URL-safe identifier for this documentation section. */
  id: string;
  /** Exact OpenAPI tag owned by this section. */
  tag: string;
  /** Human-facing section label. Defaults to the OpenAPI tag. */
  title?: string;
}

/**
 * Declares one documentation product and how operations in a combined OpenAPI
 * document are assigned to it.
 */
export interface FernProductConfig {
  /** Stable product identity and URL segment. */
  id: string;
  /** Human-facing product name; defaults to the discovered model title. */
  title?: string;
  /** Product summary used by overview and llms.txt surfaces. */
  description?: string;
  /** Replaces manifest-level targets for every snapshot in which this product exists. */
  targets?: FernTargetConfig[];
  /** Restrict operation ownership to this top-level Fern SDK group. */
  sdkGroup?: string;
  /** Optional OpenAPI path-template boundaries for this product in a combined spec. */
  pathPrefixes?: string[];
  /** Documentation sections and their exact OpenAPI tag ownership. */
  sections: FernSectionConfig[];
}

/** Top-level, route-neutral organization of products, sections, and execution targets. */
export interface FernManifest {
  /** Products exposed by the documentation surface, in navigation order. */
  products: FernProductConfig[];
  /** Default execution targets inherited by products and snapshots. */
  targets?: FernTargetConfig[];
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) throw new Error(`astro-fern: ${label} IDs must not be empty`);
    if (seen.has(value)) throw new Error(`astro-fern: duplicate ${label} ID "${value}"`);
    seen.add(value);
  }
}

function validateTargets(targets: FernTargetConfig[], owner: string): void {
  assertUnique(
    targets.map((target) => target.id),
    `${owner} target`,
  );
}

/**
 * Validates and returns the supplied Fern manifest object.
 *
 * @throws When identities are empty or duplicated, ownership selectors are
 * invalid, or sections do not uniquely own non-empty lowercase-kebab-case
 * identities and OpenAPI tags.
 */
export function defineFernManifest(manifest: FernManifest): FernManifest {
  if (manifest.products.length === 0) throw new Error('astro-fern: the manifest must contain at least one product');
  assertUnique(
    manifest.products.map((product) => product.id),
    'product',
  );
  if (manifest.targets) validateTargets(manifest.targets, 'manifest');
  for (const product of manifest.products) {
    if (product.targets) validateTargets(product.targets, `product "${product.id}"`);
    if (product.sdkGroup !== undefined && (!product.sdkGroup.trim() || product.sdkGroup.includes('.'))) {
      throw new Error(
        `astro-fern: product "${product.id}" has invalid Fern SDK group "${product.sdkGroup}" ` +
          '(must be one non-empty top-level segment)',
      );
    }
    if (product.pathPrefixes !== undefined) {
      if (product.pathPrefixes.length === 0) {
        throw new Error(`astro-fern: product "${product.id}" must not have an empty path-prefix list`);
      }
      assertUnique(product.pathPrefixes, `product "${product.id}" path prefix`);
      for (const prefix of product.pathPrefixes) {
        if (!prefix.startsWith('/') || (prefix.length > 1 && prefix.endsWith('/')) || /[?#]/.test(prefix)) {
          throw new Error(
            `astro-fern: product "${product.id}" has invalid path prefix "${prefix}" ` +
              '(must start with "/", contain no query/hash, and omit a trailing "/")',
          );
        }
      }
    }
    if (product.sections.length === 0) {
      throw new Error(`astro-fern: product "${product.id}" must contain at least one section`);
    }
    assertUnique(
      product.sections.map((section) => section.id),
      `product "${product.id}" section`,
    );
    const tagOwners = new Map<string, string>();
    for (const section of product.sections) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section.id)) {
        throw new Error(
          `astro-fern: section ID "${section.id}" in product "${product.id}" must be lowercase kebab-case`,
        );
      }
      if (!section.tag.trim()) {
        throw new Error(`astro-fern: section "${section.id}" in product "${product.id}" must own a tag`);
      }
      const owner = tagOwners.get(section.tag);
      if (owner) {
        throw new Error(
          `astro-fern: OpenAPI tag "${section.tag}" is assigned to both ${product.id}.${owner} and ${product.id}.${section.id}`,
        );
      }
      tagOwners.set(section.tag, section.id);
    }
  }
  return manifest;
}
