import { llmsRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import { commandProducts } from '../command-sidebar.ts';
import { getCommandRouter } from '../command-reference/server.ts';

/** Nimbus's `llms.txt`, followed by the cf command pages, which aren't in the API spec. */
export const { GET } = llmsRoute({
  body: async (index, context) => {
    const router = await getCommandRouter();
    const products = new Map(commandProducts.map((product) => [product.id, product]));
    const origin = context.site ?? context.url;
    const lines = router.commands.map((command) => {
      const href = new URL(`${router.commandHref(command, products.get(command.fullPath[0]!))}index.md`, origin).href;
      return `- [${command.command}](${href}) — ${command.description.split('\n')[0]}`;
    });
    return `${index.trimEnd()}\n\n## Developer tooling\n\n${lines.join('\n')}\n`;
  },
});
