/**
 * Shared Schema Utilities
 *
 * Provides consistent schema analysis functions used across all transformers.
 */

import type { Schema } from '../schema/schema.js';

/**
 * Operation types that typically require a resource identifier in the path
 */
export const RESOURCE_ID_OPERATIONS = [
  'info',
  'delete',
  'execute',
  'export',
  'restore',
  'apply',
  'get',
  'update',
] as const;

/**
 * Operations that don't need a resource ID (operate on collections)
 */
export const COLLECTION_OPERATIONS = ['list', 'create'] as const;

/**
 * Common names for resource identifier arguments
 */
export const IDENTIFIER_ARG_NAMES = ['name', 'id', 'database', 'zone', 'zone_id', 'uuid'] as const;

/**
 * Check if a method needs a resource identifier in the path.
 *
 * @example
 * methodNeedsResourceId({ name: 'info', ... }) // true
 * methodNeedsResourceId({ name: 'list', ... }) // false
 */
export function methodNeedsResourceId(method: Schema.method): boolean {
  if ((COLLECTION_OPERATIONS as readonly string[]).includes(method.name)) {
    return false;
  }
  return true;
}

/**
 * Get the first required string arg that looks like a resource identifier.
 *
 * First looks for common identifier names (name, id, database, zone, etc.),
 * then falls back to the first required string argument.
 */
export function getResourceIdArg(method: Schema.method): Schema.arg | null {
  const requiredArgs = getRequiredArgs(method.args ?? []);

  // First pass: look for common identifier names
  for (const arg of requiredArgs) {
    if (arg.type === 'string' && (IDENTIFIER_ARG_NAMES as readonly string[]).includes(arg.name)) {
      return arg;
    }
  }

  // Fallback: first required string arg
  for (const arg of requiredArgs) {
    if (arg.type === 'string') {
      return arg;
    }
  }

  return null;
}

/**
 * Get ALL required string args that look like resource identifiers.
 * Returns them in order of appearance in the method args.
 *
 * This is needed for routes like /dns/:zoneId/records/:recordId
 * where multiple IDs are required.
 */
export function getAllResourceIdArgs(method: Schema.method): Schema.arg[] {
  const requiredArgs = getRequiredArgs(method.args ?? []);
  const idArgs: Schema.arg[] = [];

  // Get all required string args that look like identifiers
  for (const arg of requiredArgs) {
    if (arg.type === 'string') {
      // Check if it looks like an ID (common patterns)
      const isIdLike =
        (IDENTIFIER_ARG_NAMES as readonly string[]).includes(arg.name) ||
        arg.name.endsWith('_id') ||
        arg.name.endsWith('Id') ||
        arg.name === 'uuid';
      if (isIdLike) {
        idArgs.push(arg);
      }
    }
  }

  return idArgs;
}

/**
 * Extract required arguments from method args (flattening nested structures).
 */
export function getRequiredArgs(args: Schema.methodArg[]): Schema.arg[] {
  const required: Schema.arg[] = [];

  for (const arg of args) {
    if ('name' in arg) {
      // Direct arg - check if it's required
      if (arg.required === true) {
        required.push(arg);
      }
    } else {
      // Nested structure with required/oneOf/options
      if (arg.required) {
        for (const a of arg.required) {
          if (a.required === true) {
            required.push(a);
          }
        }
      }
      if (arg.oneOf) {
        // oneOf args are mutually exclusive required args
        for (const a of arg.oneOf) {
          if (a.required === true) {
            required.push(a);
          }
        }
      }
    }
  }

  return required;
}

/**
 * Extract optional arguments from method args (deduped by name, flattening nested structures).
 */
export function getOptionalArgs(args: Schema.methodArg[]): Schema.arg[] {
  const optional: Schema.arg[] = [];
  const seen = new Set<string>();

  const addIfNew = (arg: Schema.arg) => {
    if (!seen.has(arg.name)) {
      seen.add(arg.name);
      optional.push(arg);
    }
  };

  for (const arg of args) {
    if ('name' in arg) {
      // Direct arg - check if it's optional (has default)
      if (arg.required !== true) {
        addIfNew(arg);
      }
    } else {
      // Nested structure
      if (arg.options) {
        for (const a of arg.options) {
          addIfNew(a);
        }
      }
      // required args with defaults are optional in the API
      if (arg.required) {
        for (const a of arg.required) {
          if (a.required !== true) {
            addIfNew(a);
          }
        }
      }
    }
  }

  return optional;
}

