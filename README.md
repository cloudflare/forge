# Forge

Forge is a schema-first OpenAPI code generation and surface tooling framework. It provides a plugin-based architecture for resolving OpenAPI 3.x specifications, applying JSONPath-based overlays, and generating typed SDKs, CLI interfaces, runtime helpers, and documentation.

## Packages

This monorepo contains:

- **[`@cloudflare/forge`](./packages/forge)**: Core engine: OpenAPI 3.x resolver, typed schema model, JSONPath overlay runner, plugin lifecycle manager, and RFC runtime helpers.
- **[`astro-fern`](./packages/astro-fern)**: Generic Astro engine for rendering Fern-based API documentation.
- **[`fern-forge`](./packages/fern-forge)**: `astro-fern` extension for validating and adapting Forge OpenAPI metadata for documentation.
- **[`docs-site`](./packages/docs-site)**: API reference documentation website consuming `astro-fern`.
- **[`@cloudflare/fern-config`](./packages/cloudflare-fern-config)**: Shared Fern generator configuration and workspace staging.
- **[`@cloudflare/forge-sdk-ts`](./packages/cloudflare-forge-sdk-ts)**: TypeScript SDK package wrapper and `sdk-map` generator.
- **[`@cloudflare/forge-transformer-sdk-ts`](./packages/cloudflare-forge-transformer-sdk-ts)**: Standalone TypeScript SDK generator that turns any bundled OpenAPI specification into an idiomatic TypeScript client library.
- **`@cloudflare/forge-sdk-{lang}`**: Multi-language SDK workspace wrappers (Python, Go, Java, PHP, C#, Ruby, Rust, Swift).

## Architecture

Forge separates the API definition from surface implementations:

```
                  +--------------------------------+
                  |  OpenAPI 3.x Specification     |
                  +---------------+----------------+
                                  |
                                  v
                  +--------------------------------+
                  |  JSONPath Overlays (Optional)  |
                  +---------------+----------------+
                                  |
                                  v
+--------------------------------------------------------------------+
|                         @cloudflare/forge                          |
|                                                                    |
|  - OpenApiResolver: $ref dereferencing, parameter/body extraction   |
|  - Schema model: typed command/method hierarchy                     |
|  - Plugin lifecycle: init -> transform -> finalize                |
+---------------------------------+----------------------------------+
                                  |
            +---------------------+---------------------+
            |                                           |
            v                                           v
+-----------------------+                   +-----------------------+
|  TypeScript SDK       |                   |  Other Surface        |
|  (@cloudflare/forge-  |                   |  Transformers (CLI,   |
|   transformer-sdk-ts) |                   |   docs, runtimes)     |
+-----------------------+                   +-----------------------+
```

## Getting Started

### Installation

```bash
pnpm add @cloudflare/forge
```

### Basic Usage

```ts
import { Forge, init } from '@cloudflare/forge';

// Load any OpenAPI 3.x specification
const spec = {
  openapi: '3.0.0',
  info: { title: 'Sample API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        summary: 'List all users',
        responses: {
          '200': { description: 'Success' },
        },
      },
    },
  },
};

// Initialize a Forge instance with overlays applied
const forge = await init(spec);

// Access resolved operations and schemas
const op = forge.getVerbPath('listUsers');
console.log(op?.path, op?.verb); // /users get
```

### CLI

Install the standalone Forge CLI to generate a TypeScript SDK from a bundled OpenAPI specification:

```bash
pnpm add --save-dev @cloudflare/forge-transformer-sdk-ts
pnpm exec forge openapi.json --out ./generated
```

Use `-` to read the OpenAPI document from stdin. Full generation requires Docker. The output directory contains the finalized OpenAPI document, generated SDK source, and `sdk-map.json`.

## Development

```bash
# Install dependencies
pnpm install

# Run tests across all packages
pnpm test

# Typecheck
pnpm typecheck

# Lint and format
pnpm check
```

## License

MIT © Cloudflare, Inc.
