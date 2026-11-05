import { markdownRoute } from '@cloudflare/nimbus-docs/agent-endpoints';
import type { APIRoute } from 'astro';

const markdown = markdownRoute();
const frontmatterDescription = /^(---\ntitle: .*\n)description: .*\n/;

/**
 * Serves Nimbus's `/<page>/index.md` and 301s this site's old `/<page>.md` URLs to it.
 * Every twin here is an API page, whose body repeats its description, so the frontmatter copy is dropped.
 */
export const GET: APIRoute = async (context) => {
  const slug = context.params.slug ?? '';
  if (slug.split('/').at(-1) !== 'index') {
    return context.redirect(`${import.meta.env.BASE_URL}${slug}/index.md${context.url.search}`, 301);
  }
  const response = await markdown.GET(context);
  if (!response.ok) return response;
  return new Response((await response.text()).replace(frontmatterDescription, '$1'), response);
};
