import "@typespec/http";

using Http;

/** A route whose reserved expansion the OpenAPI emitter, not the checker, warns about. */
@service(#{ title: "Blobs" })
namespace Blobs;

/** Read a blob. */
@route("/blobs/{+path}")
@get
op read(@path path: string): bytes;
