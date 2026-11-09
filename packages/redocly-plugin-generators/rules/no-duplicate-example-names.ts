import { rootOf } from '../utils/document.ts';
import { buildEndpointModels } from '../utils/examples-endpoint.ts';
import { isIncompleteExample, keptEntries, readFernExamples } from '../utils/examples-extension.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

/**
 * The `x-fern-examples` entries of an operation must have distinct names. Only entries Fern
 * keeps are compared; when every kept entry is incomplete (code samples only), Fern replaces
 * them with examples it generates from the schemas, so their names never clash.
 */
export const noDuplicateExampleNames: RuleDefinition = {
  name: 'no-duplicate-example-names',
  vendor: 'fern',
  sourceRules: ['fern-definition/no-duplicate-example-names'],
  severity: 'error',
  description: 'x-fern-examples entries of an operation must have unique names.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const model of buildEndpointModels(ctx, rootOf(root, ctx))) {
          const examples = readFernExamples(ctx, model.operation);
          if (examples === undefined) {
            continue;
          }
          const kept = keptEntries(examples);
          if (kept.every(isIncompleteExample)) {
            continue;
          }
          const firstIndex = new Map<string, number>();
          for (const entry of kept) {
            const name = entry.node.name;
            if (typeof name !== 'string') {
              continue;
            }
            const first = firstIndex.get(name);
            if (first === undefined) {
              firstIndex.set(name, entry.index);
              continue;
            }
            ctx.report({
              message: `Duplicate example name: ${name}. x-fern-examples entry ${first} of this operation already uses it.`,
              location: entry.location.child('name'),
            });
          }
        }
      },
    },
  }),
};
