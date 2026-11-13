const BLANK_CONFIRM_MS = 750;
const FALLBACK_ID = 'blank-window-fallback';

export interface BlankWindowFallbackDeps {
  saveAll: () => Promise<void>;
  reload?: () => void;
}

export function installBlankWindowFallback(
  rootElement: HTMLElement,
  deps: BlankWindowFallbackDeps
): () => void {
  const reload = deps.reload ?? (() => window.location.reload());
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    clearTimeout(timer);
    if (rootElement.childElementCount > 0) {
      document.getElementById(FALLBACK_ID)?.remove();
      return;
    }
    timer = setTimeout(() => {
      if (rootElement.childElementCount === 0) showFallback(deps.saveAll, reload);
    }, BLANK_CONFIRM_MS);
  };

  const observer = new MutationObserver(check);
  observer.observe(rootElement, { childList: true });
  check();
  return () => {
    observer.disconnect();
    clearTimeout(timer);
  };
}

function showFallback(saveAll: () => Promise<void>, reload: () => void): void {
  if (document.getElementById(FALLBACK_ID)) return;
  const panel = document.createElement('main');
  panel.id = FALLBACK_ID;
  panel.setAttribute('role', 'alert');
  panel.setAttribute('data-testid', FALLBACK_ID);
  panel.className = 'flex h-screen items-center justify-center bg-bg text-fg';
  panel.style.position = 'fixed';
  panel.style.inset = '0';
  panel.style.zIndex = '2147483647';

  const box = document.createElement('div');
  box.className = 'max-w-md p-8 text-center';

  const heading = document.createElement('h1');
  heading.className = 'mb-3 text-lg font-medium';
  heading.textContent = 'Something went wrong';

  const body = document.createElement('p');
  body.className = 'text-sm text-fg-muted';
  body.textContent =
    "DNAForge hit an error and can't show this window. Reload to continue. Save first to keep any unsaved changes.";

  const status = document.createElement('p');
  status.className = 'mt-3 text-sm';

  const buttons = document.createElement('div');
  buttons.className = 'mt-6 flex justify-center gap-2';
  const saveButton = button('Save and Reload', true);
  const reloadButton = button('Reload Without Saving', false);
  saveButton.addEventListener('click', () => {
    saveButton.disabled = true;
    reloadButton.disabled = true;
    status.textContent = 'Saving…';
    void saveAll()
      .catch((error: unknown) => console.error('[BlankWindowFallback] Save failed:', error))
      .finally(reload);
  });
  reloadButton.addEventListener('click', reload);
  buttons.append(saveButton, reloadButton);

  box.append(heading, body, status, buttons);
  panel.append(box);
  document.body.append(panel);
}

function button(label: string, primary: boolean): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.className = primary
    ? 'rounded bg-accent px-4 py-2 text-sm text-white hover:opacity-90'
    : 'rounded border border-border px-4 py-2 text-sm hover:bg-bg-hover';
  return element;
}
