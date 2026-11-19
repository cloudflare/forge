import { defineCollection } from 'astro:content';
import { apiCollection } from '@cloudflare/nimbus-docs/content';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { commandCatalogLoader } from './command-reference/loader.ts';

export const collections = {
  api: defineCollection(apiCollection()),
  cfCommands: defineCollection({ loader: commandCatalogLoader(() => cfCommandCatalog) }),
};
