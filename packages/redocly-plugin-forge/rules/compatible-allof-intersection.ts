/**
 * Reports `allOf` compositions whose members' types cannot all be satisfied by the same value —
 * the intersection is empty, so no value matches the composed schema. For example, mixing an
 * object member with a string member, or declaring the enclosing schema as `type: object` while
 * one of its `allOf` members resolves to a scalar.
 *
 * Deliberately permissive about the OAS 3.0 sibling-escape idiom — a single-member `allOf: [$ref]`
 * whose enclosing schema declares nothing about `type` (just `description`, `example`, etc.) —
 * since that is the only way to attach sibling keywords to a `$ref` in OAS 3.0, and it introduces
 * no intersection conflict on its own.
 */
import { isPlainObject, isRefNode, resolveNode } from '../utils/resolve.ts';
import { refName } from '../utils/schema.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

type PrimType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

const PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function toPrimType(value: string): PrimType | undefined {
  return PRIMITIVE_TYPES.has(value) ? (value as PrimType) : undefined;
}

function declaredTypes(schema: Record<string, AnyNode>): PrimType[] {
  const result: PrimType[] = [];
  const typeField = schema.type;
  if (typeof typeField === 'string') {
    const primitive = toPrimType(typeField);
    if (primitive !== undefined) {
      result.push(primitive);
    }
  } else if (Array.isArray(typeField)) {
    for (const value of typeField) {
      if (typeof value === 'string') {
        const primitive = toPrimType(value);
        if (primitive !== undefined && !result.includes(primitive)) {
          result.push(primitive);
        }
      }
    }
  }
  // OAS 3.0 `nullable: true` folds `null` into an existing type; on its own (no `type` keyword),
  // the spec gives it no meaning, so we leave the schema unconstrained rather than flipping it to
  // "only null" — the latter would turn a bare `{nullable: true}` into an intersection trap.
  if (schema.nullable === true && result.length > 0 && !result.includes('null')) {
    result.push('null');
  }
  return result;
}

function inferredTypes(schema: Record<string, AnyNode>): Set<PrimType> {
  const result = new Set<PrimType>();
  if (
    isPlainObject(schema.properties) ||
    isPlainObject(schema.additionalProperties) ||
    isPlainObject(schema.patternProperties)
  ) {
    result.add('object');
  }
  if (schema.items !== undefined) {
    result.add('array');
  }
  return result;
}

/**
 * The set of primitive types a value matching `schema` may take. `undefined` means
 * "unconstrained" (any type passes); an empty set means "known impossible" (no type passes).
 *
 * Resolves `$ref` chains transitively, intersects across `allOf` members, and unions across
 * `oneOf`/`anyOf`. Infers `object` from `properties`/`additionalProperties`/`patternProperties`
 * and `array` from `items`, so dropping `type` cannot dodge the check. OAS 3.0 `nullable: true`
 * and OAS 3.1 `type: [X, 'null']` add `null` to the set — null is an alternate, not an additional
 * constraint, so a value may be either the base type or null.
 *
 * Cycle detection is path-local: each descent gets a fresh copy of the ancestor set so sibling
 * branches that diamond onto the same schema are each decided on their own merits.
 */
