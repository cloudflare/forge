/**
 * Checks that the environments Fern builds from `servers` contain the URLs the document
 * declares. Fern keys environments by top-level server name and base URLs by
 * operation-level server name, so repeated or reserved names and unnamed servers silently lose
 * URLs.
 */
import { rootOf } from '../utils/document.ts';
import { BASE_URL_ID, operationServers, type ServerInfo, topLevelServers } from '../utils/extensions-servers.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

/** Explains why a server's description did not name it. */
function descriptionHint(server: ServerInfo): string {
  return typeof server.node.description === 'string'
    ? ` Its description '${server.node.description}' is not used as a name: Fern only derives names from the descriptions 'Production' and 'Sandbox'.`
    : '';
}

/** The environment suffix Fern derives from a URL (`api-staging.example.com` → `staging`). */
function environmentSuffix(url: string): string {
  return /[-]([a-z0-9]+)\./i.exec(url)?.[1]?.toLowerCase() ?? 'production';
}

export const matchingEnvironmentUrls: RuleDefinition = {
  name: 'matching-environment-urls',
  vendor: 'fern',
  sourceRules: ['fern-definition/matching-environment-urls'],
  severity: 'error',
  description: 'Every server URL ends up in the environments Fern builds from servers and x-fern-server-name.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const topLevel = topLevelServers(ctx, root).filter((server) => server.url !== undefined && server.url !== '');
        const named = topLevel.filter((server) => server.name !== undefined);

        // Top-level servers sharing a name: the last one replaces the others.
        const byName = new Map<string, ServerInfo>();
        for (const server of named) {
          const previous = byName.get(server.name!);
          if (previous !== undefined && previous.url !== server.url) {
            ctx.report({
              message: `Top-level servers '${previous.url}' and '${server.url}' are both named '${server.name}'. Fern builds one environment per name, so environment '${server.name}' only gets '${server.url}' and '${previous.url}' is dropped.`,
              location: previous.nameLocation,
            });
          }
          byName.set(server.name!, server);
        }

        const namedUrls = new Set(named.map((server) => server.url));
        if (named.length > 0) {
          for (const server of topLevel) {
            if (server.name === undefined && !namedUrls.has(server.url)) {
              ctx.report({
                message: `Top-level server '${server.url}' has no x-fern-server-name, so Fern skips it: once any top-level server is named, only named servers become environments.${descriptionHint(server)}`,
                location: server.location,
                forceSeverity: 'warn',
              });
            }
          }
        } else {
          const first = topLevel[0];
          for (const server of topLevel.slice(1)) {
            if (server.url !== first?.url) {
              ctx.report({
                message: `Top-level server '${server.url}' is dropped: none of the top-level servers has an x-fern-server-name, so Fern only uses the first one ('${first?.url}') as the 'Default' environment. Name each server with x-fern-server-name to get one environment per server.${descriptionHint(server)}`,
                location: server.location,
                forceSeverity: 'warn',
              });
            }
          }
        }

        // Operation- and path-level named servers become base URLs keyed by name.
        const multipleEnvironments = byName.size > 1;
        const seen = new Set<string>();
        const firstByKey = new Map<string, ServerInfo>();
        const operationLevel = operationServers(ctx, root).flatMap(({ serverName, servers }) =>
          serverName === undefined ? servers : [],
        );
        // Without other named base URLs, Fern keeps single-URL environments and drops a 'Base' server.
        const otherBaseUrls = operationLevel.some(
          (server) => server.name !== undefined && server.name !== BASE_URL_ID && server.url !== undefined,
        );
        for (const server of operationLevel) {
          if (server.name === undefined || server.url === undefined || seen.has(server.location.absolutePointer)) {
            continue;
          }
          seen.add(server.location.absolutePointer);
          if (server.name === BASE_URL_ID) {
            ctx.report({
              message: `Operation- and path-level servers cannot be named '${BASE_URL_ID}': Fern uses '${BASE_URL_ID}' for the top-level server URL of each environment. ${otherBaseUrls ? `'${server.url}' replaces the top-level server URL in every environment, so every operation without its own named server is sent to '${server.url}'.` : `Fern drops '${server.url}', and the operation is sent to the top-level server URL.`}`,
              location: server.nameLocation,
            });
            continue;
          }
          const suffix = multipleEnvironments ? environmentSuffix(server.url) : '';
          const key = `${server.name}\u0000${suffix}`;
          const first = firstByKey.get(key);
          if (first === undefined) {
            firstByKey.set(key, server);
          } else if (first.url !== server.url) {
            ctx.report({
              message: multipleEnvironments
                ? `Servers '${first.url}' and '${server.url}' are both named '${server.name}' and map to the same environment suffix '${suffix}'. Fern keeps a single URL per name and environment, so one of them silently replaces the other.`
                : `Servers '${first.url}' and '${server.url}' are both named '${server.name}'. Fern keeps a single URL per server name, so one of them silently replaces the other for every operation using '${server.name}'.`,
              location: server.nameLocation,
            });
          }
        }
      },
    },
  }),
};
