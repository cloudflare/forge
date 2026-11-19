/**
 * Reads the spec with Forge and decides what the site documents: its
 * products, where each operation's page sits, which methods are aliases of
 * another page, and each operation's samples and Terraform data.
 * `forge-api.ts` applies the result to the spec Nimbus renders.
 *
 * Forge reads the spec's Fern extensions through its `fern` adapter. A
 * top-level group is a product, the groups below it are the page's
 * resources, and the method's name ends its URL.
 */
import { type Method, parse } from '@cloudflare/forge';
import { cloudflareFormatIdentifier, cloudflareSamples } from './cloudflare.ts';
import type { TerraformOperationData } from './terraform.ts';

/** Describes a product: a top-level group of methods. */
export interface ContentProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
}

/** Describes one group below a product, on the way to a page. */
export interface ResourceSegment {
  id: string;
  slug: string;
  title: string;
}

/** Describes one method: an operation's page, or an alias of another operation's page. */
export interface ContentOperation {
  /**
   * The operation's `operationId`, or for an operation without one, its SDK
   * address joined with dots, such as `zero-trust.access.applications.list`.
   */
  operationId: string;
  /** Whether `operationId` is derived from the SDK address, because the spec gives the operation none. */
  derivedId: boolean;
  /** The operation's HTTP method, lower-case, such as `get`. */
  method: string;
  /** The operation's path, as the spec writes it. */
  path: string;
  product: ContentProduct;
  /** The section of the operation's first tag, which old URLs used. */
  sectionId: string;
  /** The page's path below its product, such as `items/methods/list`. */
  slug: string;
  /** The groups between the product and the method, or none for an operation placed only by section. */
  resourcePath?: ResourceSegment[];
  /** Whether the method is an alias. An alias has no page of its own; its URL redirects to the operation's page. */
  alias: boolean;
  deprecated: boolean;
  /** The rendered sample of each execution target, or `null` when the target can't express the operation. */
  snippets: { targetId: string; code: string | null }[];
  terraform?: TerraformOperationData;
}

/** Holds everything the site documents of one spec. */
export interface Content {
  products: ContentProduct[];
  operations: ContentOperation[];
}

/** Returns the Terraform declarations that call the operation `method` `path`, if any. */
export type TerraformLookup = (method: string, path: string) => TerraformOperationData | undefined;

type OpenApiOperation = { operationId?: unknown; tags?: unknown; deprecated?: unknown };

/** Returns the operation the document declares at `method` `path`. */
function openApiOperation(document: Record<string, unknown>, method: string, path: string): OpenApiOperation {
  const paths = (document.paths ?? {}) as Record<string, Record<string, OpenApiOperation> | undefined>;
  return paths[path]?.[method.toLowerCase()] ?? {};
}

/** Returns `value` as a URL segment, splitting camel case, such as `ip-profiles` for `ipProfiles`. */
export function routeSegment(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Reports whether the method's metadata, or one of its aliases', is removed
 * Forge metadata that keeps the operation out of the docs: `x-forge-sunset`,
 * or an `x-forge-params` override with a `flagName`.
 */
function hasRemovedMetadata(method: Method): boolean {
  return [method, ...method.aliases].some((projection) => {
    if (projection.extension('x-forge-sunset') !== undefined) return true;
    const params = projection.extension('x-forge-params');
    if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
    return Object.values(params).some(
      (override) =>
        typeof override === 'object' && override !== null && !Array.isArray(override) && 'flagName' in override,
    );
  });
}

/**
 * Returns what the site documents of `document`, an OpenAPI document with
 * Fern's extensions. Throws with Forge's message when Forge doesn't read it.
 */
export function readContent(document: Record<string, unknown>, terraform: TerraformLookup = () => undefined): Content {
  const forge = parse(JSON.stringify(document), { adapters: ['fern'] });
  const products = new Map<string, ContentProduct>();
  const operations: ContentOperation[] = [];
  for (const group of forge.groups) {
    // The root holds methods without a group, which belong to no product.
    const [productName, ...resources] = group.path.map((name) => name.kebab());
    if (productName === undefined) continue;
    for (const method of group.methods) {
      const primary = method.aliasOf ?? method;
      if (hasRemovedMetadata(primary)) continue;
      const operation = openApiOperation(document, method.httpMethod, method.path);
      const operationId =
        typeof operation.operationId === 'string' && operation.operationId !== '' ? operation.operationId : undefined;
      const title = cloudflareFormatIdentifier(productName);
      const product = products.get(productName) ?? {
        id: productName,
        slug: routeSegment(productName),
        title,
        description: `${title} API`,
      };
      products.set(productName, product);
      const resourcePath = resources.map((id) => ({
        id,
        slug: routeSegment(id),
        title: cloudflareFormatIdentifier(id),
      }));
      const methodName = method.name.kebab();
      const tag = Array.isArray(operation.tags) && typeof operation.tags[0] === 'string' ? operation.tags[0] : '';
      operations.push({
        operationId: operationId ?? sdkAddress(primary),
        derivedId: operationId === undefined,
        method: method.httpMethod.toLowerCase(),
        path: method.path,
        product,
        sectionId: routeSegment(tag),
        slug: [...resourcePath.map((segment) => segment.slug), 'methods', routeSegment(methodName)].join('/'),
        resourcePath,
        alias: method.aliasOf !== undefined,
        deprecated: operation.deprecated === true || primary.availability === 'deprecated',
        snippets: cloudflareSamples(method, [productName, ...resources, methodName]),
        ...(method.aliasOf ? {} : withTerraform(terraform(method.httpMethod.toLowerCase(), method.path))),
      });
    }
  }
  return { products: [...products.values()], operations };
}

/**
 * Returns the SDK address of `method`, its group path and name joined with
 * dots, such as `zero-trust.access.applications.list`. It names an operation
 * without an `operationId`, as Forge names its SDK method.
 */
function sdkAddress(method: Method): string {
  return [...method.group.path.map((name) => name.kebab()), method.name.kebab()].join('.');
}

function withTerraform(data: TerraformOperationData | undefined): { terraform?: TerraformOperationData } {
  return data ? { terraform: data } : {};
}
