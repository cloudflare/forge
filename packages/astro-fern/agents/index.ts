import type {
  FernContentCatalogSchema,
  JsonValueSchema,
  RenderedOperationResponseSchema,
  RenderedOperationSchema,
  OperationCodeSampleSchema,
  OperationExampleSchema,
  RenderedResponseExampleSchema,
  RenderedResponseRepresentationSchema,
  RenderedSchemaNodeSchema,
} from '../content/schema.ts';
import { isJsonMediaType, preferredRequestRepresentation } from '../content/request-body.ts';
import { classifyResponseStatus } from '../content/response.ts';
import type { FernAgentRoute, FernExecutionTargetSchema, FernPageSchema, FernProjectView } from '../route-plan.ts';

/** Rendered agent document and its HTTP content type. */
export interface AgentDocument {
  /** Complete UTF-8 Markdown source. */
  body: string;
  /** Content-Type header value expected by response helpers. */
  contentType: 'text/markdown; charset=utf-8';
}

/** Semantic lookup for one human or Markdown representation of an operation. */
export interface SemanticOperationHrefRequest {
  kind: 'operation';
  representation: 'human' | 'markdown';
  productId: string;
  snapshotId: string;
  operationId: string;
  /** Projection identity for an aliased SDK placement; defaults to the primary projection. */
  projectionId?: string;
  targetId?: string;
}

/** Semantic lookup for an llms.txt index at one supported scope. */
export type SemanticLlmsHrefRequest =
  | { kind: 'llms'; scope: 'site' }
  | { kind: 'llms'; scope: 'product'; productId: string }
  | { kind: 'llms'; scope: 'snapshot'; productId: string; snapshotId: string }
  | { kind: 'llms'; scope: 'target'; productId: string; snapshotId: string; targetId: string };

/** Route-independent link request emitted while rendering agent documents. */
export type SemanticHrefRequest = SemanticOperationHrefRequest | SemanticLlmsHrefRequest;

/**
 * Resolves a semantic document identity to a public URL.
 * Returning `undefined` omits that relationship from the rendered document.
 */
export type SemanticHrefResolver = (request: SemanticHrefRequest) => string | undefined;

/** Controls target selection, directives, and related links in operation Markdown. */
export interface RenderPageMarkdownOptions {
  /** Emit only this execution target; omit to include every target. */
  target?: string;
  /** Banner prepended to the document, or `false` to suppress it. */
  directive?: string | false;
  /** Optional semantic resolver used instead of links already stored on the page. */
  resolveHref?: SemanticHrefResolver;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function markdownBlock(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function markdownQuote(value: string): string {
  return markdownBlock(value)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function markdownCode(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = '`'.repeat(Math.max(1, longestRun + 1));
  const padding = /^`|`$|^ | $/.test(value) ? ' ' : '';
  return `${fence}${padding}${value}${padding}${fence}`;
}

function markdownFence(value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(([run]) => run.length));
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function isTextResponseMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    essence.startsWith('text/') ||
    essence === 'application/ndjson' ||
    essence === 'application/x-ndjson' ||
    essence === 'application/jsonl' ||
    essence === 'application/jsonlines' ||
    essence.endsWith('+ndjson')
  );
}

function escapeMarkdownText(value: string): string {
  const special = new Set(['\\', '`', '*', '_', '[', ']', '<', '>']);
  return [...clean(value)].map((character) => (special.has(character) ? `\\${character}` : character)).join('');
}

function headingName(node: RenderedSchemaNodeSchema): string {
  if (node.name) return `\`${node.name}\``;
  return node.title ?? node.type;
}

function schemaLines(nodes: RenderedSchemaNodeSchema[], depth = 3): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${'#'.repeat(Math.min(depth, 6))} ${headingName(node)}`, '', `Type: \`${node.type}\`  `);
    if (node.format) lines.push(`Format: \`${node.format}\`  `);
    if (node.name) lines.push(`Required: ${node.required ? 'yes' : 'no'}  `);
    if (node.enumValues?.length) {
      if (node.enumValueMetadata?.length) {
        lines.push('Allowed values:', '');
        for (const value of node.enumValues) {
          const metadata = node.enumValueMetadata.find((entry) => Object.is(entry.value, value));
          lines.push(`- ${markdownCode(String(value))}${metadata?.deprecated ? ' (deprecated)' : ''}`);
          if (metadata?.description) {
            lines.push(`  ${metadata.description.markdown.replaceAll('\n', '\n  ')}`);
          }
        }
        lines.push('');
      } else {
        lines.push(`Allowed values: ${node.enumValues.map((value) => markdownCode(String(value))).join(', ')}  `);
      }
    }
    if (node.default !== undefined) lines.push(`Default: \`${String(node.default)}\`  `);
    if (node.deprecated) lines.push('Deprecated: yes  ');
    // Agents consume the raw Markdown source, not the rendered HTML.
    if (node.description) lines.push('', markdownBlock(node.description.markdown));
    lines.push('');
    if (node.children?.length) lines.push(...schemaLines(node.children, depth + 1));
    if (node.items) lines.push(...schemaLines([node.items], depth + 1));
    if (node.variants?.length) lines.push(...schemaLines(node.variants, depth + 1));
  }
  return lines;
}

