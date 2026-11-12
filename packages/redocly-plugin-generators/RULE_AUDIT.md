# Rule Audit — OAS-Native Conversion

Deep audit of all 40 lint rules in `@cloudflare/redocly-plugin-generators`.
Goal: convert rules with OAS-native value, delete pure-Fern rules and track them for reference.

## Summary

| Decision                                     | Count | Description                                                                                    |
| -------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------- |
| **CONVERT to OAS-native**                    | 12    | Strip Fern dependencies, keep as generator-agnostic OAS rules                                  |
| **DELETE — not relevant**                    | 15    | Pure Fern validation, no OAS or Forge equivalent                                               |
| **DELETE — requires uncommitted extensions** | 7     | Validates concepts Forge may want (pagination, streaming, etc.) but extensions don't exist yet |
| **DELETE — Forge has equivalent extensions** | 6     | Forge has `x-forge-*` equivalents; new rules needed for those, not the Fern versions           |

The 40 rule files on `scaffold-redocly-plugin-generators` map to 12 CONVERT + 28 DELETE. `no-undefined-path-parameters` is split: its duplicate-placeholder check is converted (see CONVERT entry 10), its `x-fern-base-path` checks are deleted (counted once, under Not Relevant).

---

## Rules to CONVERT (12)

These rules check valid OAS semantics but are currently gated behind Fern-specific logic
(`isFernEndpoint`, `fernRequestMediaTypes`, `x-fern-*` extensions). Strip the Fern dependencies,
remove the vendor prefix, and apply to all operations.

---

### 1. content-type-only-for-multipart

**Current name:** `generators/fern-content-type-only-for-multipart`
**New name:** `generators/content-type-only-for-multipart`

#### Point

`encoding.<property>.contentType` on non-multipart request bodies is meaningless per OAS 3.x spec.

#### Fern Dependencies to Remove

- `isFernEndpoint()` — skip `x-fern-ignore`, `x-fern-webhook`
- `fernRequestMediaTypes()` — Fern's media type selection
- Error message references "Fern"

#### Logic (TDD-style)

- WHEN operation has a `requestBody` with `content` THEN check each media type
- WHEN media type is `multipart/*` THEN skip (contentType is valid there)
- WHEN a non-multipart media type has `encoding.<property>.contentType` THEN report error
- WHEN the same location was already reported THEN skip (dedup)

#### Conversion Notes

Remove `isFernEndpoint` gate. Iterate `requestBody.content` directly for all operations.
Reword message: "Per-property `encoding.contentType` is only meaningful for multipart request bodies (OAS 3.x §4.8.24.1)."

---

### 2. exploded-form-data-is-array

**Current name:** `generators/fern-exploded-form-data-is-array`
**New name:** `generators/exploded-form-data-is-array`

#### Point

`encoding.<property>.explode: true` on a non-array multipart property has undefined serialization.

#### Fern Dependencies to Remove

- `isFernEndpoint()` — Fern endpoint filtering
- `fernRequestMediaTypes()` — Fern media type selection
- `isFileSchema()` — Fern's file property definition
- `defaultFormParameterEncoding` option — Fern generator option
- Inherited property filter (`.filter(p => !p.inherited)`)

#### Logic (TDD-style)

- WHEN operation has a `multipart/*` request body THEN check encoding
- WHEN `encoding.<property>.explode: true` AND `encoding.<property>.contentType` is `application/json` THEN skip (JSON-encoded)
- WHEN `encoding.<property>.explode: true` AND property schema resolves to `type: array` THEN skip (valid)
- WHEN `encoding.<property>.explode: true` AND property schema is NOT array THEN report error

#### Conversion Notes

Remove `isFernEndpoint` gate, `defaultFormParameterEncoding` option, `isFileSchema` exception.
Iterate `requestBody.content` for `multipart/*` keys directly.

---

### 3. no-complex-query-params

**Current name:** `generators/fern-no-complex-query-params`
**New name:** `generators/no-complex-query-params`

#### Point

Query parameters containing discriminated unions cannot be serialized as query strings.

#### Fern Dependencies to Remove

- `isFernEndpoint()` — Fern endpoint filtering
- `isDiscriminatedUnion()` — Fern's definition uses `x-fern-discriminated`, `x-fern-undiscriminated`, `x-fern-type`, inferred discriminants
- `x-fern-ignore` on properties during traversal
- Error message suggests `x-fern-discriminated: false` workaround

#### Logic (TDD-style)

