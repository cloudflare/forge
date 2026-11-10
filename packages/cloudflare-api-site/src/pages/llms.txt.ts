import { llmsRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';
import { commandProducts } from '../command-sidebar.ts';
import { getCommandRouter } from '../command-reference/server.ts';

const llms = llmsRoute();

/** Nimbus's `llms.txt`, followed by the cf command pages, which aren't in the API spec. */
export const GET: APIRoute = async (context) => {
  const response = await llms.GET(context);
  if (!response.ok) return response;
  const router = await getCommandRouter();
  const products = new Map(commandProducts.map((product) => [product.id, product]));
  const origin = context.site ?? context.url;
  const lines = router.commands.map((command) => {
    const href = new URL(`${router.commandHref(command, products.get(command.fullPath[0]!))}index.md`, origin).href;
    return `- [${command.command}](${href}) — ${command.description.split('\n')[0]}`;
  });
  const body = `${(await response.text()).trimEnd()}\n\n## Developer tooling\n\n${lines.join('\n')}\n`;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  return new Response(body, { status: response.status, headers });
};
