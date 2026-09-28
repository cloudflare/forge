/**
 * Method Classification Utilities
 *
 * Classifies schema method names into categories for conditional code generation.
 * Used by transformers (command generation, completions, and metadata).
 */

import { getHttpMethod, isSafeMethod, methodHasBody } from './http.js';

/**
 * Method categories for generated CLI commands.
 * Determines which flags and behaviors are injected.
 */
export type MethodCategory = 'read' | 'create' | 'update' | 'delete' | 'action';

/**
 * Returns true if the method mutates resources (POST, PUT, PATCH, DELETE).
 * Mutating methods get --dry-run.
 */
export function isMutatingMethod(name: string): boolean {
  return !isSafeMethod(getHttpMethod(name));
}

/**
 * Returns true if the method is destructive (DELETE).
 * Destructive methods may get additional confirmation prompts.
 */
export function isDestructiveMethod(name: string): boolean {
  return getHttpMethod(name) === 'DELETE';
}

/**
 * Returns true if the method is a list operation.
 * List methods benefit from --ndjson streaming.
 */
export function isListMethod(name: string): boolean {
  return name === 'list';
}

/**
 * Returns true if the method's HTTP verb typically carries a request body.
 * Methods with bodies get --body for raw JSON input.
 */
export function methodHasRequestBody(name: string): boolean {
  return methodHasBody(getHttpMethod(name));
}

/**
 * Classify a method name into a high-level category.
 * Used for metadata, agent context, and conditional flag injection.
 */
export function getMethodCategory(name: string): MethodCategory {
  switch (name) {
    case 'list':
    case 'info':
    case 'get':
    case 'export':
    case 'status':
    case 'insights':
    case 'report':
    case 'bytime':
      return 'read';
    case 'create':
      return 'create';
    case 'update':
    case 'edit':
    case 'patch':
      return 'update';
    case 'delete':
    case 'remove':
      return 'delete';
    default:
      return 'action';
  }
}