- WHEN parameter is `in: query` THEN check its schema recursively
- WHEN schema or any nested schema (via `$ref`, `items`, `additionalProperties`, `properties`, `allOf`, `oneOf`, `anyOf`) has an OAS `discriminator` with `mapping` THEN report error
- Traversal: follow `$ref`, array items, map values, object properties, composition keywords

#### Conversion Notes

Replace Fern's `isDiscriminatedUnion()` with OAS-standard check: `discriminator.mapping` present.
Remove `x-fern-ignore` on properties. Simpler but still catches important cases.

---

### 4. no-conflicting-endpoint-paths

**Current name:** `generators/fern-no-conflicting-endpoint-paths`
**New name:** `generators/no-conflicting-endpoint-paths`

#### Point

Path templates that match the same URLs (e.g., `GET /users/me` vs `GET /users/{id}`) are ambiguous.

#### Fern Dependencies to Remove

- `isFernEndpoint()` — only dependency; filters to Fern-recognized methods

#### Logic (TDD-style)

- Collect all operations with standard HTTP methods
- Build a path tree: each segment is literal or parameter (wildcard)
- WHEN two operations with the same HTTP method have paths where a `{param}` segment matches any literal THEN report warning listing conflicting operations

#### Conversion Notes

Remove `isFernEndpoint` filter. Check all path operations with standard HTTP methods.
The path tree conflict detection is already generator-agnostic.

---

### 5. no-conflicting-parameter-names

**Current name:** `generators/fern-no-conflicting-parameter-names`
**New name:** `generators/no-conflicting-parameter-names`

#### Point

Parameters in different locations (header vs query) whose names normalize to the same camelCase cause SDK name collisions.

#### Fern Dependencies to Remove

- `fernParameterCamelCase()` — Fern's specific normalization
- `x-fern-parameter-name` — Fern parameter name override
- `FERN_HTTP_METHODS` — Fern's method set

#### Logic (TDD-style)

- FOR each operation (standard HTTP methods):
  - Merge path-level and operation-level parameters (operation overrides by `in`+`name`)
  - Compute effective name: parameter `name` (no override extensions)
  - Normalize to camelCase (lodash `camelCase`)
  - Group by normalized name
  - WHEN a group has 2+ parameters from different `in` locations THEN report error

#### Conversion Notes

Replace `fernParameterCamelCase` with lodash `camelCase` (already a dependency).
Remove `x-fern-parameter-name` override. Check all standard HTTP methods.

---

### 6. no-duplicate-auth-header-parameters

**Current name:** `generators/fern-no-duplicate-auth-header-parameters`
**New name:** `generators/no-duplicate-auth-header-parameters`

#### Point

`in: header` parameters that redeclare a header already provided by a security scheme are redundant.

#### Fern Dependencies to Remove

- `vendor: 'fern'` — the ONLY Fern dependency. Logic is already 100% OAS-native.
- Error message says "SDK generation" — make generator-agnostic

#### Logic (TDD-style)

- Collect auth header names from `components.securitySchemes`:
  - `http`, `oauth2`, `openIdConnect` → "authorization"
  - `apiKey` with `in: header` → scheme's `name` (lowercased)
- FOR each path item and operation `in: header` parameter:
  - WHEN name (lowercased) matches an auth header THEN warn

#### Conversion Notes

Simply remove `vendor: 'fern'`. Update message to "redundant with security scheme".
Zero logic changes. Cleanest conversion of all rules.

---

### 7. no-get-request-body

**Current name:** `generators/fern-no-get-request-body`
**New name:** `generators/no-get-request-body`

#### Point

GET and HEAD operations with request bodies violate RFC 9110 §9.3.1.

#### Fern Dependencies to Remove

- `isFernEndpoint()` — Fern endpoint filtering
- `fernRequestMediaTypes()` — for HEAD, only reports when Fern keeps the body
- Error message references "Fern"

#### Logic (TDD-style)

- WHEN GET operation has `requestBody` THEN report error
- WHEN HEAD operation has `requestBody` THEN report error
- Apply to ALL operations (no endpoint filtering)

#### Conversion Notes

Remove `isFernEndpoint` gate. Simplify HEAD logic — report all HEAD request bodies.
Message: "GET/HEAD operations should not have a request body (RFC 9110 §9.3.1)."

---

### 8. no-invalid-tag-names-or-frontmatter

**Current name:** `generators/fern-no-invalid-tag-names-or-frontmatter`
**New name:** `generators/no-invalid-tag-names-or-frontmatter`

#### Point

Non-ASCII tag names break URL slugs and HTTP headers. `---` in descriptions breaks markdown renderers.

#### Fern Dependencies to Remove

