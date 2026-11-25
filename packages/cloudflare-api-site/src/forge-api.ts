import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ApiSpec, ApiVersionSpec } from '@cloudflare/nimbus-docs/types';
import {
  buildFernContent,
  defineFernManifest,
  type FernContentProjectData,
  type FernManifestProvider,
  type FernSourceOperation,
  fernOperationId,
  getOperationExtensionData,
} from 'astro-fern';
import { forgeExtension, hasRemovedForgeOperationFields, hoistForgeCommands } from 'fern-forge';
import { sample } from 'openapi-sampler';
import {
  CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
  CLOUDFLARE_TARGETS,
  cloudflareFormatIdentifier,
  cloudflareOperationRoutingPreference,
  cloudflareSnippets,
} from './cloudflare.ts';
import { assertToolingRouteNamespace } from './command-reference/routing.ts';
import { planStainlessRedirects, type StainlessSnapshot } from './stainless-redirects.ts';
import {
  type SdkSnippets,
  STAINLESS_LANGUAGES,
  type StainlessLanguage,
  snippetsByOperation,
  stainlessSnippetsFileSchema,
} from './stainless-snippets.ts';
import { TERRAFORM_EXTENSION_NAME, type TerraformOperationData, terraformOperationDataSchema } from './terraform.ts';
import { cloudflareTerraformExtension } from './terraform-extension.ts';
import { parseCloudflareApiVersion } from './version.ts';

export const TERRAFORM_EXTENSION = 'x-cloudflare-terraform';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** Product slugs Nimbus keeps for its own pages → the slug the product publishes under; the old URLs redirect. */
const MOVED_PRODUCT_SLUGS: Record<string, string> = { tags: 'tagging' };
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** SDK method names that lead a resource's operations, in reading order; the rest follow in spec order. */
const LIFECYCLE = ['list', 'get', 'create', 'update', 'edit', 'delete'];

interface JsonResponse {
  content?: Record<string, { schema?: object; example?: unknown }>;
}

function addResponseExamples(responses: Record<string, JsonResponse>, document: object) {
  for (const response of Object.values(responses)) {
    const media = response.content?.['application/json'];
    if (media?.schema && media.example === undefined) {
      media.example = sample(media.schema, { skipWriteOnly: true, quiet: true }, document);
    }
  }
}

/**
 * Returns the operationId to give Nimbus for an ID that astro-fern derived from an SDK address.
 *
 * Nimbus treats the dots in an operationId as namespaces, and it reserves a few of them, such as
 * `tags`, for its own pages. When a derived ID starts with one of those products, the product is
 * renamed the same way its URL slug already is, so `tags.account-resources.get` becomes
 * `tagging.account-resources.get`.
 */
function nimbusOperationId(operationId: string): string {
  const [product, ...rest] = operationId.split('.');
  const moved = product === undefined || rest.length === 0 ? undefined : MOVED_PRODUCT_SLUGS[product];
  return moved === undefined ? operationId : [moved, ...rest].join('.');
}

/** Where Nimbus serves a product or resource page: today's URL, with moved products renamed. */
function sectionPath(productSlug: string, slugs: string[] = []): string {
  return `/${[MOVED_PRODUCT_SLUGS[productSlug] ?? productSlug, ...slugs].join('/')}/`;
}

export interface ForgeProduct {
  id: string;
  slug: string;
  title: string;
}

export interface PreparedForgeApi {
  document: Record<string, unknown>;
  /** `operationId` → collection-relative slug, today's URL without the base. */
  operations: Record<string, string>;
  products: ForgeProduct[];
  /** Collection-relative pathnames the site served and Nimbus doesn't → where they live now. */
  redirects: Record<string, string>;
  /** The product and resource pages Nimbus draws, collection-relative. */
  sections: string[];
  /** Each of `sections` → how many endpoints it and the resources below it hold. */
  endpointCounts: Record<string, number>;
  /** `METHOD /path` as the spec writes it → the operation's page, collection-relative. */
  operationPages: Record<string, string>;
}

