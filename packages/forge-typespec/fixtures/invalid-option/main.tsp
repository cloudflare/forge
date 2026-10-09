import "@typespec/http";

using Http;

/** A service whose tspconfig.yaml sets an option the OpenAPI emitter does not define. */
@service(#{ title: "Catalog" })
namespace Catalog;

/** Products. */
@route("/products")
interface Products {
  /** List products. */
  @get list(): string[];
}