- `vendor: 'fern'` — logic already applies to ALL operations (no `isFernEndpoint` gate)
- Error message mentions Fern docs renderer

#### Logic (TDD-style)

- WHEN tag `name` contains non-ASCII characters THEN report (at tag or first operation using it)
- WHEN operation `description` contains a line matching `---` (with optional whitespace) THEN report

#### Conversion Notes

Remove `vendor: 'fern'`. Update messages to be generator-agnostic.
Logic already checks all operations — no filtering changes needed.

---

### 9. no-openapi-v2-in-docs

**Current name:** `generators/fern-no-openapi-v2-in-docs`
**New name:** `generators/no-openapi-v2`

#### Point

Swagger 2.0 documents should be upgraded to OpenAPI 3.x.

#### Fern Dependencies to Remove

- `vendor: 'fern'` — only Fern artifact. Logic is trivial and 100% OAS-native.

#### Logic (TDD-style)

- WHEN document has `swagger` field (OAS 2.0) THEN report warn
- Rule runs on `spec: 'oas2'` documents only

#### Conversion Notes

Remove `vendor: 'fern'`. Consider whether this is even needed — Forge may just reject OAS 2 outright.

---

### 10. no-undefined-path-parameters (split: convert duplicate-placeholder check, delete base-path check)

**Current name:** `generators/fern-no-undefined-path-parameters`
**New name:** `generators/no-duplicate-path-placeholders`

The current rule bundles two concerns. Convert the duplicate-placeholder check (below).
Delete the `x-fern-base-path` parameter validation (see Not Relevant: `no-undefined-path-parameters (x-fern-base-path part)`).

#### Point

Duplicate path parameter placeholders in a single path template (e.g., `/pets/{id}/toys/{id}`).

#### Fern Dependencies to Remove

- `x-fern-base-path` validation — split off and deleted (see Not Relevant)
- `readBasePath()` — Fern base path reader

#### Logic (TDD-style)

- WHEN a path template has the same `{name}` more than once THEN report error
- Skip extension keys (`x-*`)

#### Conversion Notes

Extract only the duplicate-placeholder check. Delete the `x-fern-base-path` validation (Part 2).
Redocly's `path-params-defined` doesn't cover duplicate placeholders in the same template.

---

### 11. only-object-extensions

**Current name:** `generators/fern-only-object-extensions`
**New name:** `generators/only-object-allof-refs`

#### Point

`allOf` `$ref` members that resolve to non-object schemas are a JSON Schema error — no value can
simultaneously be a string AND an object.

#### Fern Dependencies to Remove

- `convertsToObject()` / `fernSchemaKind()` — Fern's type classification
- `x-fern-type`, `x-fern-ignore`, `x-fern-discriminated`, `x-fern-undiscriminated`
- `inlineAllOfSchemas` option — Fern generator setting
- Fern's nullable alias handling, property collision detection, discriminated union detection
- `parentKind()` with Fern resolution

#### Logic (TDD-style)

- WHEN schema has `allOf` with `$ref` members THEN check each `$ref` target
- WHEN `$ref` target has `type: object` or `properties` THEN skip (valid)
- WHEN `$ref` target is itself an `allOf` of objects THEN skip (valid)
- WHEN `$ref` target resolves to a scalar, array, or enum THEN report error

#### Conversion Notes

Replace Fern's classification with simple OAS checks: does the resolved schema have `type: object`
or `properties`? Remove `inlineAllOfSchemas` option, `x-fern-*` checks, Fern nullable handling.
Much simpler rule, still catches the real JSON Schema semantic error.

---

### 12. valid-type-reference-with-default-and-validation

**Current name:** `generators/fern-valid-type-reference-with-default-and-validation`
**New name:** `generators/valid-schema-defaults`

#### Point

Schema `default` values must match the schema's type. Integer validation keywords must be integers.

#### Fern Dependencies to Remove

- `x-fern-type` skip
- Fern's string `"true"`/`"false"` accepted as valid booleans
- Fern's format→type mapping (long, uint, float)
- Error messages referencing "Fern's importer"

#### Logic (TDD-style)

- WHEN string enum AND default not in enum values THEN report error
- WHEN `type: string` AND default is not a string THEN report error
- WHEN `type: boolean` AND default is not a boolean THEN report error
- WHEN `type: array` AND default is not an array THEN report error
- WHEN `type: integer` AND default is not an integer THEN report error
- WHEN `type: number` AND default is not a number THEN report error
- WHEN `type: integer` AND `minimum`/`maximum`/`multipleOf` are not integers THEN report error

#### Conversion Notes

