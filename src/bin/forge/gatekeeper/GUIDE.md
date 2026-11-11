# Building a gatekeeper on these files

Forge generated this directory from the provider's OpenAPI document and a config that lists the operations the gatekeeper covers. It is the provider's HTTP API as typed clients. Everything else about the gatekeeper is yours to write, with a person reviewing.

Follow the `write-gatekeeper` skill. This guide says only what these files change in its steps. Where the two disagree about the gatekeeper's contract, approvals, observers or simulation, the skill is right.

Do not edit the files here. They are replaced the next time Forge runs. To cover another operation, add it to the config and run Forge again.

## Before these files: the scout and the config

Forge is run twice. The first run is the scout, which needs no config and reads the whole document:

```
forge <document> --target gatekeeper --scout --out <directory>
```

It writes `CATALOG.md` and `catalog.json`: the servers, the security schemes, every operation with its parameters, scopes, statuses and a guess at how it pages, what in the document will limit the clients, and the questions the document leaves open. Read `CATALOG.md` in place of the document. `catalog.json` has the parameters and the body fields of every operation, each with its type in a few words. Give `--config` as well and it also asks the questions about the operations of the config, and writes out in `CATALOG.md` what each of them takes.

Then write the config, a JSON file, and run Forge with `--config` and without `--scout` to generate these files. Its keys:

- `operations`: the operations to cover, by `operationId`. Each has a `name`, and can have:
  - `group`: the group of the method, with dots between groups.
  - `kind`: `"read"` for a `POST` that changes nothing.
  - `conditional`: `true` for a read that can be asked for only if it changed.
  - `pagination`: how it pages. `style` is `link-header`, `offset` or `cursor`. `items` is the property of the response that has the items, when the response is not the array itself. `offset`, `limit` and `cursor` name request fields. `next`, `more` and `last` name properties of the response, and can be paths with dots. With `link-header`, `more` is the parameter of the `rel="next"` link that is `true` when there is another page.
  - `parameters`: a schema for a parameter, by name, in place of the document's, where the document is wrong.
  - `omitParameters`: parameters to leave out.
  - `failure`: `property` and `equals`, for an API that answers a failure with a 2XX.
- `security`: the security scheme a connection uses, by its name in the document, when the document has several. The generated provider sends its credential.
- `bound`: the path parameters a connection is bound to, as an array of names. No request type has a field for one: the client takes them once, as `bound`, when it is created.
- `int64`: `"number"` when the API's `int64`s fit a number. They are `bigint` otherwise.
- `omitParameters` and `failure`, for every operation.
- `properties`: a name for a property whose wire name makes none, such as `+1`, which is otherwise an error.

An example:

```json
{
  "bound": ["organization_id_or_slug"],
  "int64": "number",
  "operations": {
    "listOrganizationIssues": {
      "group": "issues",
      "name": "list",
      "pagination": { "style": "link-header", "more": "results" }
    },
    "getOrganizationIssueEvent": {
      "group": "issues.events",
      "name": "get",
      "parameters": { "event_id": { "type": "string" } }
    },
    "updateOrganizationIssue": { "group": "issues", "name": "update" }
  }
}
```

An operation pages only when the config gives it a `pagination`. One that the scout guesses pages, and has none in the config, gets no pager: Forge warns of each when it generates.

A guess of the scout is not a fact. Check how an operation pages against the provider's documentation before the config says it. The questions of the scout are in `WORKSHEET.md` too, under "The provider": answer them with the person who reviews your work, before you design the contract.

## What is here

- `read.ts`, which exports `createReadClient` and the type `ReadClient`, and `write.ts`, which exports `createWriteClient` and the type `WriteClient`.
- `index.ts`, which has the types of the runtime, and a directory for each group, whose `index.ts` has the request and response types of its operations. Import those from `./api/<group>/index.js`. Types of the same name in two groups, such as `GetResponse`, need an alias. A type from a document with no shared schemas is written in place and can be one very long line: read it through the compiler or the editor, not by eye. Every field has the name the provider gives it, such as `created_at` or `team_ids[]`, so the types match the provider's documentation and what its webhooks send.
- `client.ts` in each directory, which the files above import. Do not import it.
- `_/`: the runtime the clients import. It has no dependencies.
- `provider.ts`, which exports `createProvider`, for the server and the security scheme of the document, and what classifies a failure: `reasonOf`, `reasonMessage` and `retryAfterSeconds`.
- `pages.ts`, when the config gives an operation a `pagination`: a pager for each such operation, named after its groups and its method, as `issuesList` is for `reads.issues.list`.
- `operations.json`: the servers and security schemes of the API, and each operation with its `operationId`, the method that calls it, whether it reads or writes, how it pages, the path parameters the binding fixes (`bound`), what it asks of a credential (`security`), the errors it declares (`errors`), and what of its response has no type to rely on (`trust`).
- `WORKSHEET.md`: the decisions each operation needs from you.
- `GUIDE.md`: this file.

