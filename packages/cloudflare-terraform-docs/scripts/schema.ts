/**
 * Format of the file `generate-terraform-docs` writes, which it validates its output against before
 * writing. Internal to the generator: the consumer reads the file with its own schema (the site's is
 * in `cloudflare-api-site/src/terraform.ts`), and `format` versions the contract between them.
 */

import { z } from 'zod';

export const terraformRoleSchema = z.enum(['create', 'read', 'update', 'delete', 'import', 'other']);
export type TerraformRole = z.infer<typeof terraformRoleSchema>;

export const terraformDeclarationKindSchema = z.enum(['resource', 'data-source', 'list-data-source']);
export type TerraformDeclarationKind = z.infer<typeof terraformDeclarationKindSchema>;

const generatedTerraformAttributeShape = {
  name: z.string().min(1),
  type: z.string().min(1),
  /** Markdown, as the provider documents it. */
  description: z.string().optional(),
  deprecated: z.string().optional(),
  sensitive: z.boolean().optional(),
};

export interface GeneratedTerraformAttribute {
  name: string;
  type: string;
  description?: string | undefined;
  deprecated?: string | undefined;
  sensitive?: boolean | undefined;
  children?: GeneratedTerraformAttribute[] | undefined;
}

export const generatedTerraformAttributeSchema: z.ZodType<GeneratedTerraformAttribute> = z.lazy(() =>
  z.object({ ...generatedTerraformAttributeShape, children: z.array(generatedTerraformAttributeSchema).optional() }),
);

/** A declaration as stored once in the generated file. */
export const generatedTerraformDeclarationSchema = z.object({
  kind: terraformDeclarationKindSchema,
  name: z.string().min(1),
  /** Markdown, as the provider documents it. */
  description: z.string().optional(),
  example: z.string().min(1).optional(),
  importExample: z.string().min(1).optional(),
  required: z.array(generatedTerraformAttributeSchema),
  optional: z.array(generatedTerraformAttributeSchema),
  computed: z.array(generatedTerraformAttributeSchema),
});
export type GeneratedTerraformDeclaration = z.infer<typeof generatedTerraformDeclarationSchema>;

export const terraformEndpointLinkSchema = z.object({
  /** Key into `declarations`. */
  declaration: z.string().min(1),
  roles: z.array(terraformRoleSchema).min(1),
});
export type TerraformEndpointLink = z.infer<typeof terraformEndpointLinkSchema>;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full git commit SHA');

export const generatedTerraformDocsSchema = z
  .object({
    format: z.literal(2),
    source: z.object({
      provider: z.object({
        repository: z.url(),
        version: z.string().regex(/^\d+\.\d+\.\d+/),
        /** Commit of the provider checkout, when it was a git checkout. */
        commit: commitSchema.optional(),
      }),
      sdks: z.array(
        z.object({ module: z.string().min(1), version: z.string().min(1), commit: commitSchema.optional() }),
      ),
    }),
    stats: z.object({
      declarations: z.number().int().nonnegative(),
      linkedDeclarations: z.number().int().nonnegative(),
      endpoints: z.number().int().nonnegative(),
      unresolvedCalls: z.number().int().nonnegative(),
    }),
    /** Declarations that make no recognised SDK call (custom or stub implementations). */
    unlinked: z.array(z.string()),
    /** Service code without a tfplugindocs page, i.e. not registered by the released provider. */
    undocumented: z.array(z.string()),
    /** SDK calls for which no endpoint was found in cloudflare-go `api.md`. */
    unresolvedCalls: z.array(z.object({ declaration: z.string(), call: z.string() })),
    declarations: z.record(z.string(), generatedTerraformDeclarationSchema),
    /** Keyed by the SDK endpoint exactly as cloudflare-go documents it, e.g. `post /zones/{zone_id}/dns_records`. */
    endpoints: z.record(z.string(), z.array(terraformEndpointLinkSchema)),
  })
  .superRefine((docs, context) => {
    for (const [endpoint, links] of Object.entries(docs.endpoints)) {
      links.forEach((link, index) => {
        if (!docs.declarations[link.declaration]) {
          context.addIssue({
            code: 'custom',
            path: ['endpoints', endpoint, index, 'declaration'],
            message: `references unknown declaration ${link.declaration}`,
          });
        }
      });
    }
  });
export type GeneratedTerraformDocs = z.infer<typeof generatedTerraformDocsSchema>;
