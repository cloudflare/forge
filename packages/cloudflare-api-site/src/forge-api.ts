import { mkdirSync, writeFileSync } from 'node:fs';
import { sample } from 'openapi-sampler';
import type { ApiSpec } from '@cloudflare/nimbus-docs/types';
import {
  buildFernContent,
  defineFernManifest,
  getOperationExtensionData,
  type FernContentProjectData,
  type FernManifestProvider,
  type FernSourceOperation,
} from 'astro-fern';
import { forgeExtension, hasRemovedForgeOperationFields, hoistForgeCommands } from 'fern-forge';
import {
  CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
  CLOUDFLARE_TARGETS,
  cloudflareFormatIdentifier,
  cloudflareOperationRoutingPreference,
  cloudflareSnippets,
} from './cloudflare.ts';
import { loadForgeOpenApi } from './openapi-source.ts';
import { cloudflareTerraformExtension } from './terraform-extension.ts';
import { TERRAFORM_EXTENSION_NAME, terraformDeclarationLabel, terraformOperationDataSchema } from './terraform.ts';
import { assertToolingRouteNamespace } from './command-reference/routing.ts';
import { cloudflareApiVersionLabel, parseCloudflareApiVersion } from './version.ts';

export const TERRAFORM_EXTENSION = 'x-cloudflare-terraform';
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
/** Product slugs Nimbus keeps for its own pages → the slug the product publishes under; the old URLs redirect. */
const MOVED_PRODUCT_SLUGS: Record<string, string> = { tags: 'tagging' };
const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMENT: Record<string, string> = { typescript: '//', go: '//' };
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
  /** Tag name → the URL segment that replaces it, for products Nimbus holds a segment for. */
  tagSegments: Record<string, string>;
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
): PreparedForgeApi {
  const document = structuredClone(source);
  document.info = { ...(document.info as Record<string, unknown>), title: API_TITLE };
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
    operations[operation.operationId] = slug;
  }
  for (const alias of aliases) {
    const primary = byId.get(alias.operation.operationId);
    if (!primary) throw new Error(`cloudflare-api-site: alias of "${alias.operation.operationId}" has no primary page`);
    const { product, operation } = alias;
    redirects[`/${product.slug}/${operation.slug}/`] = `/${operations[operation.operationId]}/`;
    const slugs = operation.placement?.resourcePath.map((segment) => segment.slug) ?? [];
    for (let depth = 0; depth <= slugs.length; depth++) {
      const from = `/${[product.slug, ...slugs.slice(0, depth)].join('/')}/`;
      if (sections.has(from)) continue;
      redirects[from] ??=
        depth === slugs.length ? leafPath.get(operation.operationId)! : sectionPath(primary.product.slug);
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
      const entry = typeof op.operationId === 'string' ? byId.get(op.operationId) : undefined;
      if (!entry) {
        delete item[method];
        continue;
      }
      kept++;
      op.tags = [leafTag.get(entry.operation.operationId)];
      if (entry.operation.deprecated) op.deprecated = true;
      const rank = LIFECYCLE.findIndex((name) => name === op['x-fern-sdk-method-name']);
      if (rank !== -1) op['x-nimbus-order'] = rank + 1;
      const terraform = getOperationExtensionData(
        entry.operation,
        TERRAFORM_EXTENSION_NAME,
        terraformOperationDataSchema,
      );
      if (terraform) op[TERRAFORM_EXTENSION] = terraform;
      const declarations = terraform?.declarations.filter((declaration) => declaration.example) ?? [];
      const snippets = new Map(entry.snippets.map((snippet) => [snippet.targetId, snippet.code]));
      op['x-codeSamples'] = CLOUDFLARE_TARGETS.flatMap((target) => {
        const lang = target.id === 'terraform' ? 'hcl' : target.id;
        const code = snippets.get(target.id);
        if (code) return [{ lang, label: target.label, source: code }];
        if (target.id === 'terraform' && declarations.length > 0) {
          return declarations.map((declaration) => ({
            lang,
            label: terraformDeclarationLabel(declaration),
            source: declaration.example!,
          }));
        }
        return [
          {
            lang,
            label: target.label,
            source: `${COMMENT[target.language] ?? '#'} A ${target.label} example is not available yet.`,
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

  document.tags = [...tags.values()].map(({ key: _key, ...tag }) => tag);

  return {
    document,
    operations,
    products: primaryProducts.map(({ id, slug, title }) => ({ id, slug, title })),
    redirects,
    tagSegments: Object.fromEntries(
      primaryProducts
        .filter((product) => product.slug in MOVED_PRODUCT_SLUGS)
        .map((product) => [product.slug, MOVED_PRODUCT_SLUGS[product.slug]!]),
    ),
  };
}

/** Builds the prepared spec for every version and returns the Nimbus `api` entry. */
export async function forgeApi(): Promise<ApiSpec> {
  const source = await loadForgeOpenApi();
  const document = hoistForgeCommands(source.document);
  const label = cloudflareApiVersionLabel(air);
  const data = buildFernContent({
    source: { kind: 'snapshots', snapshots: [{ id: air.wire, source: document, label, default: true }] },
    manifest,
    responsePayloadKey: CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
    formatIdentifier: cloudflareFormatIdentifier,
    operationRoutingPreference: cloudflareOperationRoutingPreference,
    isOperationHidden: hasRemovedForgeOperationFields,
    snippets: cloudflareSnippets,
    extensions: [forgeExtension(), cloudflareTerraformExtension],
    onWarning: (message) => console.warn(`[forge-api] ${message}`),
  });
  const prepared = prepareForgeApi(document, data, air.wire);
  assertToolingRouteNamespace(prepared.products, Object.values(prepared.operations));

  const dir = new URL('../.forge/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const specFile = `openapi-${air.wire}.json`;
  writeFileSync(new URL(specFile, dir), JSON.stringify(prepared.document));
  writeFileSync(new URL('products.json', dir), JSON.stringify(prepared.products, null, 2));
  writeFileSync(new URL('redirects.json', dir), JSON.stringify(prepared.redirects, null, 2));
  writeFileSync(
    new URL('release.json', dir),
    JSON.stringify({ lastModified: source.lastModified?.toISOString() ?? null }, null, 2),
  );

  return {
    collection: 'api',
    label: 'Cloudflare API',
    versionUrl: { in: 'query' },
    bundle: false,
    // Nimbus pretty-prints the published spec: 36 MB here, over the 25 MiB Workers asset limit (20 MB minified).
    publishSpec: false,
    sidebar: 'on-demand',
    requireOperationId: true,
    samples: { generate: [] },
    extensions: ['x-fern-availability', 'x-forge-require-confirmation', TERRAFORM_EXTENSION],
    versions: [
      {
        version: air.wire,
        label,
        default: true,
        spec: `.forge/${specFile}`,
        routes: {
          convention: 'resource-action-v2',
          sections: 'hierarchical',
          tagSegments: prepared.tagSegments,
          operations: prepared.operations,
        },
      },
    ],
  };
}
