import { z } from 'astro/zod';
import type { FernPageSchema } from 'astro-fern';

export interface TerraformAttribute {
  name: string;
  type: string;
  description?: string;
  deprecated?: string;
  sensitive?: boolean;
  requiresReplace?: boolean;
  children?: TerraformAttribute[];
}

export const terraformAttributeSchema: z.ZodType<TerraformAttribute> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string().optional(),
    deprecated: z.string().optional(),
    sensitive: z.boolean().optional(),
    requiresReplace: z.boolean().optional(),
    children: z.array(terraformAttributeSchema).optional(),
  }),
);

export const terraformDeclarationSchema = z.object({
  kind: z.enum(['resource', 'data-source', 'list-data-source']),
  name: z.string().min(1),
  stainlessResource: z.string().min(1),
  methodName: z.string().min(1),
  snippet: z.string().min(1).optional(),
  required: z.array(terraformAttributeSchema),
  optional: z.array(terraformAttributeSchema),
  computed: z.array(terraformAttributeSchema),
});
export type TerraformDeclaration = z.infer<typeof terraformDeclarationSchema>;

export const terraformOperationDataSchema = z.object({
  declarations: z.array(terraformDeclarationSchema).min(1),
});
export type TerraformOperationData = z.infer<typeof terraformOperationDataSchema>;

export const generatedTerraformDocsSchema = z.object({
  format: z.literal(1),
  operations: z.record(
    z.string(),
    z.object({
      operationId: z.string().min(1),
      declarations: z.array(terraformDeclarationSchema).min(1),
    }),
  ),
});
export type GeneratedTerraformDocs = z.infer<typeof generatedTerraformDocsSchema>;

export const TERRAFORM_EXTENSION_NAME = 'cloudflare-terraform';

export function getTerraformOperationData(
  operation: FernPageSchema['operation'],
): TerraformOperationData | undefined {
  const value = operation.extensions[TERRAFORM_EXTENSION_NAME];
  return value === undefined ? undefined : terraformOperationDataSchema.parse(value);
}

export function canonicalTerraformEndpoint(method: string, endpointPath: string): string {
  return `${method.toLowerCase()} ${endpointPath.replaceAll(/\{[^}]+\}/g, '{}')}`;
}

export function terraformDeclarationLabel(declaration: TerraformDeclaration): string {
  return `${declaration.kind === 'resource' ? 'resource' : 'data'} ${declaration.name}`;
}

function combinedTerraformSnippet(data: TerraformOperationData): string | undefined {
  const snippets = data.declarations.flatMap((declaration) =>
    declaration.snippet ? [{ label: terraformDeclarationLabel(declaration), code: declaration.snippet.trimEnd() }] : [],
  );
  if (snippets.length === 0) return undefined;
  if (snippets.length === 1) return snippets[0]?.code;
  return snippets.map(({ label, code }) => `# ${label}\n${code}`).join('\n\n');
}

/** Adds operation-owned Terraform HCL to the generic target for agent Markdown. */
export function withTerraformTarget(page: FernPageSchema): FernPageSchema {
  const data = getTerraformOperationData(page.operation);
  if (!data) return page;
  const code = combinedTerraformSnippet(data);
  if (!code) return page;
  return {
    ...page,
    targets: page.targets.map((target) =>
      target.id === 'terraform' ? { ...target, code, syntax: 'hcl' } : target,
    ),
  };
}
