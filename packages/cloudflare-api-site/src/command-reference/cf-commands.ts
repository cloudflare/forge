// TODO: use the one exposed by cf package once it's open sourced
import source from './_generated/hand-written-commands.json' with { type: 'json' };
import { commandCatalogSchema } from './schema.ts';

// Vendored from cloudflare/cf packages/cli/src/commands/_generated/_meta/hand-written-commands.json.
// `handWritten` describes the CLI generator layout and is not part of the docs model.
const catalog = {
  ...source,
  commands: source.commands.map(({ handWritten: _handWritten, ...command }) => command),
};

export const cfCommandCatalog = commandCatalogSchema.parse(catalog);
