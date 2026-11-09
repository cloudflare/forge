/** Shows the Terraform section only while the code rail's HCL sample is
 *  selected, following the rail's own panel switching. A page rendered without
 *  `?lang=hcl` carries only a link to that URL; the first time Terraform is
 *  picked, the declarations are fetched from it and put in place of the link. */

import { headingAnchors, mount } from "@cloudflare/nimbus-docs/client";

mount("[data-api-terraform]", (section) => {
  const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-nb-lang-picker] [data-nb-choice-panel]"));
  if (panels.length === 0) return () => {};
  let loading = false;
  const load = async () => {
    const src = section.dataset.apiTerraformSrc;
    if (!src || loading) return;
    loading = true;
    try {
      const response = await fetch(src);
      if (!response.ok) return;
      const page = new DOMParser().parseFromString(await response.text(), "text/html");
      const body = page.querySelector("[data-api-terraform] [data-api-terraform-body]");
      const current = section.querySelector("[data-api-terraform-body]");
      if (!body || !current) return;
      current.replaceWith(document.importNode(body, true));
      delete section.dataset.apiTerraformSrc;
      headingAnchors();
    } catch {
      // The link stays in place, so the reader can still open the declarations.
    } finally {
      loading = false;
    }
  };
  const sync = () => {
    const chosen = panels.some((panel) => !panel.hidden && panel.dataset.nbChoiceKind === "hcl");
    section.hidden = !chosen;
    if (chosen) void load();
  };
  const observer = new MutationObserver(sync);
  for (const panel of panels) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  sync();
  return () => observer.disconnect();
});
