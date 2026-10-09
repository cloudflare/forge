import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { FernPageSchema } from 'astro-fern';
import {
  canonicalTerraformEndpoint,
  generatedTerraformDocsSchema,
  getTerraformOperationData,
  indexTerraformDocs,
  TERRAFORM_EXTENSION_NAME,
  terraformDeclarationLabel,
  terraformEndpointKeys,
  terraformRolesSummary,
  type GeneratedTerraformDocs,
  type TerraformDeclaration,
  withTerraformTarget,
} from './terraform.ts';

const resource: TerraformDeclaration = {
  kind: 'resource',
  name: 'cloudflare_widget',
  roles: ['create'],
  example: 'resource "cloudflare_widget" "example" {}\n',
  required: [],
  optional: [],
  computed: [],
};

const dataSource: TerraformDeclaration = {
  ...resource,
  kind: 'data-source',
  name: 'cloudflare_widget_data',
  roles: ['read'],
  example: 'data "cloudflare_widget" "example" {}\n',
};

function pageWith(declarations?: TerraformDeclaration[]): FernPageSchema {
  return {
    operation: {
      extensions: declarations ? { [TERRAFORM_EXTENSION_NAME]: { declarations } } : {},
    },
    targets: [
      { id: 'curl', code: 'curl example', syntax: 'bash' },
      { id: 'terraform', code: null, syntax: 'hcl' },
    ],
  } as FernPageSchema;
}

test('canonical Terraform endpoints ignore parameter naming differences', () => {
  assert.equal(
    canonicalTerraformEndpoint('GET', '/{account_or_zone}/{account_or_zone_id}/widgets'),
    'get /{}/{}/widgets',
  );
});

test('SDK endpoints match both concrete and merged scope paths', () => {
  assert.deepEqual(terraformEndpointKeys('post /{accounts_or_zones}/{account_or_zone_id}/rules'), [
    'post /accounts/{}/rules',
    'post /zones/{}/rules',
    'post /{}/{}/rules',
  ]);
  assert.deepEqual(terraformEndpointKeys('get /accounts/{account_id}/dns_settings'), [
    'get /accounts/{}/dns_settings',
    'get /{}/{}/dns_settings',
  ]);
  assert.deepEqual(terraformEndpointKeys('get /user/tokens'), ['get /user/tokens']);
});

test('indexTerraformDocs merges roles across endpoint variants and orders declarations', () => {
  const base = { required: [], optional: [], computed: [] };
  const docs: GeneratedTerraformDocs = {
    format: 2,
    source: { provider: { repository: 'https://example.com/provider', version: '1.0.0' }, sdks: [] },
    stats: { declarations: 2, linkedDeclarations: 2, endpoints: 2, unresolvedCalls: 0 },
    unlinked: [],
    undocumented: [],
    unresolvedCalls: [],
    declarations: {
      'resource:cloudflare_widget': { kind: 'resource', name: 'cloudflare_widget', ...base },
      'data-source:cloudflare_widget': { kind: 'data-source', name: 'cloudflare_widget', ...base },
    },
    endpoints: {
      'get /accounts/{account_id}/widgets/{id}': [
        { declaration: 'data-source:cloudflare_widget', roles: ['read'] },
        { declaration: 'resource:cloudflare_widget', roles: ['read', 'import'] },
      ],
      'get /{accounts_or_zones}/{account_or_zone_id}/widgets/{id}': [
        { declaration: 'resource:cloudflare_widget', roles: ['read'] },
      ],
    },
  };
  const index = indexTerraformDocs(docs);
  const merged = index.get('get /accounts/{}/widgets/{}');
  assert.deepEqual(
    merged?.map(({ kind, roles }) => [kind, roles]),
    [
      ['resource', ['read', 'import']],
      ['data-source', ['read']],
    ],
  );
  assert.deepEqual(
    index.get('get /zones/{}/widgets/{}')?.map(({ kind }) => kind),
    ['resource'],
  );
});

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

test('Terraform operation data remains namespaced on the operation', () => {
  assert.deepEqual(getTerraformOperationData(pageWith([resource]).operation)?.declarations, [resource]);
  assert.equal(terraformDeclarationLabel(resource), 'resource cloudflare_widget');
  assert.equal(terraformDeclarationLabel(dataSource), 'data cloudflare_widget_data');
  assert.equal(
    terraformRolesSummary({ ...resource, roles: ['read', 'import'] }),
    'Called by this resource to read and import.',
  );
  assert.equal(terraformRolesSummary(dataSource), 'Called by this data source to read.');
});

test('withTerraformTarget preserves all declaration examples for agent Markdown', () => {
  const page = pageWith([resource, dataSource]);
  const decorated = withTerraformTarget(page);
  const code = decorated.targets.find((target) => target.id === 'terraform')?.code;
  assert.match(code ?? '', /# resource cloudflare_widget/);
  assert.match(code ?? '', /# data cloudflare_widget_data/);
  assert.equal(page.targets.find((target) => target.id === 'terraform')?.code, null);
});

test('the generated index links every CRUD operation of a resource', async () => {
  const source = await readFile(new URL('./generated/terraform-docs.json', import.meta.url), 'utf8');
  const index = indexTerraformDocs(generatedTerraformDocsSchema.parse(JSON.parse(source)));
  const roles = (key: string) =>
    index.get(key)?.find(({ kind, name }) => kind === 'resource' && name === 'cloudflare_dns_record')?.roles;
  assert.deepEqual(roles('post /zones/{}/dns_records'), ['create']);
  assert.deepEqual(roles('get /zones/{}/dns_records/{}'), ['read', 'import']);
  assert.deepEqual(roles('put /zones/{}/dns_records/{}'), ['update']);
  assert.deepEqual(roles('delete /zones/{}/dns_records/{}'), ['delete']);
  // Scope-polymorphic SDK paths resolve to Forge's merged `/{account_or_zone}/…` path.
  assert.ok(
    index.get('post /{}/{}/firewall/access_rules/rules')?.some(({ name }) => name === 'cloudflare_access_rule'),
  );
});
