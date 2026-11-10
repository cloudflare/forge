import { camelCase, upperFirst } from 'lodash-es';
import { isPlainObject } from './resolve.ts';
import { schemaTypes } from './schema.ts';
import type { AnyNode, Location } from './types.ts';

/**
 * Name helpers that mirror how Fern's OpenAPI importer turns OpenAPI names into Fern names
 * (`openapi-ir` utils and `openapi-ir-parser` `getSchemaName.ts` / `convertEnum.ts`).
 */

/** Fern's rule for enum value names, field names and discriminant names. */
export const VALID_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Fern's `valid-type-name` check. */
export const TYPE_NAME_REGEX = /^[a-z]/i;

const NUMERIC_REGEX = /^(\d+)/;

const HARDCODED_ENUM_NAMES: Record<string, string> = {
  '<': 'LESS_THAN',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL_TO',
  '<=': 'LESS_THAN_OR_EQUAL_TO',
  '!=': 'NOT_EQUALS',
  '=': 'EQUAL_TO',
  '==': 'EQUAL_TO',
  '*': 'ALL',
  '': 'EMPTY',
  '""': 'EMPTY_STRING',
  '-': 'HYPHEN',
  '|': 'PIPE',
  '.': 'DOT',
  '/': 'SLASH',
};

const SINGLE_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEEN_NUMBERS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS_NUMBERS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spells out 0–9999 in snake_case (`42` → `forty_two`), undefined outside that range. */
export function convertNumberToSnakeCase(number: number): string | undefined {
  if (number < 0 || number > 9999) {
    return undefined;
  }
  if (number < 10) {
    return SINGLE_DIGITS[number];
  }
  if (number < 20) {
    return TEEN_NUMBERS[number - 10];
  }
  if (number < 100) {
    const tens = Math.floor(number / 10);
    const remainder = number % 10;
    return remainder === 0 ? TENS_NUMBERS[tens] : `${TENS_NUMBERS[tens]}_${SINGLE_DIGITS[remainder]}`;
  }
  if (number < 1000) {
    const hundreds = Math.floor(number / 100);
    const remainder = number % 100;
    return remainder === 0
      ? `${SINGLE_DIGITS[hundreds]}_hundred`
      : `${SINGLE_DIGITS[hundreds]}_hundred_${convertNumberToSnakeCase(remainder)}`;
  }
  const thousands = Math.floor(number / 1000);
  const remainder = number % 1000;
  return remainder === 0
    ? `${SINGLE_DIGITS[thousands]}_thousand`
    : `${SINGLE_DIGITS[thousands]}_thousand_${convertNumberToSnakeCase(remainder)}`;
}

/**
 * Spells out a leading number (`2fa` → `two_fa`), undefined when there is none. Like Fern, a number
 * above 9999 followed by more text is spelled `undefined` (`10000Items` → `undefined_Items`).
 */
export function replaceStartingNumber(input: string): string | undefined {
  const matches = input.match(NUMERIC_REGEX);
  if (matches !== null && matches[0] !== undefined) {
    const numericPart = matches[0];
    const nonNumericPart = input.substring(numericPart.length);
    const parsedNumber = parseFloat(numericPart);
    if (!isNaN(parsedNumber) && isFinite(parsedNumber)) {
      const snakeCasedNumber = convertNumberToSnakeCase(parsedNumber);
      return nonNumericPart.length > 0 ? `${String(snakeCasedNumber)}_${nonNumericPart}` : snakeCasedNumber;
    }
  }
  return undefined;
}

/** The Fern type name generated from breadcrumbs, e.g. `["plant_owner"]` → `PlantOwner`. */
export function getGeneratedTypeName(breadcrumbs: string[]): string {
  const name = breadcrumbs
    .map((token) => (/^[^a-zA-Z0-9]+$/.test(token) ? token : upperFirst(camelCase(token))))
    .join('');
  if (/^\d/.test(name)) {
    return replaceStartingNumber(name) ?? name;
  }
  return name;
}

/** The Fern type name generated for a `components.schemas` key. */
export function typeNameForSchemaKey(key: string): string {
  return getGeneratedTypeName([key]);
}

/** The enum value name Fern generates for a value that is not a valid name itself. */
export function generateEnumNameFromValue(value: string): string {
  const maybeParsedNumber = replaceStartingNumber(value);
  const maybeHardcodedEnumName = HARDCODED_ENUM_NAMES[value];
  if (maybeParsedNumber !== undefined) {
    return upperFirst(camelCase(maybeParsedNumber));
  }
  if (maybeHardcodedEnumName !== undefined) {
    return maybeHardcodedEnumName;
  }
  if (value.toLowerCase() === 'n/a') {
    return 'NOT_APPLICABLE';
  }
  return upperFirst(camelCase(value));
}

/** Removes the prefix shared by every name, the way Fern treats `x-enum-varnames`. */
export function stripCommonPrefix(names: string[]): string[] {
  const first = names[0];
  if (names.length <= 1 || first === undefined) {
    return names;
  }
  let index = 0;
  while (first[index] !== undefined && names.every((name) => name[index] === first[index])) {
    index++;
  }
  return names.map((name) => name.substring(index));
}

/** A `x-fern-*` string extension, or undefined when absent or not a string. */
export function stringExtension(node: AnyNode, name: string): string | undefined {
  if (!isPlainObject(node)) {
    return undefined;
  }
  const value = node[name];
  return typeof value === 'string' ? value : undefined;
}

