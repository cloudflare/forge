# Future work

Candidate rules we've considered but not committed to. Each item is a rough sketch — promote to a GitHub issue when someone is ready to pick it up. None of these are Redocly built-in equivalents; see the plugin's own `builtInRules` map for coverage the plugin already delegates.

## Fern rules awaiting Forge extensions

These upstream Fern rules validate concepts Forge may want in the future, but the corresponding `x-forge-*` extensions don't exist yet. When Forge commits to an extension, write a new `generators/forge-*` rule for it rather than porting the Fern implementation (which embeds Fern-specific behavior).

| Upstream Fern rule                            | Concept                                                               | Likely Forge extension                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `fern-definition/valid-pagination`            | Cursor/offset/URI pagination config + selector validation             | `x-forge-pagination`                                                                  |
| `fern-definition/valid-stream-condition`      | Single endpoint returns stream or non-stream based on a request param | `x-forge-stream-condition`                                                            |
| `fern-definition/no-response-property`        | SDK returns a single response property instead of the full envelope   | `x-forge-sdk-return-value`                                                            |
| `fern-definition/valid-version`               | API version header with values and default                            | `x-forge-version`                                                                     |
| `fern-definition/valid-webhook-signature`     | Webhook HMAC/asymmetric signature verification config                 | `x-forge-webhook-signature`                                                           |
| `fern-definition/valid-example-endpoint-call` | Rich example validation beyond OAS-native `examples`                  | `x-forge-examples` (if OAS examples prove insufficient)                               |
| `fern-definition/valid-global-parameters`     | Global parameter injection across operations                          | `x-forge-global-parameters` (if `components.parameters` + `$ref` proves insufficient) |

## `x-forge-*` rules deferred pending semantic clarification

Fern had equivalent rules. Each depends on a Forge semantic question not yet answered; porting without that answer would hard-code Fern assumptions.

- **`forge-no-conflicting-parameter-names`** — Fern's `no-conflicting-endpoint-parameters` reported path parameters whose effective SDK name collided with the request body's fixed argument name. Blocked on: _does Forge reserve a single argument name for the request body, and what is it?_ In Fern it was `"request"`.
- **`forge-no-duplicate-field-names`** — Fern's `no-duplicate-field-names` reported object schemas where two properties resolved to the same field name after `x-fern-property-name`. Blocked on: _does Forge rename inline request-body schemas and should the rule skip them?_ The Fern rule depended on that convention.
- **`forge-valid-enum-names`** — Fern's `valid-field-names` reported enum values whose names weren't valid identifiers. Blocked on: _does Forge rename enum values (via `x-forge-property-name` on enum values, or an `x-forge-enum`-style map), or are enum values always emitted verbatim?_ The Fern rule's shape depends on which.

## `x-forge-commands` structure validation

`x-forge-commands` has a tree of command-group metadata (names split on `.`, descriptions, optional per-command epilogue). No lint rule validates its shape today. Worth building when the plugin matures; omitted from the initial `x-forge-*` rule pass because the structure is the most involved and least likely to be hand-authored incorrectly.

## New OAS-native rule ideas

Written from scratch, not converted from Fern. Each surfaced during the audit as worth considering for any OAS-driven generator.

1. **`allOf` property conflicts** — two `allOf` members declare the same property key with different schemas.
2. **Security requirements reference existing schemes** — operations with `security` requirements should reference schemes in `components.securitySchemes`.
3. **Multipart `allOf` composition warning** — `allOf` `$ref` in multipart request body schemas is a common generator pitfall. (`forge-no-multipart-allof-composition` already covers this for Forge; a generator-agnostic version would broaden it.)
4. **Enum values are valid identifiers** — string enum values should be usable as identifier names for code generation.
5. **Component schema names start with a letter** — schema keys in `components.schemas` should be valid type names for code generation.
