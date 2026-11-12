import { ruleDefinitions } from './rules/index.ts';
import type { Oas2Rule, Oas3Rule, RuleDefinition, Severity, Vendor } from './utils/types.ts';

export const PLUGIN_ID = 'generators';

/**
 * Full rule name including vendor prefix when present. `fern-no-get-request-body` for a Fern-
 * targeted rule, `no-get-request-body` for a generator-agnostic one. The Redocly rule ID is
 * `${PLUGIN_ID}/${fullName(definition)}`.
 */
export function fullName(definition: RuleDefinition): string {
  return definition.vendor === undefined ? definition.name : `${definition.vendor}-${definition.name}`;
}

export interface BuiltInRule {
  severity: Severity;
  /** Upstream rules (or parts of them) the built-in rule implements. */
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
      result[fullName(definition)] = definition.rule;
    }
  }
  return result;
}

type ConfigShape = {
  rules: Record<string, Severity>;
  oas2Rules: Record<string, Severity>;
  oas3_0Rules: Record<string, Severity>;
  oas3_1Rules: Record<string, Severity>;
  oas3_2Rules: Record<string, Severity>;
};

/**
 * Build a config.
 *
 * - `includeBuiltIn`: `"recommended"` emits only Redocly built-in rules marked recommended;
 *   `"all"` emits every built-in this plugin relies on.
 * - `pluginSeverity`: applied to every plugin rule included in the config (overrides the
 *   definition's own severity when set; otherwise the definition's severity is used).
 * - `vendorFilter`: when set, only plugin rules whose vendor matches (or is unset, i.e.
 *   generator-agnostic) are included.
 */
function buildConfig({
  includeBuiltIn,
  pluginSeverity,
  vendorFilter,
}: {
  includeBuiltIn: 'recommended' | 'all';
  pluginSeverity?: Severity;
  vendorFilter?: Vendor;
}): ConfigShape {
  const rules: Record<string, Severity> = {};
  const oas3Rules: Record<string, Severity> = {};
  const oas2Rules: Record<string, Severity> = {};

  for (const [name, { severity, recommended, spec }] of Object.entries(builtInRules)) {
    if (includeBuiltIn === 'recommended' && !recommended) {
      continue;
    }
    (spec === 'oas3' ? oas3Rules : rules)[name] = severity;
  }

  for (const definition of ruleDefinitions) {
    if (includeBuiltIn === 'recommended' && definition.recommended === false) {
      continue;
    }
    if (vendorFilter !== undefined && definition.vendor !== undefined && definition.vendor !== vendorFilter) {
      continue;
    }
    const target = (definition.spec ?? 'oas3') === 'oas2' ? oas2Rules : oas3Rules;
    target[`${PLUGIN_ID}/${fullName(definition)}`] = pluginSeverity ?? definition.severity;
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
      recommended: buildConfig({ includeBuiltIn: 'recommended' }),
      all: buildConfig({ includeBuiltIn: 'all', pluginSeverity: 'error' }),
      stainless: buildConfig({ includeBuiltIn: 'recommended', vendorFilter: 'stainless' }),
      forge: buildConfig({ includeBuiltIn: 'recommended', vendorFilter: 'forge' }),
    },
  };
}

export { ruleDefinitions };
export type { RuleDefinition, Vendor };
