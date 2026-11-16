/** The Terraform view, as on `main`: Terraform is a view of the page, kept in
 *  the URL (`?lang=terraform`) rather than remembered like the other samples.
 *
 *  - Picking Terraform in the code rail opens the page's Terraform view, and
 *    picking another sample there opens the HTTP view with it.
 *  - The saved sample is never Terraform, so a plain URL always opens the HTTP
 *    reference.
 *  - In the Terraform view, links to other API pages carry `?lang=terraform`,
 *    so the reader stays in it. */

import { mount } from "@cloudflare/nimbus-docs/client";
import { navigate } from "astro:transitions/client";

const TERRAFORM = "terraform";
const PARAM = "lang";

// What the page renders, not the URL: the rail rewrites ?lang= on every pick.
const isTerraformView = () => document.querySelector("[data-api-terraform]") !== null;

// An API page of this site, not a file next to it (`index.md`, `nav-list.json`).
const apiPage = (link: HTMLAnchorElement): URL | null => {
  if (!link.href || link.hasAttribute("download")) return null;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return null;
  if (!url.pathname.startsWith(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/`)) return null;
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return null;
  if (url.pathname === location.pathname && url.hash) return null;
  return url;
};

mount("[data-nb-lang-picker]", (rail) => {
  const select = rail.querySelector<HTMLSelectElement>("[data-nb-choice-select]");
  const key = rail.dataset.nbChoice;
  if (!select || !key) return () => {};
  const kindOf = (value: string) =>
    rail.querySelector<HTMLElement>(`[data-nb-choice-panel="${CSS.escape(value)}"]`)?.dataset.nbChoiceKind?.toLowerCase();
  const stored = () => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const store = (value: string | null) => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch {}
  };

  // A Terraform choice saved before Terraform became a view.
  let saved = stored() === TERRAFORM ? null : stored();
  if (!isTerraformView() && stored() === TERRAFORM) {
    store(null);
    if (kindOf(select.value) === TERRAFORM && select.options[0]) {
      select.value = select.options[0].value;
      select.dispatchEvent(new Event("change"));
    }
  }

  const onChange = () => {
    const chosen = kindOf(select.value);
    // After the rail's own handler has saved the choice and written ?lang=.
    setTimeout(() => {
      const url = new URL(location.href);
      if (chosen === TERRAFORM) {
        store(saved);
        if (isTerraformView()) return;
        url.searchParams.set(PARAM, TERRAFORM);
      } else {
        saved = stored();
        if (!isTerraformView()) return;
        url.searchParams.set(PARAM, select.value);
      }
      void navigate(`${url.pathname}${url.search}`);
    });
  };
  select.addEventListener("change", onChange);
  return () => select.removeEventListener("change", onChange);
});

// Links pick up ?lang=terraform as they're about to be followed, so those the
// sidebar and its filter add later carry it too.
const carry = (event: Event) => {
  if (!isTerraformView()) return;
  const link = (event.target as Element | null)?.closest?.("a");
  if (!(link instanceof HTMLAnchorElement)) return;
  const url = apiPage(link);
  if (!url || url.searchParams.has(PARAM)) return;
  url.searchParams.set(PARAM, TERRAFORM);
  link.href = url.href;
};
for (const type of ["pointerdown", "focusin", "contextmenu", "click"]) document.addEventListener(type, carry, true);
