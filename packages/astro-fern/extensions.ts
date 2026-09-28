import type { ZodType } from 'astro/zod';
import type { OpenApiDocumentSchema, OperationSchema } from './content/openapi.ts';
import type { JsonValueSchema, RenderedOperationSchema } from './content/schema.ts';

/** The OpenAPI location currently being evaluated by an extension. */
export interface FernOperationExtensionContext {
  /** Complete source document. */
  document: OpenApiDocumentSchema;
  /** OpenAPI path template containing the operation. */
  path: string;
  /** Lowercase OpenAPI HTTP method. */
  method: string;
  /** Original OpenAPI operation object. */
  operation: OperationSchema;
}

/** Generic operation concepts that an extension can expose to all renderers. */
export interface FernOperationPresentation {
  /** Plain-text confirmation shown before a potentially dangerous operation. */
  requireConfirmation?: string;
  /** Higher values win when multiple projections resolve to the same documentation route. */
  routingPriority?: number;
}

/** An additional logical SDK projection of one physical OpenAPI operation. */
export interface FernOperationVariant<TData = JsonValueSchema> {
  /** Name unique within the extension's variants for this operation. */
  name: string;
  /** Effective Fern SDK group metadata for this projection. */
  sdkGroupName?: unknown;
  /** Effective Fern SDK method metadata for this projection. */
  sdkMethodName?: unknown;
  /** Effective Fern availability metadata for this projection. */
  availability?: unknown;
  /** Serializable extension data associated with this projection. */
  data?: TData;
  /** Generic renderer-facing metadata associated with this projection. */
  presentation?: FernOperationPresentation;
}

/** Data contributed by an extension for an OpenAPI operation. */
export interface FernOperationExtensionContribution<TData = JsonValueSchema> {
  /** Serializable data stored under the extension's name. */
  data?: TData;
  /** Additional logical projections, such as aliases. */
  variants?: readonly FernOperationVariant<TData>[];
  /** Generic renderer-facing metadata for the primary projection. */
  presentation?: FernOperationPresentation;
}

/** Logger available while an extension validates and indexes a document. */
export interface FernExtensionLogger {
  warn(message: string): void;
}

/** Build-scoped services available to an extension's preparation hook. */
export interface FernExtensionPrepareContext {
  logger: FernExtensionLogger;
}

/** Common public fields shared by stateless and stateful extensions. */
interface FernExtensionBase<TData> {
  /** Stable namespace used in each operation's `extensions` record. */
  name: string;
  /** Parses and validates data before storage and when queried at runtime. */
  schema: ZodType<TData>;
}

/**
 * A synchronous content extension for `astro-fern`.
 *
 * Stateful extensions must implement `prepare`; its return value remains
 * build-local and is passed to every `operation` call. Stateless extensions
 * receive `undefined`. Only each contribution's schema-validated JSON data is
 * serialized into Astro content.
 */
export type FernExtension<TData = JsonValueSchema, TState = undefined> = FernExtensionBase<TData> &
  (TState extends undefined
    ? {
        prepare?: (document: OpenApiDocumentSchema, context: FernExtensionPrepareContext) => undefined;
        operation?(
          context: FernOperationExtensionContext,
          state: undefined,
        ): FernOperationExtensionContribution<TData> | undefined;
      }
    : {
        prepare(document: OpenApiDocumentSchema, context: FernExtensionPrepareContext): TState;
        operation?(
          context: FernOperationExtensionContext,
          state: TState,
        ): FernOperationExtensionContribution<TData> | undefined;
      });

/** Type-erased extension shape accepted by project configuration. */
export interface FernExtensionDefinition {
  /** Stable namespace used in each operation's `extensions` record. */
  name: string;
  /** Parses and validates extension data. */
  schema: ZodType;
  /** Validates and optionally indexes the complete OpenAPI document. */
  prepare?(document: OpenApiDocumentSchema, context: FernExtensionPrepareContext): unknown;
  /** Contributes data and projections for one physical OpenAPI operation. */
  operation?(
    context: FernOperationExtensionContext,
    state: never,
  ): FernOperationExtensionContribution<unknown> | undefined;
}

