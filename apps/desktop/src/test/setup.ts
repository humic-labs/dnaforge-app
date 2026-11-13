import { afterEach, expect, vi } from 'vitest';

vi.mock('@sentry/electron/main', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

if (typeof document !== 'undefined') {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
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