function topLevelNodes(node: RenderedSchemaNodeSchema | null): RenderedSchemaNodeSchema[] {
  if (!node) return [];
  if (node.children?.length) return node.children;
  if (node.variants?.length) return node.variants;
  return [node];
}

function targetLines(target: FernExecutionTargetSchema): string[] {
  const lines = [`## Execute with ${target.label}`, ''];
  if (target.packageName) lines.push(`Package: \`${target.packageName}\`  `);
  if (target.version) lines.push(`Version: \`${target.version}\`  `);
  if (target.packageName || target.version) lines.push('');
  if (target.code) lines.push(`\`\`\`${target.syntax}`, target.code, '```', '');
  else lines.push(`A ${target.label} example is not available yet.`, '');
  return lines;
}

function exampleValueLines(value: JsonValueSchema, mediaType: string): string[] {
  const rawText = typeof value === 'string' && (isTextResponseMediaType(mediaType) || !isJsonMediaType(mediaType));
  const code = rawText ? value : (JSON.stringify(value, null, 2) ?? 'null');
  const fence = markdownFence(code);
  const syntax = rawText ? 'text' : isJsonMediaType(mediaType) ? 'json' : '';
  return [`${fence}${syntax}`, code, fence, ''];
}

function explicitExampleLines(
  example: RenderedResponseExampleSchema,
  representation: RenderedResponseRepresentationSchema,
): string[] {
  const title = example.name !== undefined ? `Example ${markdownCode(example.name)}` : 'Example';
  const lines = [`##### ${title}`, ''];
  if (example.summary) lines.push(`Summary: ${clean(example.summary)}  `);
  if (example.description) lines.push('', markdownBlock(example.description.markdown), '');
  if (example.externalValue) lines.push(`External value: ${clean(example.externalValue)}  `, '');
  if (example.value !== undefined) lines.push(...exampleValueLines(example.value, representation.mediaType));
  return lines;
}

function responseRepresentationLines(representation: RenderedResponseRepresentationSchema): string[] {
  const lines = [`#### ${markdownCode(representation.mediaType)}`, ''];
  if (representation.payloadKey)
    lines.push(`Documentation payload key: ${markdownCode(representation.payloadKey)}  `, '');
  for (const example of representation.examples) lines.push(...explicitExampleLines(example, representation));
  if (representation.examples.length === 0 && representation.generatedExample !== undefined) {
    lines.push(
      '##### Generated example',
      '',
      ...exampleValueLines(representation.generatedExample, representation.mediaType),
    );
  }
  if (representation.schema) lines.push('##### Schema', '', ...schemaLines([representation.schema], 6));
  return lines;
}

