import type { Oas3Rule } from '@redocly/openapi-core';

export interface OperationIdMissingOptions {
  /** Generator tags this rule is relevant to. Informational; does not affect behavior. */
  appliesTo?: Array<'fern' | 'stainless' | 'forge'>;
}

/**
 * Flags operations without an operationId. Generator-agnostic: every code generator
 * needs a stable identifier per operation to name methods, types, and files.
 *
 * No-op fast path: skips immediately when the parent is not an OpenAPI 3.x path item.
 */
export const OperationIdMissing: Oas3Rule = () => ({
  Operation(operation, { report, location }) {
    if (operation.operationId !== undefined && operation.operationId !== '') {
      return;
    }
    report({
      message: 'Operation is missing an operationId; code generators require one to name methods and types.',
      location: location.key(),
    });
  },
});