interface Tag {
  name: string;
  'x-displayName': string;
  description?: string;
  parent?: string;
}

const air = parseCloudflareApiVersion('2026-11-30.air');

const manifest: FernManifestProvider = (_openapi, { discoverProducts }) =>
  defineFernManifest({ targets: CLOUDFLARE_TARGETS, products: discoverProducts() });

function assertSlug(slug: string, what: string): void {
  for (const segment of slug.split('/')) {
    if (!SLUG_SEGMENT.test(segment)) {
      throw new Error(`cloudflare-api-site: ${what} "${slug}" is not lowercase kebab-case segments`);
    }
  }
}

/** Title of the API home, its root breadcrumb and the Markdown index; the spec's own names the site. */
const API_TITLE = 'API Reference';

/** Titles the spec should carry itself; an upstream title wins once it ships. Ledger: nimbus-thoughts /forge/spec-gaps. */
const SCHEMA_TITLES: Record<string, string> = {
  'dns-records_dns-record-without-data': 'Content records',
  'dns-records_dns-record-with-data': 'Data records',
};

/** Rewrites the raw Forge document into the one Nimbus draws, driven by what astro-fern decided. */
export function prepareForgeApi(
  source: Record<string, unknown>,
  data: FernContentProjectData,
  snapshotId: string,
  /** `operationId` → the retired Stainless site's SDK snippets; see `snippetsByOperation`. */
  sdkSnippets: ReadonlyMap<string, SdkSnippets> = new Map(),
): PreparedForgeApi {
  const document = structuredClone(source);
  document.info = { ...(document.info as Record<string, unknown>), title: API_TITLE };
  // Collect the IDs astro-fern derives for operations that have no operationId. Only these are
  // renamed for Nimbus; an operationId written in the spec is left as its author wrote it.
  const derivedIds = new Set<string>();
  for (const [path, item] of Object.entries((document.paths ?? {}) as Record<string, Record<string, unknown>>)) {
    for (const method of HTTP_METHODS) {
      const op = item?.[method] as Record<string, unknown> | undefined;
      if (!op || typeof op.operationId === 'string') continue;
      const derived = fernOperationId(op, method, path);
      if (derived !== undefined) derivedIds.add(derived);
    }
  }
  const nimbusId = (operationId: string) =>
    derivedIds.has(operationId) ? nimbusOperationId(operationId) : operationId;
  const schemas =
    (document.components as { schemas?: Record<string, Record<string, unknown>> } | undefined)?.schemas ?? {};
  for (const [name, title] of Object.entries(SCHEMA_TITLES)) {
    if (schemas[name]) schemas[name] = { title, ...schemas[name] };
  }
  const byId = new Map<string, FernSourceOperation>();
  const aliases: FernSourceOperation[] = [];
  for (const entry of data.operations) {
    if (entry.snapshotId !== snapshotId) continue;
    if ((entry.operation.placement?.projectionId ?? 'primary') !== 'primary') {
      aliases.push(entry);
      continue;
    }
    const id = entry.operation.operationId;
    if (byId.has(id)) throw new Error(`cloudflare-api-site: operation "${id}" has two primary placements`);
    byId.set(id, entry);
  }

  const tags = new Map<string, Tag & { key: string }>();
  const defineTag = (tag: Tag, key: string) => {
    const existing = tags.get(tag.name);
    if (existing && existing.key !== key) {
      throw new Error(`cloudflare-api-site: tag "${tag.name}" is produced by both ${existing.key} and ${key}`);
    }
    if (!existing) tags.set(tag.name, { ...tag, key });
  };

  const operations: Record<string, string> = {};
  const bySlug = new Map<string, string>();
  const redirects: Record<string, string> = {};
  const sections = new Set<string>();
  const leafTag = new Map<string, string>();
  const leafPath = new Map<string, string>();
  const operationPages: Record<string, string> = {};
  const section = (productSlug: string, slugs: string[] = []) => {
    const path = sectionPath(productSlug, slugs);
    sections.add(path);
    const today = `/${[productSlug, ...slugs].join('/')}/`;
    if (today !== path) redirects[today] = path;
    return path;
  };

  const primaryProductIds = new Set([...byId.values()].map((entry) => entry.product.id));
  const primaryProducts = data.catalog.products.filter((product) => primaryProductIds.has(product.id));
  for (const product of primaryProducts) {
    defineTag(
      { name: product.slug, 'x-displayName': product.title, description: product.description },
      `product:${product.id}`,
    );
    section(product.slug);
  }

  for (const entry of byId.values()) {
    const { product, operation } = entry;
    let leaf = product.slug;
    let path = sectionPath(product.slug);
    if (operation.placement) {
      let parent = product.slug;
      const ids: string[] = [];
      const slugs: string[] = [];
      for (const segment of operation.placement.resourcePath) {
        ids.push(segment.id);
        slugs.push(segment.slug);
        const name = `${product.slug}-${slugs.join('-')}`;
        defineTag({ name, 'x-displayName': segment.title, parent }, `${product.id}:${ids.join('/')}`);
        path = section(product.slug, slugs);
        parent = name;
      }
      leaf = parent;
    } else {
      redirects[`/${product.slug}/sections/${entry.section.id}/`] = path;
    }
    leafTag.set(operation.operationId, leaf);
    leafPath.set(operation.operationId, path);

    const slug = `${MOVED_PRODUCT_SLUGS[product.slug] ?? product.slug}/${operation.slug}`;
    if (slug !== `${product.slug}/${operation.slug}`) redirects[`/${product.slug}/${operation.slug}/`] = `/${slug}/`;
    assertSlug(slug, `route for "${operation.operationId}"`);
    const taken = bySlug.get(slug);
    if (taken)
      throw new Error(`cloudflare-api-site: "${taken}" and "${operation.operationId}" both route to "${slug}"`);
    bySlug.set(slug, operation.operationId);
    const id = nimbusId(operation.operationId);
    if (operations[id] !== undefined) {
      throw new Error(
        `cloudflare-api-site: "${operation.operationId}" and another operation are both "${id}" to Nimbus`,
      );
    }
    operations[id] = slug;
  }
  for (const alias of aliases) {
    const { product, operation } = alias;
    const primary = byId.get(operation.operationId);
    const primarySlug = operations[nimbusId(operation.operationId)];
    const primarySection = leafPath.get(operation.operationId);
    if (!primary || primarySlug === undefined || primarySection === undefined) {
      throw new Error(`cloudflare-api-site: alias of "${operation.operationId}" has no primary page`);
    }
    redirects[`/${product.slug}/${operation.slug}/`] = `/${primarySlug}/`;
    const slugs = operation.placement?.resourcePath.map((segment) => segment.slug) ?? [];
    for (let depth = 0; depth <= slugs.length; depth++) {
      const from = `/${[product.slug, ...slugs.slice(0, depth)].join('/')}/`;
      if (sections.has(from)) continue;
      redirects[from] ??= depth === slugs.length ? primarySection : sectionPath(primary.product.slug);
    }
  }

  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const [path, item] of Object.entries(paths)) {
    if (!item) continue;
    let kept = 0;
    for (const method of HTTP_METHODS) {
      const raw = item[method];
      if (!raw || typeof raw !== 'object') continue;
      const op = raw as Record<string, unknown>;
      const operationId = fernOperationId(op, method, path);
      const entry = operationId === undefined ? undefined : byId.get(operationId);
      if (!entry) {
        delete item[method];
        continue;
      }
      kept++;
      // Nimbus needs an operationId on every operation, so give the derived one to those without.
      op.operationId = nimbusId(entry.operation.operationId);
      op.tags = [leafTag.get(entry.operation.operationId)];
      // Nimbus reads each page's URL from the spec, so the config carries no route map.
      op['x-nimbus-route'] = operations[entry.operation.operationId];
      const page = operations[nimbusId(entry.operation.operationId)];
      if (page) operationPages[`${method.toUpperCase()} ${path}`] ??= `/${page}/`;
      if (entry.operation.deprecated) op.deprecated = true;
      const methodName = op['x-fern-sdk-method-name'];
      const rank = typeof methodName === 'string' ? LIFECYCLE.indexOf(methodName) : -1;
      if (rank !== -1) op['x-nimbus-order'] = rank + 1;
      const terraform = getOperationExtensionData(
        entry.operation,
        TERRAFORM_EXTENSION_NAME,
        terraformOperationDataSchema,
      );
      if (terraform) op[TERRAFORM_EXTENSION] = terraform;
      const snippets = new Map(entry.snippets.map((snippet) => [snippet.targetId, snippet.code]));
      const sdk = sdkSnippets.get(entry.operation.operationId);
      op['x-codeSamples'] = CLOUDFLARE_TARGETS.flatMap((target) => {
        const lang = target.id;
        const code = snippets.get(target.id);
        if (code) return [{ lang, label: target.label, source: code }];
        if (target.id === 'terraform') {
          return [{ lang, label: target.label, source: terraformSample(terraform) }];
        }
        if (isStainlessLanguage(target.id)) {
          return [{ lang, label: target.label, source: sdk?.[target.id] ?? sdkPlaceholder(target.id, target.label) }];
        }
        return [
          {
            lang,
            label: target.label,
            source: `# A ${target.label} example is not available yet.`,
          },
        ];
      });
      addResponseExamples((op.responses ?? {}) as Record<string, JsonResponse>, document);
    }
    if (kept === 0) delete paths[path];
  }
  addResponseExamples(
    (document.components as { responses?: Record<string, JsonResponse> } | undefined)?.responses ?? {},
    document,
  );

  document.tags = [...tags.values()].map(({ key: _key, ...tag }) =>
    tag.name in MOVED_PRODUCT_SLUGS ? { ...tag, 'x-nimbus-route': MOVED_PRODUCT_SLUGS[tag.name] } : tag,
  );

  // Resources nest by path, so a section holds every endpoint whose resource path starts with its own.
  const leaves = [...leafPath.values()];
  const endpointCounts = Object.fromEntries(
    [...sections].map((section) => [section, leaves.filter((leaf) => leaf.startsWith(section)).length]),
  );

  return {
    document,
    operations,
    products: primaryProducts.map(({ id, slug, title }) => ({ id, slug, title })),
    redirects,
    sections: [...sections],
    endpointCounts,
    operationPages,
  };
}

