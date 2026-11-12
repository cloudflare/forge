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

// The root, group 0, holds every model, and the top-level group `pets`,
// group 1, holds nothing.
export function groups() {
  return [0, 1];
}

export function getGroup(id) {
  if (id === 0) {
    return {
      name: [],
      description: '',
      path: [],
      parent: null,
      children: [1],
      methods: [],
      models: types.map((_, model) => model),
    };
  }
  return { name: ['pets'], description: '', path: [1], parent: 0, children: [], methods: [], models: [] };
}

export function getModel(id) {
  return { schemaName: `Type${id}`, name: [`type${id}`], description: '', deprecated: false, group: 0, ty: id };
}

export function getType(id) {
  return types[id];
}
