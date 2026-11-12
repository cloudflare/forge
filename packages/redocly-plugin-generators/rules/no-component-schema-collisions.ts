/**
 * Reports `components.schemas` keys that are also defined in another spec of the same Fern API.
 * Fern merges every spec listed in generators.yml into one definition, so schemas with the same
 * key overwrite each other.
 *
 * Redocly lints one document at a time, so the other specs are listed in the rule options. The
 * rule reports in every linted document that shares a key, naming the other file, so the result
 * does not depend on which document is linted first.
 *
 * Options:
 * - `apis` (string[]): paths of the other specs of the Fern API, relative to the directory of the
 *   Redocly config file (or the working directory when there is none). The linted document itself
 *   may be listed too; it is skipped.
 * - `resolveSchemaCollisions` (boolean, default false): mirrors the `resolve-schema-collisions`
 *   generators.yml setting. fern check stays quiet when it is set, but Fern only renames colliding
 *   schemas within one spec, so schemas of different specs still overwrite each other; the rule
 *   keeps reporting and says so.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseYaml } from '@redocly/openapi-core';
import { rootOf } from '../utils/document.ts';
import { isPlainObject, resolveChild } from '../utils/resolve.ts';
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

interface Options {
  apis?: unknown;
  resolveSchemaCollisions?: boolean;
}

const OPTION = 'the apis option of generators/no-component-schema-collisions';

interface OtherSpec {
  display: string;
  schemaKeys?: Set<string>;
  error?: string;
}

/** Schema keys of a parsed spec: `components.schemas`, or `definitions` for Swagger 2.0. */
function schemaKeysOf(document: AnyNode): Set<string> {
  if (!isPlainObject(document)) {
    return new Set();
  }
  const schemas =
    document.swagger !== undefined
      ? document.definitions
      : isPlainObject(document.components)
        ? document.components.schemas
        : undefined;
  return new Set(isPlainObject(schemas) ? Object.keys(schemas) : []);
}

function loadSpec(path: string, display: string): OtherSpec {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { display, error: `Cannot read "${display}", listed in ${OPTION}.` };
  }
  try {
    return { display, schemaKeys: schemaKeysOf(parseYaml(text)) };
  } catch {
    return {
      display,
      error: `"${display}", listed in ${OPTION}, is not valid YAML or JSON.`,
    };
  }
}

function toDisplay(path: string, baseDirectory: string): string {
  return relative(baseDirectory, path).split('\\').join('/');
}

export const noComponentSchemaCollisions: RuleDefinition = {
  name: 'no-component-schema-collisions',
  vendor: 'fern',
  sourceRules: ['oss/no-component-schema-collisions'],
  severity: 'warn',
  description: 'Component schema keys must not be defined in more than one spec of a Fern API.',
  rule: (options: Options = {}) => ({
    Root: {
      leave(root: AnyNode, ctx: UserContext) {
        const { apis } = options;
        if (apis === undefined) {
          return;
        }
        if (!Array.isArray(apis) || !apis.every((api) => typeof api === 'string')) {
          ctx.report({
            message: `The apis option of generators/no-component-schema-collisions must be a list of file paths.`,
            location: ctx.location,
          });
          return;
        }
        const configPath = ctx.config?.configPath;
        const baseDirectory = configPath === undefined ? process.cwd() : dirname(configPath);
        const current = resolve(ctx.location.source.absoluteRef);
        const currentDisplay = toDisplay(current, baseDirectory);
        const others = [...new Set(apis.map((api) => resolve(baseDirectory, api)))]
          .filter((path) => path !== current)
          .map((path) => loadSpec(path, toDisplay(path, baseDirectory)));

        for (const other of others) {
          if (other.error !== undefined) {
            ctx.report({
              message: other.error,
              location: ctx.location,
            });
          }
        }

        const components = resolveChild(ctx, rootOf(root, ctx), 'components');
        const schemas = components === undefined ? undefined : resolveChild(ctx, components, 'schemas');
        if (schemas === undefined || !isPlainObject(schemas.node)) {
          return;
        }
        for (const schemaId of Object.keys(schemas.node)) {
          for (const other of others) {
            if (other.schemaKeys?.has(schemaId) !== true) {
              continue;
            }
            ctx.report({
              message: `Component schema collision detected: Schema '${schemaId}' is defined in both '${currentDisplay}' and '${other.display}'. One will overwrite the other when Fern merges the specs${options.resolveSchemaCollisions === true ? ' (resolve-schema-collisions only renames colliding schemas within one spec, and fern check does not report this when it is set)' : ''}. Rename the schema in one of the specs or use namespaces to avoid conflicts.`,
              location: schemas.location.child(schemaId).key(),
            });
          }
        }
      },
    },
  }),
};
