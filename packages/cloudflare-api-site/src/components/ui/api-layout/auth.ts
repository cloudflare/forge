import type { ApiAuthView, ApiFieldView, ApiUnionView } from "@cloudflare/nimbus-docs/api";

function authTypeLabel(a: ApiAuthView): string {
  if (a.type === "http") {
    if (a.httpScheme === "bearer") return a.bearerFormat ? `HTTP Bearer (${a.bearerFormat})` : "HTTP Bearer";
    if (a.httpScheme === "basic") return "HTTP Basic";
    return "HTTP";
  }
  if (a.type === "apiKey") return `API key${a.in ? ` in ${a.in}` : ""}`;
  if (a.type === "oauth2") return "OAuth 2.0";
  if (a.type === "openIdConnect") return "OpenID Connect";
  if (a.type === "mutualTLS") return "Mutual TLS";
  return a.type ?? a.scheme;
}

function authExample(a: ApiAuthView): string | null {
  if (!a.headerName) return null;
  if (a.type === "http" && a.httpScheme === "bearer") return `${a.headerName}: Bearer <token>`;
  if (a.type === "http" && a.httpScheme === "basic") return `${a.headerName}: Basic <credentials>`;
  return `${a.headerName}: <token>`;
}

/** `value` as text in HTML. The row renders `descriptionHtml` as is, and a
 *  scope or header name is the spec's text, not markup. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const code = (value: string): string => `<code>${escapeHtml(value)}</code>`;

// OpenAPI restricts scheme keys to [A-Za-z0-9._-]; belt-and-braces for a
// non-conformant spec.
const authAnchor = (scheme: string): string =>
  `auth-${scheme.replace(/[^A-Za-z0-9._-]/g, "-")}`;

function toField(a: ApiAuthView, anchor: string): ApiFieldView {
  const example = authExample(a);
  // Built as HTML here rather than rendered from Markdown: this file runs where
  // the page renders, which on a request-rendered site is the server bundle.
  const parts = [
    example ? code(example) : "",
    a.scopes.length > 0 ? `Scopes: ${a.scopes.map(code).join(", ")}` : "",
  ].filter(Boolean);
  return {
    coordinate: `auth:${anchor}`,
    name: a.scheme,
    type: authTypeLabel(a),
    required: true,
    anchor,
    children: [],
    childCount: 0,
    truncated: false,
    descriptionHtml: parts.length > 0 ? `<p>${parts.join(" · ")}</p>` : undefined,
  };
}

/**
 * What an operation's Authorization section lists. `auth` is OR-of-AND: send
 * every scheme of any one alternative. One alternative is its schemes, each
 * required; several are a union, one option per alternative, so a token, or an
 * email and a key, never reads as three optional headers. An empty alternative
 * makes the whole section optional, and a repeated one is listed once.
 */
export function authSection(auth: ApiAuthView[][]): { fields: ApiFieldView[]; union?: ApiUnionView; optional: boolean } {
  const seen = new Set<string>();
  const alternatives = auth.filter((alt) => {
    const key = JSON.stringify(alt.map((a) => [a.scheme, a.scopes]));
    if (alt.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const optional = auth.some((alt) => alt.length === 0);
  // A scheme in several alternatives keeps its anchor in the first and numbers the rest.
  const uses = new Map<string, number>();
  const fields = (alt: ApiAuthView[]) =>
    alt.map((a) => {
      const n = (uses.get(a.scheme) ?? 0) + 1;
      uses.set(a.scheme, n);
      return toField(a, n === 1 ? authAnchor(a.scheme) : `${authAnchor(a.scheme)}-${n}`);
    });
  if (alternatives.length < 2) return { fields: fields(alternatives[0] ?? []), optional };
  return {
    fields: [],
    optional,
    union: {
      kind: "oneOf",
      variants: alternatives.map((alt) => ({ label: alt.map((a) => a.scheme).join(" and "), fields: fields(alt) })),
    },
  };
}
