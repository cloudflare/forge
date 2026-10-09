import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

/** A service that declares Forge's metadata with `@extension`. */
@service(#{ title: "Accounts" })
namespace Accounts;

model Account {
  id: string;
}

/** Accounts. */
@route("/accounts")
interface Accounts {
  /** List accounts. */
  @extension("x-fern-sdk-group-name", "accounts")
  @extension("x-fern-sdk-method-name", "list")
  @get
  list(): Account[];
}
