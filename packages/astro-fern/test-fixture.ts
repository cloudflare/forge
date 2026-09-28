import { interpolatePath } from './snippets/index.ts';
import { createSnippetProvider } from './snippets/index.ts';
import { defineFernManifest } from './manifest.ts';
import type { FernProductConfig } from './manifest.ts';
import { defineFernProject, type FernProjectOptions } from './project.ts';
import type { OpenApiDocumentSchema } from './content/openapi.ts';
import { defineFernExtension } from './extensions.ts';
import { z } from 'astro/zod';
import type {
  DocOperation,
  OperationResponse,
  RequestBody,
  ResponseExample,
  ResponseRepresentation,
  SchemaNode,
} from './content/model.ts';
import type {
  FernContentOperationEntrySchema,
  RenderedOperationResponseSchema,
  RenderedOperationSchema,
  RenderedRequestBodySchema,
  RenderedResponseExampleSchema,
  RenderedResponseRepresentationSchema,
  RenderedSchemaNodeSchema,
  RichTextSchema,
} from './content/schema.ts';
import type { JsonValueSchema } from './content/schema.ts';
import { composeFernProject, type FernDeploymentConfig, type FernProjectData } from './route-plan.ts';
import { type AstroFernIntegrationOptions, type FernTargetRouting, resolveRuntimeConfig } from './runtime-config.ts';
import { FERN_ARTIFACT_FORMAT_VERSION } from './content-contract.ts';

/**
 * A tiny, product-agnostic OpenAPI fixture (a "Widgets" API) used by the unit
 * tests. It carries no Cloudflare-specific vendor extensions, and its
 * descriptions embed Markdown links so tests can assert the raw Markdown
 * survives into the source model (and is enriched to HTML by the loader).
 */
