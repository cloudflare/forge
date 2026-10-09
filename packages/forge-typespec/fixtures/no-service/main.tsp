import "@typespec/http";

using Http;

/** Check the service responds. */
@route("/ping")
@get
op ping(): void;
