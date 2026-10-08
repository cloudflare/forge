import { getEntry } from 'astro:content';
import { base } from 'astro:config/server';
import { COMMAND_CATALOG_ENTRY_ID } from './loader.ts';
import { CommandRouter } from './routing.ts';
import type { CommandCatalog } from './schema.ts';

export const CF_COMMANDS_COLLECTION = '_cfCommands';

let routerPromise: Promise<CommandRouter> | undefined;

export async function getCommandCatalog(): Promise<CommandCatalog> {
  const entry = await getEntry(CF_COMMANDS_COLLECTION, COMMAND_CATALOG_ENTRY_ID);
  if (!entry) throw new Error('cloudflare-api-site: the _cfCommands collection has no command catalog');
  return entry.data;
}

export function getCommandRouter(): Promise<CommandRouter> {
  if (routerPromise) return routerPromise;
  const promise = getCommandCatalog().then((catalog) => new CommandRouter(catalog, { base }));
  routerPromise = promise;
  void promise.catch(() => {
    if (routerPromise === promise) routerPromise = undefined;
  });
  return promise;
}
