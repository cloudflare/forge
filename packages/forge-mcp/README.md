# @cloudflare/forge-mcp

Generates an MCP server's tools from an OpenAPI document with forge, and
serves them over Streamable HTTP.

There are two halves:

- **A forge plugin** turns the document into a tool catalogue,
  `mcp-tools.json`: one tool per method, with its input schema, annotations,
  and how its arguments become an HTTP request.
- **A runtime** serves a catalogue with the
  [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).
  `tools/list` returns the catalogue's tools; `tools/call` makes one API
  request. It needs nothing else from the document at request time.

```sh
pnpm build:plugin   # dist/forge-mcp.wasm
forge openapi.json --target wasm://dist/forge-mcp.wasm --out generated
```

```ts
import { createForgeMcpHandler } from '@cloudflare/forge-mcp';
import catalogue from './generated/mcp-tools.json';

const mcp = createForgeMcpHandler({
  catalogue,
  authorize: (request) => {
    const authorization = request.headers.get('Authorization');
    return authorization ? { Authorization: authorization } : new Response('Unauthorized', { status: 401 });
  },
});

export default { fetch: (request: Request) => mcp.fetch(request) };
```

`example/` is this for the Cloudflare API, as a Worker: `pnpm example:generate`
downloads the latest `openapi.forge.json` release and generates its catalogue
(about 3,000 tools), and `pnpm example:dev` serves it at
`http://localhost:8787/mcp`. Connect with a Cloudflare API token as the bearer
token.

## How methods become tools

This is the contract between the document and the tools. The plugin
implements it in `src/tools.ts` and `src/schema.ts`.

**Which methods.** Every method that isn't deprecated. Hidden methods
(`x-forge-hidden`) are included: hiding keeps a method out of listings such
as a CLI's help but leaves it callable, and a client can only call the tools
`tools/list` returns. A method is skipped, with the reason in the catalogue's
`skipped`, when:

- its request body is required and isn't JSON;
- two of its arguments would have the same name;
- its tool name is over 128 characters, or another method already has it.

**Name.** The method's group path and name in snake case, joined by `_`:
method `create` in group `dns › records` is `dns_records_create`.

**Title and description.** The title is the summary. The description is the
description (or the summary), followed by the availability when it isn't
generally available, and by the `x-forge-require-confirmation` sentence,
introduced as "Confirm with the user before calling this tool."

**Arguments.**

- Path, query and header parameters are top-level arguments, named by the
  parameter's name in snake case (`If-Match` is `if_match`). A name two
  locations share is prefixed with its location, as in `header_name`.
- A JSON body is one argument, `body`, shaped as the API takes it: nested,
  not flattened into the parameters. It is `request_body` if a parameter is
  named `body`.
- A path parameter is always required; others are required when the
  document says so.

**Input schema.** JSON Schema 2020-12. Each model is a `$ref` into the
tool's own `$defs`, which hold every model the tool reaches and no others, so
recursive models work and each schema stands alone. Read-only fields, which
the server sets, are left out. Descriptions, defaults, enums, array bounds and
deprecation are kept. forge's types don't carry string patterns, lengths or
numeric bounds; the API validates those.

**Annotations.** From the HTTP method:

|                          | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
| ------------------------ | -------------- | ----------------- | ---------------- |
| `GET`, `HEAD`, `OPTIONS` | true           | false             | true             |
| `PUT`                    | false          | true              | true             |
| `DELETE`                 | false          | true              | true             |
| `POST`, `PATCH`          | false          | false             | false            |

A method that needs confirmation is never read-only, and always destructive.
`openWorldHint` is always true. The hints describe the method; they authorize
nothing.

**Calls.** Path parameters are substituted and percent-encoded. Query
parameters use OpenAPI's `form` style: `a=1&a=2` when exploded, `a=1,2` when
not, and an exploded object's members as parameters of their own. The `body`
argument is sent as JSON with the body's media type. Before sending, the
runtime checks only that required arguments are present; the API validates
values. A non-2xx response is a tool result with `isError: true`, not a
protocol error, so the model sees what the API said.

## The catalogue

`src/catalogue.ts` is its type. `format` is `forge-mcp/1`; a server refuses a
catalogue in a format it doesn't know, so a catalogue written by a newer
plugin can't be half-served.

```json
{
  "format": "forge-mcp/1",
  "api": { "version": "4.0.0", "baseUrl": "https://api.cloudflare.com/client/v4" },
  "tools": [
    {
      "name": "dns_records_create",
      "title": "Create DNS Record",
      "description": "Create a new DNS record for a zone. …",
      "inputSchema": { "type": "object", "properties": { "zone_id": { "type": "string" }, "body": { "$ref": "#/$defs/…" } }, "required": ["zone_id", "body"], "$defs": { … } },
      "annotations": { "title": "Create DNS Record", "readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true },
      "request": {
        "method": "POST",
        "path": "/zones/{zone_id}/dns_records",
        "params": [{ "key": "zone_id", "name": "zone_id", "in": "path" }],
        "body": { "key": "body", "mediaType": "application/json" }
      }
    }
  ],
  "skipped": [{ "method": "PUT", "path": "/accounts/{account_id}/workers/scripts/{script_name}", "reason": "the request body is not JSON (multipart/form-data)" }]
}
```

## Your own plugin

The default plugin, `plugin/forge-mcp.ts`, uses no options. A plugin can't
take options at run time, so to choose methods, rename tools or change them,
write an entry module of your own and build it:

```ts
import { definePlugin } from '@cloudflare/forge/plugin';
import { catalogueFile } from '@cloudflare/forge-mcp/plugin';

export const { generate, generateGroup } = definePlugin({
  generate: (forge) => [
    catalogueFile(forge, {
      include: (method) => !method.deprecated && method.group.path[0]?.snake() === 'dns',
      transform: (tool) => ({ ...tool, description: tool.description.slice(0, 1024) }),
    }),
  ],
});
```

```sh
forge-plugin build plugin.ts -o plugin.wasm
```

## Serving

`createForgeMcpHandler` answers each request with a fresh, stateless MCP
server: the SDK's `createMcpHandler`, which serves MCP 2026-07-28 and
stateless 2025 clients over Streamable HTTP. To serve a catalogue on a server
you already have, alongside other tools, use `serveCatalogue(server,
catalogue, call)` with `callTool` or your own call.

The tools are installed as low-level `tools/list` and `tools/call` handlers,
not registered one by one: for thousands of tools, per-tool registration
costs more than the request. The `tools/list` payload is built once per
catalogue.

A large API's `tools/list` is large: about 6 MB for the Cloudflare API. Use
`include` to serve a part of it.
