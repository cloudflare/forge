import "@typespec/http";

using Http;

/** The same route, with the emitter's warning suppressed. */
@service(#{ title: "Blobs" })
namespace Blobs;

/** Read a blob. */
#suppress "@typespec/openapi3/path-reserved-expansion" "The path is a reserved expansion on purpose."
@route("/blobs/{+path}")
@get
op read(@path path: string): bytes;
