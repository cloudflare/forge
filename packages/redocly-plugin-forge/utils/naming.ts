import { camelCase } from 'lodash-es';

/** lodash `camelCase`, the normalization Fern applies to generated SDK names. */
export function lodashCamelCase(input: string): string {
  return camelCase(input);
}

/**
 * The camelCase normalization of Fern's `no-conflicting-parameter-names` rule: removes `-`/`_`
 * runs, upper-cases the following character, and lower-cases a leading capital.
 *
 * `Organization-Id` and `organization_id` both become `organizationId`; `X-Plant-Id` becomes
 * `xPlantId`.
 */
export function fernParameterCamelCase(input: string): string {
  return input
    .replace(/[-_]+(.)?/g, (_match, char: string | undefined) => (char !== undefined ? char.toUpperCase() : ''))
    .replace(/^[A-Z]/, (char) => char.toLowerCase());
}

/**
 * The SDK name Fern's OpenAPI importer gives a header parameter: `x-fern-parameter-name` when set,
 * otherwise the camelCased header name without a leading `x-`/`X-`.
 */
export function headerSdkName(headerName: string, parameterNameOverride: string | undefined): string {
  return parameterNameOverride ?? camelCase(headerName.replace(/^x-|^X-/, ''));
}

/** A string-valued extension, or undefined when absent or malformed. */
export function stringExtension(node: unknown, extension: string): string | undefined {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const value = (node as Record<string, unknown>)[extension];
  return typeof value === 'string' ? value : undefined;
}
