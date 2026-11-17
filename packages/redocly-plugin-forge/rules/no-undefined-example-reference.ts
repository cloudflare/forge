import { rootOf } from '../utils/document.ts';
import { buildEndpointModels } from '../utils/examples-endpoint.ts';
import { isCodeSamplesOnly, keptEntries, readFernExamples } from '../utils/examples-extension.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';

/**
 * Fern reads any string value in an `x-fern-examples` entry that looks like `$Type.Example` or
 * `$import.Type.Example` as a reference to a named type example. Types imported from OpenAPI
 * have no named examples, so `fern check` rejects every such reference. Fern escapes `$` in
 * examples it takes from native OpenAPI `example`/`examples`, so only `x-fern-examples` are
 * checked.
 */

function startsWithLetter(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z]/.test(value);
}

/** Fern's pre-filter for example references (`visitAllReferencesInExample`). */
export function isExampleReference(value: string): boolean {
  if (!value.startsWith('$')) {
    return false;
  }
  const parts = value.split('.');
  if (parts.length < 2 || parts.length > 3) {
    return false;
  }
  if (!startsWithLetter(parts[0]!.slice(1))) {
    return false;
  }
  return parts.length === 2 || startsWithLetter(parts[1]);
}

function visitStrings(value: unknown, location: Location, visit: (value: string, location: Location) => void): void {
  if (typeof value === 'string') {
    visit(value, location);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => visitStrings(item, location.child(index), visit));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      visitStrings(item, location.child(key), visit);
    }
  }
}

export const noUndefinedExampleReference: RuleDefinition = {
  name: 'no-undefined-example-reference',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-undefined-example-reference'],
  severity: 'error',
  description:
    'x-fern-examples values must not look like Fern example references ($Type.Example), which OpenAPI imports cannot define.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const report = (value: string, location: Location): void => {
          if (!isExampleReference(value)) {
            return;
          }
          ctx.report({
            message: `Example ${value} is not defined. Fern reads strings shaped like $Type.Example in x-fern-examples as references to named type examples, which OpenAPI documents cannot declare. To use the literal string, escape the dollar sign: "\\${value}".`,
            location,
          });
        };
        for (const model of buildEndpointModels(ctx, rootOf(root, ctx))) {
          const examples = readFernExamples(ctx, model.operation);
          if (examples === undefined) {
            continue;
          }
          for (const entry of keptEntries(examples)) {
            if (isCodeSamplesOnly(entry)) {
              continue;
            }
            for (const section of ['headers', 'path-parameters', 'query-parameters']) {
              const values = entry.node[section];
              if (isPlainObject(values)) {
                for (const [key, value] of Object.entries(values)) {
                  visitStrings(value, entry.location.child([section, key]), report);
                }
              }
            }
            if (entry.node.request !== undefined) {
              visitStrings(entry.node.request, entry.location.child('request'), report);
            }
            const response = entry.node.response;
            if (!isPlainObject(response)) {
              continue;
            }
            const location = entry.location.child('response');
            const streams = Array.isArray(response.stream) && model.response.kind === 'stream';
            if (streams && model.response.kind === 'stream') {
              const format = model.response.format;
              (response.stream as AnyNode[]).forEach((item, index) => {
                const itemLocation = location.child(['stream', index]);
                if (format === 'json') {
                  visitStrings(item, itemLocation, report);
                } else if (isPlainObject(item)) {
                  visitStrings(item.data, itemLocation.child('data'), report);
                }
              });
            } else if (!Array.isArray(response.stream)) {
              visitStrings(response.body, location.child('body'), report);
            }
          }
        }
      },
    },
  }),
};
