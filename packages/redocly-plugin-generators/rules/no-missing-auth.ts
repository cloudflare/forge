/**
 * Reports operations that require auth when Fern defines no auth for the API.
 *
 * Fern defines the API's auth from `components.securitySchemes`: it is defined as soon as one
 * scheme has a type Fern imports (`apiKey` in a header, `http` bearer or basic, `oauth2` with
 * `flows`, `openIdConnect`), whether or not any `security` requirement names it. Other schemes
 * (`apiKey` in a query or cookie, `mutualTLS`, other `http` schemes) are skipped.
 *
 * An operation requires auth when its effective `security` (its own, or the root `security` it
 * inherits) is a non-empty array, including `[{}]`; only `security: []` (or no `security`
 * anywhere) means no auth. Operations with their own `security` are reported at it; the root
 * `security` is reported once when at least one operation inherits it.
 *
 * Auth configured in generators.yml (`auth`, `auth-schemes`) replaces the document's schemes;
 * disable this rule for such APIs.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import { isFernEndpoint } from '../utils/structure.ts';
import type { AnyNode, Located, RuleDefinition, UserContext } from '../utils/types.ts';

/** Whether Fern's importer turns a security scheme into an auth scheme. */
function isSupportedScheme(scheme: AnyNode): boolean {
  if (!isPlainObject(scheme)) {
    return false;
  }
  switch (scheme.type) {
    case 'apiKey':
      return scheme.in === 'header';
    case 'http': {
      const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
      return httpScheme === 'bearer' || httpScheme === 'basic';
    }
    case 'openIdConnect':
      return true;
    case 'oauth2':
      return isPlainObject(scheme.flows);
    default:
      return false;
  }
}

/** Describes a security scheme Fern skips, for messages. */
function unsupportedReason(scheme: AnyNode): string {
  if (!isPlainObject(scheme)) {
    return 'not a security scheme object';
  }
  const type = scheme.type;
  if (type === 'apiKey') {
    return `apiKey in ${typeof scheme.in === 'string' ? scheme.in : 'an unknown location'}`;
  }
  if (type === 'http') {
    const httpScheme = typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    return `http ${httpScheme === '' ? 'without a scheme' : httpScheme}`;
  }
  if (type === 'oauth2') {
    return 'oauth2 without flows';
  }
  return typeof type === 'string' ? type : 'a scheme without a type';
}

/** The security schemes in `components.securitySchemes`, resolved. */
function securitySchemes(ctx: UserContext, root: Located): Record<string, AnyNode> {
  const result: Record<string, AnyNode> = {};
  const components = resolveChild(ctx, root, 'components');
  const schemes = components === undefined ? undefined : resolveChild(ctx, components, 'securitySchemes');
  if (schemes === undefined || !isPlainObject(schemes.node)) {
    return result;
  }
  for (const name of Object.keys(schemes.node)) {
    result[name] = resolveChild(ctx, schemes, name)?.node;
  }
  return result;
}

/** Whether a `security` value makes Fern require auth: any non-empty array. */
function requiresAuth(security: AnyNode): boolean {
  return Array.isArray(security) && security.some((requirement) => isPlainObject(requirement));
}

function explanation(schemes: Record<string, AnyNode>): string {
  const names = Object.keys(schemes);
  const defined =
    names.length === 0
      ? '`components.securitySchemes` defines no security schemes'
      : `Fern skips every security scheme in \`components.securitySchemes\`: ${names
          .map((name) => `${name} (${unsupportedReason(schemes[name])})`)
          .join(', ')}`;
  return `${defined}. Define a security scheme Fern supports (apiKey in a header, http bearer, http basic, oauth2 or openIdConnect), or use \`security: []\` for operations without auth.`;
}

export const noMissingAuth: RuleDefinition = {
  name: 'no-missing-auth',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-missing-auth'],
  severity: 'error',
  description: 'Operations that require auth need a security scheme Fern supports.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const document = rootOf(root, ctx);
        const schemes = securitySchemes(ctx, document);
        if (Object.values(schemes).some(isSupportedScheme)) {
          return;
        }
        const reason = explanation(schemes);
        let inheritsRootSecurity = false;
        for (const operation of getOperations(ctx, document)) {
          if (!isFernEndpoint(operation)) {
            continue;
          }
          const security = operation.node.security;
          if (security === undefined || security === null) {
            inheritsRootSecurity = true;
            continue;
          }
          if (requiresAuth(security)) {
            ctx.report({
              message: `Operation requires auth, but no auth is defined: its \`security\` is not empty, but ${reason}`,
              location: operation.location.child('security').key(),
            });
          }
        }
        if (inheritsRootSecurity && isPlainObject(root) && requiresAuth(root.security)) {
          ctx.report({
            message: `Operations without their own \`security\` require auth, but no auth is defined: the root \`security\` is not empty, but ${reason}`,
            location: ctx.location.child('security').key(),
          });
        }
      },
    },
  }),
};
