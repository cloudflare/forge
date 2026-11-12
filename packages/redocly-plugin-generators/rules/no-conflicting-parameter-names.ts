/**
 * Reports parameters of one operation (path-level and operation-level merged) whose names
 * normalize to the same camelCase identifier while living in different locations (`in: header` vs
 * `in: query`, ...). SDK generators emit one argument or property per parameter, so these
 * collide (duplicate keyword arguments in Python, duplicate properties in TypeScript).
 */
import { camelCase } from 'lodash-es';
import type { ParameterInfo } from '../utils/document.ts';
import { getOperations, rootOf } from '../utils/document.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export interface ParameterNameCollision {
  normalizedName: string;
  parameters: ParameterInfo[];
}

/**
 * Groups an operation's parameters by normalized name. Operation-level parameters come first and
 * override path-level ones with the same `in` + `name`. Only groups spanning two or more distinct
 * `in` values are returned.
 */
export function parameterNameCollisions(allParameters: ParameterInfo[]): ParameterNameCollision[] {
  const operationParameters = allParameters.filter((parameter) => parameter.level === 'operation');
  const overridden = new Set(operationParameters.map((parameter) => `${parameter.in}:${parameter.name}`));
  const merged = [
    ...operationParameters,
    ...allParameters.filter(
      (parameter) => parameter.level === 'path' && !overridden.has(`${parameter.in}:${parameter.name}`),
    ),
  ];
  const groups = new Map<string, ParameterInfo[]>();
  for (const parameter of merged) {
    const normalizedName = camelCase(parameter.name);
    if (normalizedName === '') {
      continue;
    }
    const group = groups.get(normalizedName) ?? [];
    group.push(parameter);
    groups.set(normalizedName, group);
  }
  const result: ParameterNameCollision[] = [];
  for (const [normalizedName, parameters] of groups) {
    if (parameters.length > 1 && new Set(parameters.map((parameter) => parameter.in)).size > 1) {
      result.push({ normalizedName, parameters });
    }
  }
  return result;
}

export const noConflictingParameterNames: RuleDefinition = {
  name: 'no-conflicting-parameter-names',
  sourceRules: ['oss/no-conflicting-parameter-names'],
  severity: 'error',
  description: 'Parameters of an operation in different locations must not normalize to the same camelCase name.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          for (const { normalizedName, parameters } of parameterNameCollisions(operation.allParameters)) {
            const descriptions = parameters
              .map((parameter) => `${parameter.in} parameter '${parameter.name}'`)
              .join(', ');
            ctx.report({
              message: `Parameters ${descriptions} all normalize to '${normalizedName}' in camelCase, which collides in generated code. Rename one of the parameters.`,
              location: operation.location.key(),
            });
          }
        }
      },
    },
  }),
};
