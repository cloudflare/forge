/**
 * Reports schema `default` values that don't match the schema's declared type or enum, and
 * integer-schema bounds (`minimum`, `maximum`, `multipleOf`) that aren't integers.
 *
 * Code generators emit defaults directly into typed fields of the generated SDK; a mismatch
 * either fails to compile (TypeScript, Rust) or raises at deserialization (Python, Go). A
 * non-integer bound on an `integer` schema similarly breaks typed validators that expect the
 * bound and the value to share a type.
 *
 * Checks (only applied when the schema declares a single non-null type):
 * - `default: null` is allowed only when every present direct constraint (`type`,
 *   `enum`, `const`) admits `null`, and at least one of them affirmatively permits it.
 *   See {@link isDirectlyNullable}.
 * - string enums: `default` must be one of the enum values
 * - `string`: `default` must be a string
 * - `boolean`: `default` must be a boolean
 * - `integer`: `default` must be an integer; `minimum`, `maximum`, `multipleOf` must be integers
 * - `number`: `default` must be a number
 * - `array`: `default` must be an array
 *
 * Schemas with multiple non-null types (e.g. `type: ['string', 'number']`) are skipped.
 */
import { isPlainObject } from '../utils/resolve.ts';
import { schemaTypes } from '../utils/schema.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Whether the schema's direct constraints agree that `null` is a permitted value.
 * Intentionally conservative — only shallow, local keywords count, and every one that
 * is present must admit `null`:
 *
 * - If `type` is present (OAS 3.1 array, or OAS 3.0 `type` folded with `nullable: true`
 *   by {@link schemaTypes}), it must include `"null"`.
 * - If `enum` is present, it must contain `null`.
 * - If `const` is present, it must equal `null`.
 *
 * At least one of these keywords must affirmatively permit `null`; an empty `{}` is not
 * treated as nullable.
 *
 * This is not a general "does null satisfy the schema" evaluator. See
 * {@link hasCompositionOrRef}: when composition (`allOf`, `oneOf`, `anyOf`, `not`) or a
 * `$ref` is present, the null-default check is skipped rather than approximated.
 */
function isDirectlyNullable(schema: Record<string, AnyNode>): boolean {
  const types = schemaTypes(schema);
  if (types.length > 0 && !types.includes('null')) {
    return false;
  }
  const enumPresent = Array.isArray(schema.enum);
  const enumHasNull = enumPresent && schema.enum.includes(null);
  if (enumPresent && !enumHasNull) {
    return false;
  }
  if (schema.const !== undefined && schema.const !== null) {
    return false;
  }
  return types.includes('null') || enumHasNull || schema.const === null;
}

/**
 * Whether the schema uses composition or indirection whose null-admission would require
 * a JSON Schema evaluator to decide. The rule skips the `default: null` check for these
 * schemas rather than approximate a deeper semantic.
 */
function hasCompositionOrRef(schema: Record<string, AnyNode>): boolean {
  return (
    schema.$ref !== undefined ||
    schema.allOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.anyOf !== undefined ||
    schema.not !== undefined
  );
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
      const hasDefault = value !== undefined;
      const reportDefault = (message: string): void => {
        ctx.report({ message, location: ctx.location.child('default') });
      };

      if (hasDefault && value === null && !hasCompositionOrRef(schema) && !isDirectlyNullable(schema)) {
        reportDefault('Default value is null, but the schema is not nullable.');
      }
      const hasValueDefault = hasDefault && value !== null;

      const enumValues = Array.isArray(schema.enum)
        ? schema.enum.filter((member: unknown) => member !== null)
        : undefined;
      const isStringEnum =
        enumValues !== undefined &&
        (type === undefined || type === 'string') &&
        enumValues.every((member: unknown) => typeof member === 'string');

      if (isStringEnum) {
        if (hasValueDefault && !enumValues.includes(value)) {
          reportDefault(
            `Default value '${show(value)}' is not a valid enum value. Enum values are: ${enumValues.join(', ')}.`,
          );
        }
        return;
      }

      switch (type) {
        case 'string':
          if (hasValueDefault && typeof value !== 'string') {
            reportDefault(`Default value '${show(value)}' is not a string.`);
          }
          return;
        case 'boolean':
          if (hasValueDefault && typeof value !== 'boolean') {
            reportDefault(`Default value '${show(value)}' is not a boolean.`);
          }
          return;
        case 'array':
          if (hasValueDefault && !Array.isArray(value)) {
            reportDefault(`Default value '${show(value)}' is not an array.`);
          }
          return;
        case 'integer':
          if (hasValueDefault && !Number.isInteger(value)) {
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
          if (hasValueDefault && typeof value !== 'number') {
            reportDefault(`Default value '${show(value)}' is not a number.`);
          }
          return;
        default:
          return;
      }
    },
  }),
};
