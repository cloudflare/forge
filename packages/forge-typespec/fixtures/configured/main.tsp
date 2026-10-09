import "@typespec/http";

using Http;

/** A service whose project config changes the published document. */
@service(#{ title: "Catalog" })
namespace Catalog;

model Product {
  name: string;
}

/** Products. */
@route("/products")
interface Products {
  /** List products. */
  @get list(): Product[];
}
