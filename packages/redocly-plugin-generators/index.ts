import { ruleDefinitions } from './rules/index.ts';
import type { Oas2Rule, Oas3Rule, RuleDefinition, Severity } from './utils/types.ts';

export const PLUGIN_ID = 'generators';

export interface BuiltInRule {
  severity: Severity;
  /** Generator rules (or parts of them) the built-in rule implements. */
  sourceRules: string[];
  /**
   * Whether `generators/recommended` enables the rule. Rules that also enforce things no generator
   * strictly requires are left for you to opt into.
   */
  recommended: boolean;
  /** Set when the built-in rule only exists for OpenAPI 3. */
  spec?: 'oas3';
}

/**
 * Built-in Redocly rules that already implement checks this plugin would otherwise re-implement.
 * Listed so `recommended` can enable them, and so the `covered-by-redocly` fixtures can prove the
 * built-in rule still reports the problem.
 */
export const builtInRules: Record<string, BuiltInRule> = {
  struct: {
    severity: 'error',
    recommended: true,
    sourceRules: ['fern-definition/valid-endpoint-path'],
  },
  'no-unresolved-refs': {
    severity: 'error',
    recommended: true,
    sourceRules: [
      'fern-definition/import-file-exists',
      'fern-definition/no-undefined-type-reference',
      'docs/valid-local-references',
    ],
  },
  'path-params-defined': {
    severity: 'error',
    recommended: true,
    sourceRules: ['fern-definition/no-undefined-path-parameters'],
  },
  'no-duplicated-enum-values': {
    severity: 'error',
    recommended: true,
    sourceRules: ['fern-definition/no-duplicate-enum-values'],
  },
  'no-invalid-media-type-examples': {
    severity: 'error',
    recommended: true,
    spec: 'oas3',
    sourceRules: ['fern-definition/valid-example-error', 'docs/valid-openapi-examples'],
  },
  'no-invalid-schema-examples': {
    severity: 'error',
    recommended: true,
    sourceRules: ['fern-definition/valid-example-type'],
  },
  'operation-operationId-unique': {
    severity: 'error',
    recommended: true,
    sourceRules: ['fern-definition/no-duplicate-declarations'],
  },
};

function rulesFor(spec: 'oas3' | 'oas2'): Record<string, Oas3Rule | Oas2Rule> {
  const result: Record<string, Oas3Rule | Oas2Rule> = {};
  for (const definition of ruleDefinitions) {
    if ((definition.spec ?? 'oas3') === spec) {
      result[definition.name] = definition.rule;
    }
  }
  return result;
}

/**
 * The recommended config. Plugin rules go in per-version rule maps so Redocly does not warn about
 * rules that do not apply to the linted document's version.
 */
function recommendedConfig() {
  const rules: Record<string, Severity> = {};
  const oas3Rules: Record<string, Severity> = {};
  const oas2Rules: Record<string, Severity> = {};
  for (const [name, { severity, recommended, spec }] of Object.entries(builtInRules)) {
    if (recommended) {
      (spec === 'oas3' ? oas3Rules : rules)[name] = severity;
    }
  }
  for (const definition of ruleDefinitions) {
    if (definition.recommended === false) {
      continue;
    }
    const target = (definition.spec ?? 'oas3') === 'oas2' ? oas2Rules : oas3Rules;
    target[`${PLUGIN_ID}/${definition.name}`] = definition.severity;
  }
  return {
    rules,
    oas2Rules,
    oas3_0Rules: oas3Rules,
    oas3_1Rules: oas3Rules,
    oas3_2Rules: oas3Rules,
  };
}

/**
 * The `all` config. Every plugin rule enabled at `error`; built-in rules the plugin relies on are
 * also enabled so a document linted with only `generators/all` is fully covered.
 */
function allConfig() {
  const rules: Record<string, Severity> = {};
  const oas3Rules: Record<string, Severity> = {};
  const oas2Rules: Record<string, Severity> = {};
  for (const [name, { severity, spec }] of Object.entries(builtInRules)) {
    (spec === 'oas3' ? oas3Rules : rules)[name] = severity;
  }
  for (const definition of ruleDefinitions) {
    const target = (definition.spec ?? 'oas3') === 'oas2' ? oas2Rules : oas3Rules;
    target[`${PLUGIN_ID}/${definition.name}`] = 'error';
  }
  return {
    rules,
    oas2Rules,
    oas3_0Rules: oas3Rules,
    oas3_1Rules: oas3Rules,
    oas3_2Rules: oas3Rules,
  };
}

export default function generatorsPlugin() {
  return {
    id: PLUGIN_ID,
    rules: {
      oas3: rulesFor('oas3') as Record<string, Oas3Rule>,
      oas2: rulesFor('oas2') as Record<string, Oas2Rule>,
    },
    configs: {
      recommended: recommendedConfig(),
      all: allConfig(),
    },
  };
}

export { ruleDefinitions };
export type { RuleDefinition };
