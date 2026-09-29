import { z } from 'astro/zod';
import { argumentSchema, methodArgumentSchema, paramOverrideSchema } from './arguments.ts';
import { nonEmptyStringSchema } from './shared.ts';

/** Availability statuses accepted by the Forge OpenAPI contract. */
export const forgeAvailabilitySchema = z.enum([
  'alpha',
  'beta',
  'preview',
  'generally-available',
  'deprecated',
  'legacy',
]);

/** A validated Forge availability status. */
export type ForgeAvailabilitySchema = z.infer<typeof forgeAvailabilitySchema>;

/**
 * Fern's endpoint availability: a status string, or `{ status, message }`.
 * @see https://buildwithfern.com/learn/api-definition/openapi/extensions/availability
 */
const forgeAvailabilityInputSchema = z.union([
  forgeAvailabilitySchema,
  z.strictObject({
    status: forgeAvailabilitySchema,
    message: nonEmptyStringSchema.optional(),
  }),
]);

/** Normalized, serializable Forge metadata stored on an operation projection. */
export const forgeOperationDataSchema = z
  .object({
    sdkGroupName: nonEmptyStringSchema,
    sdkMethodName: nonEmptyStringSchema,
    availability: forgeAvailabilitySchema.optional(),
    availabilityMessage: nonEmptyStringSchema.optional(),
    ignore: z.boolean(),
    hidden: z.boolean(),
    internal: z.boolean().optional(),
    globals: z.array(argumentSchema).optional(),
    epilogue: z.string().optional(),
    args: z.array(methodArgumentSchema).optional(),
    params: z.record(z.string(), paramOverrideSchema).optional(),
    requireConfirmation: nonEmptyStringSchema.optional(),
  })
  .strict();

/** Validated, serializable Forge metadata attached to one operation projection. */
export type ForgeOperationDataSchema = z.infer<typeof forgeOperationDataSchema>;

const sdkGroupSchema = nonEmptyStringSchema
  .refine(
    (group) => group.split('.').every((segment) => segment.trim().length > 0),
    'SDK group must be dot-separated with no empty segments',
  )
  .transform((group) =>
    group
      .split('.')
      .map((segment) => segment.trim())
      .join('.'),
  );

/** Forge validation for Fern headers, which generic astro-fern intentionally leaves extension-owned. */
export const operationProjectionFieldsSchema = z.object({
  'x-fern-sdk-group-name': sdkGroupSchema,
  'x-fern-sdk-method-name': nonEmptyStringSchema,
  'x-fern-availability': forgeAvailabilityInputSchema.optional(),
  'x-fern-ignore': z.boolean().optional(),
  'x-forge-hidden': z.boolean().optional(),
  'x-forge-internal': z.boolean().optional(),
  'x-forge-globals': z.array(argumentSchema).optional(),
  'x-forge-epilogue': z.string().optional(),
  'x-forge-args': z.array(methodArgumentSchema).optional(),
  'x-forge-params': z.record(z.string(), paramOverrideSchema).optional(),
  'x-forge-require-confirmation': nonEmptyStringSchema.optional(),
});

const knownOperationForgeKeys = new Set([...operationProjectionFieldsSchema.keyof().options, 'x-forge-aliases']);

export function rejectUnknownForgeKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  context: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    if (key.startsWith('x-forge-') && !known.has(key)) {
      context.addIssue({ code: 'custom', path: [key], message: 'unknown Forge extension' });
    }
  }
}

export function projectionSchema(strict: boolean) {
  const schema = strict ? operationProjectionFieldsSchema.strict() : operationProjectionFieldsSchema.loose();
  return schema.superRefine((value, context) => {
    rejectUnknownForgeKeys(value, knownOperationForgeKeys, context);
  });
}

/** Validates operation metadata while temporarily allowing missing required SDK names. */
export function operationMetadataSchema() {
  return (
    operationProjectionFieldsSchema
      // Forge requires both SDK names, but the current overlay is incomplete. Keep
      // them optional only at document ingestion while warnings track the gap.
      // TODO: Remove this override when the overlay complies with the Forge specification.
      // https://wiki.cfdata.org/spaces/EW/pages/1437565038/Forge+OpenAPI+Extensions
      .partial({
        'x-fern-sdk-group-name': true,
        'x-fern-sdk-method-name': true,
      })
      .loose()
      .superRefine((value, context) => {
        rejectUnknownForgeKeys(value, knownOperationForgeKeys, context);
      })
  );
}

export const aliasesEnvelopeSchema = z.looseObject({
  'x-forge-aliases': z.array(z.record(z.string(), z.unknown())).min(1),
});
