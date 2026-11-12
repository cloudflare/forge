/**
 * A schema's `default` must be a valid value for the schema's type and enum, and integer
 * validation keywords (`minimum`, `maximum`, `multipleOf`) must be integers.
 *
 * - string enums: `default` must be one of the values
 * - string: `default` must be a string
 * - boolean: `default` must be a boolean
 * - integer: `default` must be an integer; `minimum`, `maximum` and `multipleOf` must be integers
 * - number: `default` must be a number
 * - array: `default` must be an array
 */
import { isPlainObject } from '../utils/resolve.ts';
import { schemaTypes } from '../utils/schema.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export const validSchemaDefaults: RuleDefinition = {
  name: 'valid-schema-defaults',
  sourceRules: ['fern-definition/valid-type-reference-with-default-and-validation'],
  severity: 'error',
  description: "Schema defaults must match the schema's type and enum, and integer bounds must be integers.",
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema)) {
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
            `Default value '${show(value)}' is not a valid enum value. Enum values are: ${enumValues.join(', ')}.`,
          );
        }
        return;
      }

      switch (type) {
        case 'string':
          if (hasDefault && typeof value !== 'string') {
            reportDefault(`Default value '${show(value)}' is not a string.`);
          }
          return;
        case 'boolean':
          if (hasDefault && typeof value !== 'boolean') {
            reportDefault(`Default value '${show(value)}' is not a boolean.`);
          }
          return;
        case 'array':
          if (hasDefault && !Array.isArray(value)) {
            reportDefault(`Default value '${show(value)}' is not an array.`);
          }
          return;
        case 'integer':
          if (hasDefault && !Number.isInteger(value)) {
            reportDefault(`Default value '${show(value)}' is not an integer.`);
          }
          for (const keyword of ['minimum', 'maximum', 'multipleOf']) {
            const bound = schema[keyword];
            if (typeof bound === 'number' && !Number.isInteger(bound)) {
              ctx.report({
                message: `Integer schema has non-integer '${keyword}': ${bound}.`,
                location: ctx.location.child(keyword),
              });
            }
          }
          return;
        case 'number':
          if (hasDefault && typeof value !== 'number') {
            reportDefault(`Default value '${show(value)}' is not a number.`);
          }
          return;
        default:
          return;
      }
    },
  }),
};
