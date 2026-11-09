/**
 * Checks that enum value names and discriminant names Fern derives from the document are suitable
 * for code generation: they must start with a letter and only contain letters, numbers and
 * underscores.
 *
 * Enums: Fern ignores an `x-fern-enum.<value>.name` or `x-enum-varnames` entry (after removing the
 * prefix shared by all entries) that is not a valid name, logs a warning and falls back on the name
 * it generates from the value. That is a warning, or an error when the fallback is not valid
 * either. A value without a valid name override whose generated name is invalid is an error,
 * unless Fern drops the value because its name repeats an earlier one.
 * `x-fern-enum` entries for values that are not in `enum`, and an `x-fern-enum` that is not an
 * object, are silently ignored (warnings).
 *
 * Discriminated unions: `discriminator.x-fern-property-name`, else `discriminator.propertyName`.
 */
import { isPlainObject } from '../utils/resolve.ts';
import { getFernEnum, isFernDiscriminatedUnion, stringExtension, VALID_NAME_REGEX } from '../utils/type-names.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

const X_FERN_ENUM_DOCS_LINK =
  'https://buildwithfern.com/learn/api-definitions/openapi/extensions/enum-descriptions-and-names';

const NAME_REQUIREMENT = 'It must start with a letter and only contain letters, numbers, and underscores.';

function checkEnum(ctx: UserContext, schema: AnyNode, location: Location): void {
  const fernEnum = getFernEnum(schema, location);
  if (fernEnum === undefined) {
    return;
  }
  const names = new Set<string>();
  for (const value of fernEnum.values) {
    const { override } = value;
    const generatedIsValid = VALID_NAME_REGEX.test(value.generatedName);
    // Fern drops values whose name repeats an earlier one (see no-duplicate-field-names), so it
    // never validates their names.
    const dropped = names.has(value.name.toLowerCase());
    names.add(value.name.toLowerCase());
    if (override !== undefined && !value.overrideIsValid) {
      const subject =
        override.source === 'x-fern-enum'
          ? `x-fern-enum name "${override.name}"`
          : override.raw === override.name
            ? `x-enum-varnames entry "${override.raw}"`
            : `x-enum-varnames entry "${override.raw}" (which becomes "${override.name}" once Fern removes the prefix shared by all entries)`;
      const fallback = generatedIsValid
        ? `Fern ignores it and uses the name it generates from the value, "${value.generatedName}".`
        : value.generatedName === ''
          ? 'Fern ignores it and cannot generate a name from the value either.'
          : `Fern ignores it and falls back on the name it generates from the value, "${value.generatedName}", which is not valid either.`;
      ctx.report({
        message: `${subject} for enum value "${value.value}" is not suitable for code generation. ${NAME_REQUIREMENT} ${fallback}`,
        location: override.location,
        ...(generatedIsValid || dropped ? { forceSeverity: 'warn' as const } : {}),
      });
      continue;
    }
    if (!value.overrideIsValid && !generatedIsValid && !dropped) {
      const generated =
        value.generatedName === ''
          ? 'Fern cannot generate a name from it'
          : `the name Fern generates from it, "${value.generatedName}", is not valid`;
      ctx.report({
        message: `Enum value "${value.value}" is not suitable for code generation: ${generated}. Use the x-fern-enum extension to specify a name that starts with a letter and contains only letters, numbers, and underscores: ${X_FERN_ENUM_DOCS_LINK}`,
        location: value.location,
      });
    }
  }
  if (schema['x-fern-enum'] !== undefined && fernEnum.fernEnum === undefined) {
    ctx.report({
      message: 'x-fern-enum must be an object keyed by enum value; Fern ignores it.',
      location: location.child('x-fern-enum'),
      forceSeverity: 'warn',
    });
  }
  if (fernEnum.fernEnum !== undefined) {
    const values = new Set(fernEnum.values.map((value) => value.value));
    for (const key of Object.keys(fernEnum.fernEnum)) {
      if (!values.has(key)) {
        ctx.report({
          message: `x-fern-enum has an entry for "${key}", which is not one of the enum values, so Fern ignores it.`,
          location: location.child(['x-fern-enum', key]).key(),
          forceSeverity: 'warn',
        });
      }
    }
  }
}

function checkDiscriminator(ctx: UserContext, schema: AnyNode, location: Location): void {
  if (!isFernDiscriminatedUnion(schema)) {
    return;
  }
  const discriminator = schema.discriminator;
  const override = stringExtension(discriminator, 'x-fern-property-name');
  const discriminatorLocation = location.child('discriminator');
  if (override !== undefined) {
    if (!VALID_NAME_REGEX.test(override)) {
      ctx.report({
        message: `Discriminant name "${override}" (discriminator.x-fern-property-name) is not suitable for code generation. ${NAME_REQUIREMENT}`,
        location: discriminatorLocation.child('x-fern-property-name'),
      });
    }
    return;
  }
  const propertyName = discriminator.propertyName;
  if (typeof propertyName === 'string' && !VALID_NAME_REGEX.test(propertyName)) {
    ctx.report({
      message: `Discriminant "${propertyName}" (discriminator.propertyName) is not suitable for code generation. Add discriminator.x-fern-property-name with a name that starts with a letter and contains only letters, numbers, and underscores.`,
      location: discriminatorLocation.child('propertyName'),
    });
  }
}

export const validFieldNames: RuleDefinition = {
  name: 'valid-field-names',
  sourceRules: ['fern-definition/valid-field-names'],
  severity: 'error',
  description:
    'Enum value names and discriminant names must start with a letter and contain only letters, numbers, and underscores.',
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema) || schema['x-fern-type'] !== undefined) {
        return;
      }
      checkEnum(ctx, schema, ctx.location);
      checkDiscriminator(ctx, schema, ctx.location);
    },
  }),
};
