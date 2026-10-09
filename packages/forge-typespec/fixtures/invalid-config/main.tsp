import "@typespec/http";

using Http;

/** A service whose tspconfig.yaml has a key the config schema does not define. */
@service(#{ title: "Catalog" })
namespace Catalog;

/** Products. */
@route("/products")
interface Products {
  /** List products. */
  @get list(): string[];
}
