/**
 * Reports names Fern would use more than once inside one type.
 *
 * Objects: a property's Fern name is its `x-fern-property-name`, else its key (keys that start
 * with a digit get a `_` prefix). Two different properties, own or inherited through `allOf`,
 * must not end up with the same name. Repeating the same key across `allOf` members is fine: Fern
 * merges those.
 *
 * Enums: a value's Fern name is its valid `x-fern-enum.<value>.name` or `x-enum-varnames` entry,
 * else its literal wire value. Two enum values must not end up with the same name.
 *
 * Discriminated unions are keyed by `discriminator.mapping`, whose keys are unique, so they are not
 * checked. Inline request body schemas are not checked either: Fern renames clashing request
 * properties itself.
 */
import { rootOf } from '../utils/document.ts';
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName, unwrapSchema } from '../utils/schema.ts';
import { getFernEnum, isFernDiscriminatedUnion, stringExtension } from '../utils/type-names.ts';
import { collectDeclarations, describeLocation, isRequestBodySchemaPointer } from '../utils/type-names-declarations.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

interface Field {
  key: string;
  name: string;
  override?: string;
  /** Location of the property key. */
  location: Location;
  /** Location of what decides the name: the `x-fern-property-name`, else the property key. */
  nameLocation: Location;
  /** `$ref`s the property is inherited through. */
  via: string[];
}

/**
 * Collects the properties of an object the way Fern's importer does: own properties (without
 * `x-fern-ignore`d ones), inline `allOf` members merged in place and `$ref` `allOf` members
 * inherited, except discriminated unions, which Fern does not inherit from. The first property
 * with a given key wins.
 */
function collectFields(ctx: Ctx, located: Located): Field[] {
  const fields = new Map<string, Field>();
  const seen = new Set<string>();
  const visit = (current: Located, via: string[]): void => {
    const resolved = unwrapSchema(ctx, current);
    if (resolved === undefined || !isPlainObject(resolved.node)) {
      return;
    }
    if (seen.has(resolved.location.absolutePointer)) {
      return;
    }
    seen.add(resolved.location.absolutePointer);
    const schema = resolved.node;
    if (isPlainObject(schema.properties)) {
      for (const [key, property] of Object.entries(schema.properties)) {
        if (fields.has(key)) {
          continue;
        }
        if (isPlainObject(property) && property['x-fern-ignore'] === true) {
          continue;
        }
        const location = resolved.location.child(['properties', key]);
        const override = stringExtension(property, 'x-fern-property-name');
        fields.set(key, {
          key,
          name: /^[0-9]/.test(key) ? `_${key}` : (override ?? key),
          override,
          location,
          nameLocation: override === undefined ? location.key() : location.child('x-fern-property-name'),
          via,
        });
      }
    }
    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((member: AnyNode, index: number) => {
        const memberLocation = resolved.location.child(['allOf', index]);
        if (isRefNode(member)) {
          const target = resolveNode(ctx, member, memberLocation);
          if (
            isPlainObject(target?.node) &&
            isPlainObject(target.node.discriminator) &&
            isPlainObject(target.node.discriminator.mapping)
          ) {
            return;
          }
          visit({ node: member, location: memberLocation }, [...via, refName(member.$ref)]);
        } else {
          visit({ node: member, location: memberLocation }, via);
        }
      });
    }
  };
  visit(located, []);
  return [...fields.values()];
}

function describeField(field: Field, rootRef: string): string {
  const parts = [`"${field.key}"`];
  if (field.override !== undefined) {
    parts.push(`(x-fern-property-name "${field.override}")`);
  }
  if (field.via.length > 0) {
    parts.push(`inherited from ${field.via.join(' -> ')}`);
  }
  parts.push(`at ${describeLocation(field.location, rootRef)}`);
  return parts.join(' ');
}

function checkObject(ctx: UserContext, located: Located, rootRef: string): void {
  const groups = new Map<string, Field[]>();
  for (const field of collectFields(ctx, located)) {
    const group = groups.get(field.name) ?? [];
    group.push(field);
    groups.set(field.name, group);
  }
  for (const [name, fields] of groups) {
    if (fields.length < 2) {
      continue;
    }
    const own = fields.filter((field) => field.via.length === 0);
    const parents = new Set(fields.map((field) => field.via[0]));
    if (own.length === 0 && parents.size === 1) {
      // Every property comes from the same parent, which reports the problem itself.
      continue;
    }
    const reportAt = own[own.length - 1]?.nameLocation ?? located.location.child('allOf').key();
    ctx.report({
      message: `Object has multiple properties named "${name}": ${fields.map((field) => describeField(field, rootRef)).join(', ')}. Give each property a unique name with x-fern-property-name.`,
      location: reportAt,
    });
  }
}

function checkEnum(ctx: UserContext, schema: AnyNode, location: Location): void {
  const fernEnum = getFernEnum(schema, location);
  if (fernEnum === undefined) {
    return;
  }
  const kept = new Map<string, { value: string; name: string }>();
  for (const value of fernEnum.values) {
    const key = value.overrideIsValid ? value.override!.name : value.value;
    const first = kept.get(key);
    if (first === undefined) {
      kept.set(key, { value: value.value, name: key });
      continue;
    }

    const clash = `its name "${key}" is also the name of the earlier value "${first.value}"`;
    ctx.report({
      message: `Fern silently drops enum value "${value.value}" from the generated SDK: ${clash}. Give each value a unique name with x-fern-enum.`,
      location: value.overrideIsValid ? value.override!.location : value.location,
    });
  }
}

export const noDuplicateFieldNames: RuleDefinition = {
  name: 'no-duplicate-field-names',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-duplicate-field-names'],
  severity: 'error',
  description: 'Object properties and enum values must have unique Fern names.',
  rule: () => {
    const objects: Located[] = [];
    let rootRef = '';
    return {
      Root: {
        enter(_root: AnyNode, ctx: UserContext) {
          rootRef = ctx.location.source.absoluteRef;
        },
        leave(root: AnyNode, ctx: UserContext) {
          const { inlinedComponents } = collectDeclarations(ctx, rootOf(root, ctx), []);
          for (const located of objects) {
            const match = /^#\/components\/schemas\/([^/]+)$/.exec(located.location.pointer);
            if (
              match !== null &&
              located.location.source.absoluteRef === rootRef &&
              inlinedComponents.has(match[1]!.replace(/~1/g, '/').replace(/~0/g, '~'))
            ) {
              continue;
            }
            checkObject(ctx, located, rootRef);
          }
        },
      },
      Schema(schema: AnyNode, ctx: UserContext) {
        if (!isPlainObject(schema) || schema['x-fern-type'] !== undefined || schema['x-fern-ignore'] === true) {
          return;
        }
        checkEnum(ctx, schema, ctx.location);
        const pointer = ctx.location.pointer;
        if (/\/allOf\/\d+$/.test(pointer) || isRequestBodySchemaPointer(pointer) || isFernDiscriminatedUnion(schema)) {
          return;
        }
        if (isPlainObject(schema.properties) || Array.isArray(schema.allOf)) {
          objects.push({ node: schema, location: ctx.location });
        }
      },
    };
  },
};