function possibleTypes(ctx: Ctx, located: Located, seen: ReadonlySet<string>): Set<PrimType> | undefined {
  const resolved = resolveNode(ctx, located.node, located.location);
  if (resolved === undefined || !isPlainObject(resolved.node)) {
    return undefined;
  }
  const key = resolved.location.absolutePointer;
  if (seen.has(key)) {
    return undefined;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  const schema = resolved.node;

  const declared = declaredTypes(schema);
  let types: Set<PrimType> | undefined = declared.length > 0 ? new Set(declared) : undefined;

  if (types === undefined) {
    const inferred = inferredTypes(schema);
    if (inferred.size > 0) {
      types = inferred;
      if (schema.nullable === true) {
        types.add('null');
      }
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    for (let index = 0; index < schema.allOf.length; index++) {
      const memberTypes = possibleTypes(
        ctx,
        { node: schema.allOf[index], location: resolved.location.child(['allOf', index]) },
        nextSeen,
      );
      if (memberTypes === undefined) {
        continue;
      }
      types = types === undefined ? new Set(memberTypes) : intersectTypes(types, memberTypes);
    }
  }

  for (const unionKey of ['oneOf', 'anyOf'] as const) {
    const members = schema[unionKey];
    if (!Array.isArray(members) || members.length === 0) {
      continue;
    }
    const union = new Set<PrimType>();
    let anyUnknown = false;
    for (let index = 0; index < members.length; index++) {
      const memberTypes = possibleTypes(
        ctx,
        { node: members[index], location: resolved.location.child([unionKey, index]) },
        nextSeen,
      );
      if (memberTypes === undefined) {
        anyUnknown = true;
        break;
      }
      for (const type of memberTypes) {
        union.add(type);
      }
    }
    if (!anyUnknown) {
      types = types === undefined ? union : intersectTypes(types, union);
    }
  }

  return types;
}

function intersectTypes(left: Set<PrimType>, right: Set<PrimType>): Set<PrimType> {
  const result = new Set<PrimType>();
  for (const type of left) {
    if (right.has(type)) {
      result.add(type);
    } else if ((type === 'integer' && right.has('number')) || (type === 'number' && right.has('integer'))) {
      result.add('integer');
    }
  }
  return result;
}

/**
 * The types the enclosing schema fixes via keywords other than `allOf` — explicit `type` or the
 * `properties`/`items` inference. `oneOf`/`anyOf` siblings are not consulted here; the rule only
 * uses this to seed the intersection the `allOf` members must satisfy, and union-siblings pull
 * in cases that are better reported at their own level.
 */
function enclosingTypes(schema: Record<string, AnyNode>): Set<PrimType> | undefined {
  const declared = declaredTypes(schema);
  if (declared.length > 0) {
    return new Set(declared);
  }
  const inferred = inferredTypes(schema);
  if (inferred.size === 0) {
    return undefined;
  }
  if (schema.nullable === true) {
    inferred.add('null');
  }
  return inferred;
}

function describeTypes(types: Set<PrimType>): string {
  const nonNull = [...types].filter((type) => type !== 'null');
  if (nonNull.length === 0) {
    return 'only null';
  }
  if (nonNull.length === 1) {
    const type = nonNull[0]!;
    const article = /^[aeiou]/.test(type) ? 'an' : 'a';
    return `${article} ${type}`;
  }
  return `one of ${nonNull.join('/')}`;
}

interface MemberReport {
  label: string;
  reportLocation: Location;
}

function memberReport(member: AnyNode, memberLocation: Location, index: number): MemberReport {
  if (isRefNode(member)) {
    return {
      label: `allOf $ref "${refName(member.$ref)}"`,
      reportLocation: memberLocation.child('$ref').key(),
    };
  }
  return {
    label: `allOf member at index ${index}`,
    reportLocation: memberLocation,
  };
}

export const compatibleAllofIntersection: RuleDefinition = {
  name: 'compatible-allof-intersection',
  sourceRules: ['fern-definition/only-object-extensions'],
  severity: 'error',
  description: '`allOf` members must have compatible types; their intersection cannot be empty.',
  rule: () => ({
    Schema(schema: AnyNode, ctx: UserContext) {
      if (!isPlainObject(schema) || !Array.isArray(schema.allOf) || schema.allOf.length === 0) {
        return;
      }

      const enclosing = enclosingTypes(schema);
      let running: Set<PrimType> | undefined = enclosing;
      let conflictContext: string | undefined =
        enclosing !== undefined ? `${describeTypes(enclosing)} required by the enclosing schema` : undefined;

      for (let index = 0; index < schema.allOf.length; index++) {
        const member = schema.allOf[index];
        const memberLocation = ctx.location.child(['allOf', index]);
        const memberTypes = possibleTypes(ctx, { node: member, location: memberLocation }, new Set());
        if (memberTypes === undefined) {
          continue;
        }

        const next = running === undefined ? new Set(memberTypes) : intersectTypes(running, memberTypes);
        if (next.size === 0) {
          const report = memberReport(member, memberLocation, index);
          const context = conflictContext ?? 'an earlier allOf member';
          ctx.report({
            message: `${report.label} is ${describeTypes(memberTypes)}; cannot intersect with ${context}.`,
            location: report.reportLocation,
          });
          continue;
        }

        running = next;
        const report = memberReport(member, memberLocation, index);
        conflictContext = `${describeTypes(memberTypes)} required by ${report.label}`;
      }
    },
  }),
};