function responseLines(response: RenderedOperationResponseSchema): string[] {
  const lines = [
    `### Response ${markdownCode(response.status)}`,
    '',
    `Category: ${classifyResponseStatus(response.status)}  `,
    '',
  ];
  if (response.description.markdown) lines.push(markdownBlock(response.description.markdown), '');
  for (const representation of response.representations) {
    lines.push(...responseRepresentationLines(representation));
  }
  return lines;
}

function lifecycleLines(operation: RenderedOperationSchema): string[] {
  if (operation.deprecated) {
    const message = operation.availability?.status === 'deprecated' ? operation.availability.message : undefined;
    return [`- Availability: deprecated${message ? ` (${clean(message)})` : ''}`];
  }
  if (!operation.availability) return [];
  return [
    `- Availability: ${operation.availability.status}${
      operation.availability.message ? ` (${operation.availability.message})` : ''
    }`,
  ];
}

function codeSampleName(sample: OperationCodeSampleSchema): string {
  return sample.kind === 'sdk' ? sample.sdk : sample.language;
}

function codeSampleSyntax(sample: OperationCodeSampleSchema): string {
  const value = codeSampleName(sample).toLowerCase();
  return /^[a-z0-9_+#.-]+$/.test(value) ? value : 'text';
}

function fencedLines(code: string, syntax: string): string[] {
  const fence = markdownFence(code);
  return [`${fence}${syntax}`, code, fence, ''];
}

function operationExampleLines(example: OperationExampleSchema, index: number): string[] {
  const lines = [`### ${escapeMarkdownText(example.name ?? `Example ${index + 1}`)}`, ''];
  const requestParts: Array<[string, JsonValueSchema | undefined, string]> = [
    ['Path parameters', example.request?.pathParameters, 'application/json'],
    ['Query parameters', example.request?.queryParameters, 'application/json'],
    ['Headers', example.request?.headers, 'application/json'],
    ['Body', example.request?.body, example.request?.bodyMediaType ?? 'application/json'],
  ];
  const populated = requestParts.filter((part): part is [string, JsonValueSchema, string] => part[1] !== undefined);
  if (populated.length > 0) {
    lines.push('#### Request', '');
    for (const [label, value, mediaType] of populated) {
      lines.push(`##### ${label}`, '', ...exampleValueLines(value, mediaType));
    }
  }
  for (const sample of example.codeSamples) {
    lines.push(`#### Custom code sample: ${escapeMarkdownText(codeSampleName(sample))}`, '');
    if (sample.kind === 'language' && sample.install) {
      lines.push('##### Install', '', ...fencedLines(sample.install, 'sh'));
    }
    lines.push(...fencedLines(sample.code, codeSampleSyntax(sample)));
  }
  if (example.response) {
    lines.push(
      '#### Response body',
      '',
      ...exampleValueLines(example.response.body, example.response.mediaType ?? 'application/json'),
    );
  }
  if (populated.length === 0 && example.codeSamples.length === 0 && !example.response) {
    lines.push('No values are declared for this example.', '');
  }
  return lines;
}

/**
 * Renders a fully composed operation page as agent-oriented Markdown.
 * The output includes lifecycle metadata, parameters, request/response schemas,
 * examples, execution snippets, and related representations.
 */
export function renderPageMarkdown(page: FernPageSchema, options: RenderPageMarkdownOptions = {}): AgentDocument {
  const operation = page.operation;
  const lines: string[] = [];
  if (options.directive) lines.push(options.directive, '');
  lines.push(
    `# ${operation.title}`,
    '',
    ...(operation.description.markdown ? [markdownQuote(operation.description.markdown), ''] : []),
  );
  if (operation.requireConfirmation) {
    lines.push(`> **Destructive operation:** ${escapeMarkdownText(operation.requireConfirmation)}`, '');
  }
  lines.push(
    `- Product: ${page.product.title}`,
    `- Section: ${page.section.title}`,
    `- Snapshot: ${page.snapshot.label}`,
    `- Method: \`${operation.httpMethod}\``,
    `- Path: \`${operation.path}\``,
    ...lifecycleLines(operation),
    '',
  );
  if (operation.pathParams.length) lines.push('## Path parameters', '', ...schemaLines(operation.pathParams));
  if (operation.queryParams.length) lines.push('## Query parameters', '', ...schemaLines(operation.queryParams));
  if (operation.requestBody) {
    const representation = preferredRequestRepresentation(operation.requestBody.representations);
    lines.push(
      '## Request body',
      '',
      `Required: ${operation.requestBody.required ? 'yes' : 'no'}  `,
      `Content types: ${
        operation.requestBody.representations.length > 0
          ? operation.requestBody.representations.map(({ mediaType }) => markdownCode(mediaType)).join(', ')
          : 'none declared'
      }  `,
    );
    if (operation.requestBody.description) lines.push('', markdownBlock(operation.requestBody.description.markdown));
    if (representation?.schema) {
      lines.push(
        '',
        ...(operation.requestBody.representations.length > 1
          ? [`Schema shown for: ${markdownCode(representation.mediaType)}`, '']
          : []),
        ...schemaLines(topLevelNodes(representation.schema)),
      );
    } else {
      lines.push('');
    }
  }
  if (operation.examples?.length) {
    lines.push('## Examples', '');
    operation.examples.forEach((example, index) => lines.push(...operationExampleLines(example, index)));
  }
  const targets = options.target ? page.targets.filter((target) => target.id === options.target) : page.targets;
  for (const target of targets) lines.push(...targetLines(target));
  if (operation.responses.length) {
    lines.push('## Responses', '');
    for (const response of operation.responses) lines.push(...responseLines(response));
  }
  if (!options.resolveHref) {
    lines.push(
      '## Related representations',
      '',
      `- [Human documentation](${page.pathname})`,
      ...page.targets
        .filter((target) => target.markdownHref)
        .map((target) => `- [${target.label} Markdown](${target.markdownHref})`),
      ...page.agentLinks.llms.map((link) => `- [${link.scope} llms.txt](${link.href})`),
      '',
    );
  } else {
    const identity = {
      productId: page.product.id,
      snapshotId: page.snapshot.id,
      operationId: operation.operationId,
      ...(operation.placement ? { projectionId: operation.placement.projectionId } : {}),
    };
    const related: string[] = [];
    const humanHref = options.resolveHref({
      kind: 'operation',
      representation: 'human',
      ...identity,
      ...(options.target !== undefined ? { targetId: options.target } : {}),
    });
    if (humanHref !== undefined) related.push(`- [Human documentation](${humanHref})`);
    for (const target of page.targets) {
      const href = options.resolveHref({
        kind: 'operation',
        representation: 'markdown',
        ...identity,
        targetId: target.id,
      });
      if (href !== undefined) related.push(`- [${target.label} Markdown](${href})`);
    }
    const llmsRequests: SemanticLlmsHrefRequest[] = [
      { kind: 'llms', scope: 'site' },
      { kind: 'llms', scope: 'product', productId: page.product.id },
      {
        kind: 'llms',
        scope: 'snapshot',
        productId: page.product.id,
        snapshotId: page.snapshot.id,
      },
    ];
    for (const request of llmsRequests) {
      const href = options.resolveHref(request);
      if (href !== undefined) related.push(`- [${request.scope} llms.txt](${href})`);
    }
    lines.push('## Related representations', '', ...related, '');
  }
  return { body: lines.join('\n'), contentType: 'text/markdown; charset=utf-8' };
}

function routeHref(data: FernProjectView, pathname: string): string {
  return data.site ? new URL(pathname, data.site).href : pathname;
}

function summary(value: string): string {
  const first = clean(value).split(/(?<=[.!?])\s/, 1)[0];
  return first || 'API reference documentation.';
}

type CatalogProduct = FernContentCatalogSchema['products'][number];
type CatalogSnapshot = CatalogProduct['snapshots'][number];

function catalogProduct(catalog: FernContentCatalogSchema, productId: string): CatalogProduct {
  const product = catalog.products.find((item) => item.id === productId);
  if (!product) {
    throw new Error(
      `astro-fern: semantic product ID "${productId}" is not in the catalog; use an ID from catalog.products`,
    );
  }
  return product;
}

function catalogSnapshot(product: CatalogProduct, snapshotId: string): CatalogSnapshot {
  const snapshot = product.snapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    throw new Error(
      `astro-fern: product "${product.id}" is unavailable in semantic snapshot "${snapshotId}"; use an ID from that product's snapshots or omit the product from this scope`,
    );
  }
  return snapshot;
}