## What these files change in the skill's steps

**Step 1, understand the service.** The operations of the config are sorted into reads and writes. Read `WORKSHEET.md` for the list. Design turns up operations the config does not have: find each in `CATALOG.md`, add it to the config, run Forge again, and say in your report which you added and why. Do not write a `fetch` call for an operation the document has. `operations.json` has the scopes each operation needs, in `security`: a requirement lists scopes without saying whether all or any of them are needed, so check that against the provider's documentation before you ask for them.

**Steps 2 and 3, design the session types and stop for review.** Nothing changes. `types.d.ts` is designed for the agent that will use it, above the provider's API, and a person approves it before you implement. The generated types never appear in it: it must be self-contained, and the provider's shapes are not what an agent should see. Copy `WORKSHEET.md` out of this directory, next to `types.d.ts`, and fill it in as you design. Present it with the contract. The copy here is replaced on every run, so a later run shows new operations as a diff against yours.

**Step 4, implement.** `<name>-api.ts` has no method for each endpoint any more. It keeps what is the gatekeeper's own: the error class, what the provider documents about its failures, and the adapter from a pager to the kit's cursor. Create the clients on the provider, and write the session classes on the clients. The rules are below.

**Phase 2, actions.** The client of writes is what an action's apply handler calls. Nothing else may hold it.

## The provider

A provider sends one request and returns the status, the headers and the body as text. It is the only code that has the URL of the API and a credential. `provider.ts` has `createProvider`, which makes one from what the document says: its server, and the security scheme a connection uses.

```ts
import { createProvider } from './api/provider.js';
import { createReadClient } from './api/read.js';

const reads = createReadClient({
  provider: createProvider({ token, server: { region } }),
  error: errorOf,
});
```

Read the `ProviderOptions` of your `provider.ts` for what it takes. It depends on the document:

- The URL is the server of the document. A variable of it, such as a region, is an option under `server`, and a value the document does not list is refused. `baseUrl` is an option that takes its place, for a region or a host the document does not list. Where the document names no server, or several, `baseUrl` is required.
- The credential is an option named for the scheme: `token`, `username` and `password`, or `apiKey`. Where the document has several schemes, name the one a connection uses as `security` in the config. Where it has none, or the scheme does not say what the API really takes, `authorize` is an option: a function that sets the header or the query parameter. An API key that a document declares as the whole `Authorization` header is sent as you give it, so give it with its prefix: the catalog has what the scheme says of itself, which can name one.

What it does for every request, which you do not write:

- It sets the credential after the headers of the call, so a call cannot replace it.
- It sets `accept` to `application/json` unless a call set one. Give `accept` for an API that versions by media type.
- It does not follow a redirect, which would carry the credential elsewhere. The redirect is thrown as a failure.
- It reads no more of a body than `maxResponseBytes`, which is 4 MiB unless you give one, and throws a `ResponseTooLargeError` past it. Choose the limit from the largest page you ask for.
- It gives up after `timeoutMs`, which is 30 seconds unless you give one. A request with no response is thrown as an `UnreachableError`. Neither error has a status. For a write, whether the change was made is then not known.
- It refuses a write unless `writes` is true. Give `writes: true` only to the provider of the client of writes.

Rules that are still yours:

- Make a provider for each use of a credential, inside `CredentialSource.run()`, with the credential it was given. Do not keep one across calls.
- The imports above end in `.js`. Leave the extension out where the repository imports that way.
- Write a provider of your own, on the `Provider` interface, only for what `createProvider` cannot do: a request to rewrite, or a redirect the provider documents and you check. A request has `operationId`, `kind`, `route` and `params` next to its `path` and `query`. Use them to rewrite a path, and not a match on the encoded path. Wrap the generated provider where you can, and keep its limits where you cannot.
- The clients refuse a path parameter that is `.` or `..`, which would make the path another operation's. Every other value is percent-encoded, so a path needs nothing from the kit's `pathSegment`. Still check an identifier a caller gives against the shape the provider documents before you send it.

## Requests

A request is one object: the path and query parameters of the operation, and the fields of its body next to them, or in `body` when the request type has that field. Every field has the provider's name. Write one that is not an identifier in quotes, as `{ 'team_ids[]': ids }`.