/**
 * Extract all args from a method (required, oneOf, and optional).
 */
export function getAllArgs(args: Schema.methodArg[]): Schema.arg[] {
  const allArgs: Schema.arg[] = [];
  const seen = new Set<string>();

  const addIfNew = (arg: Schema.arg) => {
    if (!seen.has(arg.name)) {
      seen.add(arg.name);
      allArgs.push(arg);
    }
  };

  for (const arg of args) {
    if ('name' in arg) {
      addIfNew(arg);
    } else {
      if (arg.required) {
        for (const a of arg.required) {
          addIfNew(a);
        }
      }
      if (arg.oneOf) {
        for (const a of arg.oneOf) {
          addIfNew(a);
        }
      }
      if (arg.options) {
        for (const a of arg.options) {
          addIfNew(a);
        }
      }
    }
  }

  return allArgs;
}

/**
 * Check if a method has an API reference (is backed by a remote API).
 */
export function hasRemoteApi(method: Schema.method): boolean {
  return !!method.operationId;
}

/**
 * Convert a schema arg type to a TypeScript type string.
 */
export function schemaTypeToTS(arg: Schema.arg): string {
  switch (arg.type) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return 'number';
    case 'enum': {
      // Build union of literal types
      const types = arg.values.map((v) => {
        if (typeof v === 'string') return 'string';
        if (typeof v === 'boolean') return 'boolean';
        if (typeof v === 'number') return 'number';
        if ('literal' in v) {
          if (typeof v.literal === 'string') return `'${v.literal}'`;
          if (typeof v.literal === 'boolean') return String(v.literal);
          if (typeof v.literal === 'number') return String(v.literal);
        }
        return 'unknown';
      });
      return types.join(' | ');
    }
    default:
      return 'unknown';
  }
}

/**
 * Resolve arg descriptions from the OpenAPI spec for a single method.
 *
 * For each arg in the method:
 * - If the arg maps to an OpenAPI parameter and the OpenAPI has a description:
 *   - If the schema arg also has a description AND is not in `sharedArgNames` → error (redundant)
 *   - Otherwise → fill from OpenAPI (always overwrites)
 * - If the arg does NOT map to an OpenAPI parameter:
 *   - The schema arg MUST have a description (CLI-only arg)
 *
 * `sharedArgNames` contains arg names that are also used by at least one method
 * without an api.operationId — these MUST keep a schema description as fallback,
 * so the redundancy error is suppressed for them.
 *
 * Mutates arg objects in place (fills in `description`).
 * Returns a list of errors (empty = success).
 */
export function resolveMethodArgDescriptions(
  method: Schema.method,
  apiName: string,
  openApiDescriptions: Map<string, string>,
  groupName?: string,
  sharedArgNames?: Set<string>,
  originallyDescribed?: Set<Schema.arg>,
): string[] {
  const errors: string[] = [];
  const methodPath = groupName ? `${apiName}.${groupName}.${method.name}` : `${apiName}.${method.name}`;
  for (const arg of getAllArgs(method.args ?? [])) {
    // The OpenAPI parameter name matches the arg name (1:1 mapping)
    const apiParamName = arg.name;
    const openApiDesc = openApiDescriptions.get(apiParamName);

    if (openApiDesc) {
      // Only flag redundancy if the arg had a description in the original schema
      // (not one filled by a prior method's resolution of the same shared object).
      const hadSchemaDescription = originallyDescribed?.has(arg) ?? !!arg.description;
      if (hadSchemaDescription && !sharedArgNames?.has(arg.name)) {
        errors.push(
          `${methodPath}: arg "${arg.name}" has a description in the schema but OpenAPI already provides one ` +
            `for "${apiParamName}". Remove the description from the schema file (single source of truth).`,
        );
      }
      // OpenAPI is the authoritative source — always use it.
      // Sanitize: collapse newlines/whitespace runs to single space (OpenAPI descriptions can be multi-line markdown).
      (arg as { description: string }).description = openApiDesc.replace(/\s+/g, ' ').trim();
    } else {
      // No OpenAPI counterpart — schema must provide the description
      if (!arg.description) {
        errors.push(
          `${methodPath}: arg "${arg.name}" has no description and no OpenAPI description found ` +
            `for "${apiParamName}". Add a description to the schema file.`,
        );
      }
    }
  }

  return errors;
}

