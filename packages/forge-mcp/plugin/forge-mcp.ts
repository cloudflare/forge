// The default forge-mcp plugin: every method that isn't deprecated becomes a
// tool. Build it with `pnpm build:plugin`, and run it
// with `forge openapi.json --target wasm://dist/forge-mcp.wasm --out <dir>`.
import { definePlugin } from '@cloudflare/forge/plugin';

import { catalogueFile } from '../src/plugin.ts';

export const { generate, generateGroup } = definePlugin({
  generate: (forge) => [catalogueFile(forge)],
});
