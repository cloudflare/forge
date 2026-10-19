import assert from 'node:assert/strict';
import test from 'node:test';
import { generatedTerraformDocsSchema } from './schema.ts';

test('the generated file schema rejects links to unknown declarations', () => {
  const result = generatedTerraformDocsSchema.safeParse({
    format: 2,
    source: { provider: { repository: 'https://example.com/provider', version: '1.0.0' }, sdks: [] },
    stats: { declarations: 0, linkedDeclarations: 0, endpoints: 1, unresolvedCalls: 0 },
    unlinked: [],
    undocumented: [],
    unresolvedCalls: [],
    declarations: {},
    endpoints: { 'get /x': [{ declaration: 'resource:missing', roles: ['read'] }] },
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ['endpoints', 'get /x', 0, 'declaration']);
});
