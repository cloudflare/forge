import type { ViteUserConfig } from 'astro';
import type { FernRuntimeConfig } from './runtime-config.ts';

export const FERN_RUNTIME_CONFIG_MODULE_ID = 'fern:virtual/runtime-config';
const RESOLVED_RUNTIME_CONFIG_MODULE_ID = `\0${FERN_RUNTIME_CONFIG_MODULE_ID}`;
export const FERN_EXTENSIONS_MODULE_ID = 'fern:virtual/extensions';
const RESOLVED_EXTENSIONS_MODULE_ID = `\0${FERN_EXTENSIONS_MODULE_ID}`;

/** Exposes integration-owned runtime configuration to server-side Astro modules. */
export function vitePluginFernRuntimeConfig(config: FernRuntimeConfig): NonNullable<ViteUserConfig['plugins']>[number] {
  return {
    name: 'vite-plugin-astro-fern-runtime-config',
    resolveId: {
      filter: {
        id: new RegExp(`^${FERN_RUNTIME_CONFIG_MODULE_ID}$`),
      },
      handler() {
        return RESOLVED_RUNTIME_CONFIG_MODULE_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(`^${RESOLVED_RUNTIME_CONFIG_MODULE_ID}$`),
      },
      handler() {
        return `export default Object.freeze(${JSON.stringify(config)});`;
      },
    },
  };
}

/** Exposes the typed operation-extension accessor to Astro application modules. */
export function vitePluginFernExtensions(): NonNullable<ViteUserConfig['plugins']>[number] {
  return {
    name: 'vite-plugin-astro-fern-extensions',
    resolveId: {
      filter: {
        id: new RegExp(`^${FERN_EXTENSIONS_MODULE_ID}$`),
      },
      handler() {
        return RESOLVED_EXTENSIONS_MODULE_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(`^${RESOLVED_EXTENSIONS_MODULE_ID}$`),
      },
      handler() {
        return "export { getOperationExtensionData } from 'astro-fern';";
      },
    },
  };
}
