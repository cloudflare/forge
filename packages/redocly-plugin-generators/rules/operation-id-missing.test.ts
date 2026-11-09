import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createConfig, lintFromString } from '@redocly/openapi-core';

import { plugin } from '../index.ts';

const lintDoc = async (source: string) => {
  const config = await createConfig({
    plugins: [plugin()],
    extends: [],
    rules: { 'generators/operation-id-missing': 'error' },
  });
  return lintFromString({ config, source, absoluteRef: 'spec.yaml' });
};

describe('operation-id-missing', () => {
  it('flags operations without operationId', async () => {
    const problems = await lintDoc(
      [
        'openapi: 3.0.0',
        'info: {title: t, version: "1"}',
        'paths:',
        '  /things:',
        '    get:',
        '      responses: {"200": {description: ok}}',
      ].join('\n'),
    );
    assert.ok(
      problems.some((p) => p.ruleId === 'generators/operation-id-missing'),
      `expected operation-id-missing problem, got: ${JSON.stringify(problems.map((p) => p.ruleId))}`,
    );
  });

  it('is a no-op when operationId is present', async () => {
    const problems = await lintDoc(
      [
        'openapi: 3.0.0',
        'info: {title: t, version: "1"}',
        'paths:',
        '  /things:',
        '    get:',
        '      operationId: listThings',
        '      responses: {"200": {description: ok}}',
      ].join('\n'),
    );
    assert.equal(problems.filter((p) => p.ruleId === 'generators/operation-id-missing').length, 0);
  });
});