/** Preserves generic inference while defining an `astro-fern` extension. */
export function defineFernExtension<TData, TState = undefined>(
  extension: FernExtension<TData, TState>,
): FernExtension<TData, TState> {
  return extension;
}

type OperationWithExtensions = Pick<RenderedOperationSchema, 'extensions'>;

/** Extension data types registered by imported extension packages. */
export interface FernExtensionDataRegistry {}

type RegisteredExtensionName = Extract<keyof FernExtensionDataRegistry, string>;
type ExtensionName = [RegisteredExtensionName] extends [never] ? string : RegisteredExtensionName;
type ExtensionData<TName extends ExtensionName> = TName extends RegisteredExtensionName
  ? FernExtensionDataRegistry[TName]
  : JsonValueSchema;

/** Reads operation data by name, optionally parsing it with a Zod schema. */
export function getOperationExtensionData<TData>(
  operation: OperationWithExtensions,
  name: string,
  schema: ZodType<TData>,
): TData | undefined;
export function getOperationExtensionData<TName extends ExtensionName>(
  operation: OperationWithExtensions,
  name: TName,
): ExtensionData<TName> | undefined;
export function getOperationExtensionData<TData>(
  operation: OperationWithExtensions,
  name: string,
  schema?: ZodType<TData>,
): TData | JsonValueSchema | undefined {
  if (!Object.hasOwn(operation.extensions, name)) return undefined;
  const value = operation.extensions[name];
  if (value === undefined || schema === undefined) return value;
  return schema.parse(value);
}

/** Creates a typed operation-data accessor for one extension name and schema. */
export function createOperationExtensionDataAccessor<TData>(
  name: string,
  schema: ZodType<TData>,
): (operation: OperationWithExtensions) => TData | undefined {
  return (operation) => getOperationExtensionData(operation, name, schema);
}

/** One prepared extension whose state is scoped to a single document build. */
export interface PreparedFernExtension {
  /** Configured extension name. */
  name: string;
  /** Schema used to validate contributed data. */
  schema: ZodType;
  /** Resolves the extension's contribution for an operation. */
  operation(context: FernOperationExtensionContext): FernOperationExtensionContribution<unknown> | undefined;
}

function prepareExtension(
  extension: FernExtensionDefinition,
  document: OpenApiDocumentSchema,
  logger: FernExtensionLogger,
): PreparedFernExtension {
  let state: unknown;
  try {
    state = extension.prepare?.(document, { logger });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`astro-fern: extension "${extension.name}" failed to prepare: ${reason}`, { cause });
  }
  return {
    name: extension.name,
    schema: extension.schema,
    operation: (context) => extension.operation?.(context, state as never),
  };
}

/** @internal Prepares extensions once for product discovery and content generation. */
export function prepareFernExtensions(
  extensions: readonly FernExtensionDefinition[],
  document: OpenApiDocumentSchema,
  logger?: { fork(label: string): FernExtensionLogger },
): PreparedFernExtension[] {
  const names = new Set<string>();
  const ordered = [...extensions].sort((left, right) => left.name.localeCompare(right.name));
  return ordered.map((extension) => {
    if (!/^[a-z][a-z0-9-]*$/.test(extension.name)) {
      throw new Error(
        `astro-fern: extension name "${extension.name}" must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens`,
      );
    }
    if (names.has(extension.name)) {
      throw new Error(`astro-fern: duplicate extension name "${extension.name}"`);
    }
    names.add(extension.name);
    const extensionLogger =
      logger?.fork(`astro:fern-${extension.name}`) ??
      ({ warn: (message) => console.warn(`[astro:fern-${extension.name}] ${message}`) } satisfies FernExtensionLogger);
    return prepareExtension(extension, document, extensionLogger);
  });
}
