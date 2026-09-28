import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureUniqueSdkMethodNames } from './sdk-method-names.ts';

type Metadata = {
  operationId: string;
  'x-fern-sdk-group-name': string;
  'x-fern-sdk-method-name': string;
  'x-fern-ignore': boolean;
};

function metadata(operationId: string, group: string, method: string, ignored = false): Metadata {
  return {
    operationId,
    'x-fern-sdk-group-name': group,
    'x-fern-sdk-method-name': method,
    'x-fern-ignore': ignored,
  };
}

test('renames every member of a method collision from its operationId', () => {
  const first = metadata('posture-create-a-policy', 'data-security.posture', 'create');
  const second = metadata('posture-create-a-rule', 'data-security.posture', 'create');
  const methods = new Map([
    [first.operationId, [first]],
    [second.operationId, [second]],
  ]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 2);
  assert.equal(first['x-fern-sdk-method-name'], 'postureCreateAPolicy');
  assert.equal(second['x-fern-sdk-method-name'], 'postureCreateARule');
  assert.equal(ensureUniqueSdkMethodNames(methods), 0);
});

test('does not combine different groups or ignored operations', () => {
  const visible = metadata('visible-get', 'one', 'get');
  const otherGroup = metadata('other-get', 'two', 'get');
  const ignored = metadata('ignored-get', 'one', 'get', true);
  const methods = new Map([
    [visible.operationId, [visible]],
    [otherGroup.operationId, [otherGroup]],
    [ignored.operationId, [ignored]],
  ]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 0);
  assert.equal(visible['x-fern-sdk-method-name'], 'get');
  assert.equal(otherGroup['x-fern-sdk-method-name'], 'get');
  assert.equal(ignored['x-fern-sdk-method-name'], 'get');
});

test('gives aliases of the same operation deterministic distinct names', () => {
  const first = metadata('shared-operation', 'group', 'get');
  const alias = metadata('shared-operation', 'group', 'get');
  const methods = new Map([[first.operationId, [first, alias]]]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 2);
  assert.notEqual(first['x-fern-sdk-method-name'], alias['x-fern-sdk-method-name']);
  assert.equal(first['x-fern-sdk-method-name'], 'sharedOperation');
  assert.equal(alias['x-fern-sdk-method-name'], 'sharedOperationAlias1');
});

test('avoids an existing method when a collision-derived name would reuse it', () => {
  const existing = metadata('existing', 'data-security.posture', 'postureCreateAPolicy');
  const first = metadata('posture-create-a-policy', 'data-security.posture', 'create');
  const second = metadata('posture-create-a-rule', 'data-security.posture', 'create');
  const methods = new Map([
    [existing.operationId, [existing]],
    [first.operationId, [first]],
    [second.operationId, [second]],
  ]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 2);
  assert.equal(existing['x-fern-sdk-method-name'], 'postureCreateAPolicy');
  assert.notEqual(first['x-fern-sdk-method-name'], existing['x-fern-sdk-method-name']);
  assert.notEqual(first['x-fern-sdk-method-name'], second['x-fern-sdk-method-name']);
  assert.equal(ensureUniqueSdkMethodNames(methods), 0);
});

test('repairs names that collide only after Fern normalization', () => {
  const first = metadata('first-operation', 'group', 'foo-bar');
  const second = metadata('second-operation', 'group', 'fooBar');
  const methods = new Map([
    [first.operationId, [first]],
    [second.operationId, [second]],
  ]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 2);
  assert.notEqual(first['x-fern-sdk-method-name'], second['x-fern-sdk-method-name']);
});

test('hashes operationIds that normalize to the same candidate', () => {
  const first = metadata('foo-bar', 'group', 'get');
  const second = metadata('fooBar', 'group', 'get');
  const methods = new Map([
    [first.operationId, [first]],
    [second.operationId, [second]],
  ]);

  assert.equal(ensureUniqueSdkMethodNames(methods), 2);
  assert.notEqual(first['x-fern-sdk-method-name'], second['x-fern-sdk-method-name']);
  assert.match(first['x-fern-sdk-method-name'], /^fooBar[A-Fa-f0-9]{8}$/);
  assert.match(second['x-fern-sdk-method-name'], /^fooBar[A-Fa-f0-9]{8}$/);
});
