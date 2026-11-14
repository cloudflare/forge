/**
 * Reports object schema properties whose names normalize (via {@link toForgeWords}) to the same
 * SDK field identifier on the same schema, and property keys that have no letters or digits.
 *
 * A property's effective name is `x-forge-property-name` when set (and non-empty), otherwise the
 * property key. Properties marked `x-forge-skip: true` or `readOnly: true` are ignored (the field
 * is not emitted on the SDK request/response type anyway).
 *
 * Checks `properties` on every Schema node — top-level component schemas and inline/nested ones.
 * Does not look into `allOf` composition: collisions across composed schemas are a separate
 * concern.
 */
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';
import { toForgeWords } from '../utils/words.ts';

interface EffectiveProperty {
  key: string;
  effectiveName: string;
  words: string[];
  usingExtension: boolean;
  location: Location;
}

function propertyLabel(property: EffectiveProperty): string {
  return property.usingExtension
    ? `property '${property.key}' (x-forge-property-name: '${property.effectiveName}')`
    : `property '${property.key}'`;
}

function effectivePropertyOf(
  key: string,
  node: AnyNode,
  propertyLocation: Location,
): { kind: 'ok'; property: EffectiveProperty } | { kind: 'invalid'; message: string; location: Location } | undefined {
  if (!isPlainObject(node) || node['x-forge-skip'] === true || node.readOnly === true) {
    return undefined;
  }
  const extensionValue = node['x-forge-property-name'];
  const usingExtension = typeof extensionValue === 'string' && extensionValue.length > 0;
  const effectiveName = usingExtension ? (extensionValue as string) : key;
  const words = toForgeWords(effectiveName);
  if (words.length === 0) {
    const field = usingExtension ? 'x-forge-property-name' : undefined;
    const location = field === undefined ? propertyLocation.key() : propertyLocation.child(field).key();
    return {
      kind: 'invalid',
      message: usingExtension
        ? `Property '${key}' has an x-forge-property-name '${effectiveName}' with no letters or digits.`
        : `Property '${key}' has no letters or digits. Use \`additionalProperties\` for map schemas or set x-forge-property-name to a valid SDK identifier.`,
      location,
    };
  }
  return {
    kind: 'ok',
    property: {
      key,
      effectiveName,
      words,
      usingExtension,
      location: usingExtension ? propertyLocation.child('x-forge-property-name').key() : propertyLocation.key(),
    },
  };
}

export const noConflictingPropertyNames: RuleDefinition = {
  name: 'no-conflicting-property-names',
  sourceRules: ['fern-definition/no-duplicate-field-names'],
  severity: 'error',
  description:
    'Properties of the same object schema must not normalize to the same Forge identifier, and property keys must have letters or digits.',
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
        return;
      }
      const propertiesLocation = ctx.location.child('properties');
      const groups = new Map<string, EffectiveProperty[]>();
      for (const [key, propertyNode] of Object.entries(schema.properties)) {
        const result = effectivePropertyOf(key, propertyNode, propertiesLocation.child(key));
        if (result === undefined) {
          continue;
        }
        if (result.kind === 'invalid') {
          ctx.report({ message: result.message, location: result.location });
          continue;
        }
        const groupKey = result.property.words.join('\u0000');
        const group = groups.get(groupKey) ?? [];
        group.push(result.property);
        groups.set(groupKey, group);
      }
      for (const [groupKey, group] of groups) {
        if (group.length < 2) {
          continue;
        }
        const normalized = groupKey.replaceAll('\u0000', ' ');
        const labels = group.map(propertyLabel).join(', ');
        ctx.report({
          message: `Properties ${labels} all normalize to '${normalized}' in generated SDK code, which collides. Rename one of them, set a distinct x-forge-property-name, or mark one \`x-forge-skip: true\`.`,
          location: group[group.length - 1]!.location,
        });
      }
    },
  }),
};
