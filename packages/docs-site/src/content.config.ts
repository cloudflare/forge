import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
import { defineFernManifest, type FernContentOptions, type FernManifestProvider } from 'astro-fern';
import { defineFernCollections } from 'astro-fern/collections';
import { forgeExtension, hasRemovedForgeOperationFields, hoistForgeCommands } from 'fern-forge';
import {
  CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
  CLOUDFLARE_TARGETS,
  cloudflareFormatIdentifier,
  cloudflareOperationRoutingPreference,
  cloudflareSnippets,
} from './cloudflare.ts';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { commandCatalogLoader } from './command-reference/loader.ts';
import { loadForgeOpenApi } from './openapi-source.ts';
import { cloudflareTerraformExtension } from './terraform-extension.ts';
import { cloudflareApiVersionLabel, cloudflareApiVersionSlug, parseCloudflareApiVersion } from './version.ts';

const source = async () => hoistForgeCommands(await loadForgeOpenApi());

const air = parseCloudflareApiVersion('2026-11-30.air');

const manifest: FernManifestProvider = (_openapi, { discoverProducts }) =>
  defineFernManifest({
    targets: CLOUDFLARE_TARGETS,
    products: discoverProducts(),
  });

// The API reference stores one project descriptor plus immutable operation
// snapshot artifacts. `astro-fern/server` composes exact snapshot-selected pages at runtime.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  cfCommands: defineCollection({ loader: commandCatalogLoader(() => cfCommandCatalog) }),
  ...defineFernCollections({
    source: {
      kind: 'snapshots',
      snapshots: [
        {
          id: air.wire,
          source,
          label: cloudflareApiVersionLabel(air),
          slug: cloudflareApiVersionSlug(air),
          default: true,
        },
      ],
    },
    responsePayloadKey: CLOUDFLARE_RESPONSE_PAYLOAD_KEY,
    manifest,
    formatIdentifier: cloudflareFormatIdentifier,
    operationRoutingPreference: cloudflareOperationRoutingPreference,
    isOperationHidden: hasRemovedForgeOperationFields,
    snippets: cloudflareSnippets,
    extensions: [forgeExtension(), cloudflareTerraformExtension],
  } satisfies FernContentOptions),
};
