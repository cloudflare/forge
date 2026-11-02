/** Shows the Terraform section only while the code rail's HCL sample is
 *  selected, following the rail's own panel switching. */

import { mount } from "@cloudflare/nimbus-docs/client";

mount("[data-api-terraform]", (section) => {
  const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-nb-lang-panel]"));
  if (panels.length === 0) return () => {};
  const sync = () => {
    section.hidden = !panels.some((panel) => !panel.hidden && panel.dataset.nbSampleLang === "hcl");
  };
  const observer = new MutationObserver(sync);
  for (const panel of panels) observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  sync();
  return () => observer.disconnect();
});