function catalogDefaultSnapshot(product: CatalogProduct): CatalogSnapshot {
  const snapshots = product.snapshots.filter((snapshot) => snapshot.default);
  const snapshot = snapshots[0];
  if (!snapshot) {
    throw new Error(
      `astro-fern: product "${product.id}" is unavailable in the global default snapshot; request an available snapshot scope instead of a product scope`,
    );
  }
  if (snapshots.length !== 1) {
    throw new Error(
      `astro-fern: product "${product.id}" has ${snapshots.length} default snapshots; regenerate the catalog with exactly one global default snapshot`,
    );
  }
  return snapshot;
}

function catalogSelection(
  catalog: FernContentCatalogSchema,
  request: SemanticLlmsHrefRequest,
): { product?: CatalogProduct; snapshot?: CatalogSnapshot } {
  if (request.scope === 'site') return {};
  const product = catalogProduct(catalog, request.productId);
  if (request.scope === 'product') return { product, snapshot: catalogDefaultSnapshot(product) };
  const snapshot = catalogSnapshot(product, request.snapshotId);
  if (request.scope === 'target' && !snapshot.targets.some((target) => target.id === request.targetId)) {
    throw new Error(
      `astro-fern: target "${request.targetId}" is unavailable for product "${product.id}" snapshot "${snapshot.id}"; use an ID from that snapshot's targets`,
    );
  }
  return { product, snapshot };
}

