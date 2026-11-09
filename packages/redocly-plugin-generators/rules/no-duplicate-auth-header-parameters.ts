/**
 * Warns about `in: header` parameters that redeclare a header a security scheme already provides:
 * `Authorization` for `http`, `oauth2` and `openIdConnect` schemes, and the `name` of `apiKey`
 * schemes with `in: header` (compared case-insensitively). SDKs send these headers through their
 * auth configuration, so the parameter is redundant.
 */
import { HTTP_METHODS, rootOf } from '../utils/document.ts';
import { isPlainObject, resolveChild, resolveNode } from '../utils/resolve.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

type Ctx = Pick<UserContext, 'resolve'>;

function authHeaderNames(ctx: Ctx, root: Located): Set<string> {
  const result = new Set<string>();
  const components = resolveChild(ctx, root, 'components');
  const schemes = components === undefined ? undefined : resolveChild(ctx, components, 'securitySchemes');
  if (schemes === undefined || !isPlainObject(schemes.node)) {
    return result;
  }
  for (const name of Object.keys(schemes.node)) {
    const scheme = resolveChild(ctx, schemes, name)?.node;
    if (!isPlainObject(scheme)) {
      continue;
    }
    if (scheme.type === 'http' || scheme.type === 'oauth2' || scheme.type === 'openIdConnect') {
      result.add('authorization');
    } else if (scheme.type === 'apiKey' && scheme.in === 'header' && typeof scheme.name === 'string') {
      result.add(scheme.name.toLowerCase());
    }
  }
  return result;
}

export const noDuplicateAuthHeaderParameters: RuleDefinition = {
  name: 'no-duplicate-auth-header-parameters',
  sourceRules: ['oss/no-duplicate-auth-header-parameters'],
  severity: 'warn',
  description: 'Header parameters must not redeclare a header that a security scheme already defines.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const rootLocated = rootOf(root, ctx);
        const authHeaders = authHeaderNames(ctx, rootLocated);
        if (authHeaders.size === 0) {
          return;
        }
        const reported = new Set<string>();
        const check = (container: Located): void => {
          const parameters = container.node?.parameters;
          if (!Array.isArray(parameters)) {
            return;
          }
          parameters.forEach((parameter, index) => {
            const resolved = resolveNode(ctx, parameter, container.location.child(['parameters', index]));
            const node = resolved?.node;
            if (
              resolved === undefined ||
              !isPlainObject(node) ||
              node.in !== 'header' ||
              typeof node.name !== 'string' ||
              !authHeaders.has(node.name.toLowerCase())
            ) {
              return;
            }
            const location = resolved.location.child('name');
            if (reported.has(location.absolutePointer)) {
              return;
            }
            reported.add(location.absolutePointer);
            ctx.report({
              message: `Header parameter '${node.name}' conflicts with the '${node.name}' header already defined by a security scheme. This parameter will be ignored during SDK generation.`,
              location,
            });
          });
        };

        const paths = resolveChild(ctx, rootLocated, 'paths');
        if (paths === undefined || !isPlainObject(paths.node)) {
          return;
        }
        for (const path of Object.keys(paths.node)) {
          if (path.startsWith('x-')) {
            continue;
          }
          const pathItem = resolveChild(ctx, paths, path);
          if (pathItem === undefined || !isPlainObject(pathItem.node)) {
            continue;
          }
          check(pathItem);
          for (const method of HTTP_METHODS) {
            const operation = resolveChild(ctx, pathItem, method);
            if (operation !== undefined && isPlainObject(operation.node)) {
              check(operation);
            }
          }
        }
      },
    },
  }),
};
