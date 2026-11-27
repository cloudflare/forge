import { markdownRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';
import { commandDirectoryMarkdown, commandMarkdown } from '../../command-markdown.ts';
import { commandProducts } from '../../command-sidebar.ts';
import { getCommandRouter } from '../../command-reference/server.ts';

const markdown = markdownRoute();

/** Serves Nimbus's `/<page>/index.md`, and a cf command page's Markdown at the same shape of URL. */
export const GET: APIRoute = async (context) => {
  const router = await getCommandRouter();
  const pathname = context.url.pathname.replace(/index\.md$/, '');
  const llmsUrl = new URL(`${import.meta.env.BASE_URL}llms.txt`, context.site ?? context.url).href;
  const headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
  // The tooling directory: the commands `cf` implements itself, as `/tooling/` lists them.
  if (pathname === `${import.meta.env.BASE_URL.replace(/\/$/, '')}/tooling/`) {
    const productIds = new Set(commandProducts.map((product) => product.id));
    const commands = router.commands.filter((command) => !productIds.has(command.fullPath[0]!));
    const href = (command: (typeof commands)[number]) =>
      new URL(`${router.commandHref(command)}index.md`, context.site ?? context.url).href;
    return new Response(commandDirectoryMarkdown(commands, router.descriptions, href, llmsUrl), { headers });
  }
  const command = router.resolve(pathname, commandProducts);
  if (command) return new Response(commandMarkdown(command, llmsUrl), { headers });
  return markdown.GET(context);
};
