/** The Terraform view, as on `main`: Terraform is a view of the page, kept in
 *  the URL (`?lang=terraform`) rather than remembered like the other samples.
 *
 *  - The page carries both views. CSS in `ApiBody.astro` shows the Terraform
 *    section in place of the HTTP reference while the code rail shows the
 *    Terraform sample, so picking it swaps them in place, and the rail's own
 *    handler writes `?lang=` to the URL.
 *  - The saved sample is never Terraform, so a plain URL always opens the HTTP
 *    reference.
 *  - While Terraform is shown, links to other API pages carry
 *    `?lang=terraform`, so the reader stays in it. */

import { mount } from "@cloudflare/nimbus-docs/client";

const TERRAFORM = "terraform";
const PARAM = "lang";

const select = () => document.querySelector<HTMLSelectElement>("[data-nb-lang-picker] [data-nb-choice-select]");
const kindOf = (value: string | undefined) =>
  value
    ? document
        .querySelector<HTMLElement>(`[data-nb-lang-picker] [data-nb-choice-panel="${CSS.escape(value)}"]`)
        ?.dataset.nbChoiceKind?.toLowerCase()
    : undefined;
const terraformShown = () => kindOf(select()?.value) === TERRAFORM;

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
  const picker = rail.querySelector<HTMLSelectElement>("[data-nb-choice-select]");
  const key = rail.dataset.nbChoice;
  if (!picker || !key) return () => {};
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

  // A Terraform choice saved before Terraform became a view of the URL.
  let saved = stored() === TERRAFORM ? null : stored();
  if (stored() === TERRAFORM) {
    store(null);
    if (new URL(location.href).searchParams.get(PARAM) !== TERRAFORM && terraformShown() && picker.options[0]) {
      picker.value = picker.options[0].value;
      picker.dispatchEvent(new Event("change"));
    }
  }

  // After the rail's own handler has shown the panel and saved the choice.
  const onChange = () =>
    setTimeout(() => {
      if (terraformShown()) store(saved);
      else saved = stored();
    });
  picker.addEventListener("change", onChange);
  return () => picker.removeEventListener("change", onChange);
});

// Links pick up ?lang=terraform as they're about to be followed, so those the
// sidebar and its filter add later carry it too.
const carry = (event: Event) => {
  const link = (event.target as Element | null)?.closest?.("a");
  if (!(link instanceof HTMLAnchorElement)) return;
  const url = apiPage(link);
  if (!url) return;
  const shown = terraformShown();
  if (shown && !url.searchParams.has(PARAM)) {
    url.searchParams.set(PARAM, TERRAFORM);
    link.dataset.forgeTerraformLink = "";
  } else if (!shown && link.dataset.forgeTerraformLink !== undefined) {
    // Added here while Terraform was shown; the reader has left it since.
    url.searchParams.delete(PARAM);
    delete link.dataset.forgeTerraformLink;
  } else {
    return;
  }
  link.href = url.href;
};
for (const type of ["pointerdown", "focusin", "contextmenu", "click"]) document.addEventListener(type, carry, true);
