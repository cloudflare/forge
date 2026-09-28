# Forge overlays

Overlays add SDK/CLI metadata to operations **without editing the upstream spec**: grouping,
method names, lifecycle status, hiding, CLI argument overrides, destructive-action
confirmation, and so on. The format follows the OpenAPI Overlay Specification 1.0.0.

Source: `packages/forge/overlay-types.ts` (types), `packages/forge/overlay-source.ts` (resolution
and validation), `packages/forge/overlay-source.test.ts` (the best source of examples).

## Document shape

```jsonc
{
  "overlay": "1.0.0",
  "info": { "title": "users", "version": "1.0.0" },
  "actions": [
    {
      // (1) Root: declare the command catalogue and the methods/groups it contains.
      "target": "$",
      "update": {
        "x-forge-commands": {
          // command name = top-level CLI command = top-level SDK group
          "users": {
            "description": "Manage users",
            "methods": [
              {
                "operationId": "listUsers",
                "x-fern-sdk-method-name": "list",
                "x-fern-availability": "generally-available"
              },
              {
                // sub-group → users.tokens.*
                "x-fern-sdk-group-name": "tokens",
                "description": "API tokens of a user",
                "methods": [
                  {
                    "operationId": "deleteUserToken",
                    "x-fern-sdk-method-name": "delete",
                    "x-fern-availability": "beta",
                    "x-forge-require-confirmation": "This operation revokes the token immediately."
                  }
                ]
              }
            ]
          }
        }
      }
    },
    // (2) Single operation, addressed by operationId (commonly used to add a description).
    {
      "target": "$.paths.*[?@.operationId==\"listUsers\"]",
      "update": { "description": "List all users in the organization." }
    }
  ]
}
```

## Only two target forms are accepted

| Target                              | Use                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `$`                                 | Root merge. `x-forge-commands` is expanded into per-operation metadata; any other keys are deep-merged into the root as-is |
| `$.paths.*[?@.operationId=="<id>"]` | One operation (single or double quotes; `<id>` must not contain `"`, `[` or `]`)                                           |

Any other JSONPath (e.g. `$.components.schemas.X`) fails with `unsupported overlay target`.

## Method extension fields

| Field                          | Required | Meaning                                                                                                                                                                                      |
| ------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`                  | yes      | Must exist in the upstream spec, otherwise `does not exist in upstream OpenAPI`                                                                                                              |
| `x-fern-sdk-method-name`       | yes      | SDK method name. On a collision inside one group, **every** colliding method is renamed to the camelCase form of its operationId (`ensureUniqueSdkMethodNames`), silently; review the output |
| `x-fern-availability`          | yes      | `alpha` / `beta` / `preview` / `generally-available` / `deprecated`                                                                                                                          |
| `x-fern-sdk-group-name`        |          | Used on group nodes; the value written to each operation is the full dotted path `command.group.sub`                                                                                         |
| `x-fern-ignore`                |          | Generate nothing for this operation, on any surface                                                                                                                                          |
| `x-forge-hidden`               |          | Generate code but hide from CLI help unless `CF_HIDE_COMMANDS` is set                                                                                                                        |
| `x-forge-internal`             |          | Temporarily keep an operation that upstream marks internal in first-party SDKs                                                                                                               |
| `x-forge-epilogue`             |          | Text appended to CLI help                                                                                                                                                                    |
| `x-forge-args`                 |          | Explicit CLI argument definitions (`Schema.methodArg[]`)                                                                                                                                     |
| `x-forge-params`               |          | Per-parameter overrides: `description`, `default`, `hidden`, `required`, `choices`, `array`, `positional`, `fromFile`, ... (`Schema.paramOverride`)                                          |
| `x-forge-globals`              |          | Command-level global CLI arguments                                                                                                                                                           |
| `x-forge-require-confirmation` |          | Must read `This operation ….`; forces a confirmation prompt regardless of HTTP verb                                                                                                          |

When the same operationId appears under several commands, the final operation carries an
`x-forge-aliases` array with one full metadata set per placement (aliases in the CLI).

## Applying overlays

```ts
import { init, applyForgeOverlays } from '@cloudflare/forge';

// Only need the overlaid spec (e.g. to hand to Fern or another tool).
const overlaid = await applyForgeOverlays(openapi, [{ name: 'users', overlay }]);

// Need a Forge instance with the command model.
const forge = await init(openapi, [{ name: 'users', overlay }], {
  // default true: writes openapi.overlaid.{json,yaml} to overlays/_generated/ inside the package directory
  writeArtifacts: false,
  // true: drop operations missing upstream and skip the description-source check
  allowMissingOperations: false,
});
```

## Validation errors

| Error                                                       | Cause                                                                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Overlay command "X" not found in combined overlays.`       | `ApiOverlayFile.name` must equal a command key in `x-forge-commands`. Passing a bare `ApiOverlay` names it `overlay_0`, which fails this check in both `init()` and `applyForgeOverlays()` |
| `overlay has no actions`                                    | `actions` is empty                                                                                                                                                                         |
| `target operationId "X" does not exist in upstream OpenAPI` | Typo in the target operationId, or the operation was removed upstream                                                                                                                      |
| `has both upstream and overlay descriptions`                | Strict mode allows exactly one description source; drop the overlay description if upstream has one                                                                                        |
| `has no description in upstream OpenAPI or overlay`         | Neither side has a description; add one with a form (2) action                                                                                                                             |
| `Overlay method operationIds missing in overlaid OpenAPI`   | An overlay method cannot be found in the final spec                                                                                                                                        |
| `No API overlays found.`                                    | With `allowMissingOperations`, every overlay was filtered out                                                                                                                              |

Multiple overlay files are merged in alphabetical order of `name`, independent of the order passed.
