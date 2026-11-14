import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportNativeSaveFailure } from './save-failure-diagnostics';

const { append, capture } = vi.hoisted(() => ({ append: vi.fn(), capture: vi.fn() }));
vi.mock('./boot-log', () => ({ appendBootLog: append }));
vi.mock('./analytics', () => ({ trackEvent: capture }));

describe('native save failure diagnostics', () => {
  beforeEach(() => {
    append.mockReset();
    capture.mockReset();
  });

  it('retains the original error code and cause before its stack in the redacted local log', () => {
    const cause = Object.assign(new Error('write refused /Users/alice/private/file.txt'), {
      code: 'EIO',
    });
    reportNativeSaveFailure(
      Object.assign(new Error('save did not finish', { cause }), { code: 'EACCES' })
    );
    const line = append.mock.calls[0][0];
    expect(line).toContain('code=EACCES');
    expect(line).toContain('cause=Error: write refused');
    expect(line).toContain('code=EIO');
    expect(line).not.toMatch(/alice|private|file\.txt/);
    expect(capture.mock.calls[0][1].error_class).toBe('eacces');
  });

  it('keeps the two diagnostic outputs independent when one observer fails', () => {
    append.mockImplementation(() => {
      throw new Error('unavailable');
    });
    capture.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(() => reportNativeSaveFailure(new Error('EIO'))).not.toThrow();
    expect(capture).toHaveBeenCalledOnce();
  });
});
