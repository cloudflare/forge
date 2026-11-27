import { mount } from "@cloudflare/nimbus-docs/client";

type Pref = "light" | "dark" | "auto";

declare global {
  interface Window {
    __nbApplyTheme?: (pref?: Pref) => void;
  }
}

const ORDER: readonly Pref[] = ["light", "dark", "auto"];

const readPref = (): Pref => {
  const pref = document.documentElement.dataset.nbPref;
  return pref === "light" || pref === "dark" ? pref : "auto";
};

function labelFor(pref: Pref): string {
  return pref === "light"
    ? "Theme: light. Activate to switch to dark."
    : pref === "dark"
      ? "Theme: dark. Activate to switch to system."
      : "Theme: system. Activate to switch to light.";
}

function initThemeToggle(button: HTMLElement): () => void {
  function handleClick() {
    const next = ORDER[(ORDER.indexOf(readPref()) + 1) % ORDER.length]!;
    try {
      localStorage.setItem("ui-mode", next);
      window.__nbApplyTheme?.();
    } catch {
      // Storage is blocked (private mode, restricted contexts): keep the
      // choice for this page.
      window.__nbApplyTheme?.(next);
    }
    button.setAttribute("aria-label", labelFor(next));
  }

  button.setAttribute("aria-label", labelFor(readPref()));
  button.addEventListener("click", handleClick);
  return () => button.removeEventListener("click", handleClick);
}

mount("[data-nb-theme-toggle]", initThemeToggle);
