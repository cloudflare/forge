import type { AstroConfig } from 'astro';
import type { SatteriResolvedOptions } from '@astrojs/markdown-satteri';
import type { MdastPluginDefinition } from 'satteri';

type AstroMarkdownProcessor = AstroConfig['markdown']['processor'];
type SatteriMarkdownProcessor = AstroMarkdownProcessor & {
  name: 'satteri';
  options: SatteriResolvedOptions;
};

const safeUrlSchemes = new Set(['http', 'https', 'mailto', 'tel']);

function hasUnsafeScheme(url: string): boolean {
  // oxlint-disable-next-line no-control-regex
  const normalized = url.trim().replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return scheme !== undefined && !safeUrlSchemes.has(scheme);
}

/** Satteri MDAST plugin that neutralizes executable HTML and URL inputs. */
export const sanitizeFernMarkdownPlugin = {
  name: 'astro-fern-sanitize-markdown',
  html(node) {
    return { type: 'text', value: node.value };
  },
  link(node, context) {
    if (hasUnsafeScheme(node.url)) context.setProperty(node, 'url', '#');
  },
  image(node, context) {
    if (hasUnsafeScheme(node.url)) context.setProperty(node, 'url', '#');
  },
  definition(node, context) {
    if (hasUnsafeScheme(node.url)) context.setProperty(node, 'url', '#');
  },
} satisfies MdastPluginDefinition;

function isSatteriProcessor(processor: AstroMarkdownProcessor): processor is SatteriMarkdownProcessor {
  return processor.name === 'satteri';
}

/** Adds the sanitizer to Astro's active Satteri processor without replacing its options. */
export function installFernMarkdownSanitizer(processor: AstroConfig['markdown']['processor']): boolean {
  if (!isSatteriProcessor(processor)) return false;
  if (!processor.options.mdastPlugins.includes(sanitizeFernMarkdownPlugin)) {
    processor.options.mdastPlugins.push(sanitizeFernMarkdownPlugin);
  }
  return true;
}
