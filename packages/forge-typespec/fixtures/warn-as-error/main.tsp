import "@typespec/http";

using Http;

/** A service that uses a deprecated model, which the compiler warns about. */
@service(#{ title: "Legacy" })
namespace Legacy;

#deprecated "Use Item instead."
model OldItem {
  name: string;
}

/** Items. */
@route("/items")
interface Items {
  /** List items. */
  @get list(): OldItem[];
}
