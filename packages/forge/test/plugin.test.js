import assert from 'node:assert/strict';
import { test } from 'node:test';

import { definePlugin } from '../plugin/plugin.js';
import { forgeBytes } from './fixtures/metadata-host.js';

// The fixture packs a capnstruct `ForgeDoc` buffer identical to what the host
// passes to `generate(forge: list<u8>)`, exercising the plugin API end-to-end.
test('array bounds distinguish absent, zero and one through the plugin API', () => {
  definePlugin({
    generate(forge) {
      const [absent, zero, one] = forge.groups[0].models.map((model) => model.type);
      assert.equal(absent.kind, 'array');
      assert.equal(absent.minItems, undefined);
      assert.equal(absent.maxItems, undefined);
      assert.equal(zero.minItems, 0);
      assert.equal(zero.maxItems, 50);
      assert.equal(one.minItems, 1);
      assert.equal(one.maxItems, 50);
      assert.equal(one.elem.scalar, 'uuid');
      return [];
    },
  }).generate(forgeBytes);
});

test('UUIDs are a distinct scalar through the plugin API', () => {
  definePlugin({
    generate(forge) {
      assert.deepEqual(
        forge.groups[0].models.slice(3).map((model) => model.type),
        [
          { kind: 'scalar', scalar: 'string' },
          { kind: 'scalar', scalar: 'uuid' },
          { kind: 'scalar', scalar: 'date-time' },
          { kind: 'scalar', scalar: 'bytes' },
          { kind: 'scalar', scalar: 'number', number: 'int32' },
        ],
      );
      return [];
    },
  }).generate(forgeBytes);
});

test('every group is inside the root, which comes first', () => {
  definePlugin({
    generate(forge) {
      const [root, pets] = forge.groups;
      assert.equal(root.name.isEmpty, true);
      assert.deepEqual(root.path, []);
      assert.equal(root.parent, undefined);
      assert.deepEqual(root.children, [pets]);
      assert.equal(pets.parent, root);
      assert.equal(pets.path.length, 1);
      assert.ok(root.models.every((model) => model.group === root));
      return [];
    },
  }).generate(forgeBytes);
});
