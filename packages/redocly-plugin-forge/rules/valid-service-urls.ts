/**
 * Checks the base URLs operations are routed to. Fern adds operation- and path-level servers to
 * the environments built from the top-level `servers` only when they are named
 * (`x-fern-server-name`), and an operation's `x-fern-server-name` must name one of those base
 * URLs.
 */
import { operationLabel, rootOf } from '../utils/document.ts';
import { describeValue } from '../utils/extensions.ts';
import { BASE_URL_ID, hasEnvironments, operationServers, topLevelServers } from '../utils/extensions-servers.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const validServiceUrls: RuleDefinition = {
  name: 'valid-service-urls',
  vendor: 'fern',
  sourceRules: ['fern-definition/valid-service-urls'],
  severity: 'error',
  description:
    'Operation-level servers are named with x-fern-server-name and every x-fern-server-name names a known base URL.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const topLevel = topLevelServers(ctx, root);
        const topLevelUrls = new Set(topLevel.flatMap((server) => (server.url === undefined ? [] : [server.url])));
        const topLevelNames = new Set(topLevel.flatMap((server) => (server.name === undefined ? [] : [server.name])));
        const environments = hasEnvironments(topLevel);
        const operations = operationServers(ctx, root);

        // Named base URLs contributed by operation- and path-level servers.
        const urlIds = new Map<string, Set<string>>();
        for (const { serverName, servers } of operations) {
          if (serverName !== undefined) {
            continue;
          }
          for (const server of servers) {
            if (server.name !== undefined && server.url !== undefined) {
              const urls = urlIds.get(server.name) ?? new Set<string>();
              urls.add(server.url);
              urlIds.set(server.name, urls);
            }
          }
        }

        const reported = new Set<string>();
        const once = (key: string): boolean => {
          if (reported.has(key)) {
            return false;
          }
          reported.add(key);
          return true;
        };

        for (const { operation, serverName, ownServers, servers } of operations) {
          if (serverName !== undefined) {
            if (typeof serverName.node !== 'string') {
              ctx.report({
                message: `x-fern-server-name must be a string naming a server; got ${describeValue(serverName.node)}.`,
                location: serverName.location,
              });
              continue;
            }
            const name = serverName.node;
            const known = urlIds.has(name) || (name === BASE_URL_ID && environments);
            if (!known) {
              const hint = topLevelNames.has(name)
                ? ` '${name}' names a top-level server, and top-level servers become environments rather than base URLs.`
                : '';
              const problem = `x-fern-server-name '${name}' on ${operationLabel(operation)} does not name a base URL: no operation- or path-level server with a url has x-fern-server-name '${name}'.${hint}`;
              // With named base URLs, Fern keeps the name on the endpoint; otherwise it drops it.
              ctx.report({
                message:
                  environments && urlIds.size > 0
                    ? [
                        `${problem} fern check does not catch this, but the generated SDK sends the operation to a base URL that no environment defines. Use one of the configured base URLs:`,
                        ...[BASE_URL_ID, ...urlIds.keys()].map((choice) => `  - ${choice}`),
                      ].join('\n')
                    : `${problem} Fern ignores it, and the operation uses the default base URL.`,
                location: serverName.location,
              });
            }
            if (
              ownServers !== undefined &&
              Array.isArray(ownServers.node) &&
              ownServers.node.length > 0 &&
              once(ownServers.location.absolutePointer)
            ) {
              ctx.report({
                message: `The \`servers\` of ${operationLabel(operation)} are ignored because the operation sets x-fern-server-name '${name}'; Fern routes it to the base URL named '${name}' instead.`,
                location: ownServers.location.key(),
              });
            }
            continue;
          }
          const subject =
            ownServers === undefined ? `the operations of path '${operation.path}'` : operationLabel(operation);
          const falls = ownServers === undefined ? 'fall' : 'falls';
          for (const server of servers) {
            if (server.url === undefined) {
              continue;
            }
            if (server.name === undefined) {
              if (!topLevelUrls.has(server.url) && once(server.location.absolutePointer)) {
                ctx.report({
                  message: environments
                    ? `Server '${server.url}' has no x-fern-server-name, so Fern ignores it and ${subject} ${falls} back to the default base URL. Operation- and path-level servers must be named to be added to the environments.`
                    : `Server '${server.url}' has no x-fern-server-name, so Fern ignores it. The document has no top-level \`servers\` either, so the SDK has no URL for ${subject} and callers must pass a base URL. Add top-level servers and name operation- and path-level servers with x-fern-server-name.`,
                  location: server.location,
                });
              }
            } else if (!environments && once(server.location.absolutePointer)) {
              ctx.report({
                message: `Server '${server.url}' (x-fern-server-name '${server.name}') is ignored because the document has no top-level \`servers\`: Fern builds environments from the top-level servers and adds named operation- and path-level servers to them.`,
                location: server.location,
              });
            }
          }
        }
      },
    },
  }),
};
