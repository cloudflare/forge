/**
 * Validates `x-forge-skip` and `x-forge-only-for` on every placement the parser accepts:
 * path items, path-item parameters, operations, `x-forge-aliases[*]`, operation parameters,
 * request bodies, responses, reusable `components.*` definitions, and schemas (component
 * schemas, properties, nested schemas).
 *
 * - `x-forge-skip` must be a boolean or a non-empty array of non-empty strings (condition names).
 * - `x-forge-only-for` must be a non-empty array of non-empty strings (condition names).
 *
 * Empty arrays are rejected for both extensions: they are silent no-ops at parse time, which is
 * almost never what an author means (use `x-forge-skip: false` or omit the extension).
 *
 * Forge's host applies these filters before plugins see the model, driven by the conditions
 * pinned on the CLI (`--conditions=name,...`). See RFC 0003.
 */
import { getOperations, HTTP_METHODS, rootOf } from '../utils/document.ts';
import { describeKind, forEachForgeTarget, isNonEmptyString } from '../utils/extensions.ts';
import { isPlainObject, resolveChild, resolveNode } from '../utils/resolve.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

function locationKey(location: Location): string {
  return `${location.source.absoluteRef}${location.pointer ?? ''}`;
}

function checkBoth(ctx: UserContext, node: AnyNode, location: Location, seen: Set<string>): void {
  if (!isPlainObject(node)) {
    return;
  }
  if (node['x-forge-skip'] === undefined && node['x-forge-only-for'] === undefined) {
    return;
  }
  const key = locationKey(location);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
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
  if (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)) {
    return;
  }
  const detail = !Array.isArray(value)
    ? describeKind(value)
    : value.length === 0
      ? 'empty array'
      : 'array with non-string or empty elements';
  ctx.report({
    message: `x-forge-skip must be a boolean or a non-empty array of non-empty condition names; got ${detail}.`,
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
function checkParameters(ctx: UserContext, container: Located, seen: Set<string>): void {
  const parameters = container.node?.parameters;
  if (!Array.isArray(parameters)) {
    return;
  }
  parameters.forEach((parameter, index) => {
    const resolved = resolveNode(ctx, parameter, container.location.child(['parameters', index]));
    if (resolved !== undefined) {
      checkBoth(ctx, resolved.node, resolved.location, seen);
    }
  });
}

/** Reports every response of an operation (`responses.*`), resolving each through `$ref`. */
function checkResponses(ctx: UserContext, operation: Located, seen: Set<string>): void {
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
      checkBoth(ctx, response.node, response.location, seen);
    }
  }
}

/** Reports an operation, its aliases, parameters, request body, and responses. */
function checkOperation(ctx: UserContext, operation: Located, seen: Set<string>): void {
  forEachForgeTarget(operation, (node, location) => {
    checkBoth(ctx, node, location, seen);
  });
  checkParameters(ctx, operation, seen);
  const requestBody = resolveChild(ctx, operation, 'requestBody');
  if (requestBody !== undefined) {
    checkBoth(ctx, requestBody.node, requestBody.location, seen);
  }
  checkResponses(ctx, operation, seen);
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

/** Reports entries in `components.{pathItems,parameters,requestBodies,responses}` (even if unreferenced). */
function checkComponents(ctx: UserContext, root: Located, seen: Set<string>): void {
  const components = resolveChild(ctx, root, 'components');
  if (components === undefined || !isPlainObject(components.node)) {
    return;
  }
  const pathItems = resolveChild(ctx, components, 'pathItems');
  if (pathItems !== undefined && isPlainObject(pathItems.node)) {
    for (const key of Object.keys(pathItems.node)) {
      const pathItem = resolveChild(ctx, pathItems, key);
      if (pathItem === undefined || !isPlainObject(pathItem.node)) {
        continue;
      }
      checkBoth(ctx, pathItem.node, pathItem.location, seen);
      checkParameters(ctx, pathItem, seen);
      for (const method of HTTP_METHODS) {
        const operation = resolveChild(ctx, pathItem, method);
        if (operation !== undefined && isPlainObject(operation.node)) {
          checkOperation(ctx, operation, seen);
        }
      }
    }
  }
  for (const section of ['parameters', 'requestBodies', 'responses'] as const) {
    const map = resolveChild(ctx, components, section);
    if (map === undefined || !isPlainObject(map.node)) {
      continue;
    }
    for (const key of Object.keys(map.node)) {
      const entry = resolveChild(ctx, map, key);
      if (entry !== undefined) {
        checkBoth(ctx, entry.node, entry.location, seen);
      }
    }
  }
}

export const conditionalSkips: RuleDefinition = {
  name: 'conditional-skips',
  sourceRules: [],
  severity: 'error',
  description: '`x-forge-skip` and `x-forge-only-for` must take valid shapes (RFC 0003).',
  rule: () => {
    const seen = new Set<string>();
    return {
      Root: {
        leave(root: AnyNode, ctx: UserContext) {
          const rootLocated = rootOf(root, ctx);

          // Path items and their path-level parameters. Operations inside a path item are
          // reached through `getOperations` below, along with their aliases and nested shapes.
          for (const pathItem of pathItemsOf(ctx, rootLocated)) {
            checkBoth(ctx, pathItem.node, pathItem.location, seen);
            checkParameters(ctx, pathItem, seen);
          }

          // Operations, aliases, operation-level parameters, request bodies, responses.
          for (const operation of getOperations(ctx, rootLocated, { includeWebhooks: true })) {
            checkOperation(ctx, { node: operation.node, location: operation.location }, seen);
          }

          // Reusable component definitions (including unreferenced ones that Forge still parses).
          checkComponents(ctx, rootLocated, seen);
        },
      },
      Schema(schema: AnyNode, ctx: UserContext) {
        checkBoth(ctx, schema, ctx.location, seen);
      },
    };
  },
};
