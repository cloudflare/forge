import type { FernExtensionLogger } from 'astro-fern';
import type { OpenApiDocumentSchema, OperationSchema } from 'astro-fern/content';
import {
  aliasesEnvelopeSchema,
  forgeOperationDataSchema,
  operationProjectionFieldsSchema,
  operationMetadataSchema,
  projectionSchema,
} from './schemas/operation.ts';
import type { ForgeOperationDataSchema } from './schemas/operation.ts';
import { documentExtensionsSchema } from './schemas/document.ts';

export type ParsedForgeOperation = {
  primary?: ForgeOperationDataSchema;
  aliases: ForgeOperationDataSchema[];
};

export type ForgeExtensionState = {
  operations: WeakMap<OperationSchema, ParsedForgeOperation>;
};

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;
const OPERATION_PROJECTION_KEYS = operationProjectionFieldsSchema.keyof().options;

function availabilityFields(
  value: ReturnType<typeof projectionSchema>['_output']['x-fern-availability'],
): Pick<ForgeOperationDataSchema, 'availability' | 'availabilityMessage'> {
  if (value === undefined) return {};
  if (typeof value === 'string') return { availability: value };
  return {
    availability: value.status,
    ...(value.message !== undefined ? { availabilityMessage: value.message } : {}),
  };
}

function toOperationData(value: ReturnType<typeof projectionSchema>['_output']): ForgeOperationDataSchema {
  return forgeOperationDataSchema.parse({
    sdkGroupName: value['x-fern-sdk-group-name'],
    sdkMethodName: value['x-fern-sdk-method-name'],
    ...availabilityFields(value['x-fern-availability']),
    ignore: value['x-fern-ignore'] ?? false,
    hidden: value['x-forge-hidden'] ?? false,
    ...(value['x-forge-internal'] !== undefined ? { internal: value['x-forge-internal'] } : {}),
    ...(value['x-forge-globals'] !== undefined ? { globals: value['x-forge-globals'] } : {}),
    ...(value['x-forge-epilogue'] !== undefined ? { epilogue: value['x-forge-epilogue'] } : {}),
    ...(value['x-forge-args'] !== undefined ? { args: value['x-forge-args'] } : {}),
    ...(value['x-forge-params'] !== undefined ? { params: value['x-forge-params'] } : {}),
    ...(value['x-forge-require-confirmation'] !== undefined
      ? { requireConfirmation: value['x-forge-require-confirmation'] }
      : {}),
  });
}

function parseOperation(operation: OperationSchema): ParsedForgeOperation {
  operationMetadataSchema().parse(operation);
  const aliases =
    operation['x-forge-aliases'] === undefined
      ? []
      : aliasesEnvelopeSchema
          .parse(operation)
          ['x-forge-aliases'].map((alias) => toOperationData(projectionSchema(true).parse(alias)));
  const aliasAddresses = new Set<string>();
  for (const alias of aliases) {
    const address = JSON.stringify([alias.sdkGroupName, alias.sdkMethodName]);
    if (aliasAddresses.has(address)) {
      throw new Error(`x-forge-aliases contains duplicate SDK address "${alias.sdkGroupName}.${alias.sdkMethodName}"`);
    }
    aliasAddresses.add(address);
  }
  const hasPrimary =
    operation['x-fern-sdk-group-name'] !== undefined && operation['x-fern-sdk-method-name'] !== undefined;

  return {
    ...(hasPrimary ? { primary: toOperationData(projectionSchema(false).parse(operation)) } : {}),
    aliases,
  };
}

export function prepareForge(
  document: OpenApiDocumentSchema,
  { logger }: { logger: FernExtensionLogger },
): ForgeExtensionState {
  documentExtensionsSchema.parse(document);
  const operations = new WeakMap<OperationSchema, ParsedForgeOperation>();
  const errors: string[] = [];
  const missingGroup: string[] = [];
  const missingMethod: string[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    if (pathItem === undefined) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const operationId = operation.operationId ?? `${method.toUpperCase()} ${path}`;
      const hasAliases = operation['x-forge-aliases'] !== undefined;
      const hasPrimaryMetadata = OPERATION_PROJECTION_KEYS.some((key) => operation[key] !== undefined);
      if (!hasAliases || hasPrimaryMetadata) {
        if (operation['x-fern-sdk-group-name'] === undefined) missingGroup.push(operationId);
        if (operation['x-fern-sdk-method-name'] === undefined) missingMethod.push(operationId);
      }
      try {
        const parsed = parseOperation(operation);
        if (parsed.primary || parsed.aliases.length > 0) operations.set(operation, parsed);
      } catch (error) {
        errors.push(`operation "${operationId}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`fern-forge: invalid OpenAPI extensions:\n- ${errors.join('\n- ')}`);
  warnMissingRequiredField(logger, 'x-fern-sdk-group-name', missingGroup);
  warnMissingRequiredField(logger, 'x-fern-sdk-method-name', missingMethod);
  return { operations };
}

function warnMissingRequiredField(logger: FernExtensionLogger, field: string, operationIds: string[]): void {
  if (operationIds.length === 0) return;
  const examples = operationIds
    .slice(0, 3)
    .map((operationId) => `"${operationId}"`)
    .join(', ');
  logger.warn(
    `${field} is required by the Forge OpenAPI specification but missing from ${operationIds.length} operation(s); this requirement is temporarily skipped. Examples: ${examples}`,
  );
}