/**
 * Collect the names of all args used by methods that have NO api.operationId.
 * These args must retain their schema description because there is no OpenAPI
 * fallback for those methods.
 */
function collectNonApiArgNames(schema: Schema.command): Set<string> {
  const names = new Set<string>();
  walkAllMethods(schema.methods, (method) => {
    if (!method.operationId) {
      for (const arg of getAllArgs(method.args ?? [])) {
        names.add(arg.name);
      }
    }
  });
  return names;
}

/**
 * Resolve arg descriptions for an entire Schema.command.
 * Walks all methods and method groups. Requires a Forge instance
 * to look up parameter descriptions per operation.
 *
 * Returns a list of all errors across all methods (empty = success).
 */
export function resolveCommandArgDescriptions(
  schema: Schema.command,
  getParameterDescriptions: (operationId: string) => Map<string, string>,
): string[] {
  const errors: string[] = [];

  // Identify args that are used by at least one non-API method.
  // These need a schema description as fallback, so the redundancy check is suppressed.
  const sharedArgNames = collectNonApiArgNames(schema);

  // Snapshot: which arg *objects* originally had a description in the schema file.
  // This prevents false redundancy errors when a shared arg's description was
  // filled by a prior method's resolution of the same object reference.
  const originallyDescribed = new Set<Schema.arg>();
  walkAllMethods(schema.methods, (method) => {
    for (const arg of getAllArgs(method.args ?? [])) {
      if (arg.description) {
        originallyDescribed.add(arg);
      }
    }
  });

  walkAllMethods(schema.methods, (method, groupPath) => {
    const path = groupPath ? `${schema.name}.${groupPath}.${method.name}` : `${schema.name}.${method.name}`;

    if (method.operationId) {
      const descs = getParameterDescriptions(method.operationId);
      errors.push(
        ...resolveMethodArgDescriptions(method, schema.name, descs, groupPath, sharedArgNames, originallyDescribed),
      );
    } else {
      // No API operation — all args must have descriptions in the schema
      for (const arg of getAllArgs(method.args ?? [])) {
        if (!arg.description) {
          errors.push(`${path}: arg "${arg.name}" has no description and no api.operationId to resolve from OpenAPI.`);
        }
      }
    }
  });

  return errors;
}

/**
 * Get the description of an arg, throwing if it is missing.
 *
 * After the pipeline's `resolveCommandArgDescriptions` step, every arg is
 * guaranteed to have a description (either from OpenAPI or from the schema).
 * This helper turns a missing description into a hard build-time crash
 * instead of silently propagating `undefined`.
 */
export function requireDescription(arg: Schema.arg): string {
  if (!arg.description) {
    throw new Error(
      `Bug: arg "${arg.name}" has no description after OpenAPI resolution. ` +
        `Either add a description to the schema or ensure the arg maps to an OpenAPI parameter with a description.`,
    );
  }
  return arg.description;
}

/**
 * Get the description of a method, throwing if it is missing.
 *
 * After the pipeline's `resolveCommandDescriptions` step, every method is
 * guaranteed to have a description (either from OpenAPI or from the schema).
 * This helper turns a missing description into a hard build-time crash
 * instead of silently propagating `undefined`.
 */
export function requireMethodDescription(method: Schema.method): string {
  if (!method.description) {
    throw new Error(
      `Bug: method "${method.name}" has no description after OpenAPI resolution. ` +
        `Either add a description to the schema or ensure the method has an api.operationId with an OpenAPI description.`,
    );
  }
  return method.description;
}

