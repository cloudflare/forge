import "@typespec/http";
import "@typespec/openapi";

using Http;
using OpenAPI;

/**
 * A lending library that uses every part of an OpenAPI document Forge reads. The same document is written in
 * JSON (openapi.json) and YAML (openapi.yaml) beside this file.
 */
@service(#{ title: "Library" })
@info(#{ version: "1.0.0" })
@extension(
  "x-forge-commands",
  #{
    books: #{
      description: "Manage the catalogue.",
      groups: #{
        reviews: #{ description: "Manage reviews of a book.", `x-forge-epilogue`: "Reviews are public." },
      },
    },
    search: #{ description: "Search the library." },
  }
)
namespace Library;

/** A genre of book. */
enum Genre {
  fiction,
  history,
  science,
}

/** A person who wrote a book. */
model Author {
  /** The author's name. */
  name: string;

  /** The author's date of birth. */
  born?: plainDate;
}

/** A book in the catalogue. */
model Book {
  /** The book's identifier. */
  @visibility(Lifecycle.Read)
  id: string;

  /** The book's title. */
  title: string;

  /** The book's authors. */
  authors: Author[];

  /** The book's genre. */
  genre: Genre;

  /** Free-form tags. */
  tags?: string[];

  /** The date the book was published, or null when unknown. */
  published?: plainDate | null;

  /** Extra catalogue fields. */
  metadata?: Record<string>;
}

/** A page of books. */
model BookPage {
  /** The books on this page. */
  items: Book[];

  /** The cursor for the next page, or null on the last page. */
  next: string | null;
}

/** A named collection of books. */
model Collection {
  /** The collection's name. */
  name: string;

  /** What the collection holds. */
  description?: string;
}

/** A shelf of books. */
model Shelf extends Collection {
  /** The shelf's identifier. */
  @visibility(Lifecycle.Read)
  id: string;

  /** The identifiers of the books on the shelf. */
  books: string[];
}

/** A review that gives stars. */
model StarReview {
  kind: "stars";

  /** The number of stars, from one to five. */
  @minValue(1)
  @maxValue(5)
  stars: int32;
}

/** A review in words. */
model WrittenReview {
  kind: "written";

  /** The review text. */
  text: string;
}

/** A review of a book. */
@discriminated(#{ envelope: "none", discriminatorPropertyName: "kind" })
union Review {
  stars: StarReview,
  written: WrittenReview,
}

/** The resource does not exist. */
@error
model NotFoundError {
  @statusCode _: 404;

  /** The error code. */
  code: "not_found";

  /** A description of the error. */
  message: string;
}

/** Books. */
@tag("Books")
@route("/books")
interface Books {
  /** List the books in the catalogue. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "list")
  @extension("x-fern-availability", "generally-available")
  @extension("x-forge-args", #[#{ options: #[#{ name: "limit", type: "number", required: #{ default: 20 } }] }])
  @get
  list(
    /** Only books of this genre. */
    @query genre?: Genre,

    /** Only books with all of these tags. */
    @query(#{ explode: true }) tags?: string[],

    /** The most books to return. */
    @query limit?: int32 = 20,

    /** A cursor from a previous page. */
    @query cursor?: string,

    /** An identifier for tracing the request. */
    @header("x-request-id") requestId?: string,
  ): BookPage;

  /** Return one book from the catalogue. */
  @summary("Get a book")
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "get")
  @extension("x-fern-availability", "generally-available")
  @get
  get(
    /** The book's identifier. */
    @path bookId: string,
  ): Book | NotFoundError;

  /** Add a book to the catalogue. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "create")
  @extension("x-fern-availability", "beta")
  @extension("x-forge-params", #{ title: #{ positional: true } })
  @post
  create(@body book: Book): {
    @statusCode _: 201;
    @body book: Book;
  };

  /** Replace a book in the catalogue. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "update")
  @extension("x-fern-availability", "generally-available")
  @extension("x-forge-params", #{ tags: #{ hidden: true } })
  @put
  update(
    /** The book's identifier. */
    @path bookId: string,

    @body book: Book,
  ): Book | NotFoundError;

  /** Remove a book from the catalogue. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "delete")
  @extension("x-fern-availability", "generally-available")
  @extension("x-forge-require-confirmation", "This operation removes the book from the catalogue.")
  @extension("x-forge-epilogue", "A removed book cannot be restored.")
  @delete
  delete(
    /** The book's identifier. */
    @path bookId: string,
  ): NoContentResponse | NotFoundError;

  /** Import books from the previous catalogue. */
  #deprecated "Use create instead."
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "import")
  @extension("x-fern-availability", "deprecated")
  @route("/import")
  @post
  importLegacy(@body books: Book[]): NoContentResponse;

  /** Export the catalogue as CSV. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "export")
  @extension("x-fern-availability", "preview")
  @extension("x-forge-hidden", true)
  @route("/export")
  @get
  export(): {
    @header contentType: "text/csv";
    @body csv: string;
  };

  /** Rebuild the search index. */
  @extension("x-fern-sdk-group-name", "books")
  @extension("x-fern-sdk-method-name", "reindex")
  @extension("x-fern-ignore", true)
  @route("/reindex")
  @post
  reindex(): NoContentResponse;

  /** Find books by title. */
  @extension(
    "x-forge-aliases",
    #[
      #{
        `x-fern-sdk-group-name`: "books",
        `x-fern-sdk-method-name`: "find",
        `x-fern-availability`: "generally-available",
      },
      #{
        `x-fern-sdk-group-name`: "search",
        `x-fern-sdk-method-name`: "books",
        `x-fern-availability`: "beta",
        `x-forge-globals`: #[
          #{ name: "branch", type: "string", required: #{ default: "main" }, description: "The library branch to search." }
        ],
      }
    ]
  )
  @route("/search")
  @get
  find(
    /** Text to find in book titles. */
    @query q: string,
  ): Book[];
}

/** Reviews of a book. */
@tag("Reviews")
@route("/books/{bookId}/reviews")
interface Reviews {
  /** List the reviews of a book. */
  @extension("x-fern-sdk-group-name", "books.reviews")
  @extension("x-fern-sdk-method-name", "list")
  @extension("x-fern-availability", "generally-available")
  @get
  list(
    /** The book's identifier. */
    @path bookId: string,
  ): Review[] | NotFoundError;

  /** Review a book. */
  @extension("x-fern-sdk-group-name", "books.reviews")
  @extension("x-fern-sdk-method-name", "create")
  @extension("x-fern-availability", "generally-available")
  @post
  create(
    /** The book's identifier. */
    @path bookId: string,

    @body review: Review,
  ): {
    @statusCode _: 201;
    @body review: Review;
  } | NotFoundError;
}

/** Shelves, whose Forge metadata comes from an overlay. */
@tag("Shelves")
@route("/shelves")
interface Shelves {
  /** List the shelves. */
  @get
  list(): Shelf[];

  /** Return one shelf. */
  @get
  get(
    /** The shelf's identifier. */
    @path shelfId: string,
  ): Shelf | NotFoundError;
}
