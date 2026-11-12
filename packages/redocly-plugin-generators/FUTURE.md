# Future work

Candidate rules we considered during the OAS-native conversion but did not commit to. Each item is a rough sketch — promote to a GitHub issue when someone is ready to pick it up. None of these are Redocly built-in equivalents; see the plugin's own `builtInRules` map for coverage the plugin already delegates.

## Fern rules awaiting Forge extensions

These upstream Fern rules validate concepts Forge may want in the future, but the corresponding `x-forge-*` extensions don't exist yet. When Forge commits to an extension, write a new `generators/forge-*` rule for it rather than porting the Fern implementation (which embeds Fern-specific behavior).

| Upstream Fern rule | Concept | Likely Forge extension |
| --- | --- | --- |
| `fern-definition/valid-pagination` | Cursor/offset/URI pagination config + selector validation | `x-forge-pagination` |
| `fern-definition/valid-stream-condition` | Single endpoint returns stream or non-stream based on a request param | `x-forge-stream-condition` |
| `fern-definition/no-response-property` | SDK returns a single response property instead of the full envelope | `x-forge-sdk-return-value` |
| `fern-definition/valid-version` | API version header with values and default | `x-forge-version` |
| `fern-definition/valid-webhook-signature` | Webhook HMAC/asymmetric signature verification config | `x-forge-webhook-signature` |
| `fern-definition/valid-example-endpoint-call` | Rich example validation beyond OAS-native `examples` | `x-forge-examples` (if OAS examples prove insufficient) |
| `fern-definition/valid-global-parameters` | Global parameter injection across operations | `x-forge-global-parameters` (if `components.parameters` + `$ref` proves insufficient) |

## Validation gaps in existing `x-forge-*` extensions

Forge already has extensions equivalent to the Fern ones below — the Rust vendor adapter normalizes Fern to `x-forge-*` — but normalization is not validation. New `generators/forge-*` rules are needed. The Fern rule implementations can't be reused because they embed Fern-specific naming logic.

| Upstream Fern rule | Fern extension | Forge equivalent | New rule needed |
| --- | --- | --- | --- |
| `oss/no-duplicate-overrides` | `x-fern-sdk-group-name` + `x-fern-sdk-method-name` | `x-forge-group-name` + `x-forge-method-name` | Duplicate group+method detection |
| `fern-definition/no-conflicting-endpoint-parameters` | `x-fern-parameter-name`, request wrapper model | `x-forge-parameter-name` | Parameter name conflicts with Forge naming |
| `fern-definition/no-duplicate-field-names` | `x-fern-property-name`, `x-fern-enum` | `x-forge-property-name` | Property name collisions using Forge naming |
| `fern-definition/valid-field-names` | `x-fern-enum`, `x-fern-property-name`, `x-fern-type` | `x-forge-property-name`, `x-forge-model-name` | Valid identifier check for Forge names |
| `fern-definition/valid-type-name` | `x-fern-type-name` | `x-forge-model-name` | `x-forge-model-name` starts with a letter |
| `fern-definition/no-extensions-with-file-upload` | `allOf` `$ref` in Fern multipart | `x-forge-skip` | Multipart `allOf` composition warning |

Other `x-forge-*` extensions that have no lint rule today and could use one:

- **`x-forge-method-name`** / **`x-forge-group-name`** — format, duplicate group+method combinations.
- **`x-forge-model-name`** — must start with a letter, be a valid identifier.
- **`x-forge-property-name`** / **`x-forge-parameter-name`** — valid identifiers, collisions after normalization.
- **`x-forge-availability`** — must be one of `alpha`, `beta`, `preview`, `generally-available`, `deprecated`.
- **`x-forge-aliases`** — alias structure, duplicate alias method names.
- **`x-forge-skip`** — must be boolean.
- **`x-forge-commands`** — command-group structure.
- **`x-forge-sensitive`** / **`x-forge-hidden`** / **`x-forge-require-confirmation`** — type checks.

## New OAS-native rule ideas

Written from scratch, not converted from Fern. Each surfaced during the audit as worth considering for any OAS-driven generator.

1. **`allOf` property conflicts** — two `allOf` members declare the same property key with different schemas.
2. **Security requirements reference existing schemes** — operations with `security` requirements should reference schemes in `components.securitySchemes`.
3. **Multipart `allOf` composition warning** — `allOf` `$ref` in multipart request body schemas is a common generator pitfall.
4. **Enum values are valid identifiers** — string enum values should be usable as identifier names for code generation.
5. **Component schema names start with a letter** — schema keys in `components.schemas` should be valid type names for code generation.