/**
 * Renders an llms.txt index from the compact route-neutral catalog.
 * `resolveHref` binds canonical identities to deployment-specific public URLs.
 *
 * @throws When the requested product, snapshot, or target identity is invalid.
 */
export function renderLlmsIndexFromCatalog(
  catalog: FernContentCatalogSchema,
  request: SemanticLlmsHrefRequest,
  resolveHref: SemanticHrefResolver,
): AgentDocument {
  const { product, snapshot } = catalogSelection(catalog, request);
  const title = [
    product?.title,
    snapshot && !snapshot.default ? snapshot.label : undefined,
    request.scope === 'target' ? request.targetId : undefined,
  ]
    .filter(Boolean)
    .join(' - ');
  const lines: string[] = [`# ${title || 'API documentation'}`, ''];
  if (!product) {
    lines.push('## Products', '');
    for (const item of catalog.products) {
      const href = resolveHref({ kind: 'llms', scope: 'product', productId: item.id });
      const label = href === undefined ? item.title : `[${item.title}](${href})`;
      lines.push(`- ${label}: ${summary(item.description)}`);
    }
  } else if (snapshot) {
    lines.push(`> ${summary(product.description)}`, '', '## API operations', '');
    const targetId = request.scope === 'target' ? request.targetId : undefined;
    for (const section of snapshot.sections) {
      const operations: string[] = [];
      for (const operation of section.operations) {
        const identity = {
          productId: product.id,
          snapshotId: snapshot.id,
          operationId: operation.operationId,
          ...(operation.placement ? { projectionId: operation.placement.projectionId } : {}),
          ...(targetId !== undefined ? { targetId } : {}),
        };
        const markdownHref = resolveHref({ kind: 'operation', representation: 'markdown', ...identity });
        const href = markdownHref ?? resolveHref({ kind: 'operation', representation: 'human', ...identity });
        if (href !== undefined) {
          operations.push(
            `- [${operation.title}](${href}): ${operation.httpMethod} - ${summary(operation.description)}`,
          );
        }
      }
      if (operations.length) lines.push(`### ${section.title}`, '', ...operations);
    }
    lines.push('', '## Execution targets', '');
    for (const target of snapshot.targets) {
      const href = resolveHref({
        kind: 'llms',
        scope: 'target',
        productId: product.id,
        snapshotId: snapshot.id,
        targetId: target.id,
      });
      lines.push(href === undefined ? `- ${target.label}` : `- [${target.label}](${href})`);
    }
  }
  lines.push('');
  return { body: lines.join('\n'), contentType: 'text/markdown; charset=utf-8' };
}

