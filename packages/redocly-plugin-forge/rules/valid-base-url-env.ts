/**
 * Validates `x-fern-base-url-env`: it must be a non-empty string, and it only has an effect when
 * Fern builds at least one environment from the top-level `servers`.
 */
import { rootOf } from '../utils/document.ts';
import { describeValue, isNonEmptyString } from '../utils/extensions.ts';
import { hasEnvironments, rootValue, topLevelServers } from '../utils/extensions-servers.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const validBaseUrlEnv: RuleDefinition = {
  name: 'valid-base-url-env',
  sourceRules: ['fern-definition/valid-base-url-env'],
  severity: 'error',
  description: 'x-fern-base-url-env is a non-empty string and the document declares servers for it to override.',
  rule: () => ({
    Root: {
      leave(rootNode: AnyNode, ctx: UserContext) {
        const root = rootOf(rootNode, ctx);
        const value = rootValue(ctx, root, 'x-fern-base-url-env');
        if (value === undefined) {
          return;
        }
        if (!isNonEmptyString(value.node)) {
          ctx.report({
            message: `x-fern-base-url-env must be a non-empty string naming an environment variable; Fern ignores ${describeValue(value.node)}.`,
            location: value.location,
          });
          return;
        }
        if (!hasEnvironments(topLevelServers(ctx, root))) {
          ctx.report({
            message:
              `x-fern-base-url-env ${value.node} has no effect because no environments are declared. ` +
              'Fern builds environments from the top-level servers, and the environment variable overrides ' +
              'the default environment, so it is only read when at least one top-level server with a url exists. ' +
              'Add a top-level server, or remove x-fern-base-url-env.',
            location: root.location.child(['x-fern-base-url-env']).key(),
            forceSeverity: 'warn',
          });
        }
      },
    },
  }),
};
