/**
 * Shared Path Generation Utilities
 *
 * Provides consistent REST path generation across SDK and Worker generators.
 * Handles resource IDs, method groups, and different parameter styles.
 */

import type { Schema } from '../schema/schema.js';
import { toCamelCase, toKebabCase } from './naming.js';
import { getAllResourceIdArgs, methodNeedsResourceId } from './schema-utils.js';

/**
 * Parameter interpolation style for generated paths
 */
export type ParamStyle =
  /** Template literal style: ${paramName} */
  | 'template'
  /** Router param style: :paramName */
  | 'colon'
  /** OpenAPI style: {paramName} */
  | 'braces';

/**
 * Options for path generation
 */
export interface PathGeneratorOptions {
  /** How to format path parameters */
  paramStyle: ParamStyle;
  /** Whether to URL-encode parameters (only for template style) */
  encodeParams?: boolean;
}

/**
 * Result of path generation
 */
export interface GeneratedPath {
  /** The generated path string */
  path: string;
  /** Names of path parameters (in camelCase) */
  pathParams: string[];
}

/**
 * Format a path parameter based on the style option.
 *
 * @param paramName - Parameter name in camelCase
 * @param options - Path generator options
 * @returns Formatted parameter placeholder
 */
function formatPathParam(paramName: string, options: PathGeneratorOptions): string {
  switch (options.paramStyle) {
    case 'colon':
      return `:${paramName}`;
    case 'braces':
      return `{${paramName}}`;
    case 'template':
      if (options.encodeParams) {
        return `\${encodeURIComponent(${paramName})}`;
      }
      return `\${${paramName}}`;
  }
}

/**
 * Operations that typically retrieve a single resource by ID.
 * These don't append the method name to the path.
 */
const SINGLE_RESOURCE_OPERATIONS = ['info', 'get', 'delete'];

/**
 * Check if a method should append its name to the path.
 * Single-resource operations (get, info, delete) typically don't.
 */
function shouldAppendMethodName(methodName: string): boolean {
  return !SINGLE_RESOURCE_OPERATIONS.includes(methodName);
}

/**
 * Generate a REST path for a schema method.
 *
 * Handles:
 * - Direct methods (e.g., /d1/create, /d1/:name)
 * - Method groups (e.g., /d1/:name/time-travel/info)
 * - Resource ID detection and placement
 *
 * @param basePath - Base API path (e.g., '/d1')
 * @param method - Schema method definition
 * @param groupName - Optional method group name
 * @param options - Path generation options
 * @returns Generated path and extracted path parameters
 *
 * @example
 * // Direct method with resource ID
 * generateResourcePath('/d1', { name: 'info', ... }, undefined, { paramStyle: 'colon' })
 * // Returns: { path: '/d1/:name', pathParams: ['name'] }
 *
 * @example
 * // Method group with resource ID
 * generateResourcePath('/d1', { name: 'restore', ... }, 'time-travel', { paramStyle: 'template' })
 * // Returns: { path: '/d1/${name}/time-travel/restore', pathParams: ['name'] }
 */
export function generateResourcePath(
  basePath: string,
  method: Schema.method,
  groupName?: string,
  options: PathGeneratorOptions = { paramStyle: 'colon' },
): GeneratedPath {
  const pathParams: string[] = [];
  const pathParts: string[] = [basePath];

  // Check if we need resource IDs in the path
  const needsResourceId = methodNeedsResourceId(method);
  const resourceIdArgs = needsResourceId ? getAllResourceIdArgs(method) : [];

  // Add all resource IDs to the path
  // For nested resources like /dns/:zoneId/records/:recordId
  for (const resourceIdArg of resourceIdArgs) {
    const paramName = toCamelCase(resourceIdArg.name);
    pathParams.push(paramName);
    pathParts.push(formatPathParam(paramName, options));
  }

  // Add group name if present
  if (groupName) {
    pathParts.push(toKebabCase(groupName));
  }

  // Add method name for action operations (not for get/info/delete)
  if (shouldAppendMethodName(method.name)) {
    pathParts.push(toKebabCase(method.name));
  }

  return {
    path: pathParts.join('/'),
    pathParams,
  };
}

/**
 * Generate an OpenAPI-style path from a schema method.
 * Uses {paramName} style for path parameters.
 *
 * @example
 * generateOpenAPIPath('/d1', { name: 'info', ... })
 * // Returns: { path: '/d1/{name}', pathParams: ['name'] }
 */
export function generateOpenAPIPath(basePath: string, method: Schema.method, groupName?: string): GeneratedPath {
  return generateResourcePath(basePath, method, groupName, { paramStyle: 'braces' });
}

/**
 * Generate a router-style path from a schema method.
 * Uses :paramName style for path parameters.
 *
 * @example
 * generateRouterPath('/d1', { name: 'info', ... })
 * // Returns: { path: '/d1/:name', pathParams: ['name'] }
 */
export function generateRouterPath(basePath: string, method: Schema.method, groupName?: string): GeneratedPath {
  return generateResourcePath(basePath, method, groupName, { paramStyle: 'colon' });
}

/**
 * Generate a template literal path from a schema method.
 * Uses ${paramName} style for path parameters.
 *
 * @example
 * generateTemplatePath('/d1', { name: 'info', ... })
 * // Returns: { path: '/d1/${name}', pathParams: ['name'] }
 */
export function generateTemplatePath(
  basePath: string,
  method: Schema.method,
  groupName?: string,
  encodeParams = false,
): GeneratedPath {
  return generateResourcePath(basePath, method, groupName, {
    paramStyle: 'template',
    encodeParams,
  });
}
