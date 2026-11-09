/**
 * Reports operations whose generated SDK request object would contain two properties with the
 * same name, or with names that are equal after camelCase normalization. The request object holds
 * path parameters, query parameters, headers, and the request body: either the properties of an
 * inlined body schema, or a single `body` property.
 *
 * The SDK names follow Fern's OpenAPI importer: `x-fern-parameter-name` / `x-fern-property-name`
 * overrides, camelCased header names without `x-`, automatic renames of path parameters and direct
 * body properties that collide with other request properties, and dropped auth and global headers.
 *
 * Collisions made only of parameters that `no-conflicting-parameter-names` already reports are left
 * to that rule.
 */
import { FERN_HTTP_METHODS, parameterNameCollisions } from './no-conflicting-parameter-names.ts';
import { rootOf } from '../utils/document.ts';
import { lodashCamelCase } from '../utils/naming.ts';
import type { RefOccurrence, WrapperItem } from '../utils/naming-request-wrapper.ts';
import { buildRequestWrapper, documentFacts } from '../utils/naming-request-wrapper.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';
import type { OperationInfo } from '../utils/document.ts';

function describe(item: WrapperItem, alwaysShowName = false): string {
  const overrideNote =
    item.override !== undefined
      ? ` (${item.override}: "${item.name}")`
      : alwaysShowName || item.name !== item.openapiName
        ? ` (SDK name "${item.name}")`
        : '';
  switch (item.kind) {
    case 'path':
      return `path parameter "${item.openapiName}"${overrideNote}`;
    case 'query':
      return `query parameter "${item.openapiName}"${overrideNote}`;
    case 'header':
      return `header parameter "${item.openapiName}"${overrideNote}`;
    case 'body-property':
      return `requestBody property "${item.openapiName}"${overrideNote}`;
    case 'inherited-property':
      return `requestBody property "${item.openapiName}"${overrideNote} inherited via allOf from ${(item.via ?? []).map((name) => `"${name}"`).join(' -> ')}`;
    case 'multipart-property':
      return `multipart requestBody property "${item.openapiName}"${overrideNote}`;
    case 'request-body':
      return `the requestBody, which the SDK exposes as a property named "body" because its schema is not inlined into the request`;
  }
}

function remedy(items: WrapperItem[]): string {
  const hints: string[] = [];
  if (items.some((item) => item.parameter !== undefined)) {
    hints.push('x-fern-parameter-name on a parameter');
  }
  if (items.some((item) => item.kind === 'body-property' || item.kind === 'inherited-property')) {
    hints.push('x-fern-property-name on a requestBody property');
  }
  return hints.length === 0 ? 'Rename one of them' : `Use ${hints.join(' or ')}`;
}

/** Whether `no-conflicting-parameter-names` reports a group containing all of `items`. */
function coveredByParameterNameRule(items: WrapperItem[], operation: OperationInfo): boolean {
  if (items.some((item) => item.parameter === undefined)) {
    return false;
  }
  return parameterNameCollisions(operation.allParameters).some((collision) =>
    items.every((item) => collision.parameters.includes(item.parameter!)),
  );
}

export const noConflictingRequestWrapperProperties: RuleDefinition = {
  name: 'no-conflicting-request-wrapper-properties',
  sourceRules: ['fern-definition/no-conflicting-request-wrapper-properties'],
  severity: 'error',
  description:
    'The parameters and body properties of an operation must have distinct SDK names in the generated request object.',
  rule: () => {
    const refs: RefOccurrence[] = [];
    return {
      ref: {
        enter(_node: AnyNode, ctx: UserContext, resolved: AnyNode) {
          if (resolved?.location !== undefined) {
            refs.push({
              from: ctx.location.absolutePointer,
              to: resolved.location.absolutePointer,
            });
          }
        },
      },
      Root: {
        leave(root: AnyNode, ctx: UserContext) {
          const facts = documentFacts(ctx, rootOf(root, ctx), refs);
          for (const operation of facts.operations) {
            if (!FERN_HTTP_METHODS.has(operation.method)) {
              continue;
            }
            const { items } = buildRequestWrapper(ctx, operation, facts);

            const byName = new Map<string, WrapperItem[]>();
            for (const item of items) {
              const group = byName.get(item.name) ?? [];
              group.push(item);
              byName.set(item.name, group);
            }
            for (const [name, group] of byName) {
              if (group.length < 2 || coveredByParameterNameRule(group, operation)) {
                continue;
              }
              ctx.report({
                message:
                  `Multiple request properties have the name "${name}": ${group.map((item) => describe(item)).join(', ')}. ` +
                  `This is not suitable for code generation. ${remedy(group)} to deconflict.`,
                location: operation.location.key(),
              });
            }

            const byCamelCase = new Map<string, WrapperItem[]>();
            for (const item of items) {
              const normalized = lodashCamelCase(item.name);
              const group = byCamelCase.get(normalized) ?? [];
              group.push(item);
              byCamelCase.set(normalized, group);
            }
            for (const [normalized, group] of byCamelCase) {
              if (new Set(group.map((item) => item.name)).size < 2 || coveredByParameterNameRule(group, operation)) {
                continue;
              }
              ctx.report({
                message:
                  `Multiple request properties resolve to the same generated name "${normalized}" after camelCase normalization: ` +
                  `${group.map((item) => describe(item, true)).join(', ')}. ` +
                  `This causes broken generated code. ${remedy(group)} to disambiguate.`,
                location: operation.location.key(),
              });
            }
          }
        },
      },
    };
  },
};
