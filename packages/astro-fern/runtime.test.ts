import assert from 'node:assert/strict';
import test from 'node:test';
import { targetFromHash } from './runtime.ts';

test('targetFromHash resolves configured targets', () => {
  assert.equal(targetFromHash('#type%73cript', ['typescript']), 'typescript');
  assert.equal(targetFromHash('#python', ['typescript']), undefined);
});

test('targetFromHash rejects malformed percent encoding', () => {
  assert.equal(targetFromHash('#%', ['typescript']), undefined);
});
