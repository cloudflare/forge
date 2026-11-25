/** Copies a button's `data-cf-copy-command` on click and marks it `data-copied` for a moment. */
export function copyOnClick(button: Element): () => void {
  if (!(button instanceof HTMLButtonElement)) return () => {};
  const controller = new AbortController();
  const status = button.querySelector('[data-copy-status]');
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener(
    'click',
    async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.cfCopyCommand ?? '');
      } catch {
        return;
      }
      button.setAttribute('data-copied', '');
      if (status) status.textContent = 'Copied';
      clearTimeout(timer);
      timer = setTimeout(() => {
        button.removeAttribute('data-copied');
        if (status) status.textContent = '';
      }, 1500);
    },
    { signal: controller.signal },
  );
  return () => {
    controller.abort();
    clearTimeout(timer);
  };
}
