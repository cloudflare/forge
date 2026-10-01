# fern-forge

Use Forge OpenAPI metadata in an `astro-fern` documentation project.

`fern-forge` validates Forge and Fern extension fields, contributes SDK
projections to product discovery, stores Forge data on rendered operations, and
promotes confirmation metadata into shared `astro-fern` fields.

## Package roles

| Package or application | Responsibility                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@cloudflare/forge`    | Forge overlay generation and the Forge code generation model                                                        |
| `astro-fern`           | OpenAPI loading, manifests, snapshots, snippets, catalogs, operation artifacts, route planning, and agent documents |
| `fern-forge`           | Validation and adaptation for Forge metadata through the `astro-fern` extension API                                 |
| Your Astro application | HTML, navigation, theme, snippet implementations, visibility policy, commands, and optional custom URLs             |

Configure collections, operation loading, routes, and adapters with the
[`astro-fern` guide](../astro-fern/README.md).

## Register the extension

Add `forgeExtension()` to `defineFernCollections()`. The extension prepares each
snapshot source before product discovery and operation generation.

```ts
// src/content.config.ts
import { defineFernManifest, type FernContentOptions } from 'astro-fern';
import { defineFernCollections } from 'astro-fern/collections';
import { forgeExtension, hoistForgeCommands } from 'fern-forge';

const upstreamSpec = new URL('https://example.com/openapi.json');

const source = async () => {
  const response = await fetch(upstreamSpec);
  if (!response.ok) {
    throw new Error(`OpenAPI request failed: ${response.status} ${response.statusText}`);
  }
  return hoistForgeCommands(await response.json());
};

export const collections = {
  ...defineFernCollections({
    source,
    extensions: [forgeExtension()],
    manifest: (_defaultSource, { discoverProducts }) =>
      defineFernManifest({
        products: discoverProducts(),
      }),
  } satisfies FernContentOptions),
};
```

Register `astroFern()` separately in `astro.config`. That integration installs
the virtual extension accessor used by Astro pages and components.

## Author operation metadata

Section discovery uses a Forge operation's first OpenAPI tag. Content generation
checks all operation tags against the sections declared in the manifest, but
those sections remain internal ownership metadata. The Fern SDK group supplies
the public product and resource hierarchy, and the SDK method supplies the final
method route and snippet accessor.

```yaml
paths:
  /accounts/{account_id}/tokens:
    get:
      operationId: listTokens
      tags:
        - Tokens
      x-fern-sdk-group-name: accounts.tokens
      x-fern-sdk-method-name: list
      x-fern-availability: generally-available
      x-forge-internal: false
```

Manifest discovery creates the `accounts` product and normalizes `Tokens` to the
ownership section ID `tokens`. The operation route ends in
`/accounts/tokens/methods/list/`. A static manifest can select the same
projection with `sdkGroup: 'accounts'`.

### Product and section discovery

`discoverProducts()` applies these rules:

1. The operation must have an `operationId`.
2. The first segment of `x-fern-sdk-group-name` becomes the product ID.
3. The first OpenAPI tag becomes the ownership section and is normalized to a
   lowercase ID.
4. Every Forge alias contributes another SDK projection.
5. `x-fern-ignore: true` removes the physical operation from discovery.
6. Snapshot discovery returns the union of products and sections from every
   snapshot source.

When a static `astro-fern` product declares `sdkGroup`, every projection whose
first SDK group segment exactly equals the configured value is selected. Each
matching primary or alias projection receives an independent page, SDK accessor,
and method. The remaining SDK group segments form its resource hierarchy. Forge
alias projection identities derive from their SDK group and method, so reordering
the alias array does not change identity across snapshots.

Within a product that owns the operation, content generation assigns the
operation when any of its tags matches a manifest section. Matching two sections
in one product is an error. Across snapshots, one generated section ID must map
to the same tag.

## Add aliases

`x-forge-aliases` exposes one physical OpenAPI operation through one or more SDK
groups or methods.

```yaml
operationId: listTokens
tags:
  - Tokens
x-forge-aliases:
  - x-fern-sdk-group-name: accounts.tokens
    x-fern-sdk-method-name: list
    x-fern-availability: generally-available
  - x-fern-sdk-group-name: users.tokens
    x-fern-sdk-method-name: list
    x-fern-availability: beta
