// The WIT records returned by a host, including QuickJS's null options and
// the bigint values used for u64 bounds. The Rust wasm tests exercise the
// real host; this fixture checks the JavaScript projection of its records.
const types = [
  { tag: 'array', val: { elem: 3, minItems: null, maxItems: null } },
  { tag: 'array', val: { elem: 4, minItems: 0n, maxItems: 50n } },
  { tag: 'array', val: { elem: 4, minItems: 1n, maxItems: 50n } },
  { tag: 'scalar', val: { tag: 'string' } },
  { tag: 'scalar', val: { tag: 'uuid' } },
  { tag: 'scalar', val: { tag: 'date-time' } },
  { tag: 'scalar', val: { tag: 'bytes' } },
  { tag: 'scalar', val: { tag: 'number', val: 'int32' } },
];

export function info() {
  return { version: '1', description: '', baseUrl: '' };
}

export function models() {
  return types.map((_, id) => id);
}

export function getModel(id) {
  return { schemaName: `Type${id}`, name: [`type${id}`], description: '', deprecated: false, group: undefined, ty: id };
}

export function getType(id) {
  return types[id];
}
