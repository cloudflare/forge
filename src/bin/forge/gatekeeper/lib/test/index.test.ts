import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as lib from '../src/index.js';

test('exports the runtime of the generated clients', () => {
  assert.deepEqual(Object.keys(lib).toSorted(), [
    'ApiError',
    'DecodeError',
    'ResponseTooLargeError',
    'Transport',
    'UnreachableError',
    'array',
    'bytes',
    'cursorPages',
    'date',
    'discriminated',
    'fetchProvider',
    'instant',
    'int64',
    'intersection',
    'linkPages',
    'map',
    'object',
    'offsetPages',
    'parseLinks',
    'reasonMessage',
    'reasonOf',
    'retryAfterSeconds',
    'serverUrl',
    'union',
    'withClient',
  ]);
});
