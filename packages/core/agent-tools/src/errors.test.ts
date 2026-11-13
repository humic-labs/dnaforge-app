import { describe, it, expect } from 'vitest';
import {
  ACTION_ERROR_BRAND,
  ActionError,
  ActionErrorCode,
  ALL_ACTION_ERROR_CODES,
  isActionError,
} from './errors';

describe('ActionErrorCode', () => {
  it('exposes exactly the 5 canonical codes', () => {
    expect(Object.values(ActionErrorCode).sort()).toEqual(
      ['BAD_INPUT', 'EXECUTION_FAILED', 'NOT_IMPLEMENTED', 'SCOPE_DENIED', 'STALE_STATE'].sort()
    );
  });

  it('ALL_ACTION_ERROR_CODES enumerates the same set', () => {
    expect([...ALL_ACTION_ERROR_CODES].sort()).toEqual(Object.values(ActionErrorCode).sort());
  });

  it('ALL_ACTION_ERROR_CODES is frozen', () => {
    expect(Object.isFrozen(ALL_ACTION_ERROR_CODES)).toBe(true);
  });

  it('ActionErrorCode const itself is frozen (prevents process-wide retriability tampering)', () => {
    expect(Object.isFrozen(ActionErrorCode)).toBe(true);
  });
});

describe('ActionError', () => {
  it('rejects an unknown code at construction (TypeScript erasure defense)', () => {
    expect(
      () => new ActionError('SUDO_GRANTED' as unknown as 'BAD_INPUT', 'spoof attempt')
    ).toThrow(/invalid code/i);
    expect(() => new ActionError('' as unknown as 'BAD_INPUT', 'x')).toThrow(/invalid code/i);
    expect(() => new ActionError(undefined as unknown as 'BAD_INPUT', 'x')).toThrow(
      /invalid code/i
    );
  });

  it('sets code, message, name, and default retriability for non-stale codes', () => {
    const err = new ActionError('BAD_INPUT', 'bad input');
    expect(err.code).toBe('BAD_INPUT');
    expect(err.message).toBe('bad input');
    expect(err.name).toBe('ActionError');
    expect(err.retriable).toBe(false);
    expect(err.details).toBeUndefined();
    expect(err).toBeInstanceOf(Error);
  });

  it('defaults STALE_STATE to retriable=true', () => {
    const err = new ActionError('STALE_STATE', 'design revision changed');
    expect(err.retriable).toBe(true);
  });

  it('caller-provided retriable wins over the default', () => {
    expect(new ActionError('STALE_STATE', 'x', { retriable: false }).retriable).toBe(false);
    expect(new ActionError('EXECUTION_FAILED', 'y', { retriable: true }).retriable).toBe(true);
  });

  it('attaches details when provided', () => {
    const details = { expectedRevision: 3, actualRevision: 5 };
    const err = new ActionError('STALE_STATE', 'mismatch', { details });
    expect(err.details).toEqual(details);
  });

  it('attaches cause as non-enumerable but accessible', () => {
    const inner = new Error('boom');
    const err = new ActionError('EXECUTION_FAILED', 'wrapped', { cause: inner });
    expect((err as Error & { cause?: unknown }).cause).toBe(inner);
    expect(Object.keys(err)).not.toContain('cause');
  });

  it('toPayload omits details when none set', () => {
    const err = new ActionError('NOT_IMPLEMENTED', 'soon');
    expect(err.toPayload()).toEqual({
      code: 'NOT_IMPLEMENTED',
      message: 'soon',
      retriable: false,
    });
  });

  it('toPayload includes details when present', () => {
    const err = new ActionError('BAD_INPUT', 'invalid', {
      details: { path: ['start'], issue: 'must be int' },
    });
    expect(err.toPayload()).toEqual({
      code: 'BAD_INPUT',
      message: 'invalid',
      retriable: false,
      details: { path: ['start'], issue: 'must be int' },
    });
  });
});

describe('isActionError', () => {
  it('returns true for ActionError instances', () => {
    expect(isActionError(new ActionError('BAD_INPUT', 'x'))).toBe(true);
  });

  it('returns false for plain errors and non-errors', () => {
    expect(isActionError(new Error('plain'))).toBe(false);
    expect(isActionError({ code: 'BAD_INPUT', message: 'x' })).toBe(false);
    expect(isActionError(null)).toBe(false);
    expect(isActionError(undefined)).toBe(false);
    expect(isActionError('string')).toBe(false);
  });

  it('uses Symbol.for brand so dual-loaded ActionError instances still pass', () => {
    const fromOtherCopy = Object.assign(Object.create(null), {
      [ACTION_ERROR_BRAND]: true,
      code: 'STALE_STATE',
      message: 'from other module copy',
      retriable: true,
      toPayload() {
        return { code: 'STALE_STATE' as const, message: 'from other module copy', retriable: true };
      },
    });
    expect(fromOtherCopy instanceof ActionError).toBe(false);
    expect(isActionError(fromOtherCopy)).toBe(true);
  });

  it('rejects shape-without-brand (defends the brand check against forgery via shape alone)', () => {
    const shapeOnly = {
      code: 'STALE_STATE',
      message: 'forged',
      retriable: true,
      toPayload: () => ({}),
    };
    expect(isActionError(shapeOnly)).toBe(false);
  });

  it('rejects brand-without-shape (defends against bare-symbol forgery)', () => {
    const brandOnly = { [ACTION_ERROR_BRAND]: true };
    expect(isActionError(brandOnly)).toBe(false);
  });

  it('rejects an unknown code even with the brand and shape', () => {
    const wrong = {
      [ACTION_ERROR_BRAND]: true,
      code: 'TOTALLY_FAKE',
      message: 'x',
      toPayload: () => ({}),
    };
    expect(isActionError(wrong)).toBe(false);
  });
});
