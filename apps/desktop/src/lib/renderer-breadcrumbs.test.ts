// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBreadcrumbBuffer, installBreadcrumbCapture } from './renderer-breadcrumbs';

class FakeWindow extends EventTarget {
  electronAPI = { sendBreadcrumbs: vi.fn() };
}

describe('renderer-breadcrumbs  item 4)', () => {
  describe('createBreadcrumbBuffer', () => {
    it('keeps only the last N lines (ring rotation)', () => {
      const buffer = createBreadcrumbBuffer(3);
      ['a', 'b', 'c', 'd', 'e'].forEach((l) => buffer.push(l));
      expect(buffer.snapshot()).toEqual(['c', 'd', 'e']);
    });
  });

  describe('installBreadcrumbCapture', () => {
    let win: FakeWindow;
    let teardown: () => void;

    beforeEach(() => {
      vi.useFakeTimers();
      win = new FakeWindow();
      teardown = installBreadcrumbCapture(win as unknown as Window);
    });
    afterEach(() => {
      teardown();
      vi.useRealTimers();
    });

    it('captures console warn/error and debounce-flushes them to main', () => {
      console.warn('w-breadcrumb');
      console.error('e-breadcrumb');
      expect(win.electronAPI.sendBreadcrumbs).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2100);
      expect(win.electronAPI.sendBreadcrumbs).toHaveBeenCalledTimes(1);
      const lines = win.electronAPI.sendBreadcrumbs.mock.calls[0][0] as string[];
      expect(lines.some((l) => l.startsWith('warn: ') && l.includes('w-breadcrumb'))).toBe(true);
      expect(lines.some((l) => l.startsWith('error: ') && l.includes('e-breadcrumb'))).toBe(true);
    });

    it('redacts secrets/PII from captured lines before they leave the process', () => {
      console.error('failed to read /Users/alice/research/secret.gb for bob@lab.org');
      vi.advanceTimersByTime(2100);
      const lines = win.electronAPI.sendBreadcrumbs.mock.calls[0][0] as string[];
      const joined = lines.join('\n');
      expect(joined).toContain('/Users/[redacted-user]/[redacted-path] for [redacted-email]');
      expect(joined).not.toContain('secret.gb');
      expect(joined).not.toContain('research');
      expect(joined).not.toContain('alice');
      expect(joined).not.toContain('bob@lab.org');
    });

    it('flushes immediately on pagehide (controlled unload), before the debounce', () => {
      console.warn('pre-unload-crumb');
      expect(win.electronAPI.sendBreadcrumbs).not.toHaveBeenCalled();

      win.dispatchEvent(new Event('pagehide'));
      expect(win.electronAPI.sendBreadcrumbs).toHaveBeenCalledTimes(1);
      const lines = win.electronAPI.sendBreadcrumbs.mock.calls[0][0] as string[];
      expect(lines.some((l) => l.includes('pre-unload-crumb'))).toBe(true);
    });

    it('restores console on teardown (no capture afterwards)', () => {
      teardown();
      const callsBefore = win.electronAPI.sendBreadcrumbs.mock.calls.length;
      console.warn('after-teardown');
      vi.advanceTimersByTime(2100);
      expect(win.electronAPI.sendBreadcrumbs.mock.calls.length).toBe(callsBefore);
    });
  });
});
