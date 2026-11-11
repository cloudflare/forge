# Building a gatekeeper on these files

Forge generated this directory from the provider's OpenAPI document and a config that lists the operations the gatekeeper covers. It is the provider's HTTP API as typed clients. Everything else about the gatekeeper is yours to write, with a person reviewing.

Follow the `write-gatekeeper` skill. This guide says only what these files change in its steps. Where the two disagree about the gatekeeper's contract, approvals, observers or simulation, the skill is right.

Do not edit the files here. They are replaced the next time Forge runs. To cover another operation, add it to the config and run Forge again.

## What is here

- `read.ts`, which exports `createReadClient`, and `write.ts`, which exports `createWriteClient`.
- `index.ts` and a directory for each group: the request and response types of every operation, and the types of the runtime.
- `client.ts` in each directory, which the files above import. Do not import it.
- `_/`: the runtime the clients import. It has no dependencies.
- `operations.json`: each operation with its `operationId`, the method that calls it, whether it reads or writes, and how it pages.
- `WORKSHEET.md`: the decisions each operation needs from you.
- `GUIDE.md`: this file.

## What these files change in the skill's steps

**Step 1, understand the service.** The operations are already chosen and sorted into reads and writes. Read `WORKSHEET.md` for the list. If the gatekeeper needs an operation that is not there, stop and say so; do not write a `fetch` call for it.

**Steps 2 and 3, design the session types and stop for review.** Nothing changes. `types.d.ts` is designed for the agent that will use it, above the provider's API, and a person approves it before you implement. The generated types never appear in it: it must be self-contained, and the provider's shapes are not what an agent should see. Copy `WORKSHEET.md` out of this directory, next to `types.d.ts`, and fill it in as you design. Present it with the contract. The copy here is replaced on every run, so a later run shows new operations as a diff against yours.

**Step 4, implement.** There is no `<name>-api.ts` to write. Write a provider, create the clients on it, and write the session classes on the clients. The rules are below.

**Phase 2, actions.** The client of writes is what an action's apply handler calls. Nothing else may hold it.

## The provider

A provider sends one request and returns the status, the headers and the body as text. It is the only code that has the URL of the API and a credential.

```ts
import { readTextCapped } from '@gadgets/gatekeeper-kit/response-body';
import type { Failure, Provider } from './api/index.js';
import { createReadClient } from './api/read.js';

function provider(token: string): Provider {
  return {
    async send(request) {
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${token}`);
      const url = new URL(`https://api.example.com${request.path}`);
      url.search = request.query.toString();
      const timeout = AbortSignal.timeout(30_000);
      const response = await fetch(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
      return { status: response.status, headers: response.headers, text: await readTextCapped(response) };
    },
  };
}
```

- Make a provider for each use of a credential, inside `CredentialSource.run()`, with the credential it was given. Do not keep one across calls.
- Do not follow redirects with the credential attached. Return the redirect and let the call fail, unless the provider documents the redirect and you check where it goes.
- Limit the size of the body. The provider is the only place it is read.
- A request has `operationId`, `kind`, `route` and `params` next to its `path` and `query`. Use them to rewrite a path, such as to address a resource by an id you pinned, and not a match on the encoded path.
- A provider that is only ever given to the client of reads should refuse a request whose `kind` is `write`, and one whose `method` is not `GET`, `HEAD` or a `POST` you know. The `kind` is what the config says, so check the method too.
- The clients refuse a path parameter that is `.` or `..`, which would make the path another operation's. Every other value is percent-encoded. Still check an identifier a caller gives against the shape the provider documents before you send it.

## Errors

A response that is not 2XX is thrown. Give the clients an `error` function that returns the gatekeeper's own error class. It gets the status, the headers and the decoded body, and it is where you decide what kind of failure this was:

```ts
const reads = createReadClient({
  provider: provider(token),
  error: (failure) => new ExampleApiError(failure.operationId, failure.status, reasonOf(failure)),
});

