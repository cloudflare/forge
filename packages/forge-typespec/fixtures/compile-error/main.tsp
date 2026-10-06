import "@typespec/http";

using Http;

/** A service that refers to a type it never declares. */
@service(#{ title: "Broken" })
namespace Broken;

model Account {
  balance: Money;
}

/** Accounts. */
@route("/accounts")
interface Accounts {
  /** Read an account. */
  @get read(): Account;
}
