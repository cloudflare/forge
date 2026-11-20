// A packed capnstruct `ForgeDoc` buffer matching the test metadata fixture,
// exercising array bounds (absent, 0n, 1n..50n), UUID scalars, and group trees
// through the plugin API's single-buffer `generate(bytes)` entrypoint.
import { ForgeDoc } from '../../plugin/schema.js';

const types = [
  { tag: 'Array', value: { elem: 3, minItems: null, maxItems: null } },
  { tag: 'Array', value: { elem: 4, minItems: 0n, maxItems: 50n } },
  { tag: 'Array', value: { elem: 4, minItems: 1n, maxItems: 50n } },
  { tag: 'Scalar', value: { tag: 'String' } },
  { tag: 'Scalar', value: { tag: 'Uuid' } },
  { tag: 'Scalar', value: { tag: 'DateTime' } },
  { tag: 'Scalar', value: { tag: 'Bytes' } },
  { tag: 'Scalar', value: { tag: 'Number', value: { tag: 'Int32' } } },
];

export const forgeBytes = ForgeDoc.packEnvelope({
  version: '1',
  description: '',
  baseUrl: '',
  groupOrder: [0, 1],
  groups: [
    {
      name: [],
      description: '',
      path: [],
      parent: null,
      children: [1],
      methods: [],
      models: types.map((_, model) => model),
    },
    {
      name: ['pets'],
      description: '',
      path: [1],
      parent: 0,
      children: [],
      methods: [],
      models: [],
    },
  ],
  methods: [],
  models: types.map((_, id) => ({
    schemaName: `Type${id}`,
    name: [`type${id}`],
    group: 0,
    description: '',
    deprecated: false,
    ty: id,
  })),
  types,
});
