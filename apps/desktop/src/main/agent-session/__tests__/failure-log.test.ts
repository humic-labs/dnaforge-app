import { describe, it, expect } from 'vitest';
import { pickUserFacingCliError, extractTraceFailureDetail } from '../failure-log';

describe('pickUserFacingCliError ', () => {
  it('prefers richer trace detail over a bare "exit 1"', () => {
    expect(pickUserFacingCliError('exit 1', 'spawn ENOENT: codex not found')).toBe(
      'spawn ENOENT: codex not found'
    );
    expect(pickUserFacingCliError('5', 'real failure detail here')).toBe(
      'real failure detail here'
    );
    expect(pickUserFacingCliError('failed', 'the actual reason it failed')).toBe(
      'the actual reason it failed'
    );
  });

  it('keeps a descriptive raw error even when a short trace detail exists', () => {
    const raw = 'Anthropic API returned 401 Unauthorized for the selected model';
    expect(pickUserFacingCliError(raw, null)).toBe(raw);
    expect(pickUserFacingCliError(raw, 'short')).toBe(raw);
  });

  it('falls back to the raw error when there is no trace detail', () => {
    expect(pickUserFacingCliError('exit 1', null)).toBe('exit 1');
    expect(pickUserFacingCliError('exit 1', '')).toBe('exit 1');
  });
});

describe('extractTraceFailureDetail ', () => {
  it('returns display.text for a terminal-failed event', () => {
    expect(
      extractTraceFailureDetail({ terminal: 'failed', display: { kind: 'result', text: 'boom' } })
    ).toBe('boom');
  });

  it('ignores a non-terminal error event (only terminal:failed counts)', () => {
    expect(extractTraceFailureDetail({ display: { kind: 'error', text: 'kaboom' } })).toBeNull();
    expect(
      extractTraceFailureDetail({ terminal: null, display: { kind: 'error', text: 'kaboom' } })
    ).toBeNull();
  });

  it('returns null for non-failure events and non-objects', () => {
    expect(
      extractTraceFailureDetail({
        terminal: null,
        display: { kind: 'reasoning', text: 'thinking' },
      })
    ).toBeNull();
    expect(extractTraceFailureDetail({ display: { kind: 'command', text: 'ls' } })).toBeNull();
    expect(extractTraceFailureDetail(null)).toBeNull();
    expect(extractTraceFailureDetail('nope')).toBeNull();
    expect(extractTraceFailureDetail({ terminal: 'failed' })).toBeNull();
  });

  it('caps very long failure detail', () => {
    const out = extractTraceFailureDetail({
      terminal: 'failed',
      display: { kind: 'error', text: 'x'.repeat(20000) },
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(8192);
  });
});

describe('model/account recovery presentation', () => {
  it('turns the raw account-model rejection into one actionable message', () => {
    const raw = JSON.stringify({
      error: {
        message:
          "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
        type: 'invalid_request_error',
      },
    });
    expect(pickUserFacingCliError(raw, raw)).toBe(
      'This Codex model is unavailable with your current account. Choose an available model or the provider default, then try again. Your request remains in this conversation.'
    );
  });
});
