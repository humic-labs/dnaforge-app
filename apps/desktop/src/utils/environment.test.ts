import { afterEach, describe, expect, it } from 'vitest';
import { isBrowserOnly, isDesktopRuntime, isHostedBrowserRuntime } from './environment';

describe('renderer environment', () => {
  afterEach(() => {
    delete document.documentElement.dataset.dnaforgeRuntime;
    delete (window as Window & { electronAPI?: unknown }).electronAPI;
  });

  it('does not treat the hosted production runtime as browser-mock fixtures', () => {
    document.documentElement.dataset.dnaforgeRuntime = 'hosted-browser';
    expect(isHostedBrowserRuntime()).toBe(true);
    expect(isDesktopRuntime()).toBe(false);
    expect(isBrowserOnly()).toBe(false);
  });

  it('recognizes the HTML runtime attribute without dataset camelCase', () => {
    document.documentElement.setAttribute('data-dnaforge-runtime', 'hosted-browser');
    expect(isHostedBrowserRuntime()).toBe(true);
    expect(isBrowserOnly()).toBe(false);
  });
});
