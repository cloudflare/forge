import "@typespec/http";
import "@typespec/versioning";

using Http;
using Versioning;

/** Invoices, with an operation renamed and one added in v2. */
@service(#{ title: "Billing" })
@versioned(Versions)
namespace Billing {
  enum Versions {
    v1,
    v2,
  }

  /** Invoices. */
  @route("/invoices")
  interface Invoices {
    /** List invoices. */
    @renamedFrom(Versions.v2, "all")
    @get
    list(): string[];

    /** Cancel an invoice. */
    @added(Versions.v2)
    @route("/{id}/cancel")
    @post
    cancel(@path id: string): void;
  }
}

/** People, in an unversioned service. */
@service(#{ title: "Identity" })
namespace Identity {
  /** Users. */
  @route("/users")
  interface Users {
    /** List users. */
    @get list(): User[];
  }

  /** Groups, declared after users but sorted before them in the document. */
  @route("/groups")
  interface Groups {
    /** List groups. */
    @get list(): Group[];
  }

  model User {
    name: string;
  }

  model Group {
    name: string;
  }
}
