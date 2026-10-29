# Cap'n Web server

This document proposes a Forge plugin that generates a [Cap'n Web](https://github.com/cloudflare/capnweb) server from an OpenAPI spec. The server exposes the API's groups and methods as RPC targets. The server then sends each method call to the HTTP API.

The server is a thin layer over the TypeScript SDK. It doesn't build requests, convert fields or declare types. The SDK does all of that, and the server forwards each call to it.

## Usage

The following code snippet shows a worker using the generated code to serve the capnweb server for the entire API:

```ts title="worker running the generated capnweb server"
import { createClient } from '#sdk'; // Generate TS SDK
import { Api } from './gen/index'; // Generated capnweb server
import { newWorkersRpcResponse } from 'capnweb';

export default {
  fetch(request: Request, env: Env) {
    const client = createClient({ token: env.CLOUDFLARE_API_TOKEN });
    return newWorkersRpcResponse(request, new Api(client));
  },
};
```

On the other side, a Cap'n Web client uses `Api` as the type of its stub:

```ts
import { newWebSocketRpcSession } from 'capnweb';
import type { Api } from '@cloudflare/sdk-capnweb';

using api = newWebSocketRpcSession<Api>('wss://example.com/api');
const zone = await api.zones.get({ zoneId });
```

## Modules

The server has the same modules as the SDK, at the same paths:

| Import path                                      | SDK module it wraps                      |
| ------------------------------------------------ | ---------------------------------------- |
| `@cloudflare/sdk-capnweb`                        | `@cloudflare/sdk`                        |
| `@cloudflare/sdk-capnweb/zones`                  | `@cloudflare/sdk/zones`                  |
| `@cloudflare/sdk-capnweb/logs/control/retention` | `@cloudflare/sdk/logs/control/retention` |

Every module exports its server as `Api`, as every SDK module exports `createClient` and `Client` under the same names. Any `Api` can be the main object of a session, wrapping a client of its SDK module:

```ts
import { createClient } from '@cloudflare/sdk/zones';
import { Api } from '@cloudflare/sdk-capnweb/zones';

newWorkersRpcResponse(request, new Api(createClient({ token })));
```

A module's `Api` is only needed to serve part of the API. The root `Api` already serves every module with one client: each subgroup getter passes down the SDK client of its subgroup, so a caller reaches any module from the root, as in `api.zones.dns.records.list()`.

### Types

A module exports only its `Api`.

The server doesn't declare a type of its own for any request, response or model. Each method of `Api` is typed with the SDK's `<Method>Request` and `<Method>Response`, so a stub typed as `Api` infers every request and response from it.

## Servers

A server is an `RpcTarget` that holds the SDK client of its group:

```ts
import { RpcTarget } from 'capnweb';
import type { Client, GetRequest, GetResponse, ListRequest, ListResponse } from '#sdk/zones';
import { type Options, requestOptions } from '../options.js';
import { Api as DnsApi } from './dns/server.js';

export class Api extends RpcTarget {
  readonly #client: Client;

  constructor(client: Client) {
    super();
    this.#client = client;
  }

  get(request: GetRequest, options?: Options): Promise<GetResponse> {
    return this.#client.get(request, requestOptions(options));
  }

  list(request?: ListRequest, options?: Options): Promise<ListResponse> {
    return this.#client.list(request, requestOptions(options));
  }

  get dns(): DnsApi {
    return new DnsApi(this.#client.dns);
  }
}
```

- **Methods.** Every method of the SDK client is a method of the server with the same name. It takes the SDK's request, optional when it's optional in the SDK, and returns the SDK's response.
- **Subgroups.** Every subgroup is a getter that returns the subgroup's server, wrapping the SDK client of the subgroup. Cap'n Web pipelines property access, so `api.zones.dns.records.list()` is one round trip.
- **Left-out methods.** A method the SDK leaves out, such as a non-JSON operation, is left out of the server too.
- **Docs.** Each method has the same JSDoc as the SDK method, generated from the description of the operation in the spec. An editor shows the same docs for `api.zones.get` as for `cf.zones.get`, and the request and response fields keep the JSDoc of the SDK's types.

The server keeps every name from the SDK, so the SDK's docs and types also describe the server.

### A method and a subgroup with the same name

The SDK lets a property be both a method and a subgroup, such as `cf.projects.archive({ ... })` next to `cf.projects.archive.restore({ ... })`. The server doesn't support this: a method and a subgroup with the same name in one group is a generation error.

Cap'n Web can serve such a property at runtime, as a function that carries the subgroup's members, but its types drop those members, so a client typed as `Api` can't call `api.projects.archive.restore`. The Cloudflare spec has no such conflicts.

### Reserved names

Cap'n Web doesn't deliver some names to a target: the properties of `Object.prototype`, such as `constructor` and `toString`, and the members of its stubs, `then`, `catch`, `finally`, `map`, `dup` and `onRpcBroken`. A method or group with one of these names can't be called over Cap'n Web, so Forge reports it as a generation error that names the group and the member. As with conflicts in the SDK, the fix belongs in the spec.

## Options

Each method takes an optional second argument, like the SDK's `RequestOptions`, but limited to what Cap'n Web can carry:

```ts
interface Options {
  headers?: Headers | Record<string, string> | [string, string][];
  query?: Record<string, string> | [string, string][];
}
```

- `headers` replace headers of the same name set on the SDK client, as in the SDK.
- `query` is appended after the client's query. Cap'n Web doesn't carry a `URLSearchParams`, so it's a record, or a list of pairs to repeat a key in order. The server turns it into a `URLSearchParams` for the SDK.

## Errors

The server doesn't catch anything. Cap'n Web sends whatever the SDK throws to the caller: an `ApiError` for an error response, and the original error for a network failure. Cap'n Web carries an error's message and its own enumerable properties, so a caller gets the `status` and `details` of an `ApiError`. A property whose value Cap'n Web can't serialize is dropped, and the rest of the error still arrives.

The caller receives a plain `Error`, not an `ApiError`. Cap'n Web only rebuilds the built-in error classes, such as `TypeError`, so a caller checks `status` instead of using `instanceof`:

```ts
try {
  await api.zones.get({ zoneId });
} catch (e) {
  if (e instanceof Error && 'status' in e && e.status === 404) {
    // ...
  }
}
```

We can improve on this by exporting an `ApiError` type with custom instanceof logic as a followup.

## Open questions

- **Types Cap'n Web can't carry.** The SDK uses `Temporal.Instant` and `Temporal.PlainDate` for dates, which Cap'n Web doesn't serialize today. We will depend on a branch with support for them.
- **Pagination.** Iterating every page of a list method over RPC is left for a follow-up. Mainly because it is not handled by Forge today.
- **Group accessors over HTTP batch.** Over HTTP, it stops working after the first `await`, because the batch ends the session:

  ```ts
  const zones = api.zones;
  await zones.list();
  await zones.get({ zoneId }); // HTTP batch: throws "Batch RPC request ended."
  ```

  Group accessors are idempotent, so a client could safely replay `zones` in a new batch, but Cap'n Web has no way to mark them as idempotent. How should they be marked?

## Dependencies

The generated server imports the SDK from `#sdk`. This allows for both cases of either splitting the SDK as a separate package or bundling it together.
