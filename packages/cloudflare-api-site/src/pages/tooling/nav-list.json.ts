import { stripBase } from '@cloudflare/nimbus-docs/runtime';
import type { APIRoute } from 'astro';
import { commandProducts } from '../../command-sidebar.ts';
import { getCommandRouter } from '../../command-reference/server.ts';

// The cf commands the sidebar filter finds beside the API's own page list, in
// the same row shape (`NavListRow`): the API list only holds API pages.
export const prerender = true;

export const GET: APIRoute = async () => {
  const router = await getCommandRouter();
  const products = new Map(commandProducts.map((product) => [product.id, product]));
  const rows = router.commands.map((command) => ({
    title: command.command,
    url: stripBase(router.commandHref(command, products.get(command.fullPath[0]!)), import.meta.env.BASE_URL),
  }));
  return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
};
