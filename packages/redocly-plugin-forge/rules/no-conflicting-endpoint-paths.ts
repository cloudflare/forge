/**
 * Reports operations whose path can match the same URL as another operation with the same HTTP
 * method. Paths are split on `/` (empty segments ignored), and a segment that is entirely a path
 * parameter (`{id}`) matches any segment, so `GET /users/me` conflicts with `GET /users/{id}`.
 * Each conflicting operation is reported, listing the operations it conflicts with.
 */
import type { OperationInfo } from '../utils/document.ts';
import { getOperations, operationLabel, rootOf } from '../utils/document.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

function isPathParameter(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** Tree of path segments; path-parameter segments share one child. */
class PathTree {
  private readonly literalChildren = new Map<string, PathTree>();
  private parameterChild: PathTree | undefined;
  private readonly operations: OperationInfo[] = [];

  insert(segments: string[], operation: OperationInfo): void {
    const [first, ...rest] = segments;
    if (first === undefined) {
      this.operations.push(operation);
      return;
    }
    let next: PathTree | undefined;
    if (isPathParameter(first)) {
      next = this.parameterChild ??= new PathTree();
    } else {
      next = this.literalChildren.get(first);
      if (next === undefined) {
        next = new PathTree();
        this.literalChildren.set(first, next);
      }
    }
    next.insert(rest, operation);
  }

  matching(segments: string[]): OperationInfo[] {
    const [first, ...rest] = segments;
    if (first === undefined) {
      return this.operations;
    }
    const result: OperationInfo[] = [];
    if (isPathParameter(first)) {
      for (const child of this.literalChildren.values()) {
        result.push(...child.matching(rest));
      }
    } else {
      const child = this.literalChildren.get(first);
      if (child !== undefined) {
        result.push(...child.matching(rest));
      }
    }
    if (this.parameterChild !== undefined) {
      result.push(...this.parameterChild.matching(rest));
    }
    return result;
  }
}

function describe(operation: OperationInfo): string {
  const label = operationLabel(operation);
  return typeof operation.node.operationId === 'string'
    ? `${label} (operationId ${operation.node.operationId})`
    : label;
}

export const noConflictingEndpointPaths: RuleDefinition = {
  name: 'no-conflicting-endpoint-paths',
  sourceRules: ['fern-definition/no-conflicting-endpoint-paths'],
  severity: 'warn',
  description: 'Operations with the same HTTP method should not have paths that match the same URLs.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const operations = getOperations(ctx, rootOf(root, ctx));
        const segments = operations.map((operation) => segmentsOf(operation.path));
        const tree = new PathTree();
        operations.forEach((operation, index) => {
          tree.insert(segments[index]!, operation);
        });
        operations.forEach((operation, index) => {
          const conflicts = tree
            .matching(segments[index]!)
            .filter((other) => other !== operation && other.method === operation.method);
          if (conflicts.length === 0) {
            return;
          }
          ctx.report({
            message: `Endpoint path ${operation.path} conflicts with other ${operation.method.toUpperCase()} operations whose paths match the same URLs (a path parameter segment matches any segment): ${conflicts.map(describe).join(', ')}.`,
            location: operation.location.key(),
          });
        });
      },
    },
  }),
};