/** `x-fern-request-name`, falling back to `x-request-name`. */
export function requestNameOverride(operation: AnyNode): { name: string; extension: string } | undefined {
  for (const extension of ['x-fern-request-name', 'x-request-name']) {
    const name = stringExtension(operation, extension);
    if (name !== undefined) {
      return { name, extension };
    }
  }
  return undefined;
}

export interface FernEnumValue {
  /** The wire value. */
  value: string;
  /** Location of the value inside `enum` (or `const`). */
  location: Location;
  /** The name override Fern reads, before validation. */
  override?:
    | {
        name: string;
        source: 'x-fern-enum' | 'x-enum-varnames';
        /** For `x-enum-varnames`, the entry before the shared prefix was removed. */
        raw: string;
        location: Location;
      }
    | undefined;
  /** Whether the override passes {@link VALID_NAME_REGEX} (Fern ignores it otherwise). */
  overrideIsValid: boolean;
  /** The name Fern generates from the value. */
  generatedName: string;
  /** The name Fern uses: the valid override, else the generated name. */
  name: string;
}

export interface FernEnum {
  values: FernEnumValue[];
  /** The raw `x-fern-enum` object, when it is an object. */
  fernEnum?: Record<string, AnyNode> | undefined;
  location: Location;
}

/**
 * The enum Fern's importer builds from a schema, or undefined when Fern does not import the schema
 * as an enum (non-string values, other types, `x-fern-type` overrides).
 */
export function getFernEnum(schema: AnyNode, location: Location): FernEnum | undefined {
  if (!isPlainObject(schema) || schema['x-fern-type'] !== undefined) {
    return undefined;
  }
  const hasConst = 'const' in schema;
  if (!hasConst && !Array.isArray(schema.enum)) {
    return undefined;
  }
  const types = schemaTypes(schema).filter((type) => type !== 'null');
  if (types.length > 1 || (types.length === 1 && types[0] !== 'string' && types[0] !== 'enum')) {
    return undefined;
  }
  const rawValues: { value: AnyNode; location: Location }[] = hasConst
    ? [{ value: schema.const, location: location.child('const') }]
    : (schema.enum as AnyNode[]).map((value, index) => ({
        value,
        location: location.child(['enum', index]),
      }));
  const nonNull = rawValues.filter((entry) => entry.value !== null);
  if (!nonNull.every((entry) => typeof entry.value === 'string')) {
    return undefined;
  }
  const seen = new Set<string>();
  const unique = nonNull.filter((entry) => {
    if (seen.has(entry.value)) {
      return false;
    }
    seen.add(entry.value);
    return true;
  });

  const fernEnum = isPlainObject(schema['x-fern-enum'])
    ? (schema['x-fern-enum'] as Record<string, AnyNode>)
    : undefined;
  const varNames = schema['x-enum-varnames'];
  const rawVarNames: string[] | undefined =
    Array.isArray(varNames) && varNames.every((name: AnyNode) => typeof name === 'string') ? varNames : undefined;
  const strippedVarNames = stripCommonPrefix(rawVarNames ?? []);

  const values = unique.map(({ value, location: valueLocation }, index): FernEnumValue => {
    const generatedName = VALID_NAME_REGEX.test(value) ? value : generateEnumNameFromValue(value);
    let override: FernEnumValue['override'];
    const fernEnumEntry = fernEnum !== undefined ? fernEnum[value] : undefined;
    const fernEnumName = stringExtension(fernEnumEntry, 'name');
    if (fernEnumName !== undefined) {
      override = {
        name: fernEnumName,
        source: 'x-fern-enum',
        raw: fernEnumName,
        location: location.child(['x-fern-enum', value, 'name']),
      };
    } else {
      const varName = strippedVarNames[index];
      if (varName !== undefined) {
        override = {
          name: varName,
          source: 'x-enum-varnames',
          raw: rawVarNames?.[index] ?? varName,
          location: location.child(['x-enum-varnames', index]),
        };
      }
    }
    const overrideIsValid = override !== undefined && VALID_NAME_REGEX.test(override.name);
    return {
      value,
      location: valueLocation,
      override,
      overrideIsValid,
      generatedName,
      name: overrideIsValid ? override!.name : generatedName,
    };
  });
  return { values, fernEnum, location };
}

/** Whether Fern imports a schema with a `discriminator` as a discriminated union. */
export function isFernDiscriminatedUnion(schema: AnyNode): boolean {
  if (!isPlainObject(schema) || !isPlainObject(schema.discriminator)) {
    return false;
  }
  const mapping = schema.discriminator.mapping;
  if (!isPlainObject(mapping) || Object.keys(mapping).length === 0) {
    return false;
  }
  const hasOneOf = Array.isArray(schema.oneOf) && schema.oneOf.length > 0;
  const types = schemaTypes(schema).filter((type) => type !== 'null');
  const isObject = types.length === 1 && types[0] === 'object';
  if (hasOneOf && schema['x-fern-discriminated'] === false) {
    return false;
  }
  if (isObject) {
    return true;
  }
  if (hasOneOf) {
    return schema['x-fern-discriminated'] === true || !schema['x-fern-undiscriminated'];
  }
  return schema.oneOf === undefined && schema.anyOf === undefined;
}
