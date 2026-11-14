// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBreadcrumbBuffer, installBreadcrumbCapture } from './renderer-breadcrumbs';
import { reportSaveFailure } from './report-save-failure';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';

vi.mock('./analytics', () => ({ trackRendererEvent: vi.fn() }));

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

    it('retains Error details and their cause when a save failure is caught', () => {
      const cause = Object.assign(new Error('write refused for /Users/alice/private/file.txt'), {
        code: 'EACCES',
      });
      console.error('[Save All] Some changes were not saved:', new Error('Save failed', { cause }));
      win.dispatchEvent(new Event('pagehide'));
      const lines = win.electronAPI.sendBreadcrumbs.mock.calls.at(-1)![0] as string[];
      expect(lines.join('\n')).toContain('Save failed');
      expect(lines.join('\n')).toContain('EACCES');
      expect(lines.join('\n')).toContain('write refused');
      expect(lines.join('\n')).not.toMatch(/alice|private|file\.txt/);
    });

    it('sends a caught error before a renderer crash can discard the debounce', () => {
      console.error('Save failed', new Error('EIO'));
      expect(win.electronAPI.sendBreadcrumbs).toHaveBeenCalledOnce();
      expect(win.electronAPI.sendBreadcrumbs.mock.calls[0][0].join('\n')).toContain('EIO');
    });

    it('retains the notebook UUID and save phase before a long stack is truncated', () => {
      const pageId = '830a9677-d9c5-4e17-9d5c-a3562463360c';
      const error = new Error('EACCES: notebook write refused');
      error.stack = 'Error: EACCES\n' + '    at writeNotebook (app.js:100:20)\n'.repeat(50);
      reportSaveFailure(
        '[useEditorAutosave] save failed:',
        {
          pageId,
          operation: 'autosave',
          filePath: '/Users/alice/research/private-notebook.md',
          name: 'Private construct name',
        },
        error,
        { notebookPhase: 'autosave' }
      );
      const line = win.electronAPI.sendBreadcrumbs.mock.calls[0][0][0] as string;
      expect(line).toContain(`pageId=${pageId}`);
      expect(line).toContain('operation=autosave');
      expect(line).toContain('EACCES');
      expect(line).not.toMatch(/alice|research|private-notebook|Private construct/);
      expect(line.length).toBeLessThanOrEqual(500);
    });

    it('retains the workspace-scoped UUID produced when a notebook is created', () => {
      const pageId = scopedProjectionId(
        workspaceScopeKey(null, 3),
        '830a9677-d9c5-4e17-9d5c-a3562463360c'
      );
      const error = new Error('NativeDocumentCommandError: NOTEBOOK_SAVE_FAILED: EACCES');
      error.stack = error.message + '\n' + '    at writeNotebook (app.js:100:20)\n'.repeat(50);
      reportSaveFailure(
        '[useEditorAutosave] save failed:',
        { pageId, operation: 'autosave', filePath: '/Users/alice/private-notebook.md' },
        error,
        { notebookPhase: 'autosave' }
      );
      const line = win.electronAPI.sendBreadcrumbs.mock.calls[0][0][0] as string;
      expect(line).toContain(`pageId=ws3::830a9677-d9c5-4e17-9d5c-a3562463360c`);
      expect(line).toContain('operation=autosave');
      expect(line).toContain('NOTEBOOK_SAVE_FAILED: EACCES');
      expect(line).not.toMatch(/alice|private-notebook/);
      expect(line.length).toBeLessThanOrEqual(500);
    });

    it.each([
      'private-project::830a9677-d9c5-4e17-9d5c-a3562463360c',
      'ws-private::830a9677-d9c5-4e17-9d5c-a3562463360c',
      'ws3::private-notebook',
    ])('does not retain a named or malformed scoped identity', (pageId) => {
      const error = new Error('EACCES');
      error.stack = 'Error: EACCES';
      reportSaveFailure('[Notebook]', { pageId, operation: 'manual' }, error);
      const line = win.electronAPI.sendBreadcrumbs.mock.calls[0][0][0] as string;
      expect(line).toContain('operation=manual');
      expect(line).not.toContain(pageId);
      expect(line).not.toContain('pageId=');
    });

    it('retains the canonical repo UUID scope produced for a managed notebook', () => {
      const pageId = scopedProjectionId(
        workspaceScopeKey('ab5fb349-9c0f-4d1c-b449-bfdd6d32bf63', 3),
        '830a9677-d9c5-4e17-9d5c-a3562463360c'
      );
      reportSaveFailure('[Notebook]', { pageId, operation: 'manual' }, new Error('EACCES'));
      const line = win.electronAPI.sendBreadcrumbs.mock.calls[0][0][0] as string;
      expect(line).toContain(`pageId=${pageId}`);
      expect(line).toContain('operation=manual');
    });

    it('retains an opaque native document target and rejects arbitrary context labels', () => {
      const documentId = 'file-document:830a9677-d9c5-4e17-9d5c-a3562463360c';
      reportSaveFailure(
        '[DocumentLifecycle] Save failed:',
        {
          target: { kind: 'sequence-document', documentId },
          operation: 'private-operation-name',
          pageId: 'private-page-name',
          kind: 'private-kind-name',
          filePath: '/Users/alice/private-file.txt',
        },
        new Error('EIO')
      );
      const line = win.electronAPI.sendBreadcrumbs.mock.calls[0][0][0] as string;
      expect(line).toContain(`target.documentId=${documentId}`);
      expect(line).toContain('target.kind=sequence-document');
      expect(line).not.toMatch(/private-operation|private-page|private-kind|private-file|alice/);
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
