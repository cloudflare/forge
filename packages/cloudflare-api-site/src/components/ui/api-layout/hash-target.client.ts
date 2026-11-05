const revealHashTarget = () => {
  let id: string;
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {
    return;
  }
  const target = id ? document.getElementById(id) : null;
  if (!target?.closest("[data-api-section], [data-api-responses]")) return;
  let opened = false;
  const open = (details: HTMLDetailsElement | null) => {
    if (details && !details.open) {
      details.open = true;
      opened = true;
    }
  };
  for (let node = target.parentElement; node; node = node.parentElement) {
    if (node instanceof HTMLDetailsElement) open(node);
  }
  open(target.querySelector<HTMLDetailsElement>(":scope > details"));
  if (opened) target.scrollIntoView({ block: "start" });
};

window.addEventListener("hashchange", revealHashTarget);
revealHashTarget();
