/**
 * Reports Swagger 2.0 (OpenAPI v2) documents. This rule runs on OAS 2 documents only.
 *
 * Modern OpenAPI tooling — including most code generators and this plugin's other rules —
 * targets OpenAPI 3.x. Swagger 2 omits concepts the generators rely on (`requestBody`,
 * `components.schemas` composition, `oneOf`/`anyOf`, nullable types via `type: ['x', 'null']`),
 * so a v2 document produces degraded or broken output. Upgrade the spec to OpenAPI 3.0 or 3.1
 * before consuming it here.
 */
import type { AnyNode, RuleDefinition, UserContext } from '../utils/types.ts';

export const noOpenApiV2InDocs: RuleDefinition = {
  name: 'no-openapi-v2-in-docs',
  sourceRules: ['docs/no-openapi-v2-in-docs'],
  severity: 'warn',
  description: 'Swagger 2.0 documents should be upgraded to OpenAPI 3.',
  spec: 'oas2',
  rule: () => ({
    Root(_root: AnyNode, ctx: UserContext) {
      ctx.report({
        message: 'OpenAPI version 2.0 (Swagger) detected. Consider upgrading to OpenAPI 3.0 or later.',
        location: ctx.location.child('swagger').key(),
      });
    },
  }),
};
