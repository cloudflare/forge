/**
 * Shared Interface Generation Utilities
 *
 * Provides consistent TypeScript interface generation from schema args.
 */

import type { Schema } from '../schema/schema.js';
import { toCamelCase, toPascalCase } from './naming.js';
import { getOptionalArgs, schemaTypeToTS, walkAllMethods } from './schema-utils.js';

/**
 * Generate a TypeScript interface for method options.
 *
 * @param prefix - Prefix for the interface name (e.g., 'D1', 'D1TimeTravel')
 * @param methodName - The method name (e.g., 'create')
 * @param optionalArgs - List of optional arguments to include
 * @returns Generated interface code, or null if no optional args
 *
 * Example: generateOptionsInterface('D1', 'create', [locationArg, jurisdictionArg])
 * Returns an interface like D1CreateOptions with optional location and jurisdiction fields.
 */
export function generateOptionsInterface(
  prefix: string,
  methodName: string,
  optionalArgs: Schema.arg[],
): string | null {
  if (optionalArgs.length === 0) return null;

  const interfaceName = `${prefix}${toPascalCase(methodName)}Options`;

  const properties = optionalArgs
    .map((arg) => {
      const name = toCamelCase(arg.name);
      const type = schemaTypeToTS(arg);
      const description = arg.description ? `  /** ${arg.description} */\n` : '';
      return `${description}  ${name}?: ${type};`;
    })
    .join('\n');

  return `export interface ${interfaceName} {\n${properties}\n}`;
}

/**
 * Generate TypeScript interfaces for all methods in a schema.
 *
 * @param schema - The command schema
 * @param prefix - Prefix for interface names (e.g., 'D1')
 * @returns Array of generated interface code strings
 */
export function generateAllOptionsInterfaces(schema: Schema.command, prefix: string): string[] {
  const interfaces: string[] = [];

  walkAllMethods(schema.methods, (method, groupPath) => {
    const methodPrefix = groupPath ? `${prefix}${groupPath.split('.').map(toPascalCase).join('')}` : prefix;
    const optionalArgs = getOptionalArgs(method.args ?? []);
    const iface = generateOptionsInterface(methodPrefix, method.name, optionalArgs);
    if (iface) interfaces.push(iface);
  });

  return interfaces;
}

/**
 * Generate a method signature from schema args.
 *
 * @param method - The method definition
 * @param optionsTypeName - Name of the options interface (or null if no options)
 * @returns Method parameter list as a string
 *
 * @example
 * generateMethodSignature(createMethod, 'D1CreateOptions')
 * // Returns: 'name: string, options?: D1CreateOptions'
 */
export function generateMethodSignature(method: Schema.method, optionsTypeName: string | null): string {
  const params: string[] = [];

  // Add required args
  for (const arg of method.args ?? []) {
    if ('name' in arg) {
      if (arg.required === true) {
        params.push(`${toCamelCase(arg.name)}: ${schemaTypeToTS(arg)}`);
      }
    } else {
      // Nested structure
      if (arg.required) {
        for (const a of arg.required) {
          if (a.required === true) {
            params.push(`${toCamelCase(a.name)}: ${schemaTypeToTS(a)}`);
          }
        }
      }
    }
  }

  // Add options parameter if there are optional args
  if (optionsTypeName) {
    params.push(`options?: ${optionsTypeName}`);
  }

  return params.join(', ');
}

/**
 * Generate JSDoc comment from a schema description.
 *
 * @param description - The description text
 * @param indent - Number of spaces to indent (default 2)
 * @returns Formatted JSDoc comment
 */
export function generateJSDoc(description: string, indent = 2): string {
  const spaces = ' '.repeat(indent);
  const firstLine = description.split('\n')[0];
  return `${spaces}/**\n${spaces} * ${firstLine}\n${spaces} */`;
}

/**
 * Generate JSDoc with additional tags.
 *
 * @param description - The description text
 * @param tags - Object mapping tag names to values
 * @param indent - Number of spaces to indent (default 2)
 * @returns Formatted JSDoc comment with tags
 *
 * @example
 * generateJSDocWithTags('Create a database', { deprecated: 'Use createV2 instead' })
 * // Returns:
 * // /**
 * //  * Create a database
 * //  * @deprecated Use createV2 instead
 * //  *\/
 */
export function generateJSDocWithTags(description: string, tags: Record<string, string>, indent = 2): string {
  const spaces = ' '.repeat(indent);
  const lines = [`${spaces}/**`, `${spaces} * ${description.split('\n')[0]}`];

  for (const [tag, value] of Object.entries(tags)) {
    lines.push(`${spaces} * @${tag} ${value}`);
  }

  lines.push(`${spaces} */`);
  return lines.join('\n');
}
