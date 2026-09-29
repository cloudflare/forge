import { defineFernExtension, type FernOperationExtensionContribution } from 'astro-fern';
import { prepareForge, type ForgeExtensionState } from './parser.ts';
import { forgeOperationDataSchema, type ForgeOperationDataSchema } from './schemas/operation.ts';

function presentation(
  data: ForgeOperationDataSchema,
): NonNullable<FernOperationExtensionContribution<ForgeOperationDataSchema>['presentation']> {
  return {
    ...(data.requireConfirmation ? { requireConfirmation: data.requireConfirmation } : {}),
    // Hidden is approval metadata, not global docs visibility. It only loses to
    // an approved projection when two SDK addresses collide.
    routingPriority: data.hidden ? -1 : 0,
  };
}

function aliasName(alias: ForgeOperationDataSchema): string {
  return `alias:${encodeURIComponent(alias.sdkGroupName)}/${encodeURIComponent(alias.sdkMethodName)}`;
}

function variantAvailability(
  alias: ForgeOperationDataSchema,
): ForgeOperationDataSchema['availability'] | { status: ForgeOperationDataSchema['availability']; message: string } {
  if (alias.availability !== undefined && alias.availabilityMessage !== undefined) {
    return { status: alias.availability, message: alias.availabilityMessage };
  }
  return alias.availability;
}

const extension = defineFernExtension<ForgeOperationDataSchema, ForgeExtensionState>({
  name: 'forge',
  schema: forgeOperationDataSchema,
  prepare: prepareForge,
  operation({ operation }, state) {
    const parsed = state.operations.get(operation);
    if (!parsed) return undefined;
    return {
      ...(parsed.primary ? { data: parsed.primary, presentation: presentation(parsed.primary) } : {}),
      variants: parsed.aliases.map((alias) => {
        const availability = variantAvailability(alias);
        return {
          name: aliasName(alias),
          sdkGroupName: alias.sdkGroupName,
          sdkMethodName: alias.sdkMethodName,
          ...(availability !== undefined ? { availability } : {}),
          data: alias,
          presentation: presentation(alias),
        };
      }),
    };
  },
});

/** Creates the `astro-fern` extension for Forge OpenAPI metadata. */
export function forgeExtension(): typeof extension {
  return extension;
}
