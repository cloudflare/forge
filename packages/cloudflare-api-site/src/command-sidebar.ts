import { stripBase } from '@cloudflare/nimbus-docs/runtime';
import type { SidebarItem } from '@cloudflare/nimbus-docs/types';
import products from '../.forge/products.json';
import { type CommandProductRoute, type CommandRouter, commandTitle } from './command-reference/routing.ts';
import type { CommandMetadata } from './command-reference/schema.ts';
import { getCommandRouter } from './command-reference/server.ts';

type Item = { label: string; link: string } | { label: string; items: Item[]; collapsed: boolean };

interface Node {
  name: string;
  command?: CommandMetadata;
  children: Map<string, Node>;
}

export const commandProducts: readonly (CommandProductRoute & { title: string })[] = products;

function tree(commands: readonly CommandMetadata[]): Map<string, Node> {
  const roots = new Map<string, Node>();
  for (const command of commands) {
    let siblings = roots;
    command.fullPath.forEach((name, index) => {
      let node = siblings.get(name);
      if (!node) {
        node = { name, children: new Map() };
        siblings.set(name, node);
      }
      if (index === command.fullPath.length - 1) node.command = command;
      siblings = node.children;
    });
  }
  return roots;
}

function render(router: CommandRouter, node: Node, product?: CommandProductRoute): Item {
  const children = [...node.children.values()].map((child) => render(router, child, product));
  if (node.command && children.length === 0) {
    return { label: commandTitle(node.command), link: router.commandHref(node.command, product) };
  }
  return {
    label: commandTitle(node),
    collapsed: true,
    items: [
      ...(node.command ? [{ label: 'Overview', link: router.commandHref(node.command, product) }] : []),
      ...children,
    ],
  };
}

interface CommandGroups {
  /** Non-product commands, after an Overview link to the directory. */
  global: Item[];
  /** Each product's commands, by product. */
  products: Map<CommandProductRoute & { title: string }, Item[]>;
}

function commandGroups(router: CommandRouter): CommandGroups {
  const byId = new Map(commandProducts.map((product) => [product.id, product]));
  const global: Item[] = [{ label: 'Overview', link: router.directoryHref }];
  const products = new Map<CommandProductRoute & { title: string }, Item[]>();
  for (const root of tree(router.commands).values()) {
    const product = byId.get(root.name);
    if (!product) {
      global.push(render(router, root));
      continue;
    }
    products.set(
      product,
      [render(router, root, product)].flatMap((item) => ('items' in item ? item.items : [item])),
    );
  }
  return { global, products };
}

function currentPath(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

function toSidebarItem(item: Item, current: string, order: number): SidebarItem {
  if ('link' in item) {
    const href = stripBase(item.link, import.meta.env.BASE_URL);
    return { type: 'link', label: item.label, href, isCurrent: item.link.replace(/\/+$/, '') === current, order };
  }
  return {
    type: 'group',
    label: item.label,
    collapsed: item.collapsed,
    children: item.items.map((child, index) => toSidebarItem(child, current, index)),
    order,
  };
}

export interface ToolingSidebar {
  /** The site-wide "Developer Tooling" group. */
  global: SidebarItem[];
  /** A product's "Developer Tooling" group, by the product's section path (`/d1/`). */
  products: Map<string, SidebarItem[]>;
}

/** The command groups the API sidebar lists beside the spec's sections. */
export async function getToolingSidebar(url: URL): Promise<ToolingSidebar> {
  const { global, products } = commandGroups(await getCommandRouter());
  const current = currentPath(url.pathname);
  const toItems = (items: Item[]) => items.map((item, order) => toSidebarItem(item, current, order));
  return {
    global: toItems(global),
    products: new Map([...products].map(([product, items]) => [`/${product.slug}/`, toItems(items)])),
  };
}
