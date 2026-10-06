import "@typespec/http";

using Http;

/** A service declared out of the order `tsp compile` writes its paths, schemas and parameters in. */
@service(#{ title: "Workshop" })
namespace Workshop;

model Widget {
  id: string;
}

model Gadget {
  id: string;
}

model PageQuery {
  @query limit?: int32;
  @query cursor?: string;
}

/** Widgets. */
@route("/widgets")
interface Widgets {
  /** List widgets. */
  @get list(...PageQuery): Widget[];
}

/** Gadgets. */
@route("/gadgets")
interface Gadgets {
  /** List gadgets. */
  @get list(...PageQuery): Gadget[];
}
