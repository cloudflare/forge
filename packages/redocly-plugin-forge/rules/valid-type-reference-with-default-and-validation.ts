import { isPlainObject } from '../utils/resolve.ts';
import { schemaTypes } from '../utils/schema.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

/**
 * A schema's `default` must fit the type Fern imports the schema as, and integer validation
 * keywords must be integers. Fern's importer either passes the value through (and `fern check`
 * rejects it) or silently drops it; both cases are reported.
 *
 * - string enums: `default` must be one of the values
 * - strings: `default` must be a string
 * - booleans: `default` must be a boolean (Fern also accepts the strings "true" and "false")
 * - integers: `default` must be an integer (`format: int64` imports as `long`, which only
 *   needs a number); `minimum`, `maximum` and `multipleOf` must be integers
 * - numbers: `default` must be a number
 * - arrays: `default` must be an array
 */

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

const VALIDATION_NAMES: Record<string, string> = {
  minimum: 'min',
  maximum: 'max',
  multipleOf: 'multipleOf',
};

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

type NumericKind = 'integer' | 'long' | 'uint' | 'double' | 'float';

function numericKind(type: string, format: unknown): NumericKind {
  switch (format) {
    case 'int64':
      return 'long';
    case 'int32':
      return 'integer';
    case 'uint32':
    case 'uint64':
      return 'uint';
    case 'float':
      return 'float';
    case 'double':
      return 'double';
    default:
      return type === 'integer' ? 'integer' : 'double';
  }
}

export const validTypeReferenceWithDefaultAndValidation: RuleDefinition = {
  name: 'valid-type-reference-with-default-and-validation',
  sourceRules: ['fern-definition/valid-type-reference-with-default-and-validation'],
  severity: 'error',
  description:
    "Schema defaults must match the schema's type and enum, and integer validation keywords must be integers.",
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema) || schema['x-fern-type'] !== undefined) {
        return;
      }
      const types = schemaTypes(schema).filter((type) => type !== 'null');
      if (types.length > 1) {
        return;
      }
      const type = types[0];
      const value = schema.default;
      const hasDefault = value !== undefined && value !== null;
      const reportDefault = (message: string): void => {
        ctx.report({ message, location: ctx.location.child('default') });
      };

      const enumValues = Array.isArray(schema.enum)
        ? schema.enum.filter((member: unknown) => member !== null)
        : undefined;
      const isStringEnum =
        enumValues !== undefined &&
        (type === undefined || type === 'string') &&
        enumValues.every((member: unknown) => typeof member === 'string');

      if (isStringEnum) {
        if (hasDefault && !enumValues.includes(value)) {
          reportDefault(
            `Default value '${show(value)}' is not a valid enum value. Enum values are: ${enumValues.join(', ')}. Fern's importer drops the default.`,
          );
        }
        return;
      }

      switch (type) {
        case 'string':
          if (hasDefault && typeof value !== 'string') {
            reportDefault(`Default value '${show(value)}' is not a valid string. Fern's importer drops the default.`);
          }
          return;
        case 'boolean':
          if (
            hasDefault &&
            typeof value !== 'boolean' &&
            !(typeof value === 'string' && ['true', 'false'].includes(value.toLowerCase()))
          ) {
            reportDefault(`Default value '${show(value)}' is not a valid boolean. Fern's importer drops the default.`);
          }
          return;
        case 'array':
          if (hasDefault && !Array.isArray(value)) {
            reportDefault(
              `Default value '${show(value)}' is not valid: the default value for a list type must be an array.`,
            );
          }
          return;
        case 'integer':
        case 'number': {
          const kind = numericKind(type, schema.format);
          if (hasDefault) {
            if (kind === 'long') {
              if (typeof value !== 'number') {
                reportDefault(
                  `Default value '${show(value)}' is not a valid long (format: int64), which needs a number.`,
                );
              }
            } else if (kind === 'double' || kind === 'float') {
              if (typeof value !== 'number') {
                reportDefault(
                  `Default value '${show(value)}' is not a valid ${kind === 'float' ? 'float' : 'number'}.${kind === 'float' ? " Fern's importer drops the default." : ''}`,
                );
              }
            } else if (!Number.isInteger(value)) {
              reportDefault(
                `Default value '${show(value)}' is not a valid integer.${kind === 'uint' ? " Fern's importer drops the default." : ''}`,
              );
            }
          }
          if (kind === 'integer') {
            for (const [keyword, name] of Object.entries(VALIDATION_NAMES)) {
              const bound = schema[keyword];
              if (typeof bound === 'number' && bound >= INT32_MIN && bound <= INT32_MAX && !Number.isInteger(bound)) {
                ctx.report({
                  message: `Validation for '${name}' must be an integer, but found '${bound}'. The schema is an integer, so ${keyword} must be a whole number.`,
                  location: ctx.location.child(keyword),
                });
              }
            }
          }
          return;
        }
        default:
          return;
      }
    },
  }),
};