```

The aliases add `accounts` and `users` products during discovery. Both products
use the `Tokens` section.

The alias array must contain at least one entry. Each alias declares a complete
projection with both SDK names. Forge data, availability, confirmation text,
argument configuration, and parameter overrides belong to
the alias that declares them. Primary metadata can appear on the same operation
and contributes another projection. SDK addresses within the alias array must be
unique; duplicate group-and-method pairs are rejected as ambiguous.

Every alias produces its own operation page unless multiple mappings resolve to
the same SDK URL. For a route collision, `astro-fern` generates a page only when
exactly one candidate has the highest routing priority. Forge gives approved
projections priority `0` and `x-forge-hidden` projections priority `-1`. A tie at
the highest priority generates no page and emits a diagnostic listing every
conflicting HTTP path and operation ID.

## Apply visibility

The two visibility fields have separate behavior:

| Field                  | Behavior                                                         |
| ---------------------- | ---------------------------------------------------------------- |
| `x-fern-ignore: true`  | Removes the operation from discovery and generated documentation |
| `x-forge-hidden: true` | Stores approval state and lowers SDK route-collision priority    |

By itself, `x-forge-hidden` does not remove a uniquely routed operation. Apply it
through the application's content policy when it should remove documentation:

```ts
defineFernCollections({
  source,
  extensions: [forgeExtension()],
  manifest,
  isOperationHidden: (operation) => operation['x-forge-hidden'] === true,
});
```

Forge validation runs before either visibility filter. Invalid ignored or hidden
operations fail validation. Missing primary SDK names emit warnings after every
operation in that source passes validation.

`isOperationHidden` receives the physical OpenAPI operation and applies its
result to every projection. Alias values for `x-fern-ignore` or
`x-forge-internal` are stored on that alias and do not filter its generated page.
Alias `x-forge-hidden` only affects route-collision preference. Global projection
visibility therefore needs to be expressed on the physical operation with the
current API.

Forge extension data is serialized into public operation artifacts. Visibility
and internal flags provide no authorization boundary. Keep credentials, private
configuration, and other secrets out of these fields.

## Read Forge data

Import the virtual accessor from Astro application code:

```ts
import { forgeOperationDataSchema } from 'fern-forge';
import { getOperationExtensionData } from 'fern:virtual/extensions';

const forge = getOperationExtensionData(page.operation, 'forge', forgeOperationDataSchema);

if (forge?.internal) {
  // Apply the application's internal presentation.
}
```

Importing `fern-forge` registers `forge` in `FernExtensionDataRegistry`, so the
two-argument accessor has the return type at compile time
`ForgeOperationDataSchema | undefined`. It returns stored JSON without parsing
it. Pass `forgeOperationDataSchema` as the third argument, as above, to validate
the value at runtime. A selected operation projection receives the Forge data
attached to that projection.

This source field is promoted into a shared operation field:

| Source field                   | Rendered field                       |
| ------------------------------ | ------------------------------------ |
| `x-forge-require-confirmation` | `page.operation.requireConfirmation` |

Human and agent renderers read these values from `page.operation`.

## Normalize command metadata

When a path item contains `x-forge-commands`, `hoistForgeCommands()` validates
the OpenAPI fields consumed by `astro-fern` and the Forge root fields, moves
those entries to the root, removes them from path items, and returns a new
object.

```ts
import { hoistForgeCommands } from 'fern-forge';

const source = async () => {
  const response = await fetch(upstreamSpec);
  if (!response.ok) throw new Error(`OpenAPI request failed: ${response.status}`);
  return hoistForgeCommands(await response.json());
};
```

Use the returned object. Duplicate command names between the root and path items,
or between two path items, fail normalization.

The extension validates root command and group metadata. Command metadata is not
copied into the generated Fern catalog. Keep the normalized source available to
a separate application loader that creates command catalogs, routes, and pages.

## Operation metadata reference

Primary operation metadata accepts these fields:

| Source field                   | Accepted value                                 | Normalized field      | Effect                                                    |
| ------------------------------ | ---------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `x-fern-sdk-group-name`        | Nonempty dotted string or string segment array | `sdkGroupName`        | Selects products and supplies the SDK accessor path       |
| `x-fern-sdk-method-name`       | Nonempty string                                | `sdkMethodName`       | Supplies the SDK method for snippets                      |
| `x-fern-availability`          | Availability value below                       | `availability`        | Supplies lifecycle metadata                               |
| `x-fern-ignore`                | Boolean, default `false`                       | `ignore`              | Removes the operation from generated content when true    |
| `x-forge-hidden`               | Boolean, default `false`                       | `hidden`              | Stores approval state and lowers route-collision priority |
| `x-forge-internal`             | Boolean                                        | `internal`            | Stores internal visibility metadata                       |
| `x-forge-globals`              | Argument array                                 | `globals`             | Stores shared command arguments                           |
| `x-forge-epilogue`             | String                                         | `epilogue`            | Stores command or method footer text                      |
| `x-forge-args`                 | Method argument array                          | `args`                | Stores method argument configuration                      |
| `x-forge-params`               | Parameter override map                         | `params`              | Stores overrides by parameter name                        |
| `x-forge-require-confirmation` | Nonempty string                                | `requireConfirmation` | Promotes confirmation text to the rendered operation      |
| `x-forge-aliases`              | Nonempty projection array                      | N/A                   | Adds SDK projections for discovery and content generation |

Primary SDK group and method names are required by the Forge contract. Current
document ingestion accepts missing primary names and emits warnings. An
incomplete primary projection contributes no primary Forge data. Alias
projections always require both names.

### Availability

`x-fern-availability` accepts:

```text
alpha
beta
preview
generally-available
deprecated
legacy
```

## Argument metadata reference

`x-forge-globals` contains arguments. `x-forge-args` contains arguments or
argument groups.

### Arguments

| Field         | Accepted value                           | Required   |
| ------------- | ---------------------------------------- | ---------- |
| `name`        | Nonempty string                          | Yes        |
| `alias`       | Nonempty string                          | No         |
| `description` | Nonempty string                          | No         |
| `completion`  | Completion object                        | No         |
| `type`        | `string`, `number`, `boolean`, or `enum` | Yes        |
| `required`    | `true` or `{ default: scalar }`          | Yes        |
| `values`      | Nonempty enum value array                | For `enum` |

A scalar is a string, number, or boolean. Defaults for string, number, and
boolean arguments must match the argument type.

Enum entries can use a scalar or one of these objects:

```yaml
values:
  - automatic
  - literal: manual
    description: Require explicit confirmation.
  - literal: 10
  - literal: true
