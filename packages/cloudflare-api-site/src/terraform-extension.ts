import { readFileSync } from 'node:fs';
import { renderDescription } from './description-markdown.ts';
import {
  canonicalTerraformEndpoint,
  indexTerraformDocs,
  renderTerraformDescriptions,
  terraformDocsSchema,
  type TerraformDeclaration,
  type TerraformOperationData,
} from './terraform.ts';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

/**
 * Loads the generated docs (the root's `generate:terraform-docs` writes them) and renders their Markdown
 * descriptions with the renderer the OpenAPI descriptions use, once at build time, so pages only
 * print HTML.
 */
function loadTerraformIndex(): Map<string, TerraformDeclaration[]> {
  const file = new URL('./generated/terraform-docs.json', import.meta.url);
  const docs = terraformDocsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return indexTerraformDocs(renderTerraformDescriptions(docs, renderDescription));
}

/**
 * Returns the Terraform declarations that call each operation of
 * `document`, looked up by HTTP method and path. Warns about provider
 * declarations that match no operation of the document, so drift between the
 * provider and the spec shows in builds.
 */
export function cloudflareTerraform(
  document: Record<string, unknown>,
  warn: (message: string) => void = (message) => console.warn(`[forge-api] ${message}`),
): (method: string, path: string) => TerraformOperationData | undefined {
  const index = loadTerraformIndex();
  const known = new Set<string>();
  for (const [endpointPath, pathItem] of Object.entries((document.paths ?? {}) as Record<string, unknown>)) {
    for (const method of HTTP_METHODS) {
      if ((pathItem as Record<string, unknown> | undefined)?.[method]) {
        known.add(canonicalTerraformEndpoint(method, endpointPath));
      }
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
    warn(
      `${unmatched.length} Terraform declarations match no OpenAPI operation: ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? ', …' : ''}`,
    );
  }
  return (method, path) => {
    const declarations = index.get(canonicalTerraformEndpoint(method, path));
    return declarations?.length ? { declarations } : undefined;
  };
}
