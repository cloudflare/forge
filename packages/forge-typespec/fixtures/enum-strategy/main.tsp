import "@typespec/http";

using Http;

/** A service whose config asks for an enum strategy that OpenAPI 3.0 does not support. */
@service(#{ title: "Colors" })
namespace Colors;

/** Read the color. */
@route("/color")
@get
op read(): "red" | "blue";
