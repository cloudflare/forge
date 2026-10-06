import "@typespec/http";

using Http;

/** Two operations sharing a route, which the OpenAPI emitter merges, changing their parameters as it goes. */
@service(#{ title: "Shared" })
namespace Shared;

model FilterRequired {
  @query filter: string;
}

model FilterOptional {
  @query filter?: string;
}

/** List items of kind a. */
@sharedRoute
@route("/items")
@get
op listA(...FilterRequired, @query kind: "a"): void;

/** List items of kind b. */
@sharedRoute
@route("/items")
@get
op listB(...FilterOptional, @query kind: "b"): void;
