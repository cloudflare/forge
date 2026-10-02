import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalTerraformEndpoint, extractTerraformDocs } from './generate-terraform-docs.ts';

test('canonicalTerraformEndpoint ignores path parameter names', () => {
  assert.equal(
    canonicalTerraformEndpoint('POST', '/accounts/{account_id}/widgets/{widget_id}'),
    'post /accounts/{}/widgets/{}',
  );
});

test('extractTerraformDocs resolves fields and joins declarations to Forge operations', () => {
  const servicePath = '(resource) widgets';
  const sourcePath = `${servicePath} > (terraform resource)`;
  const namePath = `${sourcePath} > (attribute) name`;
  const settingsPath = `${sourcePath} > (attribute) settings`;
  const enabledPath = `${settingsPath} > (attribute) enabled`;
  const sdkJson = {
    resources: {
      widgets: {
        stainlessPath: servicePath,
        methods: { create: { endpoint: 'post /accounts/{account_id}/widgets' } },
        subresources: {},
      },
    },
    decls: {
      terraform: {
        [servicePath]: { kind: 'TerraformDeclServiceNode', resource: sourcePath },
        [sourcePath]: {
          kind: 'TerraformDeclSource',
          type: 'resource',
          name: 'cloudflare_widget',
          methodName: 'create',
          required: [namePath],
          optional: [settingsPath],
          computed: [],
        },
        [namePath]: {
          kind: 'TerraformDeclAttribute',
          name: 'name',
          type: { category: 'primitive', type: 'String' },
          children: [],
        },
        [settingsPath]: {
          kind: 'TerraformDeclAttribute',
          name: 'settings',
          type: { category: 'nested', type: 'SingleNested' },
          children: [enabledPath],
        },
        [enabledPath]: {
          kind: 'TerraformDeclAttribute',
          name: 'enabled',
          type: { category: 'primitive', type: 'Bool' },
          children: [],
        },
      },
    },
    snippets: {
      'terraform.default': {
        [sourcePath]: { default: { content: 'resource "cloudflare_widget" "example" {}\n' } },
      },
    },
    metadata: { terraform: { version: '1.0.0' } },
  };
  const openapi = {
    paths: {
      '/accounts/{account}/widgets': {
        post: { operationId: 'widgets_create' },
      },
    },
  };
  const result = extractTerraformDocs(sdkJson, openapi);

  assert.deepEqual(result.stats, { operations: 1, declarations: 1, missingSnippets: 0, unmatched: 0 });
  assert.equal(result.operations['post /accounts/{}/widgets'].operationId, 'widgets_create');
  assert.deepEqual(result.operations['post /accounts/{}/widgets'].declarations[0].optional[0], {
    name: 'settings',
    type: 'Attributes',
    children: [{ name: 'enabled', type: 'Bool' }],
  });
});