/**
 * Renders an llms.txt index from an eager, fully composed project view.
 * Prefer {@link renderLlmsIndexFromCatalog} in server integrations that keep
 * operation artifacts lazy.
 */
export function renderLlmsIndex(data: FernProjectView, route: FernAgentRoute): AgentDocument {
  const scope = route.scope ?? {};
  const product = scope.product ? data.catalog.products.find((item) => item.id === scope.product) : undefined;
  const snapshot = product
    ? (product.snapshots.find((item) => item.id === scope.snapshot) ?? product.snapshots.find((item) => item.default))
    : undefined;
  const title = [product?.title, snapshot && !snapshot.default ? snapshot.label : undefined, scope.target]
    .filter(Boolean)
    .join(' - ');
  const lines: string[] = [`# ${title || 'API documentation'}`, ''];
  if (!product) {
    lines.push('## Products', '');
    for (const item of data.catalog.products) {
      const productRoute = data.agentRoutes.find(
        (candidate) => candidate.scopeKind === 'product' && candidate.scope?.product === item.id,
      );
      const label = productRoute ? `[${item.title}](${routeHref(data, productRoute.pathname)})` : item.title;
      lines.push(`- ${label}: ${summary(item.description)}`);
    }
  } else if (snapshot) {
    lines.push(`> ${summary(product.description)}`, '', '## API operations', '');
    let sectionId: string | undefined;
    const documents = new Map(data.pages.map((page) => [page.id, page]));
    for (const page of snapshot.pages) {
      const document = documents.get(page.id);
      if (!document) continue;
      if (page.section.id !== sectionId) {
        sectionId = page.section.id;
        lines.push(`### ${page.section.title}`, '');
      }
      // Prefer the agent-native Markdown representation; when Markdown routes are
      // disabled, fall back to the human page so the index stays navigable rather
      // than dropping the operation entirely.
      const scoped = scope.target ? document.targets.find((target) => target.id === scope.target) : undefined;
      const href = scope.target
        ? (scoped?.markdownHref ?? scoped?.href)
        : (document.agentLinks.markdown?.href ?? document.pathname);
      if (href)
        lines.push(`- [${page.title}](${routeHref(data, href)}): ${page.httpMethod} - ${summary(page.description)}`);
    }
    lines.push('', '## Execution targets', '');
    for (const target of snapshot.targets) {
      const targetRoute = data.agentRoutes.find(
        (candidate) =>
          candidate.scopeKind === 'target' &&
          candidate.scope?.product === product.id &&
          candidate.scope.snapshot === snapshot.id &&
          candidate.scope.target === target.id,
      );
      const label = targetRoute ? `[${target.label}](${routeHref(data, targetRoute.pathname)})` : target.label;
      lines.push(`- ${label}`);
    }
  }
  lines.push('');
  return { body: lines.join('\n'), contentType: 'text/markdown; charset=utf-8' };
}
