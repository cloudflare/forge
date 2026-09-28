/**
 * Shared Naming Utilities
 *
 * Provides consistent case conversion functions used across all transformers.
 */

/**
 * Convert a kebab-case or snake_case string to camelCase.
 *
 * @example
 * toCamelCase('my-variable') // 'myVariable'
 * toCamelCase('my_variable') // 'myVariable'
 * toCamelCase('MyVariable') // 'myVariable'
 */
export function toCamelCase(str: string): string {
  // Handle already camelCase strings
  if (!str.includes('-') && !str.includes('_')) {
    return str.charAt(0).toLowerCase() + str.slice(1);
  }

  return str.toLowerCase().replace(/[-_](.)/g, (_, char) => char.toUpperCase());
}

/**
 * Convert a kebab-case, snake_case, or camelCase string to PascalCase.
 *
 * @example
 * toPascalCase('my-variable') // 'MyVariable'
 * toPascalCase('my_variable') // 'MyVariable'
 * toPascalCase('myVariable') // 'MyVariable'
 */
export function toPascalCase(str: string): string {
  const camel = toCamelCase(str);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Convert a camelCase or PascalCase string to kebab-case.
 *
 * @example
 * toKebabCase('myVariable') // 'my-variable'
 * toKebabCase('MyVariable') // 'my-variable'
 * toKebabCase('my_variable') // 'my-variable'
 */
export function toKebabCase(str: string): string {
  // First replace underscores with hyphens
  let result = str.replace(/_/g, '-');

  // Then handle camelCase by inserting hyphens before uppercase letters
  result = result.replace(/([a-z])([A-Z])/g, '$1-$2');

  return result.toLowerCase();
}

/**
 * Convert a camelCase or PascalCase string to snake_case.
 *
 * @example
 * toSnakeCase('myVariable') // 'my_variable'
 * toSnakeCase('MyVariable') // 'my_variable'
 * toSnakeCase('my-variable') // 'my_variable'
 */
export function toSnakeCase(str: string): string {
  // First replace hyphens with underscores
  let result = str.replace(/-/g, '_');

  // Then handle camelCase by inserting underscores before uppercase letters
  result = result.replace(/([a-z])([A-Z])/g, '$1_$2');

  return result.toLowerCase();
}

/**
 * Convert camelCase to PascalCase (capitalize first letter).
 *
 * @example
 * camelToPascal('myVariable') // 'MyVariable'
 */
export function camelToPascal(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert PascalCase to camelCase (lowercase first letter).
 *
 * @example
 * pascalToCamel('MyVariable') // 'myVariable'
 */
export function pascalToCamel(str: string): string {
  return str.charAt(0).toLowerCase() + str.slice(1);
}
