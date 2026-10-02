import { readFileSync } from 'node:fs';
import { defineFernExtension } from 'astro-fern';
import {
  canonicalTerraformEndpoint,
  generatedTerraformDocsSchema,
  TERRAFORM_EXTENSION_NAME,
  terraformOperationDataSchema,
  type GeneratedTerraformDocs,
  type TerraformOperationData,
} from './terraform.ts';

function loadTerraformDocs(): GeneratedTerraformDocs {
  const file = new URL('./generated/terraform-docs.json', import.meta.url);
  return generatedTerraformDocsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const terraformDocs = loadTerraformDocs();

/** Build-only bridge from Stainless's Terraform model into operation artifacts. */
export const cloudflareTerraformExtension = defineFernExtension<
  TerraformOperationData,
  GeneratedTerraformDocs['operations']
>({
  name: TERRAFORM_EXTENSION_NAME,
  schema: terraformOperationDataSchema,
  prepare: () => terraformDocs.operations,
  operation: ({ method, path, operation }, operations) => {
    const entry = operations[canonicalTerraformEndpoint(method, path)];
    if (!entry) return undefined;
    if (entry.operationId !== operation.operationId) {
      throw new Error(
        `generated Terraform mapping expected operationId "${entry.operationId}" for ${method.toUpperCase()} ${path}, received "${operation.operationId ?? '<missing>'}"`,
      );
    }
    return { data: { declarations: entry.declarations } };
  },
});
