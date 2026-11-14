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
import { groupAndReport } from '../utils/collision.ts';
import { getOperations, type OperationInfo, rootOf } from '../utils/document.ts';
import { duplicatePlaceholders, pathPlaceholders } from '../utils/extensions.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Location, RuleDefinition, UserContext } from '../utils/types.ts';
import { forgeWordsKey, toForgeWords } from '../utils/words.ts';

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
  /** Location of the parameter's `name` (or `x-forge-parameter-name`) key, for anchored reports. */
  reportLocation: Location;
  usingExtension: boolean;
}

function effectiveParameterOf(
  parameter: OperationInfo['parameters'][number],
): { kind: 'ok'; parameter: EffectiveParameter } | { kind: 'invalid'; message: string; location: Location } {
  const extensionValue = parameter.node['x-forge-parameter-name'];
  const usingExtension = typeof extensionValue === 'string' && extensionValue.length > 0;
  const effectiveName = usingExtension ? (extensionValue as string) : parameter.name;
  const field = usingExtension ? 'x-forge-parameter-name' : 'name';
  const reportLocation = parameter.location.child(field).key();
  const words = toForgeWords(effectiveName);
  if (words.length === 0) {
    return {
      kind: 'invalid',
      message: `${parameter.in} parameter '${parameter.name}' has ${usingExtension ? `an x-forge-parameter-name '${effectiveName}'` : 'a name'} with no letters or digits.`,
      location: reportLocation,
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
      reportLocation,
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

function reportPlaceholderProblems(ctx: UserContext, paths: Record<string, AnyNode>, pathsLocation: Location): void {
  for (const path of Object.keys(paths)) {
    if (path.startsWith('x-')) {
      continue;
    }
    for (const placeholder of pathPlaceholders(path)) {
      if (toForgeWords(placeholder).length === 0) {
        ctx.report({
          message: `Path '${path}' has placeholder '{${placeholder}}' with no letters or digits.`,
          location: pathsLocation.child([path]).key(),
        });
      }
    }
    for (const placeholder of duplicatePlaceholders(path)) {
      ctx.report({
        message: `Path '${path}' uses the same placeholder '{${placeholder}}' more than once. Rename one of the segments (e.g. '/pets/{petId}/toys/{toyId}').`,
        location: pathsLocation.child([path]).key(),
      });
    }
  }
}

function reportNamespace(ctx: UserContext, parameters: EffectiveParameter[]): void {
  groupAndReport(
    parameters,
    (parameter) => forgeWordsKey(parameter.effectiveName),
    (group) => {
      const normalized = group[0]!.words.join(' ');
      const labels = group.map(parameterLabel).join(', ');
      ctx.report({
        message: `Parameters ${labels} all normalize to '${normalized}' in generated SDK code, which collides. Rename one of them or set a distinct x-forge-parameter-name.`,
        location: group[group.length - 1]!.reportLocation,
      });
    },
  );
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
            if (result.kind === 'invalid') {
              ctx.report({ message: result.message, location: result.location });
              continue;
            }
            byNamespace[namespace].push(result.parameter);
          }
          reportNamespace(ctx, byNamespace.value);
          reportNamespace(ctx, byNamespace.header);
        }
      },
    },
  }),
};