- An array in a query parameter is sent as the parameter repeated, `a=1&a=2`, or joined with commas where the document says so. A parameter whose name ends in `[]` takes an array, even where the document gives it the schema of one value.
- The types are what the provider's document says, and a document is often looser than the API, or wrong. A field the API always sends can be optional in its type, one that can be null can lack `null`, and a body can have another shape than its type. Do not assert a field with `!`: check it as you map, and throw when what you depend on is missing.
- When a request type cannot hold what the API takes, send a query parameter in the `query` of the options of the call, which replaces the parameter of that name, and cast a body in one place with a comment that says what the document has wrong. Report it in `GAPS.md`.
- A field of a body that its type does not have is sent as it is. A misspelled optional field is therefore sent too, and the compiler is what catches it: do not build a request as `Record<string, unknown>`.

## Errors

A response that is not 2XX is thrown. Give the clients an `error` function that returns the gatekeeper's own error class. It gets the status, the headers and the body, and it is where you decide what kind of failure this was. `details` is the body as it parsed when it is JSON, and as text when it is not:

```ts
import { reasonMessage, reasonOf, type Reason } from './api/provider.js';

function errorOf(failure: Failure): ExampleApiError {
  // What the provider documents that a status alone does not say.
  const reason: Reason = reasonOf(failure, { 404: 'denied' });
  return new ExampleApiError(failure.operationId, failure.status, reason, reasonMessage(reason, 'Example'));
}
```

`reasonOf` says what a status means by default: `credential` for a 401, `denied` for a 403, `missing` for a 404 or 410, `rate-limit` for a 429, `invalid` for a 400 or 422, `conflict` for a 409 or 412, `unavailable` for a 5XX, and `other`. It is a default and not a fact about the provider. Its second argument has what the provider documents otherwise, by status. `reasonMessage` is a message for a reason with nothing the provider sent in it. `retryAfterSeconds(failure.headers)` reads when a rate limit says to try again. The error class is yours, since the kit decides what it extends.

- Keep a numeric `status` on the error, and the reason. A status is not enough: many providers answer a rate limit with a 403, and some hide a resource the caller cannot see behind a 404. Where a rule by status cannot say it, read the headers and `details` before you call `reasonOf`, as the provider documents.
- When you check whether an observer has access, only a definite denial is "no". An expired credential, a rate limit, an outage and a `DecodeError` are indeterminate, and are thrown again. The kit's `isNoAccessError` and `probeAccess` take any 401, 403 or 404 for a denial, so do not use them alone as that check.
- Classify only a rejected credential as an auth error for `CredentialSource`. A 403 or 404 for one resource is not one.
- Do not put `failure.message` or `failure.details` in an error an agent can read, or in a log. They are what the provider sent, and can hold another user's data.
- Without an `error` function the clients throw `ApiError`, whose message has the first 200 characters of the provider's message. That is for tests and scripts.
- Some providers answer a failure with a 2XX and say so in the body. When the config names what says so, such a response is thrown like any other failure, with `source: 'body'` and its 2XX `status`. No status tells you what it means, so classify it from `details`, and do not let a check for `status >= 400` take it for a success.
- A 2XX response whose body is not JSON, or is empty where the operation has one, is thrown as a `DecodeError`, which has no `status`. The clients do not check that a body has the fields its type says. Check what you depend on when you map it.
- A write that answers a 2XX with no body, where the operation has one, is not thrown: `data` is `undefined`, which its type says. A `DecodeError` from a write still means that the provider answered a 2XX, so the change was made. Do not report it as an outcome that is unknown, or as a change that was not made.
- A `ResponseTooLargeError` and an `UnreachableError` come from the provider, not from the API, and have no status. Decide what each means: for a read, usually to try again or to ask for less.

## Reads

Session code gets the client of reads and nothing else. It imports `./api/read.js`, and never `./api/write.js`.

- Run each call through `CredentialSource.run()` with `replayable: true`. A read can be sent twice. For a read that is sent with `POST`, be sure of that first.
- Fix what the binding fixes. A session bound to one repository passes its own owner and name, or the id it pinned, and never takes them from the caller. A path parameter the config lists under `bound` is fixed for you: give it to `createReadClient` and `createWriteClient` as `bound: { <name>: <value> }`, from the binding and never from a caller. No request type has it, and a request that names it anyway is overruled. `operations.json` lists them for each operation as `bound`.
- A method returns `{ data, status, headers }`. Map `data` to the type in `types.d.ts` with a function you write. Do not return it as it is, and do not spread it: the provider can add a field tomorrow.
- `operations.json` lists under `trust` the parts of a response the document gives no type (`untyped`), and the objects none of whose fields it requires (`allOptional`). Those are where a type says the least, and the worksheet asks what you check of each.
- When `operations.json` marks an operation `untyped`, the provider's document gives its response no type. `data` is then what the provider sent, with no check at all. Check every field you read as you map it.
- An `int64` of the provider is a `bigint` in the generated types, unless the config makes it a number. `JSON.stringify` throws on one, and Cap'n Web, storage and action payloads may not take one. Turn it into a string, or a number when it is known to fit, as you map.
- Every session method that returns information to its caller awaits the helper that authorizes its observation, with `subresources`, before it returns. That is once for each session method, after its provider calls, and not once for each call of a client. A read that only prepares an action is not an observation.
- The clients know nothing of pending actions. A session method reads through the client, then applies the simulation.

