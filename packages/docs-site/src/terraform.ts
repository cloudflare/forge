import { z } from 'astro/zod';
import type { FernPageSchema } from 'astro-fern';

export interface TerraformAttribute {
  name: string;
  type: string;
  description?: string;
  deprecated?: string;
  sensitive?: boolean;
  children?: TerraformAttribute[];
}

export const terraformAttributeSchema: z.ZodType<TerraformAttribute> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    type: z.string().min(1),
    description: z.string().optional(),
    deprecated: z.string().optional(),
    sensitive: z.boolean().optional(),
    children: z.array(terraformAttributeSchema).optional(),
  }),
);

export const terraformRoleSchema = z.enum(['create', 'read', 'update', 'delete', 'import', 'other']);
export type TerraformRole = z.infer<typeof terraformRoleSchema>;

export const terraformDeclarationKindSchema = z.enum(['resource', 'data-source', 'list-data-source']);
export type TerraformDeclarationKind = z.infer<typeof terraformDeclarationKindSchema>;

/** A declaration as stored once in the generated file. */
export const generatedTerraformDeclarationSchema = z.object({
  kind: terraformDeclarationKindSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  example: z.string().min(1).optional(),
  importExample: z.string().min(1).optional(),
  required: z.array(terraformAttributeSchema),
  optional: z.array(terraformAttributeSchema),
  computed: z.array(terraformAttributeSchema),
});
export type GeneratedTerraformDeclaration = z.infer<typeof generatedTerraformDeclarationSchema>;

/** A declaration as attached to one operation, with the lifecycle roles that use it. */
export const terraformDeclarationSchema = generatedTerraformDeclarationSchema.extend({
  roles: z.array(terraformRoleSchema).min(1),
});
export type TerraformDeclaration = z.infer<typeof terraformDeclarationSchema>;

export const terraformOperationDataSchema = z.object({
  declarations: z.array(terraformDeclarationSchema).min(1),
});
export type TerraformOperationData = z.infer<typeof terraformOperationDataSchema>;

export const terraformEndpointLinkSchema = z.object({
  /** Key into `declarations`. */
  declaration: z.string().min(1),
  roles: z.array(terraformRoleSchema).min(1),
});
export type TerraformEndpointLink = z.infer<typeof terraformEndpointLinkSchema>;

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full git commit SHA');

/**
 * Shape of `src/generated/terraform-docs.json`. `scripts/generate-terraform-docs.ts` validates
 * its output against this schema, and the build reads the file with it.
 */
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
    /** SDK calls for which no endpoint was found in cloudflare-go `api.md`. */
    /** Service code without a tfplugindocs page, i.e. not registered by the released provider. */
    undocumented: z.array(z.string()),
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

export const TERRAFORM_EXTENSION_NAME = 'cloudflare-terraform';

export function getTerraformOperationData(operation: FernPageSchema['operation']): TerraformOperationData | undefined {
  const value = operation.extensions[TERRAFORM_EXTENSION_NAME];
  return value === undefined ? undefined : terraformOperationDataSchema.parse(value);
}

const SCOPE_PREFIX = /^\/(?:accounts|zones|\{\})\/\{\}(?=\/|$)/;

/** Normalizes an endpoint so path parameter names do not matter: `get /zones/{zone_id}` -> `get /zones/{}`. */
export function canonicalTerraformEndpoint(method: string, endpointPath: string): string {
  return `${method.toLowerCase()} ${endpointPath.replaceAll(/\{[^}]+\}/g, '{}')}`;
}

/**
 * Keys under which an SDK endpoint should be found in the OpenAPI document.
 *
 * cloudflare-go and the Forge OpenAPI disagree on scope-polymorphic paths: the SDK may
 * document `/{accounts_or_zones}/{account_or_zone_id}/…` where Forge has `/{account_or_zone}/…`,
 * or the SDK may document `/accounts/{account_id}/…` for an operation Forge merged into
 * `/{account_or_zone}/…`. Concrete scopes match the merged path; merged scopes match both.
 */
export function terraformEndpointKeys(endpoint: string): string[] {
  const separator = endpoint.indexOf(' ');
  if (separator < 1) throw new Error(`Invalid Terraform endpoint ${endpoint}`);
  const key = canonicalTerraformEndpoint(endpoint.slice(0, separator), endpoint.slice(separator + 1));
  const [method, endpointPath] = [key.slice(0, separator), key.slice(separator + 1)];
  const scope = endpointPath.match(SCOPE_PREFIX)?.[0];
  if (!scope) return [key];
  const rest = endpointPath.slice(scope.length);
  const variants = scope === '/{}/{}' ? ['/accounts/{}', '/zones/{}', '/{}/{}'] : [scope, '/{}/{}'];
  return variants.map((prefix) => `${method} ${prefix}${rest}`);
}

/** Indexes generated endpoint links by OpenAPI lookup key. */
export function indexTerraformDocs(docs: GeneratedTerraformDocs): Map<string, TerraformDeclaration[]> {
  const index = new Map<string, Map<string, TerraformDeclaration>>();
  for (const [endpoint, links] of Object.entries(docs.endpoints)) {
    for (const key of terraformEndpointKeys(endpoint)) {
      const declarations = index.get(key) ?? new Map<string, TerraformDeclaration>();
      for (const { declaration: id, roles } of links) {
        const declaration = docs.declarations[id];
        if (!declaration) throw new Error(`Terraform endpoint ${endpoint} references unknown declaration ${id}`);
        const previous = declarations.get(id);
        const merged = previous ? [...new Set([...previous.roles, ...roles])] : roles;
        declarations.set(id, {
          ...declaration,
          roles: terraformRoleSchema.options.filter((role) => merged.includes(role)),
        });
      }
      index.set(key, declarations);
    }
  }
  const kindOrder = { resource: 0, 'data-source': 1, 'list-data-source': 2 };
  return new Map(
    [...index].map(([key, declarations]) => [
      key,
      [...declarations.values()].sort(
        (left, right) => kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name),
      ),
    ]),
  );
}

export function terraformDeclarationLabel(declaration: Pick<TerraformDeclaration, 'kind' | 'name'>): string {
  return `${declaration.kind === 'resource' ? 'resource' : 'data'} ${declaration.name}`;
}

const ROLE_LABELS: Record<TerraformRole, string> = {
  create: 'create',
  read: 'read',
  update: 'update',
  delete: 'delete',
  import: 'import',
  other: 'other',
};

/** e.g. "Used by this resource to create and import." */
export function terraformRolesSummary(declaration: TerraformDeclaration): string {
  const roles = declaration.roles.filter((role) => role !== 'other').map((role) => ROLE_LABELS[role]);
  const subject = declaration.kind === 'resource' ? 'resource' : 'data source';
  if (roles.length === 0) return `Called by this ${subject}.`;
  const list = roles.length === 1 ? roles[0] : `${roles.slice(0, -1).join(', ')} and ${roles.at(-1)}`;
  return `Called by this ${subject} to ${list}.`;
}

function combinedTerraformSnippet(data: TerraformOperationData): string | undefined {
  const snippets = data.declarations.flatMap((declaration) =>
    declaration.example ? [{ label: terraformDeclarationLabel(declaration), code: declaration.example.trimEnd() }] : [],
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
    targets: page.targets.map((target) => (target.id === 'terraform' ? { ...target, code, syntax: 'hcl' } : target)),
  };
}
