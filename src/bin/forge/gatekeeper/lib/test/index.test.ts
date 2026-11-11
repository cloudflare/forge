import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as lib from '../src/index.js';

test('exports the runtime of the generated clients', () => {
  assert.deepEqual(Object.keys(lib).toSorted(), [
    'ApiError',
    'DecodeError',
    'Transport',
    'array',
    'bytes',
    'cursorPages',
    'date',
    'discriminated',
    'instant',
    'int64',
    'intersection',
    'linkPages',
    'map',
    'object',
    'offsetPages',
    'parseLinks',
    'union',
  ]);
});