function isStainlessLanguage(id: string): id is StainlessLanguage {
  return (STAINLESS_LANGUAGES as readonly string[]).includes(id);
}

/** What an SDK tab shows for an operation the old site had no snippet for, as a comment in its language. */
function sdkPlaceholder(language: StainlessLanguage, label: string): string {
  return `${language === 'python' ? '#' : '//'} This operation is not available in the ${label} SDK.`;
}

/**
 * The Terraform sample, worded as the old site's: every declaration's example
 * (or that it has none), each followed by its import command.
 */
function terraformSample(terraform: TerraformOperationData | undefined): string {
  if (!terraform || terraform.declarations.length === 0) return '# This operation is not implemented in Terraform.';
  return terraform.declarations
    .map((declaration) => {
      const parts = [declaration.example?.trimEnd() ?? `# No HCL example is available for ${declaration.name}.`];
      if (declaration.importExample) {
        // A shell command, possibly with its own comments: every line becomes an
        // HCL comment, without the prompt.
        const lines = declaration.importExample
          .trim()
          .split('\n')
          .map((line) => `# ${line.replace(/^\$\s*/, '').replace(/^#\s?/, '')}`.trimEnd());
        parts.push([`# Import an existing ${declaration.name}:`, ...lines].join('\n'));
      }
      return parts.join('\n\n');
    })
    .join('\n\n');
}

