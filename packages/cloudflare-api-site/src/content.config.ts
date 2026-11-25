import { defineCollection } from 'astro:content';
import { cfCommandCatalog } from './command-reference/cf-commands.ts';
import { commandCatalogLoader } from './command-reference/loader.ts';

export const collections = {
  cfCommands: defineCollection({ loader: commandCatalogLoader(() => cfCommandCatalog) }),
};
