import { readFileSync } from 'node:fs';
import { z } from 'astro/zod';
import { defineFernManifest, type FernProductConfig, type FernSectionConfig } from '../manifest.ts';
import type { SnippetOperation, SnippetParam, SnippetProvider } from '../snippets/index.ts';
import {
  prepareFernExtensions,
  type FernExtensionDefinition,
  type FernOperationExtensionContext,
  type FernOperationPresentation,
  type PreparedFernExtension,
} from '../extensions.ts';
import type { DocOperation, DocProduct, DocSection, DocsModel, SchemaNode } from './model.ts';
import { openApiDocumentSchema, type OpenApiDocumentSchema, type OperationSchema } from './openapi.ts';
import { HTTP_METHODS, resolveOperation } from './resolver.ts';
import {
  jsonValueSchema,
  type AvailabilitySchema,
  type JsonValueSchema,
  type OperationPlacementSchema,
} from './schema.ts';

export { openApiDocumentSchema } from './openapi.ts';

/**
 * Reads and validates a JSON OpenAPI document from a filesystem path or `file:` URL.
 *
 * @throws With distinct errors when the source cannot be read, is invalid JSON,
 * or does not match the OpenAPI fields consumed by astro-fern.
 */
export function loadOpenApiDocument(source: string | URL): OpenApiDocumentSchema {
  let raw: string;
  try {
    raw = readFileSync(source, 'utf8');
  } catch (cause) {
    throw new Error(`Could not read the Fern OpenAPI source at ${String(source)}.`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('The overlaid OpenAPI artifact is not valid JSON.', { cause });
  }

  return parseOpenApiDocument(parsed);
}

function assertOpenApiDocument(value: unknown): asserts value is OpenApiDocumentSchema {
  const result = openApiDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `The overlaid OpenAPI artifact is not a valid OpenAPI document:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }
}

/**
 * Validates an already parsed value as an OpenAPI document without cloning it.
 * Unknown OpenAPI and extension fields are preserved by the loose schemas.
 *
 * @throws A formatted validation error when a consumed field has an invalid shape.
 */
export function parseOpenApiDocument(value: unknown): OpenApiDocumentSchema {
  assertOpenApiDocument(value);
  return value;
}

/**
 * Normalise Fern's `x-fern-availability` (a bare status string or a
 * `{ status, message }` object) into {@link AvailabilitySchema}.
 */
const sourceAvailabilitySchema = z.union([
  z
    .string()
    .trim()
    .min(1)
    .transform((status): AvailabilitySchema => ({ status })),
  z
    .object({ status: z.string().trim().min(1), message: z.string().optional() })
    .transform((availability): AvailabilitySchema => availability),
]);

const sdkGroupPathSchema = z.union([
  z.array(z.string().trim().min(1)).min(1),
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => value.split('.').every((segment) => segment.trim().length > 0),
      'SDK group must have no empty segments',
    )
    .transform((value) => value.split('.').map((segment) => segment.trim())),
]);
const sdkMethodNameSchema = z.string().trim().min(1);

function toAvailability(value: unknown): AvailabilitySchema | undefined {
  return sourceAvailabilitySchema.optional().parse(value);
}

/**
 * Default identifier formatter: title-case each `-`/`_`-delimited word. Consumers
 * inject their own (e.g. an acronym-aware one) via `defineFernProject`.
 */
export function defaultFormatIdentifier(identifier: string): string {
  return identifier
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Accept Fern arrays and Forge's pre-transform dotted-string group convention. */
function toSdkGroupPath(groupName: unknown, operationId: string): string[] {
  if (groupName === undefined) return [];
  const parsed = sdkGroupPathSchema.safeParse(groupName);
  if (parsed.success) return parsed.data;
  throw new Error(`astro-fern: operation "${operationId}" has an invalid x-fern-sdk-group-name`);
}

interface OperationSdkMetadata {
  projectionId: string;
  groupName: unknown;
  methodName: unknown;
  availability: unknown;
  extensions: Record<string, JsonValueSchema>;
  presentation: FernOperationPresentation;
}

function mergePresentation(
  operationId: string,
  values: Array<{ extension: string; value: FernOperationPresentation | undefined }>,
): FernOperationPresentation {
  const result: FernOperationPresentation = {};
  const owners: Partial<Record<keyof FernOperationPresentation, string>> = {};
  for (const { extension, value } of values) {
    if (!value) continue;
    if (value.requireConfirmation !== undefined) {
      if (result.requireConfirmation !== undefined && result.requireConfirmation !== value.requireConfirmation) {
        throw new Error(
          `astro-fern: extensions "${owners.requireConfirmation}" and "${extension}" contribute conflicting requireConfirmation metadata to operation "${operationId}"`,
        );
      }
      result.requireConfirmation = value.requireConfirmation;
      owners.requireConfirmation = extension;
    }
    if (value.routingPriority !== undefined) {
      if (!Number.isFinite(value.routingPriority)) {
        throw new Error(`astro-fern: extension "${extension}" contributed an invalid routing priority`);
      }
      if (result.routingPriority !== undefined && result.routingPriority !== value.routingPriority) {
        throw new Error(
          `astro-fern: extensions "${owners.routingPriority}" and "${extension}" contribute conflicting routing priorities to operation "${operationId}"`,
        );
      }
      result.routingPriority = value.routingPriority;
      owners.routingPriority = extension;
    }
  }
  return result;
}

function operationSdkMetadata(
  context: FernOperationExtensionContext,
  preparedExtensions: readonly PreparedFernExtension[],
): OperationSdkMetadata[] {
  const operationId = context.operation.operationId ?? '<unknown>';
  const contributions = preparedExtensions.map(({ name, schema, operation }) => {
    let contribution;
    try {
      contribution = operation(context);
    } catch (cause) {
      throw new Error(`astro-fern: extension "${name}" failed for operation "${operationId}"`, { cause });
    }
    return { name, schema, contribution };
  });
  const extensions: Record<string, JsonValueSchema> = {};
  for (const { name, schema, contribution } of contributions) {
    if (contribution?.data === undefined) continue;
    extensions[name] = jsonValueSchema.parse(schema.parse(contribution.data));
  }
  const primary: OperationSdkMetadata = {
    projectionId: 'primary',
    groupName: context.operation['x-fern-sdk-group-name'],
    methodName: context.operation['x-fern-sdk-method-name'],
    availability: context.operation['x-fern-availability'],
    extensions,
    presentation: mergePresentation(
      operationId,
      contributions.map(({ name, contribution }) => ({
        extension: name,
        value: contribution?.presentation,
      })),
    ),
  };
  const variants: OperationSdkMetadata[] = [];
  for (const { name, schema, contribution } of contributions) {
    const names = new Set<string>();
    for (const variant of contribution?.variants ?? []) {
      if (!variant.name.trim() || names.has(variant.name)) {
        throw new Error(
          `astro-fern: extension "${name}" returned an invalid or duplicate variant name for operation "${operationId}"`,
        );
      }
      names.add(variant.name);
      const variantExtensions = { ...extensions };
      delete variantExtensions[name];
      if (variant.data !== undefined) {
        variantExtensions[name] = jsonValueSchema.parse(schema.parse(variant.data));
      }
      variants.push({
        projectionId: `${name}:${variant.name}`,
        groupName: variant.sdkGroupName,
        methodName: variant.sdkMethodName,
        availability: variant.availability,
        extensions: variantExtensions,
        presentation: mergePresentation(operationId, [
          ...contributions
            .filter((candidate) => candidate.name !== name)
            .map((candidate) => ({
              extension: candidate.name,
              value: candidate.contribution?.presentation,
            })),
          { extension: name, value: variant.presentation },
        ]),
      });
    }
  }
  return [primary, ...variants];
}

function metadataForProduct(variants: OperationSdkMetadata[], product: FernProductConfig): OperationSdkMetadata[] {
  if (product.sdkGroup) {
    return variants.filter((candidate) => toSdkGroupPath(candidate.groupName, '<unknown>')[0] === product.sdkGroup);
  }
  const primary = variants[0];
  if (!primary) throw new Error('astro-fern: operation has no primary projection');
  return [primary];
}

export function routeSegment(value: string, owner = 'operationId'): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`astro-fern: ${owner} "${value}" cannot form a documentation URL`);
  return slug;
}

function operationPlacement(
  metadata: OperationSdkMetadata,
  product: FernProductConfig,
  operationId: string,
  formatIdentifier: (identifier: string) => string,
): OperationPlacementSchema {
  const groupPath = toSdkGroupPath(metadata.groupName, operationId);
  const methodName = sdkMethodNameSchema.safeParse(metadata.methodName);
  if (!product.sdkGroup || groupPath[0] !== product.sdkGroup || !methodName.success) {
    throw new Error(
      `astro-fern: operation "${operationId}" projection "${metadata.projectionId}" does not have a complete SDK address for product "${product.id}"`,
    );
  }
  return {
    projectionId: metadata.projectionId,
    resourcePath: groupPath.slice(1).map((id) => ({
      id,
      slug: routeSegment(id, 'SDK group segment'),
      title: formatIdentifier(id),
    })),
    method: {
      id: methodName.data,
      slug: routeSegment(methodName.data, 'SDK method name'),
    },
  };
}

function placementSlug(placement: OperationPlacementSchema): string {
  return [...placement.resourcePath.map((segment) => segment.slug), 'methods', placement.method.slug].join('/');
}

function productOwnsOperation(
  product: FernProductConfig,
  pathTemplate: string,
  operation: OperationSchema,
  variants: OperationSdkMetadata[],
): boolean {
  if (product.sdkGroup) {
    return variants.some(
      (metadata) => toSdkGroupPath(metadata.groupName, operation.operationId ?? '<unknown>')[0] === product.sdkGroup,
    );
  }
  if (!product.pathPrefixes) return true;
  return product.pathPrefixes.some(
    (prefix) => prefix === '/' || pathTemplate === prefix || pathTemplate.startsWith(`${prefix}/`),
  );
}

/** Options controlling extension-aware product discovery. */
export interface DiscoverFernProductsOptions {
  /** Extensions whose operation projections participate in discovery. */
  extensions?: readonly FernExtensionDefinition[];
}

/**
 * Derives deterministic product and primary-tag section configuration from Fern
 * SDK group metadata and extension projections in an OpenAPI document.
 */
export function discoverFernProducts(
  source: OpenApiDocumentSchema,
  options: DiscoverFernProductsOptions = {},
): FernProductConfig[] {
  return discoverFernProductsWithPrepared(source, prepareFernExtensions(options.extensions ?? [], source));
}

/** @internal Derives products with extension state shared by the enclosing build. */
export function discoverFernProductsWithPrepared(
  source: OpenApiDocumentSchema,
  preparedExtensions: readonly PreparedFernExtension[],
): FernProductConfig[] {
  const products = new Map<string, Map<string, FernSectionConfig>>();

  for (const [path, pathItem] of Object.entries(source.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation?.operationId || operation['x-fern-ignore'] === true) continue;
      const operationId = operation.operationId;
      const tags = operation.tags ?? [];
      const tag = tags[0];
      const metadata = operationSdkMetadata({ document: source, path, method, operation }, preparedExtensions);
      const projected = metadata.filter((variant) => toSdkGroupPath(variant.groupName, operationId).length > 0);
      if (projected.length === 0) continue;
      if (!tag) {
        throw new Error(`astro-fern: operation "${operationId}" has Fern SDK metadata but no OpenAPI tag`);
      }

      for (const variant of projected) {
        const productId = toSdkGroupPath(variant.groupName, operationId)[0];
        if (!productId) continue;
        let sections = products.get(productId);
        if (!sections) {
          sections = new Map();
          products.set(productId, sections);
        }
        const sectionId = routeSegment(tag, 'OpenAPI tag');
        const existing = sections.get(sectionId);
        if (existing && existing.tag !== tag) {
          throw new Error(
            `astro-fern: OpenAPI tags "${existing.tag}" and "${tag}" collide at section "${productId}.${sectionId}"`,
          );
        }
        sections.set(sectionId, { id: sectionId, tag });
      }
    }
  }

  return [...products]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, sections]) => ({
      id,
      sdkGroup: id,
      sections: [...sections.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    }));
}

function toSnippetParam(node: SchemaNode): SnippetParam {
  const sp: SnippetParam = { name: node.name ?? '', required: node.required, type: node.type };
  if (node.sdkName) sp.sdkName = node.sdkName;
  if (node.enumValues) sp.enumValues = node.enumValues;
  if (node.default !== undefined) sp.default = node.default;
  if (node.children) sp.children = node.children.map(toSnippetParam);
  if (node.items) sp.items = toSnippetParam(node.items);
  if (node.variants) sp.variants = node.variants.map(toSnippetParam);
  if (node.apiFieldPath) sp.apiFieldPath = node.apiFieldPath;
  return sp;
}
function toSnippetOp(op: DocOperation): SnippetOperation {
  const requestBody = op.requestBody
    ? {
        required: op.requestBody.required,
        representations: op.requestBody.representations.map((representation) => ({
          mediaType: representation.mediaType,
          ...(representation.schema ? { schema: toSnippetParam(representation.schema) } : {}),
        })),
      }
    : undefined;
  return {
    path: op.path,
    method: op.httpMethod.toLowerCase(),
    pathParams: op.pathParams.map(toSnippetParam),
    queryParams: op.queryParams.map(toSnippetParam),
    ...(requestBody ? { requestBody } : {}),
  };
}

/** Context supplied to a consumer-owned SDK route collision tie-breaker. */
export interface FernOperationRoutingPreferenceContext {
  /** Original OpenAPI operation. */
  operation: OperationSchema;
  /** Original OpenAPI path template. */
  path: string;
  /** Lowercase OpenAPI HTTP method. */
  method: string;
  /** Product receiving this operation projection. */
  product: FernProductConfig;
  /** SDK resource and method placement for this projection. */
  placement: OperationPlacementSchema;
  /** Generated route relative to the documentation origin. */
  route: string;
  /** Priority already supplied by extensions. */
  routingPriority: number;
}

/** Inputs and policies for building the stable, route-neutral documentation model. */
export interface BuildOptions {
  /** Fern-compatible OpenAPI input, filesystem path, or `file:` URL. */
  source: OpenApiDocumentSchema | string | URL;
  /** Explicit product and OpenAPI-tag section ownership. */
  products: FernProductConfig[];
  /** Identifier → display-label formatter. Defaults to {@link defaultFormatIdentifier}. */
  formatIdentifier?: (identifier: string) => string;
  /** Renders per-operation code samples. When omitted, operations carry no snippets. */
  snippets?: SnippetProvider;
  /** Snapshot IDs to render independently. Omit when building without project snapshot context. */
  snippetSnapshotIds?: string[];
  /** Consumer-owned visibility policy. Return true to omit an otherwise owned operation. */
  isOperationHidden?: (operation: OperationSchema) => boolean;
  /** Secondary SDK collision preference applied only after extension routing priority. */
  operationRoutingPreference?: (context: FernOperationRoutingPreferenceContext) => number | undefined;
  /** Successful-response envelope key exposed to documentation renderers (e.g. "result"). */
  responsePayloadKey?: string;
  /** Synchronous extensions that validate and annotate the source document. */
  extensions?: readonly FernExtensionDefinition[];
  /** Receives recoverable build diagnostics such as suppressed SDK route collisions. */
  onWarning?: (message: string) => void;
}

/**
 * Resolves a Fern-compatible OpenAPI document into the serializable Docs Model.
 *
 * @throws When source or manifest validation fails, a configured section matches
 * no operation, ownership is ambiguous, identities collide, or extension processing fails.
 */
export function buildDocsModel(opts: BuildOptions): DocsModel {
  return buildDocsModelResult(opts).model;
}

interface BuildDocsModelOptions extends BuildOptions {
  /** Project-level snapshot builds validate missing sections across the complete source set. */
  allowMissingSections?: boolean;
}

/** Internal project-build metadata used to distinguish hidden products from unknown products. */
export function buildDocsModelResult(
  opts: BuildDocsModelOptions,
  preparedExtensions?: readonly PreparedFernExtension[],
): {
  model: DocsModel;
  hiddenOnlyProducts: ReadonlySet<string>;
  matchedProducts: ReadonlySet<string>;
  matchedSections: ReadonlySet<string>;
} {
  const doc =
    typeof opts.source === 'string' || opts.source instanceof URL
      ? loadOpenApiDocument(opts.source)
      : preparedExtensions
        ? opts.source
        : parseOpenApiDocument(opts.source);
  const activeExtensions = preparedExtensions ?? prepareFernExtensions(opts.extensions ?? [], doc);
  const description = doc.info?.description;
  const productConfigs = defineFernManifest({ products: opts.products }).products;
  const formatIdentifier = opts.formatIdentifier ?? defaultFormatIdentifier;
  const renderSnippets = opts.snippets;
  const productMap = new Map<string, DocProduct>();
  const knownSections = new Set<string>();
  const knownProducts = new Set<string>();
  const operationIds = new Set<string>();
  const routeSlugs = new Set<string>();
  const resourceSegments = new Map<string, string>();
  const pendingPlacements = new Map<
    string,
    Array<{
      section: DocSection;
      operation: DocOperation;
      priority: number;
      preference: number;
    }>
  >();
  const productSlugs = new Map<string, string>();

  for (const product of productConfigs) {
    const slug = routeSegment(product.id, 'product ID');
    const existing = productSlugs.get(slug);
    if (existing && existing !== product.id) {
      throw new Error(`astro-fern: product IDs "${existing}" and "${product.id}" share URL slug "${slug}"`);
    }
    productSlugs.set(slug, product.id);
  }

  for (const [pathTemplate, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op?.operationId) continue;
      if (op['x-fern-ignore'] === true) continue;
      const variants = operationSdkMetadata(
        { document: doc, path: pathTemplate, method, operation: op },
        activeExtensions,
      );

      const pathOwners = productConfigs.filter((product) => productOwnsOperation(product, pathTemplate, op, variants));
      if (pathOwners.length === 0) continue;
      const tags = new Set(op.tags ?? []);
      const owners = pathOwners.flatMap((product) =>
        product.sections.filter((section) => tags.has(section.tag)).map((section) => ({ product, section })),
      );
      if (owners.length === 0) continue;
      const uniqueOwners = new Map(owners.map((owner) => [`${owner.product.id}\0${owner.section.id}`, owner]));
      const ownerValues = [...uniqueOwners.values()];
      const ownersByProduct = Map.groupBy(ownerValues, (owner) => owner.product.id);
      const ambiguousWithinProduct = [...ownersByProduct.values()].some((productOwners) => productOwners.length > 1);
      const mayDuplicateAcrossProducts = ownerValues.every((owner) => owner.product.sdkGroup !== undefined);
      if (ambiguousWithinProduct || (uniqueOwners.size > 1 && !mayDuplicateAcrossProducts)) {
        throw new Error(`astro-fern: operation "${op.operationId}" matches more than one configured section`);
      }
      for (const { product, section } of ownerValues) {
        knownProducts.add(product.id);
        knownSections.add(`${product.id}\0${section.id}`);
      }
      if (opts.isOperationHidden?.(op)) {
        continue;
      }

      const resolved = resolveOperation(doc, pathItem, method, op, opts.responsePayloadKey);
      for (const { product: productConfig, section: sectionConfig } of ownerValues) {
        const operationKey = `${productConfig.id}\0${op.operationId}`;
        if (operationIds.has(operationKey)) {
          throw new Error(`astro-fern: duplicate operationId "${op.operationId}" in product "${productConfig.id}"`);
        }
        operationIds.add(operationKey);

        let product = productMap.get(productConfig.id);
        if (!product) {
          product = {
            name: productConfig.id,
            title: productConfig.title ?? formatIdentifier(productConfig.id),
            description: productConfig.description ?? `${formatIdentifier(productConfig.id)} API`,
            slug: routeSegment(productConfig.id, 'product ID'),
            sections: [],
          };
          productMap.set(productConfig.id, product);
        }
        let section = product.sections.find((candidate) => candidate.id === sectionConfig.id);
        if (!section) {
          section = {
            id: sectionConfig.id,
            tag: sectionConfig.tag,
            title: sectionConfig.title ?? sectionConfig.tag,
            slug: sectionConfig.id,
            operations: [],
          };
          product.sections.push(section);
        }

        const metadatas = metadataForProduct(variants, productConfig);
        for (const metadata of metadatas) {
          const placement = productConfig.sdkGroup
            ? operationPlacement(metadata, productConfig, op.operationId, formatIdentifier)
            : undefined;
          const slug = placement
            ? placementSlug(placement)
            : `sections/${sectionConfig.id}/operations/${routeSegment(op.operationId)}`;
          const routeKey = `${productConfig.id}/${slug}`;

          if (placement) {
            let parent = productConfig.id;
            for (const segment of placement.resourcePath) {
              const key = `${parent}/${segment.slug}`;
              const existing = resourceSegments.get(key);
              if (existing && existing !== segment.id) {
                throw new Error(
                  `astro-fern: SDK group segments "${existing}" and "${segment.id}" share resource route "${key}"`,
                );
              }
              resourceSegments.set(key, segment.id);
              parent = key;
            }
          } else {
            if (routeSlugs.has(routeKey)) throw new Error(`astro-fern: duplicate documentation route "${routeKey}"`);
            routeSlugs.add(routeKey);
          }

          const availability = toAvailability(metadata.availability);
          const deprecated = op.deprecated === true || availability?.status === 'deprecated';
          const docOp: DocOperation = {
            operationId: op.operationId,
            slug,
            ...(placement ? { placement } : {}),
            title: op.summary?.trim() || formatIdentifier(op.operationId),
            httpMethod: resolved.method.toUpperCase(),
            path: pathTemplate,
            description: resolved.description,
            deprecated,
            extensions: metadata.extensions,
            examples: resolved.examples,
            pathParams: resolved.pathParams,
            queryParams: resolved.queryParams,
            requestBody: resolved.requestBody,
            responses: resolved.responses,
            snippets: [],
          };
          if (availability) docOp.availability = availability;
          if (metadata.presentation.requireConfirmation) {
            docOp.requireConfirmation = metadata.presentation.requireConfirmation;
          }
          if (renderSnippets) {
            const accessorPath = toSdkGroupPath(metadata.groupName, op.operationId);
            const parsedMethodName = sdkMethodNameSchema.safeParse(metadata.methodName);
            const methodName = parsedMethodName.success ? parsedMethodName.data : op.operationId;
            const snippetInput = { op: toSnippetOp(docOp), accessorPath, methodName };
            docOp.snippets = opts.snippetSnapshotIds
              ? opts.snippetSnapshotIds.flatMap((snapshotId) =>
                  renderSnippets({ ...snippetInput, snapshotId }).map((snippet) => ({ ...snippet, snapshotId })),
                )
              : renderSnippets(snippetInput);
          }

          if (!placement) {
            section.operations.push(docOp);
            continue;
          }
          const priority = metadata.presentation.routingPriority ?? 0;
          const preference =
            opts.operationRoutingPreference?.({
              operation: op,
              path: pathTemplate,
              method,
              product: productConfig,
              placement,
              route: `/${product.slug}/${slug}/`,
              routingPriority: priority,
            }) ?? 0;
          if (!Number.isFinite(preference)) {
            throw new Error(`astro-fern: operation routing preference for "${op.operationId}" must be a finite number`);
          }
          const pending = pendingPlacements.get(routeKey) ?? [];
          pending.push({
            section,
            operation: docOp,
            priority,
            preference,
          });
          pendingPlacements.set(routeKey, pending);
        }
      }
    }
  }

  const warn = opts.onWarning ?? ((message: string) => console.warn(`[astro-fern] ${message}`));
  for (const [route, candidates] of pendingPlacements) {
    if (candidates.length === 1) {
      const candidate = candidates[0];
      if (candidate) candidate.section.operations.push(candidate.operation);
      continue;
    }
    const priority = Math.max(...candidates.map((candidate) => candidate.priority));
    const prioritized = candidates.filter((candidate) => candidate.priority === priority);
    const preference = Math.max(...prioritized.map((candidate) => candidate.preference));
    const preferred = prioritized.filter((candidate) => candidate.preference === preference);
    const winner = preferred.length === 1 ? preferred[0] : undefined;
    if (winner) {
      winner.section.operations.push(winner.operation);
      continue;
    }
    const selectionPolicy = opts.operationRoutingPreference
      ? 'extension routing priorities and the configured operation routing preference'
      : 'extension routing priorities';
    warn(
      [
        `Documentation URL conflict: "/${route}/"`,
        `  ${candidates.length} OpenAPI operation mappings point to this URL:`,
        ...candidates.map(
          (candidate) =>
            `  - ${candidate.operation.httpMethod} ${candidate.operation.path} (operation ID: "${candidate.operation.operationId}")`,
        ),
        `  Result: no page was generated because ${preferred.length} mappings remained tied after applying ${selectionPolicy}.`,
        '  Fix: give each operation a unique x-fern-sdk-group-name and x-fern-sdk-method-name, or adjust routing priorities or preferences so exactly one mapping wins.',
      ].join('\n'),
    );
  }

  if (!opts.allowMissingSections) {
    for (const product of productConfigs) {
      for (const section of product.sections) {
        if (!knownSections.has(`${product.id}\0${section.id}`)) {
          throw new Error(
            `astro-fern: section "${product.id}.${section.id}" did not match OpenAPI tag "${section.tag}" in the Fern source`,
          );
        }
      }
    }
  }
  const products = productConfigs
    .map((config) => productMap.get(config.id))
    .filter((product): product is DocProduct => product !== undefined)
    .map((product) => ({
      ...product,
      sections: product.sections.filter((section) => section.operations.length > 0),
    }))
    .filter((product) => product.sections.length > 0);
  for (const product of products) {
    const config = productConfigs.find((candidate) => candidate.id === product.name);
    if (!config) throw new Error(`astro-fern: missing configuration for product "${product.name}"`);
    const order = new Map(config.sections.map((section, index) => [section.id, index]));
    const sectionOrder = (sectionId: string): number => {
      const index = order.get(sectionId);
      if (index === undefined) {
        throw new Error(`astro-fern: missing configuration for section "${product.name}.${sectionId}"`);
      }
      return index;
    };
    product.sections.sort((a, b) => sectionOrder(a.id) - sectionOrder(b.id));
    for (const section of product.sections) {
      section.operations.sort((a, b) => a.title.localeCompare(b.title) || a.operationId.localeCompare(b.operationId));
    }
  }
  const visibleProducts = new Set(products.map((product) => product.name));
  const hiddenOnlyProducts = new Set([...knownProducts].filter((product) => !visibleProducts.has(product)));
  return {
    model: { ...(description !== undefined ? { description } : {}), products },
    hiddenOnlyProducts,
    matchedProducts: knownProducts,
    matchedSections: knownSections,
  };
}
