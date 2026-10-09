import "@typespec/http";

using Http;

/** A service that type-checks, but whose enum the OpenAPI emitter cannot represent as a schema. */
@service(#{ title: "Mixed" })
namespace Mixed;

enum Value {
  text: "x",
  number: 1,
}

/** Values. */
@route("/values")
interface Values {
  /** Read a value. */
  @get read(): { value: Value };
}
