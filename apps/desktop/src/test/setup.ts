import { afterEach, expect, vi } from 'vitest';

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

if (typeof document !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      const event = new Event('beforetoggle', { cancelable: true });
      Object.defineProperty(event, 'newState', { value: 'open' });
      if (this.dispatchEvent(event)) this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      const event = new Event('beforetoggle');
      Object.defineProperty(event, 'newState', { value: 'closed' });
      this.dispatchEvent(event);
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
  const [{ cleanup }, { default: wrappedMatchers, ...namedMatchers }] = await Promise.all([
    import('@testing-library/react'),
    import('@testing-library/jest-dom/matchers'),
  ]);

  expect.extend(wrappedMatchers ?? namedMatchers);

  afterEach(() => {
    cleanup();
  });
}
