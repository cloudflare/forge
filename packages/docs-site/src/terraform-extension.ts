import { readFileSync } from 'node:fs';
import { defineFernExtension } from 'astro-fern';
import {
  canonicalTerraformEndpoint,
  generatedTerraformDocsSchema,
  indexTerraformDocs,
  TERRAFORM_EXTENSION_NAME,
  terraformOperationDataSchema,
  type TerraformDeclaration,
  type TerraformOperationData,
} from './terraform.ts';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

function loadTerraformIndex(): Map<string, TerraformDeclaration[]> {
  const file = new URL('./generated/terraform-docs.json', import.meta.url);
  return indexTerraformDocs(generatedTerraformDocsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))));
}

/** Build-only bridge from the released Terraform provider into operation artifacts. */
export const cloudflareTerraformExtension = defineFernExtension<
  TerraformOperationData,
  Map<string, TerraformDeclaration[]>
>({
  name: TERRAFORM_EXTENSION_NAME,
  schema: terraformOperationDataSchema,
  prepare: (document, { logger }) => {
    const index = loadTerraformIndex();
    // Report provider endpoints the current OpenAPI no longer has, so drift is visible in builds.
    const known = new Set<string>();
    for (const [endpointPath, pathItem] of Object.entries(document.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if ((pathItem as Record<string, unknown> | undefined)?.[method])
          known.add(canonicalTerraformEndpoint(method, endpointPath));
      }
    }
    const missing = [...index.keys()].filter((key) => !known.has(key));
    const orphaned = new Set(
      [...index]
        .filter(([key]) => missing.includes(key))
        .flatMap(([, declarations]) => declarations.map(({ kind, name }) => `${kind}:${name}`)),
    );
    const matched = new Set(
      [...index]
        .filter(([key]) => known.has(key))
        .flatMap(([, declarations]) => declarations.map(({ kind, name }) => `${kind}:${name}`)),
    );
    const unmatched = [...orphaned].filter((declaration) => !matched.has(declaration));
    if (unmatched.length > 0) {
      logger.warn(
        `${unmatched.length} Terraform declarations match no OpenAPI operation: ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? ', …' : ''}`,
      );
    }
    return index;
  },
  operation: ({ method, path }, index) => {
    const declarations = index.get(canonicalTerraformEndpoint(method, path));
    return declarations?.length ? { data: { declarations } } : undefined;
  },
});
