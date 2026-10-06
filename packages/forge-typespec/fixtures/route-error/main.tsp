import "@typespec/http";

using Http;

/** A route with a query string, which the OpenAPI emitter, not the checker, rejects. */
@service(#{ title: "Items" })
namespace Items;

/** List items. */
@route("/items?filter=x")
@get
op list(): string[];