/**
 * Resolve method descriptions (and summaries) from OpenAPI for an entire Schema.command.
 *
 * For each method with an `api.operationId`:
 * - If OpenAPI has a description and the schema also has one → error (redundant)
 * - If OpenAPI has a description and the schema does not → fill from OpenAPI
 * - If OpenAPI has no description and the schema does → keep it
 * - If neither has a description → error
 *
 * If `getOperationSummary` is supplied, the short one-line `summary` is filled
 * from OpenAPI when present. Summary is optional — its absence is never an error.
 *
 * Methods without `api.operationId` must have a schema description.
 *
 * Mutates method objects in place (fills in `description` and, when available, `summary`).
 * Returns a list of errors (empty = success).
 */
export function resolveCommandDescriptions(
  schema: Schema.command,
  getOperationDescription: (operationId: string) => string | undefined,
  getOperationSummary?: (operationId: string) => string | undefined,
): string[] {
  const errors: string[] = [];

  walkAllMethods(schema.methods, (method, groupPath) => {
    const path = groupPath ? `${schema.name}.${groupPath}.${method.name}` : `${schema.name}.${method.name}`;

    if (!method.operationId) {
      // Non-API method — must have a schema description
      if (!method.description) {
        errors.push(`${path}: method has no description and no api.operationId to resolve from OpenAPI.`);
      }
      return;
    }

    // Fill the short one-line `summary` from OpenAPI when available. Summary is
    // optional (falls back to description downstream), so absence is not an error.
    const openApiSummary = getOperationSummary?.(method.operationId);
    if (openApiSummary && !method.summary) {
      (method as { summary: string }).summary = openApiSummary.replace(/\s+/g, ' ').trim();
    }

    const openApiDesc = getOperationDescription(method.operationId);

    if (openApiDesc) {
      if (method.description) {
        errors.push(
          `${path}: method has a description in the schema but OpenAPI already provides one ` +
            `for "${method.operationId}". Remove the description from the schema file (single source of truth).`,
        );
      }
      // Sanitize: collapse newlines/whitespace runs to single space.
      (method as { description: string }).description = openApiDesc.replace(/\s+/g, ' ').trim();
    } else {
      if (!method.description) {
        errors.push(
          `${path}: method has no description and no OpenAPI description found ` +
            `for "${method.operationId}". Add a description to the schema file.`,
        );
      }
    }
  });

  return errors;
}

/**
 * Type guard: check if a command method entry is a method group (has nested methods).
 */
export function isMethodGroup(item: Schema.method | Schema.methodGroup): item is Schema.methodGroup {
  return 'methods' in item;
}

/**
 * Walk all leaf methods in a command, recursively descending into nested method groups.
 * Calls the callback with each leaf method and its dotted group path (e.g. 'access.applications.cas').
 */
export function walkAllMethods(
  methods: (Schema.method | Schema.methodGroup)[],
  callback: (method: Schema.method, groupPath: string | undefined) => void,
  parentGroupPath?: string,
): void {
  for (const item of methods) {
    if (isMethodGroup(item)) {
      const groupPath = parentGroupPath ? `${parentGroupPath}.${item.name}` : item.name;
      walkAllMethods(item.methods, callback, groupPath);
    } else {
      callback(item, parentGroupPath);
    }
  }
}

/**
 * Collect all leaf methods from a command or method list, flattening all nested groups.
 */
export function collectAllMethods(methods: (Schema.method | Schema.methodGroup)[]): Schema.method[] {
  const result: Schema.method[] = [];
  walkAllMethods(methods, (method) => result.push(method));
  return result;
}

/**
 * Collect all leaf methods from a command with their group paths.
 */
export function collectAllMethodsWithGroup(
  methods: (Schema.method | Schema.methodGroup)[],
): { method: Schema.method; groupPath: string | undefined }[] {
  const result: { method: Schema.method; groupPath: string | undefined }[] = [];
  walkAllMethods(methods, (method, groupPath) => result.push({ method, groupPath }));
  return result;
}

/**
 * Check if a method is deprecated.
 */
export function isDeprecated(method: Schema.method): boolean {
  return method.status === 'deprecated';
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
