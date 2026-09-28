/**
 * Argument Classification Utilities
 *
 * Classifies schema arguments for input validation and zone resolution.
 * Used by transformers to determine which validation function to call.
 */

import type { Schema } from '../schema/schema.js';

/**
 * Argument names that represent Cloudflare zones.
 * Zone args can be resolved from context (project config, env vars, flags).
 */
const ZONE_ARG_NAMES = new Set(['zoneId', 'zone_id', 'zone-id', 'zone']);

/**
 * Returns true if the argument represents a zone identifier.
 * Zone args get special resolution logic in generated commands.
 */
export function isZoneArg(arg: Schema.arg): boolean {
  return ZONE_ARG_NAMES.has(arg.name);
}

/**
 * Returns true if the argument name maps to an OpenAPI path parameter.
 * Path parameter args get stricter validation (no path traversal, no embedded params).
 *
 * @param argName - The camelCase argument name from the schema
 * @param pathParamNames - Path parameter names from the resolved OpenAPI operation
 */
export function isResourceIdArg(argName: string, pathParamNames: string[]): boolean {
  return pathParamNames.includes(argName);
}