Remove `x-fern-type` skip. Remove Fern string-boolean acceptance. Simplify numeric kinds to
standard OAS format semantics. This is JSON Schema validation of defaults — universally valuable.

---

## Rules to DELETE (28)

Delete these rules and their tests/fixtures. Tracked here for reference so we know what existed
and why we dropped it.

### Not Relevant (15 rules)

These validate Fern-specific concepts with no OAS or Forge equivalent. Pure Fern validation —
Fern should own these.

| Current Rule                                         | Upstream Reference                                          | Why Not Relevant                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| matching-environment-urls                            | `fern-definition/matching-environment-urls`                 | Fern's `x-fern-server-name` environment model. OAS `servers` is sufficient.                                                                             |
| no-component-schema-collisions                       | `oss/no-component-schema-collisions`                        | Fern multi-spec merge. OAS documents are self-contained.                                                                                                |
| no-conflicting-request-wrapper-properties            | `fern-definition/no-conflicting-request-wrapper-properties` | 900+ lines modeling Fern's request wrapper construction.                                                                                                |
| no-duplicate-declarations                            | `fern-definition/no-duplicate-declarations`                 | Fern's type/request/error naming model.                                                                                                                 |
| no-duplicate-example-names                           | `fern-definition/no-duplicate-example-names`                | `x-fern-examples` naming. OAS examples use unique object keys.                                                                                          |
| no-missing-auth                                      | `fern-definition/no-missing-auth`                           | Fern's "supported scheme" filter — not the same as OAS security validation.                                                                             |
| no-non-component-refs                                | `docs/no-non-component-refs`                                | Fern's raw-text `$ref` scanning for docs. Non-component `$ref`s are valid OAS.                                                                          |
| no-schema-title-collisions                           | `oss/no-schema-title-collisions`                            | Fern's `title-as-schema-name` generator mode.                                                                                                           |
| no-undefined-example-reference                       | `fern-definition/no-undefined-example-reference`            | `$Type.Example` refs in `x-fern-examples`. Fern-proprietary syntax.                                                                                     |
| no-undefined-path-parameters (x-fern-base-path part) | `fern-definition/no-undefined-path-parameters`              | `x-fern-base-path` parameter validation. OAS `servers` handles base paths. The duplicate-placeholder half of this rule is converted (CONVERT entry 10). |
| no-undefined-type-reference                          | `fern-definition/no-undefined-type-reference`               | `x-fern-type` syntax (`optional<list<string>>`). Fern-proprietary type system.                                                                          |
| no-undefined-variable-reference                      | `fern-definition/no-undefined-variable-reference`           | `x-fern-sdk-variable` → `x-fern-sdk-variables`. Fern-specific SDK variable system.                                                                      |
| valid-base-path                                      | `fern-definition/valid-base-path`                           | `x-fern-base-path`. OAS `servers` handles base paths.                                                                                                   |
| valid-base-url-env                                   | `fern-definition/valid-base-url-env`                        | `x-fern-base-url-env`. SDK config concern, not spec metadata.                                                                                           |
| valid-oauth                                          | `fern-definition/valid-oauth`                               | Fern OAuth config via rule options. OAS `securitySchemes.oauth2` is native.                                                                             |
| valid-service-urls                                   | `fern-definition/valid-service-urls`                        | Fern's `x-fern-server-name` base URL matching. OAS `servers` suffices.                                                                                  |

### Requires Uncommitted Extensions (7 rules)

These validate concepts that Forge may want in the future, but the extensions don't exist yet.
When Forge commits to these extensions, new rules should be written for `x-forge-*` — not
converted from the Fern versions, which embed Fern-specific behavior.

| Current Rule                | Upstream Reference                            | Concept                                                                                                                                                                    | Future Forge Extension                                                            |
| --------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| valid-pagination            | `fern-definition/valid-pagination`            | Cursor/offset/URI pagination config + selector validation                                                                                                                  | `x-forge-pagination`                                                              |
| valid-stream-condition      | `fern-definition/valid-stream-condition`      | Stream-condition: single endpoint returns stream or non-stream based on a request param (OAS 3.2 `itemSchema` covers SSE/NDJSON natively, but not the conditional pattern) | `x-forge-stream-condition`                                                        |
| no-response-property        | `fern-definition/no-response-property`        | SDK returns a single response property instead of the full envelope                                                                                                        | `x-forge-sdk-return-value`                                                        |
| valid-version               | `fern-definition/valid-version`               | API version header with values and default                                                                                                                                 | `x-forge-version` (if needed)                                                     |
| valid-webhook-signature     | `fern-definition/valid-webhook-signature`     | Webhook HMAC/asymmetric signature verification config                                                                                                                      | `x-forge-webhook-signature` (if needed)                                           |
| valid-example-endpoint-call | `fern-definition/valid-example-endpoint-call` | Rich example validation beyond OAS native `examples`                                                                                                                       | `x-forge-examples` (if native examples are insufficient)                          |
| valid-global-parameters     | `fern-definition/valid-global-parameters`     | Global parameter injection across operations                                                                                                                               | `x-forge-global-parameters` (if `components.parameters` + `$ref` is insufficient) |

