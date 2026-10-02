import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { FernPageSchema } from 'astro-fern';
import {
  canonicalTerraformEndpoint,
  generatedTerraformDocsSchema,
  getTerraformOperationData,
  TERRAFORM_EXTENSION_NAME,
  terraformDeclarationLabel,
  type TerraformDeclaration,
  withTerraformTarget,
} from './terraform.ts';

const resource: TerraformDeclaration = {
  kind: 'resource',
  name: 'cloudflare_widget',
  stainlessResource: 'widgets',
  methodName: 'create',
  snippet: 'resource "cloudflare_widget" "example" {}\n',
  required: [],
  optional: [],
  computed: [],
};

const dataSource: TerraformDeclaration = {
  ...resource,
  kind: 'data-source',
  name: 'cloudflare_widget_data',
  snippet: 'data "cloudflare_widget" "example" {}\n',
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

test('Terraform operation data remains namespaced on the operation', () => {
  assert.deepEqual(getTerraformOperationData(pageWith([resource]).operation)?.declarations, [resource]);
  assert.equal(terraformDeclarationLabel(resource), 'resource cloudflare_widget');
  assert.equal(terraformDeclarationLabel(dataSource), 'data cloudflare_widget_data');
});

test('withTerraformTarget preserves all declaration snippets for agent Markdown', () => {
  const page = pageWith([resource, dataSource]);
  const decorated = withTerraformTarget(page);
  const code = decorated.targets.find((target) => target.id === 'terraform')?.code;
  assert.match(code ?? '', /# resource cloudflare_widget/);
  assert.match(code ?? '', /# data cloudflare_widget_data/);
  assert.equal(page.targets.find((target) => target.id === 'terraform')?.code, null);
});

test('the generated index retains every declaration for shared DLP endpoints', async () => {
  const source = await readFile(new URL('./generated/terraform-docs.json', import.meta.url), 'utf8');
  const generated = generatedTerraformDocsSchema.parse(JSON.parse(source));
  const dlp = generated.operations['get /accounts/{}/dlp/entries'];
  assert.ok(dlp);
  assert.equal(dlp.declarations.length, 4);
  assert.deepEqual(
    dlp.declarations.map((declaration) => declaration.name),
    [
      'cloudflare_zero_trust_dlp_custom_entries',
      'cloudflare_zero_trust_dlp_entries',
      'cloudflare_zero_trust_dlp_integration_entries',
      'cloudflare_zero_trust_dlp_predefined_entries',
    ],
  );
});
