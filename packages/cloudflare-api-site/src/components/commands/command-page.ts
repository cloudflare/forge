import type { Breadcrumb } from '@cloudflare/nimbus-docs/runtime';
import { commandTitle, type CommandProductRoute } from '../../command-reference/routing.ts';
import type { CommandMetadata } from '../../command-reference/schema.ts';

/** A command page's breadcrumbs: its product's page, or the tooling directory and the command's group there. */
export function commandBreadcrumbs(
  command: CommandMetadata,
  product?: CommandProductRoute & { title: string },
): Breadcrumb[] {
  const root = { label: 'API Reference', href: '/' };
  if (product) return [root, { label: product.title, href: `/${product.slug}/` }];
  const group = command.fullPath.length > 1 ? command.fullPath[0]! : undefined;
  return [
    root,
    { label: 'Developer Tooling', href: '/tooling/' },
    ...(group ? [{ label: commandTitle({ name: group }), href: `/tooling/#${group}` }] : []),
  ];
}
