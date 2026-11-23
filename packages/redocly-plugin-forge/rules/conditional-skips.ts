/**
 * Validates `x-forge-skip` and `x-forge-only-for` on every placement the parser accepts:
 * path items, path-item parameters, operations, `x-forge-aliases[*]`, operation parameters,
 * request bodies, responses, and schemas (component schemas, properties, nested schemas).
 *
 * - `x-forge-skip` must be a boolean or an array of non-empty strings (condition names).
 * - `x-forge-only-for` must be a non-empty array of non-empty strings (condition names). An
 *   empty array is a silent no-op at parse time, which is almost never what an author means.
 *
 * Forge's host applies these filters before plugins see the model, driven by the conditions
 * pinned on the CLI (`--conditions=name,...`). See RFC 0003.
 */
import { getOperations, rootOf } from '../utils/document.ts';
import { describeKind, forEachForgeTarget } from '../utils/extensions.ts';
import { isPlainObject, resolveChild, resolveNode } from '../utils/resolve.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function checkBoth(ctx: UserContext, node: AnyNode, location: Location): void {
  if (!isPlainObject(node)) {
    return;
  }
  checkSkip(ctx, node, location);
  checkOnlyFor(ctx, node, location);
}

function checkSkip(ctx: UserContext, node: Record<string, unknown>, location: Location): void {
  const value = node['x-forge-skip'];
  if (value === undefined) {
    return;
  }
  if (typeof value === 'boolean') {
    return;
  }
  if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return;
  }
  const detail = Array.isArray(value) ? 'array with non-string or empty elements' : describeKind(value);
  ctx.report({
    message: `x-forge-skip must be a boolean or an array of non-empty condition names; got ${detail}.`,
    location: location.child('x-forge-skip').key(),
  });
}

function checkOnlyFor(ctx: UserContext, node: Record<string, unknown>, location: Location): void {
  const value = node['x-forge-only-for'];
  if (value === undefined) {
    return;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)) {
    return;
  }
  const detail = !Array.isArray(value)
    ? describeKind(value)
    : value.length === 0
      ? 'empty array'
      : 'array with non-string or empty elements';
  ctx.report({
    message: `x-forge-only-for must be a non-empty array of non-empty condition names; got ${detail}.`,
    location: location.child('x-forge-only-for').key(),
  });
}

/** Reports the parameters of a path item or operation, resolving each entry through `$ref`. */
function checkParameters(ctx: UserContext, container: Located): void {
  const parameters = container.node?.parameters;
  if (!Array.isArray(parameters)) {
    return;
  }
  parameters.forEach((parameter, index) => {
    const resolved = resolveNode(ctx, parameter, container.location.child(['parameters', index]));
    if (resolved !== undefined) {
      checkBoth(ctx, resolved.node, resolved.location);
    }
  });
}

/** Reports every response of an operation (`responses.*`), resolving each through `$ref`. */
function checkResponses(ctx: UserContext, operation: Located): void {
  const responses = resolveChild(ctx, operation, 'responses');
  if (responses === undefined || !isPlainObject(responses.node)) {
    return;
  }
  for (const status of Object.keys(responses.node)) {
    if (status.startsWith('x-')) {
      continue;
    }
    const response = resolveChild(ctx, responses, status);
    if (response !== undefined) {
      checkBoth(ctx, response.node, response.location);
    }
  }
}

/** Iterates each path item (from `paths` and OAS 3.1 `webhooks`) as a {@link Located}. */
function* pathItemsOf(ctx: UserContext, root: Located): Iterable<Located> {
  for (const container of ['paths', 'webhooks'] as const) {
    const map = resolveChild(ctx, root, container);
    if (map === undefined || !isPlainObject(map.node)) {
      continue;
    }
    for (const key of Object.keys(map.node)) {
      if (key.startsWith('x-')) {
        continue;
      }
      const pathItem = resolveChild(ctx, map, key);
      if (pathItem !== undefined && isPlainObject(pathItem.node)) {
        yield pathItem;
      }
    }
  }
}

export const conditionalSkips: RuleDefinition = {
  name: 'conditional-skips',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-skip` and `x-forge-only-for` must take valid shapes (RFC 0003).',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const rootLocated = rootOf(root, ctx);

        // Path items and their path-level parameters. Operations inside a path item are
        // reached through `getOperations` below, along with their aliases and nested shapes.
        for (const pathItem of pathItemsOf(ctx, rootLocated)) {
          checkBoth(ctx, pathItem.node, pathItem.location);
          checkParameters(ctx, pathItem);
        }

        // Operations, aliases, operation-level parameters, request bodies, responses.
        for (const operation of getOperations(ctx, rootLocated, { includeWebhooks: true })) {
          const operationLocated: Located = { node: operation.node, location: operation.location };
          forEachForgeTarget(operation, (node, location) => {
            checkBoth(ctx, node, location);
          });
          checkParameters(ctx, operationLocated);
          const requestBody = resolveChild(ctx, operationLocated, 'requestBody');
          if (requestBody !== undefined) {
            checkBoth(ctx, requestBody.node, requestBody.location);
          }
          checkResponses(ctx, operationLocated);
        }
      },
    },
    Schema(schema: AnyNode, ctx: UserContext) {
      checkBoth(ctx, schema, ctx.location);
    },
  }),
};
