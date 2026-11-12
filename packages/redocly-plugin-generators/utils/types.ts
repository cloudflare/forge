import type { Location, Oas2Rule, Oas3Rule, UserContext } from '@redocly/openapi-core';

export type { Location, Oas2Rule, Oas3Rule, UserContext };

/** A loosely typed OpenAPI node. Lint rules must cope with malformed input, so nothing is assumed. */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyNode = any;

/** A node paired with the location it was read from (after `$ref` resolution). */
export interface Located<T = AnyNode> {
  node: T;
  location: Location;
}

export type Severity = 'error' | 'warn';

export type Vendor = 'fern' | 'stainless' | 'forge';

export interface RuleDefinition {
  /**
   * Rule name inside the plugin. The full Redocly rule ID is `generators/<name>` for generator-
   * agnostic rules, or `generators/<vendor>-<name>` when `vendor` is set.
   */
  name: string;
  /**
   * Vendor this rule targets. Omit for generator-agnostic rules. When set, the rule's full name
   * becomes `<vendor>-<name>` so grepping `fern-`/`stainless-`/`forge-` finds everything from a
   * single vendor.
   */
  vendor?: Vendor;
  /**
   * The upstream rule (or rules) this ports, as `<validator>/<rule-name>` — e.g.
   * `fern-definition/no-duplicate-field-names`. Documentation only; does not affect behavior.
   */
  sourceRules: string[];
  /** Severity used by the plugin's `recommended` config. */
  severity: Severity;
  /** Whether `generators/recommended` enables the rule. Defaults to `true`. */
  recommended?: boolean;
  /** One-line description for docs. */
  description: string;
  /** Spec family the rule runs on. Defaults to `oas3`. */
  spec?: 'oas3' | 'oas2';
  rule: Oas3Rule | Oas2Rule;
}
