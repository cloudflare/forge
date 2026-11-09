import { getOperations, type OperationInfo } from './document.ts';
import { readExtension } from './extensions.ts';
import { isPlainObject, resolveChild, resolveNode } from './resolve.ts';
import type { AnyNode, Located, Location, UserContext } from './types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

/**
 * The URL id Fern gives the top-level server URL inside each environment once operation-level
 * servers add more base URLs.
 */
export const BASE_URL_ID = 'Base';

/** A server as Fern's OpenAPI importer sees it. */
export interface ServerInfo {
  /** The URL with server variables replaced by their defaults, as Fern computes it. */
  url: string | undefined;
  /** `x-name`, then `x-fern-server-name`, then a `description` of production/sandbox. */
  name: string | undefined;
  /** Where the name comes from (the extension key, or the server when unnamed). */
  nameLocation: Location;
  node: AnyNode;
  location: Location;
}

function substituteVariables(url: string, variables: AnyNode): string {
  if (!isPlainObject(variables)) {
    return url;
  }
  let result = url;
  for (const [variable, declaration] of Object.entries(variables)) {
    const value = isPlainObject(declaration) ? declaration.default : undefined;
    result = result.replace(`{${variable}}`, encodeURIComponent(String(value)));
  }
  return result;
}

export function readServer(ctx: Ctx, located: Located | undefined): ServerInfo | undefined {
  if (located === undefined || !isPlainObject(located.node)) {
    return undefined;
  }
  const server = located.node;
  let name: string | undefined;
  let nameLocation = located.location;
  for (const key of ['x-name', 'x-fern-server-name']) {
    if (server[key] !== undefined && server[key] !== null) {
      const value = readExtension(ctx, located, key);
      name = typeof value?.node === 'string' ? value.node : undefined;
      nameLocation = located.location.child([key]);
      break;
    }
  }
  if (name === undefined && typeof server.description === 'string') {
    const description = server.description.toLowerCase();
    if (description === 'production') {
      name = 'Production';
      nameLocation = located.location.child(['description']);
    } else if (description === 'sandbox') {
      name = 'Sandbox';
      nameLocation = located.location.child(['description']);
    }
  }
  return {
    url: typeof server.url === 'string' ? substituteVariables(server.url, server.variables) : undefined,
    name,
    nameLocation,
    node: server,
    location: located.location,
  };
}

export function readServers(ctx: Ctx, located: Located | undefined): ServerInfo[] {
  if (located === undefined || !Array.isArray(located.node)) {
    return [];
  }
  const result: ServerInfo[] = [];
  located.node.forEach((_server: AnyNode, index: number) => {
    const server = readServer(ctx, resolveChild(ctx, located, index));
    if (server !== undefined) {
      result.push(server);
    }
  });
  return result;
}

export function topLevelServers(ctx: Ctx, root: Located): ServerInfo[] {
  return readServers(ctx, resolveChild(ctx, root, 'servers'));
}

export interface OperationServers {
  operation: OperationInfo;
  /** The operation's own `x-fern-server-name`, which replaces its servers entirely. */
  serverName: Located | undefined;
  /** The operation's own `servers`, if declared. */
  ownServers: Located | undefined;
  /** The servers Fern reads: the operation's `servers`, otherwise the path item's. */
  servers: ServerInfo[];
}

/** Server information for every operation under `paths`. */
export function operationServers(ctx: Ctx, root: Located): OperationServers[] {
  return getOperations(ctx, root).map((operation) => {
    const located = { node: operation.node, location: operation.location };
    const ownServers =
      operation.node.servers === undefined || operation.node.servers === null
        ? undefined
        : resolveChild(ctx, located, 'servers');
    const pathServers =
      operation.pathItem.node?.servers === undefined || operation.pathItem.node?.servers === null
        ? undefined
        : resolveChild(ctx, operation.pathItem, 'servers');
    const serverName =
      operation.node['x-fern-server-name'] === undefined || operation.node['x-fern-server-name'] === null
        ? undefined
        : readExtension(ctx, located, 'x-fern-server-name');
    return {
      operation,
      serverName,
      ownServers,
      servers: readServers(ctx, ownServers ?? pathServers),
    };
  });
}

/** Whether Fern builds at least one environment from the top-level servers. */
export function hasEnvironments(servers: ServerInfo[]): boolean {
  return (
    servers.some((server) => server.name !== undefined && server.url !== undefined && server.url !== '') ||
    servers[0]?.url !== undefined
  );
}

/** Follows `$ref`s on a root-level value, keeping the raw value when it is not a reference. */
export function rootValue(ctx: Ctx, root: Located, key: string): Located | undefined {
  const value = root.node?.[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return (
    resolveNode(ctx, value, root.location.child([key])) ?? {
      node: value,
      location: root.location.child([key]),
    }
  );
}