export const widgetsSpec: OpenApiDocumentSchema = {
  info: {
    description: 'Welcome to the **Widgets API**. Read the [guide](https://example.com/widgets).',
  },
  paths: {
    '/widgets/{widget_id}': {
      patch: {
        operationId: 'widgets_update',
        summary: 'Update widget',
        description: 'Updates a [widget](https://example.com/widgets) by ID.',
        tags: ['Widget Management'],
        'x-fern-sdk-group-name': 'widgets.items',
        'x-fern-sdk-method-name': 'update',
        'x-fern-availability': 'generally-available',
        parameters: [
          {
            name: 'widget_id',
            in: 'path',
            required: true,
            description: 'The [widget](https://example.com/widgets) ID.',
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          required: true,
          description: 'Fields to update on the [widget](https://example.com/widgets).',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', description: "The widget's display [name](https://example.com/naming)." },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The updated [widget](https://example.com/widgets).',
            content: {
              'application/json': {
                examples: {
                  updated: {
                    summary: 'Updated widget',
                    description: 'A complete **widget** response.',
                    value: { id: 'id', name: 'name' },
                  },
                  null: { value: null },
                  empty: { value: {} },
                },
                schema: {
                  type: 'object',
                  properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const widgetsProduct: FernProductConfig = {
  id: 'widgets',
  sections: [{ id: 'management', tag: 'Widget Management' }],
};

const fixtureAliasSchema = z.looseObject({
  'x-fern-sdk-group-name': z.unknown().optional(),
  'x-fern-sdk-method-name': z.unknown().optional(),
  'x-fern-availability': z.unknown().optional(),
  'x-test-confirmation': z.string().min(1).optional(),
});
const fixtureAliasesSchema = z.array(fixtureAliasSchema).optional().default([]);
const fixtureConfirmationSchema = z.string().min(1).optional();

/** Generic fixture extension used to exercise extension projections and presentation metadata. */
export const fixtureExtension = defineFernExtension<JsonValueSchema>({
  name: 'fixture',
  schema: z.json(),
  operation({ operation }) {
    const confirmation = fixtureConfirmationSchema.parse(operation['x-test-confirmation']);
    const aliases = fixtureAliasesSchema.parse(operation['x-test-aliases']);
    return {
      data: { source: 'primary' },
      presentation: confirmation ? { requireConfirmation: confirmation } : {},
      variants: aliases.map((alias, index) => {
        return {
          name: `alias-${index + 1}`,
          sdkGroupName: alias['x-fern-sdk-group-name'],
          sdkMethodName: alias['x-fern-sdk-method-name'],
          availability: alias['x-fern-availability'],
          data: { source: `alias-${index + 1}` },
          presentation: alias['x-test-confirmation'] ? { requireConfirmation: alias['x-test-confirmation'] } : {},
        };
      }),
    };
  },
});

/** A generic snippet provider for the fixture's two targets (curl + Python). */
export const fixtureSnippets = createSnippetProvider(
  {
    curl: {
      label: 'curl',
      syntax: 'bash',
      render: ({ op }) => `curl -X ${op.method.toUpperCase()} https://api.example.com${interpolatePath(op.path)}`,
    },
    python: {
      label: 'Python',
      syntax: 'python',
      render: ({ accessorPath, methodName }) => `client.${[...accessorPath, methodName].join('.')}()`,
    },
  },
  ['curl', 'python'],
);

export interface TestProject {
  getData(): FernProjectData;
}

function renderNode(node: SchemaNode, render: (markdown: string) => RichTextSchema): RenderedSchemaNodeSchema {
  const out: RenderedSchemaNodeSchema = { type: node.type, required: node.required };
  if (node.name !== undefined) out.name = node.name;
  if (node.sdkName !== undefined) out.sdkName = node.sdkName;
  if (node.title !== undefined) out.title = node.title;
  if (node.format !== undefined) out.format = node.format;
  if (node.description) out.description = render(node.description);
  if (node.enumValues) out.enumValues = node.enumValues;
  if (node.enumValueMetadata) {
    out.enumValueMetadata = node.enumValueMetadata.map((metadata) => ({
      value: metadata.value,
      ...(metadata.description ? { description: render(metadata.description) } : {}),
      ...(metadata.deprecated ? { deprecated: true } : {}),
    }));
  }
  if (node.default !== undefined) out.default = node.default;
  if (node.deprecated) out.deprecated = true;
  if (node.children) out.children = node.children.map((child) => renderNode(child, render));
  if (node.items) out.items = renderNode(node.items, render);
  if (node.variants) out.variants = node.variants.map((variant) => renderNode(variant, render));
  if (node.apiFieldPath) out.apiFieldPath = node.apiFieldPath;
  return out;
}

function renderRequestBody(body: RequestBody, render: (markdown: string) => RichTextSchema): RenderedRequestBodySchema {
  return {
    required: body.required,
    ...(body.description ? { description: render(body.description) } : {}),
    representations: body.representations.map((representation) => ({
      mediaType: representation.mediaType,
      schema: representation.schema ? renderNode(representation.schema, render) : null,
    })),
  };
}

function renderResponseExample(
  example: ResponseExample,
  render: (markdown: string) => RichTextSchema,
): RenderedResponseExampleSchema {
  const out: RenderedResponseExampleSchema = {};
  if (example.name !== undefined) out.name = example.name;
  if (example.summary !== undefined) out.summary = example.summary;
  if (example.description !== undefined) out.description = render(example.description);
  if (example.value !== undefined) out.value = example.value;
  if (example.externalValue !== undefined) out.externalValue = example.externalValue;
  return out;
}

function renderResponseRepresentation(
  representation: ResponseRepresentation,
  render: (markdown: string) => RichTextSchema,
): RenderedResponseRepresentationSchema {
  const out: RenderedResponseRepresentationSchema = {
    mediaType: representation.mediaType,
    schema: representation.schema ? renderNode(representation.schema, render) : null,
    examples: representation.examples.map((example) => renderResponseExample(example, render)),
  };
  if (representation.payloadKey !== undefined) out.payloadKey = representation.payloadKey;
  if (representation.generatedExample !== undefined) out.generatedExample = representation.generatedExample;
  return out;
}

function renderResponse(
  response: OperationResponse,
  render: (markdown: string) => RichTextSchema,
): RenderedOperationResponseSchema {
  return {
    status: response.status,
    description: render(response.description),
    representations: response.representations.map((representation) =>
      renderResponseRepresentation(representation, render),
    ),
  };
}

function renderOperation(
  operation: DocOperation,
  render: (markdown: string) => RichTextSchema,
): RenderedOperationSchema {
  const out: RenderedOperationSchema = {
    operationId: operation.operationId,
    slug: operation.slug,
    title: operation.title,
    httpMethod: operation.httpMethod,
    path: operation.path,
    description: render(operation.description),
    deprecated: operation.deprecated,
    extensions: operation.extensions,
    examples: operation.examples ?? [],
    pathParams: operation.pathParams.map((node) => renderNode(node, render)),
    queryParams: operation.queryParams.map((node) => renderNode(node, render)),
    requestBody: operation.requestBody ? renderRequestBody(operation.requestBody, render) : null,
    responses: operation.responses.map((response) => renderResponse(response, render)),
  };
  if (operation.availability) out.availability = operation.availability;
  if (operation.requireConfirmation) out.requireConfirmation = operation.requireConfirmation;
  return out;
}

export function testProject(
  contentOptions: FernProjectOptions,
  integrationOptions: AstroFernIntegrationOptions = {},
  render: (markdown: string) => RichTextSchema = (markdown) => ({ markdown, html: markdown }),
  deployment: FernDeploymentConfig = {},
): TestProject {
  let data: FernProjectData | undefined;
  return {
    getData() {
      if (data) return data;
      const content = defineFernProject(contentOptions).getData();
      const operations = content.operations.map((source) => ({
        snapshotId: source.snapshotId,
        operation: {
          format: FERN_ARTIFACT_FORMAT_VERSION,
          kind: 'operation' as const,
          id: source.id,
          product: source.product,
          section: source.section,
          operation: renderOperation(source.operation, render),
          snippets: source.snippets,
        } satisfies FernContentOperationEntrySchema,
      }));
      const metadata =
        content.catalog.description !== undefined ? { description: render(content.catalog.description) } : {};
      data = composeFernProject(
        content.catalog,
        operations,
        resolveRuntimeConfig(integrationOptions),
        deployment,
        metadata,
      );
      return data;
    },
  };
}

export function fixtureProject(target: FernTargetRouting = 'hash'): TestProject {
  return testProject(
    {
      source: widgetsSpec,
      snippets: fixtureSnippets,
      manifest: defineFernManifest({
        products: [widgetsProduct],
        targets: [
          { id: 'curl', kind: 'http', label: 'curl', language: 'bash' },
          { id: 'python', kind: 'sdk', label: 'Python', language: 'python', packageName: 'widgets' },
        ],
      }),
    },
    { routing: { target } },
  );
}