// What the failure means, from what the provider documents.
function reasonOf(failure: Failure): 'credential' | 'denied' | 'missing' | 'rate-limit' | 'other' {
  if (failure.status === 429 || failure.headers.get('retry-after') !== null) return 'rate-limit';
  if (failure.status === 401) return 'credential';
  if (failure.status === 403) return 'denied';
  if (failure.status === 404) return 'missing';
  return 'other';
}
```

- Keep a numeric `status` on the error, and the reason. A status is not enough: many providers answer a rate limit with a 403, and some hide a resource the caller cannot see behind a 404. Read the headers and `details` to tell them apart, as the provider documents.
- When you check whether an observer has access, only a definite denial is "no". An expired credential, a rate limit, an outage and a `DecodeError` are indeterminate, and are thrown again. The kit's `isNoAccessError` and `probeAccess` take any 401, 403 or 404 for a denial, so do not use them alone as that check.
- Classify only a rejected credential as an auth error for `CredentialSource`. A 403 or 404 for one resource is not one.
- Do not put `failure.message` or `failure.details` in an error an agent can read, or in a log. They are what the provider sent, and can hold another user's data.
- Without an `error` function the clients throw `ApiError`, whose message has the first 200 characters of the provider's message. That is for tests and scripts.
- A 2XX response whose body is not JSON, or is empty where the operation has one, is thrown as a `DecodeError`, which has no `status`. The clients do not check that a body has the fields its type says. Check what you depend on when you map it.
- The kit's `readTextCapped` throws an error of its own, without a status, for a body over its limit, which is 1 MiB unless you give one. Choose the limit from the largest page you ask for, and decide what that error means.

## Reads

Session code gets the client of reads and nothing else. It imports `./api/read.js`, and never `./api/write.js`.

- Run each call through `CredentialSource.run()` with `replayable: true`. A read can be sent twice. For a read that is sent with `POST`, be sure of that first.
- Fix what the binding fixes. A session bound to one repository passes its own owner and name, or the id it pinned, and never takes them from the caller.
- A method returns `{ data, status, headers }`. Map `data` to the type in `types.d.ts` with a function you write. Do not return it as it is, and do not spread it: the provider can add a field tomorrow.
- An `int64` of the provider is a `bigint` in the generated types. `JSON.stringify` throws on one, and Cap'n Web, storage and action payloads may not take one. Turn it into a string, or a number when it is known to fit, as you map.
- Every session method that returns information to its caller awaits the helper that authorizes its observation, with `subresources`, before it returns. That is once for each session method, after its provider calls, and not once for each call of a client. A read that only prepares an action is not an observation.
- The clients know nothing of pending actions. A session method reads through the client, then applies the simulation.

**Conditional operations.** A method whose operation is marked conditional returns either a result or `{ notModified: true }`. Send `if-none-match` in the options of the call with the `ETag` you stored, and answer from your own cache on `notModified`. Store the `ETag` with the mapped value, and partition the cache by credential. Use this only where the provider counts a 304 for less than a full read; otherwise a `KvTtlCache` with a TTL is enough.

**Paged operations.** `operations.json` says how an operation pages. For `link-header`, the next page is the `rel="next"` URL of the `link` header of a result. Take its query parameters and send them as the `query` of the options of the next call, which replace those of the request. Do not count pages yourself: the link can carry a cursor the request type does not have. When it has a `field`, the items are in that field of `data`, and otherwise `data` is the array. Wrap this in one of the kit's cursors, and authorize every page it hands out.

## Writes

- Import `./api/write.js` in one module, the one that has the apply handlers, and nowhere else. Add a lint rule that says so if the repository has a way to.
- Create the client of writes only inside an action's apply handler. A session method that changes something stages an action with the kit's `defineActions` and `stageAction` and returns.
- The payload of an action is the type you designed, not the provider's request type. The apply handler builds the request from the payload. A request type can change when the provider's document does, and a stored payload cannot.
- One operation can serve several kinds of action, and one action can call several operations. The worksheet lists operations, and the action table is yours.
- A write is not replayable. Do not pass `replayable: true`, and decide what a timeout means: after the provider was reached, the outcome is unknown. Throw the kit's `ActionOutcomeUnknownError` for that, on a definition with `claimBeforeApply`, and `ActionApplyError` only when the effect is known to be absent.
- A read made to build an action's description goes through the client of reads, and is not an observation.

## What is not here

Forge leaves out an operation whose request or response is not JSON, such as a log, a diff or a file download. It also cannot generate what the provider only offers outside its OpenAPI document, such as GraphQL or git. Write those by hand, in a file of their own, behind the same provider where the credential and the URL are the same.

## Report what was missing

These files are a first version, and what you had to work around is the most useful thing you can report. Keep a list as you work, in `GAPS.md` next to your worksheet:

- An operation you needed that the config could not express or Forge could not generate.
- A type that was wrong against the real API: a field that is missing, null when the type says it is not, or of another type.
- Anything you wrote by hand that looks the same for every operation.
- Anything in this guide that was wrong, unclear or missing.