```

A string object requires `description`. Number and boolean objects accept only
`literal`.

### Completion

| `type`    | Additional fields                                            |
| --------- | ------------------------------------------------------------ |
| `none`    | None                                                         |
| `choices` | None                                                         |
| `file`    | Optional `extensions: string[]`                              |
| `dynamic` | Required nonempty `listOperation` and `displayField` strings |

### Argument groups

An argument group defines at least one of these arrays:

| Field      | Meaning                                          |
| ---------- | ------------------------------------------------ |
| `required` | Arguments required together by the command model |
| `oneOf`    | Alternative arguments in the command model       |
| `options`  | Optional arguments in the command model          |

## Parameter override reference

`x-forge-params` maps an OpenAPI parameter name to an override:

| Field         | Accepted value                                                 |
| ------------- | -------------------------------------------------------------- |
| `description` | Nonempty string                                                |
| `default`     | Scalar or `null`                                               |
| `hidden`      | Boolean                                                        |
| `required`    | Boolean                                                        |
| `choices`     | Scalar array                                                   |
| `array`       | Boolean                                                        |
| `positional`  | Boolean                                                        |
| `fromFile`    | `false` or an object with format `binary`, `base64`, or `json` |

Every override property is optional. The schema accepts any map key; it does not
check that the key names a parameter declared by the OpenAPI operation.

Generated SDK and CLI names come from the native Fern extensions:
`x-fern-parameter-name` on a parameter and `x-fern-property-name` on a
request-body property. A nested body field's CLI flag joins the effective name of
each segment, so `mtls.mtls_certificate_id` with
`x-fern-property-name: certificate-id` produces `--mtls-certificate-id`.

Example:

```yaml
x-forge-params:
  account_id:
    required: true
  payload:
    fromFile:
      format: json
```

## Command metadata reference

The root document accepts these Forge fields:

| Field                | Shape                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `x-forge-commands`   | Map from command name to an executable group or metadata node            |
| `x-forge-group-info` | Map from command name and dotted group path to description/epilogue data |

An executable command group contains a nonempty `description` and a `methods`
array. Each method is one of these forms:

| Form                 | Required fields                                                | Other accepted fields                                                                                            |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Command leaf         | `operationId`, `x-fern-sdk-method-name`, `x-fern-availability` | Optional description and projection fields except `x-forge-aliases`; SDK group can come from its enclosing group |
| Nested command group | `description`, `methods`, `x-fern-sdk-group-name`              | Optional `x-forge-epilogue`                                                                                      |

A metadata node contains a nonempty `description`, optional
`x-forge-epilogue`, and optional recursive `groups`. A group key can nest
through `groups` or name a dotted path directly:

```yaml
x-forge-commands:
  accounts:
    description: Manage Cloudflare accounts.
    groups:
      tokens:
        description: Manage account tokens.
        x-forge-epilogue: See the token security guide.
        groups:
          permissions:
            description: Inspect token permissions.
      members.roles:
        description: Manage member roles.
```

Unknown root `x-forge-*` names fail document validation.

## Handle validation errors

`forgeExtension()` validates root metadata before validating supported HTTP
methods under `paths`. Root errors stop operation validation. Operation errors
are collected into one error so a content run reports every affected operation.
Callback and webhook operations are not inspected. Extension state is isolated
by snapshot source.

## Public API

All public exports are available from `fern-forge`:

| Export                     | Kind     | Use                                                                               |
| -------------------------- | -------- | --------------------------------------------------------------------------------- |
| `forgeExtension()`         | Function | Register Forge validation and operation contributions with `astro-fern`           |
| `forgeDocumentSchema`      | Schema   | Validate OpenAPI fields consumed by `astro-fern` plus root Forge command metadata |
| `hoistForgeCommands()`     | Function | Normalize path item command metadata into the root document                       |
| `forgeAvailabilitySchema`  | Schema   | Validate an availability value accepted by this package                           |
| `forgeOperationDataSchema` | Schema   | Validate normalized operation projection data                                     |
| `ForgeDocumentSchema`      | Type     | Type inferred from `forgeDocumentSchema`                                          |
| `ForgeCommandsSchema`      | Type     | Type for root command metadata                                                    |
| `ForgeAvailabilitySchema`  | Type     | Type for accepted availability values                                             |
| `ForgeOperationDataSchema` | Type     | Type for normalized operation projection data                                     |
