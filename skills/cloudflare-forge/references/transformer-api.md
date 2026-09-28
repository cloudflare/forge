# Writing a custom transformer

A transformer is a `(forge: Forge) => Promise<void>` function: it reads the spec and command
model from a `Forge` instance and outputs files with `forge.emit(path, content)`. Cloudflare's TS
SDK, `cf` CLI, Cap'n Web bindings, Zod schemas and MCP servers all follow this model; the TS SDK
generator is the transformer published in this repository.

Source: `packages/forge/forge.ts`, `packages/forge/openapi-resolver.ts`,
`packages/forge/schema/schema.ts`, `packages/forge/shared/`.

## Lifecycle

```ts
import { readFileSync } from 'node:fs';
import { init, type TransformerFn } from '@cloudflare/forge';

const spec = JSON.parse(readFileSync('openapi.json', 'utf8'));
// 1. init: resolve the spec (optionally with overlays)
const forge = await init(spec);

// 2. transform: emit into a buffer
const catalog: TransformerFn = async (f) => {
  const rows = ['| operationId | endpoint | summary |', '|---|---|---|'];
  for (const id of f.getOperationIds()) {
    rows.push(`| ${id} | ${f.getVerbPath(id)} | ${f.getOperationSummary(id) ?? ''} |`);
  }
  f.emit('ENDPOINTS.md', `${rows.join('\n')}\n`);
};

// returns SourceFile[] and clears the buffer
const files = await forge.transform(catalog);
// 3. finalize: write to disk (path-traversal guarded)
await forge.finalize('./out', files, { clean: true });
```

One Forge instance can run several transformers in sequence. To chain, feed one transformer's
`SourceFile[]` or on-disk output (for example `sdk-map.json`) into the next. The caller decides
the order; the framework does not impose one.

> Packages export `.ts` sources, so run consumers with a TypeScript-capable runtime such as `tsx`.
> Until the packages are published to npm, create a workspace package inside the forge monorepo
> and depend on `"@cloudflare/forge": "workspace:*"`.

## `Forge` instance API

| Method                                                    | Returns                       | Notes                                                                     |
| --------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `getOperationIds()`                                       | `string[]`                    | All operationIds, sorted                                                  |
| `getVerbPath(id)`                                         | `string \| undefined`         | A string such as `"GET /users/{id}"` (not an object)                      |
| `getDescription(id)`                                      | `string`                      | Description, falling back to summary; **throws** if neither exists        |
| `getOperationDescription(id)` / `getOperationSummary(id)` | `string \| undefined`         | Non-throwing variants                                                     |
| `getParameterDescriptions(id)`                            | `Map<string, string>`         | Parameter name → description, following `$ref` chains                     |
| `matchResponseStatus(id, status)`                         | `ResponseInfo \| undefined`   | OpenAPI precedence: exact status → `4XX`/`4xx` range → `default`          |
| `commands`                                                | `Map<string, Schema.command>` | Command model (below); empty when the spec has no `x-fern-sdk-group-name` |
| `methodMap()` / `methodStats()`                           |                               | Command tree and method-name frequencies; handy when debugging overlays   |
| `getMissingDescriptions()`                                | `string[]`                    | Operations lacking a description (also logs to the console)               |

Apostrophes in operationIds are stripped before lookup, so passing the literal spec id works.

## Structured operation data: `resolveOperation`

```ts
import { resolveOperation } from '@cloudflare/forge';

const op = resolveOperation('listUsers');
// op.path, op.method, op.pathParams, op.queryParams, op.headerParams,
// op.bodyParams (nested objects flattened into CLI-friendly parameters),
// op.requestContentTypes, op.requestBodyRef, op.hasRequestBody, ...
```

The resolver keeps **module-level global state**: `populateOperationMap` replaces the global
`openapi` and `operationMap`, and `init()` repopulates them. Do not interleave two specs in one
process. The resolver only indexes get/post/put/patch/delete; head/options/trace operations are
not found.

## Command model (`Schema` namespace)

```
Schema.command      { name, description, methods: (method | methodGroup)[], globalCliArgs, hideCommand }
Schema.methodGroup  { name, description, epilogue?, methods: (method | methodGroup)[] }
Schema.method       { name, operationId, status, summary?, description?, epilogue?,
                      args?, params?, requireConfirmation? }
```

It is built from each operation's `x-fern-sdk-group-name` (dotted path; the first segment is the
command name) and `x-fern-sdk-method-name`. Without a method name, the last `-`/`_`-separated
segment of the operationId is used. Walk it with `walkAllMethods`:

```ts
import { walkAllMethods } from '@cloudflare/forge';

for (const [name, cmd] of forge.commands) {
  walkAllMethods(cmd.methods, (method, groupPath) => {
    // groupPath is e.g. 'tokens' or 'access.applications'; undefined for top-level methods
    console.log([name, groupPath, method.name].filter(Boolean).join('.'), method.operationId);
  });
}
```

`shared/` also provides naming (`naming.ts`), path (`path-generator.ts`), HTTP method
classification (`http.ts`, `method-classification.ts`) and CLI argument classification
(`arg-classification.ts`) helpers, all re-exported from the package root. Check them before
writing your own in a CLI-style transformer.