**Conditional operations.** A method whose operation is marked conditional returns either a result or `{ notModified: true }`. Send `if-none-match` in the options of the call with the `ETag` you stored, and answer from your own cache on `notModified`. Store the `ETag` with the mapped value, and partition the cache by credential. Use this only where the provider counts a 304 for less than a full read; otherwise a `KvTtlCache` with a TTL is enough.

**Paged operations.** `operations.json` says how an operation pages. When its `pagination` has `items`, the items are in that field of `data`, and otherwise `data` is the array. Wrap either style in one of the kit's cursors, and authorize every page it hands out.

`pages.ts` has a pager for each paged operation. It reads the items of a result and what names the next page, and builds the request for that page, so do not write either by hand:

```ts
import * as pages from './api/pages.js';

// `next` is undefined for the first page.
const page = await pages.issuesList.fetch(reads, first, next);
// page.items are typed. page.next is undefined on the last page. page.result has the status and headers.
```

`fetch` gets one page. It is `resume`, the call of the client, then `page`, which a pager also has for a call you make yourself:

```ts
const { request, options } = pages.issuesList.resume(first, next);
const result = await reads.issues.list(request, options);
const page = pages.issuesList.page(result, request);
```

For a conditional operation, `fetch` can return `{ notModified: true }` in place of a page.

`next` is JSON: the query of the `rel="next"` link, an offset, or the provider's cursor. Put it in the kit's cursor. A cursor that takes a string token, as `TokenCursor` does, gets it as `JSON.stringify(next)`, parsed and checked for its shape on the way back. What a caller gives back is the caller's input, so seal it or check it before you pass it to `resume`: a `next` of a link is sent as query parameters of the request, over those of the same name. A pager leaves out of `next` an API key that the document says is sent in the query, since an API can write it back in the link. The pager decides nothing else: the largest offset to allow, and how many pages one call may read, are yours.

What the pagers go by, for each style:

- `link-header`: the next page is the `rel="next"` URL of the `link` header of a result. Take its query parameters and send them as the `query` of the options of the next call. Each replaces the parameter of the request that has its name, and the other parameters of the request are still sent. Do not count pages yourself: the link can carry a cursor the request type does not have. Some APIs send that link with the last page too. The pagination then has `more`, the parameter of the link that is `true` when there is another page, as in `<url>; rel="next"; results="false"`. Without it, a page with no `rel="next"` link is the last. The pager of the operation reads the header for you.
- `offset`: a call asks for a page with the request fields that `offset` and `limit` name. A page shorter than the limit is not taken for the last, since an API can give fewer items than a call asks for. Check what the provider documents as the largest offset, and stop there.
- `cursor`: a call asks for the next page with the request field that `cursor` names, set to what `next` names in the `data` of the page before. `next` can be a path, such as `response_metadata.next_cursor`. A cursor is the provider's: do not hand it to a caller as it is, since a caller could send back another.

For `offset` and `cursor`, `more` names the field of `data` that is true when there is another page, and `last` the one that is true when the page is the last. Without either, a page with no items, or with no cursor, is the last, which costs one more call: name `more` or `last` where the provider has one.

**Headers.** A request type has no field for a header the operation declares, and the clients do not send one. The only header they set is `content-type`, for a request with a body. `operations.json` lists them in `headers`, with whether each is required and its default. Set one that is the same for every request, such as a versioned `accept`, in the provider. Set one that differs by call in the `headers` of the options of the call. A required header that nothing sets fails at the provider, not at compile time.

## Writes

- Import `./api/write.js` in one module, the one that has the apply handlers, and nowhere else. Add a lint rule that says so if the repository has a way to.
- Create the client of writes only for an action's apply handler. The module of the apply handlers exports the function that creates it from a provider, and what runs a handler calls that function inside `CredentialSource.run()`, with the credential it was given. A session method that changes something stages an action with the kit's `defineActions` and `stageAction` and returns.
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
