/**
 * Shared Utilities for Code Generation Transformers
 *
 * This module provides consistent utilities used across all generators:
 * - CLI command/handler generators
 * - SDK TypeScript generator
 * - Worker REST router generator
 */

// Argument classification utilities
export { isResourceIdArg, isZoneArg } from './arg-classification.js';
// Command metadata types (shared between CLI and transformers)
export type { ArgumentMeta, CommandMeta, ExampleMeta, OptionMeta } from './command-types.js';
// Generated CLI option definitions
export {
  BODY_OPTIONS,
  FILE_OPTIONS,
  type GeneratedOption,
  GLOBAL_OPTIONS,
  HAND_WRITTEN_COMMANDS,
  MUTATING_OPTIONS,
  UNIVERSAL_OPTIONS,
} from './generated-cli-options.js';
// Fern OpenAPI conversion compatibility
export { applyFernCompatibilityFixes, type FernCompatibilityFixes } from './fern-openapi-compat.js';
// HTTP utilities
export { getHttpMethod, type HttpMethod, isIdempotentMethod, isSafeMethod, methodHasBody } from './http.js';
// Interface generation utilities
export {
  generateAllOptionsInterfaces,
  generateJSDoc,
  generateJSDocWithTags,
  generateMethodSignature,
  generateOptionsInterface,
} from './interface-generator.js';
// Method classification utilities
export {
  getMethodCategory,
  isDestructiveMethod,
  isListMethod,
  isMutatingMethod,
  type MethodCategory,
  methodHasRequestBody,
} from './method-classification.js';
// Naming utilities
export { camelToPascal, pascalToCamel, toCamelCase, toKebabCase, toPascalCase, toSnakeCase } from './naming.js';
// Path generation utilities
export {
  type GeneratedPath,
  generateOpenAPIPath,
  generateResourcePath,
  generateRouterPath,
  generateTemplatePath,
  type ParamStyle,
  type PathGeneratorOptions,
} from './path-generator.js';
// Schema utilities
export {
  COLLECTION_OPERATIONS,
  collectAllMethods,
  collectAllMethodsWithGroup,
  getAllArgs,
  getAllResourceIdArgs,
  getOptionalArgs,
  getRequiredArgs,
  getResourceIdArg,
  hasRemoteApi,
  IDENTIFIER_ARG_NAMES,
  isDeprecated,
  isMethodGroup,
  methodNeedsResourceId,
  RESOURCE_ID_OPERATIONS,
  requireDescription,
  requireMethodDescription,
  resolveCommandArgDescriptions,
  resolveCommandDescriptions,
  resolveMethodArgDescriptions,
  schemaTypeToTS,
  walkAllMethods,
} from './schema-utils.js';
// String utilities
export {
  escapeString,
  generatedFileHeader,
  indent,
  pluralize,
  singularize,
  toIdentifier,
  trimBlankLines,
  wrapText,
} from './string-utils.js';
