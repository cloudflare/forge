/**
 * A parser for Fern's type reference syntax (`optional<list<string>>`, `map<string, Foo>`, ...),
 * as accepted by `x-fern-type` and the `type` of `x-fern-global-headers` /
 * `x-fern-idempotency-headers`. It mirrors Fern's `visitRawTypeReference`, including its
 * regex-based matching: whatever is not a primitive, `unknown` or a container is a named type.
 */

export type FernTypeNode =
  | { kind: 'primitive'; name: string }
  | { kind: 'unknown' }
  | { kind: 'literal' }
  | { kind: 'named'; name: string }
  | {
      kind: 'list' | 'set' | 'optional' | 'nullable';
      value: FernTypeNode;
    }
  | { kind: 'map'; key: FernTypeNode; value: FernTypeNode };

export const FERN_PRIMITIVES: ReadonlySet<string> = new Set([
  'integer',
  'long',
  'uint',
  'uint64',
  'float',
  'double',
  'boolean',
  'string',
  'datetime',
  'datetime-rfc-2822',
  'base64',
  'uuid',
  'date',
  'bigint',
]);

const CONTAINER_REGEX = {
  map: /^map<\s*([^,]*)\s*,\s*(.*)\s*>$/,
  list: /^list<\s*(.*)\s*>$/,
  set: /^set<\s*(.*)\s*>$/,
  optional: /^optional<\s*(.*)\s*>$/,
  nullable: /^nullable<\s*(.*)\s*>$/,
  literal: /^literal<\s*(?:"(.*)"|(true|false))\s*>$/,
} as const;

const MAX_DEPTH = 64;

export function parseFernType(type: string, depth = 0): FernTypeNode {
  if (depth > MAX_DEPTH) {
    return { kind: 'named', name: type };
  }
  if (FERN_PRIMITIVES.has(type)) {
    return { kind: 'primitive', name: type };
  }
  if (type === 'unknown') {
    return { kind: 'unknown' };
  }
  const map = CONTAINER_REGEX.map.exec(type);
  if (map?.[1] !== undefined && map[2] !== undefined) {
    return {
      kind: 'map',
      key: parseFernType(map[1], depth + 1),
      value: parseFernType(map[2], depth + 1),
    };
  }
  for (const kind of ['list', 'set', 'optional', 'nullable'] as const) {
    const match = CONTAINER_REGEX[kind].exec(type);
    if (match?.[1] !== undefined) {
      return { kind, value: parseFernType(match[1], depth + 1) };
    }
  }
  const literal = CONTAINER_REGEX.literal.exec(type);
  if (literal?.[1] !== undefined || literal?.[2] !== undefined) {
    return { kind: 'literal' };
  }
  return { kind: 'named', name: type };
}

/** Named types referenced anywhere in a parsed type, in order of appearance. */
export function namedTypes(node: FernTypeNode): string[] {
  switch (node.kind) {
    case 'named':
      return [node.name];
    case 'map':
      return [...namedTypes(node.key), ...namedTypes(node.value)];
    case 'list':
    case 'set':
    case 'optional':
    case 'nullable':
      return namedTypes(node.value);
    default:
      return [];
  }
}

/**
 * Map keys the OpenAPI importer rejects: it only builds a map when the key is a bare primitive,
 * and otherwise drops the whole type.
 */
export function nonPrimitiveMapKeys(node: FernTypeNode): FernTypeNode[] {
  switch (node.kind) {
    case 'map':
      return [
        ...(node.key.kind === 'primitive' ? [] : [node.key]),
        ...nonPrimitiveMapKeys(node.key),
        ...nonPrimitiveMapKeys(node.value),
      ];
    case 'list':
    case 'set':
    case 'optional':
    case 'nullable':
      return nonPrimitiveMapKeys(node.value);
    default:
      return [];
  }
}

/** Renders a parsed type back to Fern syntax (used in messages). */
export function formatFernType(node: FernTypeNode): string {
  switch (node.kind) {
    case 'primitive':
      return node.name;
    case 'unknown':
      return 'unknown';
    case 'literal':
      return 'literal<...>';
    case 'named':
      return node.name;
    case 'map':
      return `map<${formatFernType(node.key)}, ${formatFernType(node.value)}>`;
    default:
      return `${node.kind}<${formatFernType(node.value)}>`;
  }
}

/** Whether a named type looks like an identifier rather than broken container syntax. */
export function isTypeNameSyntax(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name);
}
