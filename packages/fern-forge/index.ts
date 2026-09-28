import type { ForgeOperationDataSchema } from './schemas/operation.ts';

declare module 'astro-fern' {
  interface FernExtensionDataRegistry {
    forge: ForgeOperationDataSchema;
  }
}

export { forgeExtension } from './extension.ts';
export {
  forgeDocumentSchema,
  hoistForgeCommands,
  type ForgeCommandsSchema,
  type ForgeDocumentSchema,
} from './schemas/document.ts';
export {
  forgeAvailabilitySchema,
  forgeOperationDataSchema,
  type ForgeAvailabilitySchema,
  type ForgeOperationDataSchema,
} from './schemas/operation.ts';
