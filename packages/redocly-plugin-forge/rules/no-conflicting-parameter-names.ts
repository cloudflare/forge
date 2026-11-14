/**
 * Reports parameters of one operation whose names normalize (via {@link toForgeWords}) to the same
 * identifier within a single SDK argument namespace. Also reports path placeholders that have no
 * letters or digits, and path placeholders repeated in the same template.
 *
 * SDK argument namespaces:
 *
 * - `path` + `query` + `cookie` — these all become keyword arguments / request-struct fields.
 * - `header` — headers become a separate argument (map, dict, …). `Accept`, `Content-Type`, and
 *   `Authorization` are excluded because they are set automatically.
 *
 * Operation-level parameters override path-level ones with the same (`in`, `name`) pair before
 * grouping. A parameter's effective name is `x-forge-parameter-name` when set (and non-empty),
 * otherwise `name`.
 */
import { getOperations, type OperationInfo, rootOf } from '../utils/document.ts';
import { duplicatePlaceholders, pathPlaceholders } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';
import { toForgeWords } from '../utils/words.ts';

type Namespace = 'value' | 'header';

const VALUE_LOCATIONS = new Set(['path', 'query', 'cookie']);
const IGNORED_HEADER_NAMES = new Set(['accept', 'content-type', 'authorization']);

function namespaceOf(location: string): Namespace | undefined {
  if (location === 'header') {
    return 'header';
  }
  if (VALUE_LOCATIONS.has(location)) {
    return 'value';
  }
  return undefined;
}

interface EffectiveParameter {
  effectiveName: string;
  words: string[];
  in: string;
  rawName: string;
  node: AnyNode;
  location: import('../utils/types.ts').Location;
  usingExtension: boolean;
}

function effectiveParameterOf(
  parameter: OperationInfo['parameters'][number],
):
  | { kind: 'ok'; parameter: EffectiveParameter }
  | { kind: 'invalid'; message: string; location: import('../utils/types.ts').Location }
  | undefined {
  const extensionValue = parameter.node['x-forge-parameter-name'];
  const usingExtension = typeof extensionValue === 'string' && extensionValue.length > 0;
  const effectiveName = usingExtension ? (extensionValue as string) : parameter.name;
  const words = toForgeWords(effectiveName);
  if (words.length === 0) {
    const field = usingExtension ? 'x-forge-parameter-name' : 'name';
    return {
      kind: 'invalid',
      message: `${parameter.in} parameter '${parameter.name}' has ${usingExtension ? `an x-forge-parameter-name '${effectiveName}'` : 'a name'} with no letters or digits.`,
      location: parameter.location.child(field).key(),
    };
  }
  return {
    kind: 'ok',
    parameter: {
      effectiveName,
      words,
      in: parameter.in,
      rawName: parameter.name,
      node: parameter.node,
      location: parameter.location,
      usingExtension,
    },
  };
}

function parameterLabel(parameter: EffectiveParameter): string {
  if (parameter.usingExtension) {
    return `${parameter.in} parameter '${parameter.rawName}' (x-forge-parameter-name: '${parameter.effectiveName}')`;
  }
  return `${parameter.in} parameter '${parameter.rawName}'`;
}

function reportPlaceholderProblems(ctx: UserContext, paths: Record<string, AnyNode>, pathsLocation: unknown): void {
  const location = pathsLocation as { child(segments: (string | number)[]): import('../utils/types.ts').Location };
  for (const path of Object.keys(paths)) {
    if (path.startsWith('x-')) {
      continue;
    }
    for (const placeholder of pathPlaceholders(path)) {
      if (toForgeWords(placeholder).length === 0) {
        ctx.report({
          message: `Path '${path}' has placeholder '{${placeholder}}' with no letters or digits.`,
          location: location.child([path]).key(),
        });
      }
    }
    for (const placeholder of duplicatePlaceholders(path)) {
      ctx.report({
        message: `Path '${path}' uses the same placeholder '{${placeholder}}' more than once. Rename one of the segments (e.g. '/pets/{petId}/toys/{toyId}').`,
        location: location.child([path]).key(),
      });
    }
  }
}

function reportNamespace(
  ctx: UserContext,
  operationLocation: import('../utils/types.ts').Location,
  parameters: EffectiveParameter[],
): void {
  const groups = new Map<string, EffectiveParameter[]>();
  for (const parameter of parameters) {
    const key = parameter.words.join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(parameter);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) {
      continue;
    }
    const normalized = key.replaceAll('\u0000', ' ');
    const labels = group.map(parameterLabel).join(', ');
    ctx.report({
      message: `Parameters ${labels} all normalize to '${normalized}' in generated SDK code, which collides. Rename one of them or set a distinct x-forge-parameter-name.`,
      location: operationLocation.key(),
    });
  }
}

export const noConflictingParameterNames: RuleDefinition = {
  name: 'no-conflicting-parameter-names',
  sourceRules: ['fern-definition/no-conflicting-parameter-names', 'fern-definition/no-undefined-path-parameters'],
  severity: 'error',
  description:
    'Parameters in the same SDK argument namespace must not normalize to the same Forge identifier, and path placeholders must have letters or digits and not repeat.',
  rule: () => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        if (isPlainObject(root) && isPlainObject(root.paths)) {
          reportPlaceholderProblems(ctx, root.paths, ctx.location.child(['paths']));
        }
        for (const operation of getOperations(ctx, rootOf(root, ctx))) {
          const byNamespace: Record<Namespace, EffectiveParameter[]> = { value: [], header: [] };
          for (const parameter of operation.parameters) {
            if (!isPlainObject(parameter.node)) {
              continue;
            }
            const namespace = namespaceOf(parameter.in);
            if (namespace === undefined) {
              continue;
            }
            if (namespace === 'header' && IGNORED_HEADER_NAMES.has(parameter.name.toLowerCase())) {
              continue;
            }
            const result = effectiveParameterOf(parameter);
            if (result === undefined) {
              continue;
            }
            if (result.kind === 'invalid') {
              ctx.report({ message: result.message, location: result.location });
              continue;
            }
            byNamespace[namespace].push(result.parameter);
          }
          reportNamespace(ctx, operation.location, byNamespace.value);
          reportNamespace(ctx, operation.location, byNamespace.header);
        }
      },
    },
  }),
};
