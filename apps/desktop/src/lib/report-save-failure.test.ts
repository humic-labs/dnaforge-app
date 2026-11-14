import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import { reportSaveFailure } from './report-save-failure';

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('./analytics', () => ({ trackRendererEvent: capture }));

describe('caught save failure diagnostics', () => {
  beforeEach(() => {
    capture.mockReset();
  });

  it.each([
    new Error(
      "Error invoking remote method 'fs:fileDocument': Error: EACCES: /Users/alice/private/file.txt"
    ),
    new Error('Save did not finish', {
      cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    }),
  ])('classifies the original safe code through IPC wrapping and Error causes', (failure) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportSaveFailure('[Save]', {}, failure);
      expect(capture.mock.calls[0][1].error_class).toBe('eacces');
      expect(JSON.stringify(capture.mock.calls)).not.toMatch(/alice|private|file\.txt/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each(['autosave', 'manual', 'flush'] as const)(
    'identifies a notebook %s failure with admitted fields',
    (notebookPhase) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        reportSaveFailure('[Notebook]', { pageId: 'private-page' }, new Error('EACCES'), {
          notebookPhase,
        });
        const properties = capture.mock.calls[0][1];
        expect(properties).toMatchObject({
          workflow: 'content',
          workflow_action: 'save',
          outcome_kind: 'notebook_save_failed',
          error_class: `notebook_${notebookPhase}_eacces`,
        });
        expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
        expect(JSON.stringify(properties)).not.toContain('private-page');
      } finally {
        consoleError.mockRestore();
      }
    }
  );

  it('retains the original local error and sends only safe failure metadata remotely', () => {
    const context = { filePath: '/Users/alice/private/construct.gb' };
    const failure = Object.assign(new Error('write refused for PRIVATE_SEQUENCE'), {
      code: 'EACCES',
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      reportSaveFailure('[TextViewerTab] Save failed:', context, failure);
      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        '[TextViewerTab] Save failed:',
        context,
        failure
      );
      expect(capture).toHaveBeenCalledWith(
        'workflow_action_observed',
        expect.objectContaining({
          workflow: 'file',
          workflow_action: 'save',
          action_phase: 'error',
          error_class: 'eacces',
          success: false,
        })
      );
      const properties = capture.mock.calls[0][1];
      expect(sanitizeClosedBetaProperties(properties)).toEqual(properties);
      expect(JSON.stringify(properties)).not.toMatch(/PRIVATE|alice|construct|write refused/);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not treat arbitrary private text as an error code or throw when telemetry fails', () => {
    capture.mockImplementation(() => {
      throw new Error('unavailable');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        reportSaveFailure('[Save]', {}, new Error('PRIVATE_CONSTRUCT: not written'))
      ).not.toThrow();
      expect(capture.mock.calls[0][1].error_class).toBe('save_failed');
    } finally {
      consoleError.mockRestore();
    }
  });
});
