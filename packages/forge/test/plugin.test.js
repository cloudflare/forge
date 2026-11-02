import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Supply the imported host interface while using the built plugin library
// unchanged, just as a component receives that interface from Forge.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier === 'forge:plugin/forge@0.3.0'
        ? new URL('./fixtures/metadata-host.js', import.meta.url).href
        : specifier,
      context,
    );
  },
});
const { definePlugin } = await import('../plugin/index.js');
hooks.deregister();

test('array bounds distinguish absent, zero and one through the plugin API', () => {
  definePlugin({
    generate(forge) {
      const [absent, zero, one] = forge.models.map((model) => model.type);
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
  }).generate();
});

test('UUIDs are a distinct scalar through the plugin API', () => {
  definePlugin({
    generate(forge) {
      assert.deepEqual(
        forge.models.slice(3).map((model) => model.type),
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
  }).generate();
});
