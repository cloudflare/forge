import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availabilityLabel } from './availability.ts';

test('labels every Fern endpoint availability status', () => {
  assert.equal(availabilityLabel('alpha'), 'Alpha');
  assert.equal(availabilityLabel('beta'), 'Beta');
  assert.equal(availabilityLabel('preview'), 'Preview');
  assert.equal(availabilityLabel('generally-available'), 'Generally Available');
  assert.equal(availabilityLabel('deprecated'), 'Deprecated');
  assert.equal(availabilityLabel('legacy'), 'Legacy');
});

test('keeps unknown statuses readable', () => {
  assert.equal(availabilityLabel('custom-channel'), 'custom channel');
});
