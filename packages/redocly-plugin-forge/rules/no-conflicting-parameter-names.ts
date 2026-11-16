/**
 * Reports parameters of one operation whose names normalize (via {@link toForgeWords}) to the same
 * identifier within a single SDK argument namespace. Also reports path placeholders that have no
 * letters or digits, and path placeholders repeated in the same template.
 *
 * SDK argument namespaces:
 *
 * - `path` + `query` + `cookie` + top-level JSON request-body properties — these all become
 *   keyword arguments / request-struct fields on the generated method. Body properties are only
 *   folded in when the request body has a JSON media type and its schema is `type: object` with a
 *   `properties` map. `allOf`/`oneOf`/`anyOf` composition is out of scope (same deferral as
 *   `no-conflicting-property-names`). Body properties with `readOnly: true` or `x-forge-skip:
 *   true` are excluded (they don't appear on the request type).
 * - `header` — headers become a separate argument (map, dict, …). `Accept`, `Content-Type`, and
 *   `Authorization` are excluded because they are set automatically.
 *
 * Operation-level parameters override path-level ones with the same (`in`, `name`) pair before
 * grouping. A parameter's effective name is `x-forge-parameter-name` when set (and non-empty),
 * otherwise `name`. A body property's effective name is `x-forge-property-name` when set,
 * otherwise the property key.
 */
import { groupAndReport } from '../utils/collision.ts';
import {
  getJsonMediaType,
  getOperations,
  getRequestBody,
  type OperationInfo,
  rootOf,
  schemaOfMediaType,
} from '../utils/document.ts';
import { duplicatePlaceholders, pathPlaceholders } from '../utils/extensions.ts';
import { isPlainObject, resolveNode } from '../utils/resolve.ts';
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
  /** `parameter` for OAS parameters; `body-property` for top-level JSON request-body properties. */
  kind: 'parameter' | 'body-property';
  /** Parameter location (`path`/`query`/`cookie`/`header`), or `body` for body properties. */
  in: string;
  rawName: string;
  node: AnyNode;
  /** Location of the `name` key, `x-forge-parameter-name`, property key, or `x-forge-property-name`. */
  reportLocation: Location;
  /** True when `x-forge-parameter-name` or `x-forge-property-name` is in effect. */
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
      kind: 'parameter',
      in: parameter.in,
      rawName: parameter.name,
      node: parameter.node,
      reportLocation,
      usingExtension,
    },
  };
}

function parameterLabel(parameter: EffectiveParameter): string {
  if (parameter.kind === 'body-property') {
    return parameter.usingExtension
      ? `body property '${parameter.rawName}' (x-forge-property-name: '${parameter.effectiveName}')`
      : `body property '${parameter.rawName}'`;
  }
  if (parameter.usingExtension) {
    return `${parameter.in} parameter '${parameter.rawName}' (x-forge-parameter-name: '${parameter.effectiveName}')`;
  }
  return `${parameter.in} parameter '${parameter.rawName}'`;
}

/**
 * Top-level properties of the JSON request-body object schema, as pseudo-parameters in the `value`
 * namespace. Returns nothing when the body is missing, non-JSON, a `$ref` that cannot be resolved,
 * or whose schema is not a plain `type: object` with `properties` (composition is out of scope).
 * Properties with `readOnly: true`, `x-forge-skip: true`, or empty normalized names are dropped;
 * the latter two are the property-name rule's job to report.
 */
function* bodyPropertiesOf(ctx: Pick<UserContext, 'resolve'>, operation: OperationInfo): Iterable<EffectiveParameter> {
  const requestBody = getRequestBody(ctx, operation);
  if (requestBody === undefined) {
    return;
  }
  const mediaType = getJsonMediaType(ctx, requestBody);
  if (mediaType === undefined) {
    return;
  }
  const schemaRef = schemaOfMediaType(mediaType);
  if (schemaRef === undefined) {
    return;
  }
  const schema = resolveNode(ctx, schemaRef.node, schemaRef.location);
  if (schema === undefined || !isPlainObject(schema.node) || !isPlainObject(schema.node.properties)) {
    return;
  }
  const propertiesLocation = schema.location.child('properties');
  for (const [key, propertyNode] of Object.entries(schema.node.properties)) {
    if (!isPlainObject(propertyNode) || propertyNode['x-forge-skip'] === true || propertyNode.readOnly === true) {
      continue;
    }
    const extensionValue = propertyNode['x-forge-property-name'];
    const usingExtension = typeof extensionValue === 'string' && extensionValue.length > 0;
    const effectiveName = usingExtension ? (extensionValue as string) : key;
    const words = toForgeWords(effectiveName);
    if (words.length === 0) {
      continue;
    }
    const propertyLocation = propertiesLocation.child(key);
    yield {
      effectiveName,
      words,
      kind: 'body-property',
      in: 'body',
      rawName: key,
      node: propertyNode,
      reportLocation: usingExtension ? propertyLocation.child('x-forge-property-name').key() : propertyLocation.key(),
      usingExtension,
    };
  }
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

function renameHint(group: EffectiveParameter[]): string {
  const hasParameter = group.some((member) => member.kind === 'parameter');
  const hasBodyProperty = group.some((member) => member.kind === 'body-property');
  if (hasParameter && hasBodyProperty) {
    return 'Rename one of them, or set a distinct x-forge-parameter-name / x-forge-property-name.';
  }
  if (hasBodyProperty) {
    return 'Rename one of them, set a distinct x-forge-property-name, or mark one `x-forge-skip: true`.';
  }
  return 'Rename one of them or set a distinct x-forge-parameter-name.';
}

function reportNamespace(ctx: UserContext, parameters: EffectiveParameter[]): void {
  groupAndReport(
    parameters,
    (parameter) => forgeWordsKey(parameter.effectiveName),
    (group) => {
      const normalized = group[0]!.words.join(' ');
      const labels = group.map(parameterLabel).join(', ');
      ctx.report({
        message: `Parameters ${labels} all normalize to '${normalized}' in generated SDK code, which collides. ${renameHint(group)}`,
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
          byNamespace.value.push(...bodyPropertiesOf(ctx, operation));
          reportNamespace(ctx, byNamespace.value);
          reportNamespace(ctx, byNamespace.header);
        }
      },
    },
  }),
};
