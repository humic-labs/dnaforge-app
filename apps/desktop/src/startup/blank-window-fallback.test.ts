import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBlankWindowFallback } from './blank-window-fallback';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mountRoot() {
  const root = document.createElement('div');
  root.id = 'root';
  root.append(document.createElement('main'));
  document.body.append(root);
  return root;
}

const fallback = () => document.querySelector('[data-testid="blank-window-fallback"]');
const flushObserver = () => Promise.resolve();

describe('blank window fallback ', () => {
  it('shows recovery controls when the app disappears, and saves before reloading', async () => {
    vi.useFakeTimers();
    const root = mountRoot();
    const saveAll = vi.fn(async () => undefined);
    const reload = vi.fn();
    installBlankWindowFallback(root, { saveAll, reload });

    root.replaceChildren();
    await flushObserver();
    vi.advanceTimersByTime(1000);
    expect(fallback()).toHaveTextContent('Something went wrong');
    expect((fallback() as HTMLElement).style.zIndex).toBe('2147483647');

    const save = [...fallback()!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Save and Reload'
    )!;
    save.click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(saveAll).toHaveBeenCalledOnce();
  });

  it('ignores a root that is only empty between renders', async () => {
    vi.useFakeTimers();
    const root = mountRoot();
    installBlankWindowFallback(root, { saveAll: vi.fn(), reload: vi.fn() });
    root.replaceChildren();
    await flushObserver();
    root.append(document.createElement('main'));
    await flushObserver();
    vi.advanceTimersByTime(1000);
    expect(fallback()).toBeNull();
  });
});
