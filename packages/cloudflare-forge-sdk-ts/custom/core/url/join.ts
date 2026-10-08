// Cloudflare custom runtime: query-string / fragment preservation in join().
//
// Divergence from stock Fern TS 3.88.3 `core/url/join.ts`:
//   - A path segment carrying a `?query` or `#fragment` suffix has that suffix
//     peeled off and reattached to the URL's search/hash, instead of being folded
//     into the pathname.
//
// Rationale: assigning `url.pathname` percent-encodes `?` and `#` (WHATWG URL), so
// `join(baseUrl, "path?a=b")` would otherwise yield `.../path%3Fa=b` — the query
// swallowed into the path. Peeling the suffix keeps `?`/`&`/`#` intact, letting
// passthrough callers reach not-yet-typed endpoints by putting query params
// straight in the path (e.g. `client.<resource>.fetch("/path?a=b")`). Only the
// absolute-base branch needs this — the relative branch concatenates strings and
// never encodes. Normal generated call sites are unaffected: Fern encodes path
// params before they reach join() and handles query params in the fetcher, so a
// literal `?`/`#` only appears in the passthrough case.
// Keep in sync with the upstream generated file when bumping the generator.

export function join(base: string, ...segments: string[]): string {
  if (!base) {
    return '';
  }

  if (segments.length === 0) {
    return base;
  }

  if (base.includes('://')) {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      return joinPath(base, ...segments);
    }

    // Cloudflare: accumulate any query/fragment peeled off the segments so it
    // can be reattached below instead of percent-encoded into the pathname.
    let suffix = '';

    const lastSegment = segments[segments.length - 1];
    // Trailing-slash preservation keys off the path portion, not the query.
    const shouldPreserveTrailingSlash = splitPathSuffix(lastSegment ?? '').path.endsWith('/');

    for (const segment of segments) {
      const { path, suffix: segmentSuffix } = splitPathSuffix(segment);
      suffix += segmentSuffix;
      const cleanSegment = trimSlashes(path);
      if (cleanSegment) {
        url.pathname = joinPathSegments(url.pathname, cleanSegment);
      }
    }

    if (shouldPreserveTrailingSlash && !url.pathname.endsWith('/')) {
      url.pathname += '/';
    }

    // Cloudflare: reattach the peeled query/fragment with separators intact.
    applyPathSuffix(url, suffix);

    return url.toString();
  }

  return joinPath(base, ...segments);
}

// Cloudflare: split a segment into its path portion and the `?query`/`#fragment`
// suffix (everything from the first `?` or `#` onwards). The suffix, if present,
// always begins with `?` or `#`.
function splitPathSuffix(segment: string): { path: string; suffix: string } {
  const index = segment.search(/[?#]/);
  if (index === -1) {
    return { path: segment, suffix: '' };
  }
  return { path: segment.slice(0, index), suffix: segment.slice(index) };
}

// Cloudflare: apply a peeled `?query`/`#fragment` suffix to the URL via the
// search/hash setters, which preserve `?`/`&`/`#` semantics (unlike `pathname`).
// A query is merged after any query already present on the base URL.
function applyPathSuffix(url: URL, suffix: string): void {
  if (!suffix) {
    return;
  }
  const hashIndex = suffix.indexOf('#');
  const query = hashIndex === -1 ? suffix : suffix.slice(0, hashIndex);
  const hash = hashIndex === -1 ? '' : suffix.slice(hashIndex);
  // `query`/`hash` are empty or begin with `?`/`#`; a length of 1 is a bare
  // separator with nothing after it, which we drop.
  if (query.length > 1) {
    const existing = url.search === '' ? '' : `${url.search.slice(1)}&`;
    url.search = `${existing}${query.slice(1)}`;
  }
  if (hash.length > 1) {
    url.hash = hash;
  }
}

function joinPath(base: string, ...segments: string[]): string {
  if (segments.length === 0) {
    return base;
  }

  let result = base;

  const lastSegment = segments[segments.length - 1];
  const shouldPreserveTrailingSlash = lastSegment?.endsWith('/');

  for (const segment of segments) {
    const cleanSegment = trimSlashes(segment);
    if (cleanSegment) {
      result = joinPathSegments(result, cleanSegment);
    }
  }

  if (shouldPreserveTrailingSlash && !result.endsWith('/')) {
    result += '/';
  }

  return result;
}

function joinPathSegments(left: string, right: string): string {
  if (left.endsWith('/')) {
    return left + right;
  }
  return `${left}/${right}`;
}

function trimSlashes(str: string): string {
  return str.replace(/^\/+|\/+$/g, '');
}