/**
 * Nimbus's transform for the API: prepares the spec it reads (from the Forge
 * release, or `FORGE_OPENAPI_SPEC`) for rendering, and writes the products and
 * redirects the site reads to `.forge/`. Nimbus runs it in Node at each build
 * and dev start, and `astro preview` reuses the last build's result.
 */
export function prepareForgeSpec(source: Record<string, unknown>): Record<string, unknown> {
  const document = hoistForgeCommands(source);
  const data = buildFernContent({
    source: { kind: 'snapshots', snapshots: [{ id: air.wire, source: document, label: air.label, default: true }] },
    manifest,
    responsePayloadKey: CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
    formatIdentifier: cloudflareFormatIdentifier,
    operationRoutingPreference: cloudflareOperationRoutingPreference,
    isOperationHidden: hasRemovedForgeOperationFields,
    snippets: cloudflareSnippets,
    extensions: [forgeExtension(), cloudflareTerraformExtension],
    onWarning: (message) => console.warn(`[forge-api] ${message}`),
  });
  const snapshot = readStainlessSnapshot();
  const prepared = prepareForgeApi(document, data, air.wire, readStainlessSnippets(snapshot));
  assertToolingRouteNamespace(prepared.products, Object.values(prepared.operations));

  const dir = new URL('../.forge/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL('products.json', dir), JSON.stringify(prepared.products, null, 2));
  writeFileSync(new URL('redirects.json', dir), JSON.stringify(prepared.redirects, null, 2));
  writeFileSync(new URL('endpoint-counts.json', dir), JSON.stringify(prepared.endpointCounts));
  writeFileSync(new URL('operation-pages.json', dir), JSON.stringify(prepared.operationPages));
  writeStainlessRedirects(snapshot, prepared, dir);
  return prepared.document;
}

/** The Nimbus `api` entry, reading `spec`; `prepareForgeSpec` is its transform. */
export function forgeApi(spec: ApiVersionSpec['spec']): ApiSpec {
  return {
    collection: 'api',
    label: 'Cloudflare API',
    versionUrl: { in: 'query' },
    bundle: false,
    // Nimbus pretty-prints the published spec: 36 MB here, over the 25 MiB Workers asset limit (20 MB minified).
    publishSpec: false,
    // Nothing cites this site's operations yet, and it sits behind Access.
    publishCoordinates: false,
    sidebar: 'on-demand',
    requireOperationId: true,
    samples: { generate: [] },
    extensions: ['x-fern-availability', 'x-forge-require-confirmation', TERRAFORM_EXTENSION],
    versions: [
      {
        version: air.wire,
        label: air.label,
        default: true,
        spec,
        routes: { convention: 'resource-action-v2', sections: 'hierarchical' },
      },
    ],
  };
}

function readStainlessSnapshot(): StainlessSnapshot {
  return JSON.parse(readFileSync(new URL('./stainless-redirects.json', import.meta.url), 'utf8')) as StainlessSnapshot;
}

/** The retired Stainless site's SDK snippets, by the operation their old page redirects to. */
function readStainlessSnippets(snapshot: StainlessSnapshot): Map<string, SdkSnippets> {
  const file = stainlessSnippetsFileSchema.parse(
    JSON.parse(readFileSync(new URL('./stainless-snippets.json', import.meta.url), 'utf8')),
  );
  const { byOperation, shared } = snippetsByOperation(snapshot, file);
  if (shared.length > 0) {
    console.warn(
      `[forge-api] ${shared.length} operations have several old Stainless method pages; each uses the first page's SDK snippets`,
    );
  }
  return byOperation;
}

/** Plans the retired Stainless site's redirects against today's pages, for the middleware. */
function writeStainlessRedirects(snapshot: StainlessSnapshot, prepared: PreparedForgeApi, dir: URL): void {
  const plan = planStainlessRedirects(snapshot, {
    operations: prepared.operations,
    sections: new Set(prepared.sections),
  });
  if (plan.fallbacks.length > 0) {
    console.warn(
      `[forge-api] ${plan.fallbacks.length} Stainless pages have no page today and redirect to an ancestor's; see .forge/stainless-fallbacks.json`,
    );
  }
  writeFileSync(new URL('stainless-fallbacks.json', dir), JSON.stringify(plan.fallbacks, null, 2));
  writeFileSync(new URL('stainless-lookup.json', dir), JSON.stringify(plan.lookup));
}