### Forge Has Equivalent Extensions — Needs New Rules (6 rules)

These validate naming/grouping concepts that Forge already supports via `x-forge-*` extensions.
The Fern versions are normalized to `x-forge-*` by the Rust vendor adapter
(`src/bin/forge/normalize/vendor/fern.rs`), but normalization is not validation — we still need
lint rules for the `x-forge-*` extensions. The Fern rule implementations can't be reused because
they embed Fern-specific naming logic; new `generators/forge-*` rules should be written.

| Current Rule                       | Upstream Reference                                   | Fern Extension                                                                     | Forge Equivalent                              | New Rule Needed                             |
| ---------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------- |
| no-duplicate-overrides             | `oss/no-duplicate-overrides`                         | `x-fern-sdk-group-name` + `x-fern-sdk-method-name`                                 | `x-forge-group-name` + `x-forge-method-name`  | Duplicate group+method detection            |
| no-conflicting-endpoint-parameters | `fern-definition/no-conflicting-endpoint-parameters` | `x-fern-parameter-name`, request wrapper model                                     | `x-forge-parameter-name`                      | Parameter name conflicts with Forge naming  |
| no-duplicate-field-names           | `fern-definition/no-duplicate-field-names`           | `x-fern-property-name`, `x-fern-enum`                                              | `x-forge-property-name`                       | Property name collisions using Forge naming |
| valid-field-names                  | `fern-definition/valid-field-names`                  | `x-fern-enum`, `x-fern-property-name`, `x-fern-type`                               | `x-forge-property-name`, `x-forge-model-name` | Valid identifier check for Forge names      |
| valid-type-name                    | `fern-definition/valid-type-name`                    | `x-fern-type-name`                                                                 | `x-forge-model-name`                          | `x-forge-model-name` starts with a letter   |
| no-extensions-with-file-upload     | `fern-definition/no-extensions-with-file-upload`     | `allOf` `$ref` in Fern multipart (uses `x-fern-ignore`, Fern media type selection) | `x-forge-skip`                                | Multipart `allOf` composition warning       |

---

## Future Rules (Not Conversions — New Rules)

Ideas surfaced during the audit. These would be written from scratch, not converted from Fern.

### OAS-Native Rules

1. **allOf property conflicts**: Two `allOf` members declaring the same property key with different
   schemas. (Inspired by `no-duplicate-field-names` but checks OAS semantics, not Fern naming.)

2. **Security requirements reference existing schemes**: Operations with `security` requirements
   should reference schemes in `components.securitySchemes`. (Inspired by `no-missing-auth` but
   without Fern's "supported" filter.)

3. **Multipart allOf composition warning**: `allOf` `$ref` in multipart request body schemas is a
   common generator pitfall. (Inspired by `no-extensions-with-file-upload` but generator-agnostic.)

4. **Enum values are valid identifiers**: String enum values should be usable as identifier names
   for code generation. (Inspired by `valid-field-names` but without Fern's name generation.)

5. **Component schema names start with a letter**: Schema keys in `components.schemas` should be
   valid type names for code generation. (Inspired by `valid-type-name` but checking raw keys.)

### `x-forge-*` Extension Validation Rules

The existing `x-forge-*` extensions have no lint rules today. New `generators/forge-*` rules for:

- **`x-forge-method-name`** / **`x-forge-group-name`**: Validate format, detect duplicate
  group+method combinations across operations.
- **`x-forge-model-name`**: Must start with a letter, be a valid identifier.
- **`x-forge-property-name`** / **`x-forge-parameter-name`**: Must be valid identifiers, detect
  collisions after normalization.
- **`x-forge-availability`**: Must be one of `alpha`, `beta`, `preview`, `generally-available`,
  `deprecated`.
- **`x-forge-aliases`**: Validate alias structure, detect duplicate alias method names.
- **`x-forge-skip`**: Must be boolean.
- **`x-forge-commands`**: Validate command group structure.
- **`x-forge-sensitive`** / **`x-forge-hidden`** / **`x-forge-require-confirmation`**: Type checks.
