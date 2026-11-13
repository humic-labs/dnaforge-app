import { describe, expect, it } from 'vitest';
import {
  armQuitOrchestration,
  armWindowClosePrompt,
  quitPromptSuppressed,
} from './quit-prompt-timing';

function event() {
  const calls: string[] = [];
  return {
    calls,
    event: {
      preventDefault: () => calls.push('prevent'),
    },
  };
}

describe('quit prompt timing', () => {
  it('suppresses the prompt only for an unpackaged test run', () => {
    expect(quitPromptSuppressed(false, '1')).toBe(true);
    expect(quitPromptSuppressed(false, undefined)).toBe(false);
    expect(quitPromptSuppressed(true, '1')).toBe(false);
    expect(quitPromptSuppressed(true, undefined)).toBe(false);
  });

  it('aborts quit and does not run teardown until the event handler can return', () => {
    const { calls, event: quitEvent } = event();
    const arm = armQuitOrchestration({
      event: quitEvent,
      alreadyQuitting: false,
      bypass: false,
      schedule: (run) => {
        calls.push('schedule');
        calls.push(run === runProductQuit ? 'scheduled-body' : 'other');
      },
      run: runProductQuit,
    });

    function runProductQuit() {
      calls.push('run');
    }

    expect(arm).toBe('armed');
    expect(calls).toEqual(['prevent', 'schedule', 'scheduled-body']);
  });

  it('lets a cutover shell and an already-accepted quit close without a second prompt', () => {
    const first = event();
    expect(
      armQuitOrchestration({
        event: first.event,
        alreadyQuitting: false,
        bypass: true,
        schedule: () => {
          throw new Error('bypass must not schedule');
        },
        run: () => {
          throw new Error('bypass must not run');
        },
      })
    ).toBe('bypass');
    expect(first.calls).toEqual([]);

    const second = event();
    expect(
      armQuitOrchestration({
        event: second.event,
        alreadyQuitting: true,
        bypass: false,
        schedule: () => {
          throw new Error('second quit must not schedule');
        },
        run: () => {
          throw new Error('second quit must not run');
        },
      })
    ).toBe('already-quitting');
    expect(second.calls).toEqual([]);
  });

  it('keeps a dirty window open and waits to show the dialog', () => {
    const { calls, event: closeEvent } = event();
    let opened = false;
    const arm = armWindowClosePrompt({
      event: closeEvent,
      suppressed: false,
      alreadyQuitting: false,
      hasConsent: false,
      dirty: true,
      promptAlreadyOpen: opened,
      schedule: (run) => {
        calls.push('schedule');
        opened = true;
        run();
      },
      run: () => calls.push('prompt'),
    });

    expect(arm).toBe('defer');
    expect(calls).toEqual(['prevent', 'schedule', 'prompt']);
    expect(opened).toBe(true);
  });

  it('does not stack a second dialog while the first prompt is still open', () => {
    const { calls, event: closeEvent } = event();
    const arm = armWindowClosePrompt({
      event: closeEvent,
      suppressed: false,
      alreadyQuitting: false,
      hasConsent: false,
      dirty: true,
      promptAlreadyOpen: true,
      schedule: () => calls.push('schedule'),
      run: () => calls.push('prompt'),
    });

    expect(arm).toBe('defer');
    expect(calls).toEqual(['prevent']);
  });

  it.each([
    ['suppressed', { suppressed: true, alreadyQuitting: false, hasConsent: false, dirty: true }],
    [
      'already quitting',
      { suppressed: false, alreadyQuitting: true, hasConsent: false, dirty: true },
    ],
    [
      'consent granted',
      { suppressed: false, alreadyQuitting: false, hasConsent: true, dirty: true },
    ],
    ['clean', { suppressed: false, alreadyQuitting: false, hasConsent: false, dirty: false }],
  ] as const)('allows close when the prompt is %s', (_label, flags) => {
    const { calls, event: closeEvent } = event();
    expect(
      armWindowClosePrompt({
        event: closeEvent,
        ...flags,
        promptAlreadyOpen: false,
        schedule: () => calls.push('schedule'),
        run: () => calls.push('prompt'),
      })
    ).toBe('allow');
    expect(calls).toEqual([]);
  });
});
