import { describe, expect, it } from 'vitest';
import { createQuitPromptBinding, type QuitPromptWindow } from './quit-prompt-binding';

interface Harness {
  calls: string[];
  quitting: () => boolean;
  binding: ReturnType<typeof createQuitPromptBinding>;
  flush: () => void;
  dirty: { hasDirtyWork: boolean; details: string };
  consent: boolean;
  dialogChoice: 'proceed' | 'cancel';
  win: QuitPromptWindow & { destroyed: boolean; visible: boolean };
}

function harness(options?: { suppressed?: boolean; cutover?: boolean }): Harness {
  const calls: string[] = [];
  const queued: Array<() => void> = [];
  const state = {
    dirty: { hasDirtyWork: true, details: '2 sequences' },
    consent: false,
    dialogChoice: 'cancel' as 'proceed' | 'cancel',
    win: {
      destroyed: false,
      visible: true,
      isDestroyed: () => state.win.destroyed,
      show: () => {
        state.win.visible = true;
        calls.push('show');
      },
      hide: () => {
        state.win.visible = false;
        calls.push('hide');
      },
      focus: () => calls.push('focus'),
      destroy: () => {
        state.win.destroyed = true;
        calls.push('destroy');
      },
    },
  };
  const binding = createQuitPromptBinding({
    isSuppressed: () => options?.suppressed ?? false,
    isCutoverBuild: () => options?.cutover ?? false,
    getDirty: () => state.dirty,
    isUpdateStaged: () => false,
    hasConsent: () => state.consent,
    grantConsent: () => {
      state.consent = true;
      calls.push('consent');
    },
    showDialog: async (win) => {
      calls.push(
        win && !win.isDestroyed() && state.win.visible ? 'dialog-visible' : 'dialog-hidden'
      );
      return state.dialogChoice;
    },
    getWindow: () => state.win,
    schedule: (run) => queued.push(run),
    runQuit: async (controls) => {
      calls.push('freeze');
      controls.freezeRenderer();
      if (!state.consent && state.dirty.hasDirtyWork) {
        const decision = await bindingDepsShow(controls);
        if (decision === 'cancel') {
          controls.restoreRenderer();
          calls.push('cancelled');
          return { cancelled: true };
        }
        state.consent = true;
      }
      controls.concealRenderer();
      calls.push('teardown');
      return { cancelled: false };
    },
  });

  async function bindingDepsShow(
    controls: Parameters<Parameters<typeof createQuitPromptBinding>[0]['runQuit']>[0]
  ): Promise<'proceed' | 'cancel'> {
    void controls;
    calls.push(
      state.win.visible && !state.win.destroyed ? 'quit-dialog-visible' : 'quit-dialog-hidden'
    );
    return state.dialogChoice;
  }

  return {
    calls,
    quitting: () => binding.isQuitting(),
    binding,
    flush: () => {
      const run = queued.shift();
      run?.();
    },
    get dirty() {
      return state.dirty;
    },
    set dirty(value) {
      state.dirty = value;
    },
    get consent() {
      return state.consent;
    },
    set consent(value) {
      state.consent = value;
    },
    get dialogChoice() {
      return state.dialogChoice;
    },
    set dialogChoice(value) {
      state.dialogChoice = value;
    },
    win: state.win,
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('quit prompt binding', () => {
  it('shows the quit dialog before hiding the window and keeps the app on cancel', async () => {
    const h = harness();
    const event = { preventDefault: () => h.calls.push('prevent') };
    h.binding.onBeforeQuit(event);
    expect(h.calls).toEqual(['prevent']);
    expect(h.quitting()).toBe(true);
    h.flush();
    await drain();
    expect(h.calls).toEqual([
      'prevent',
      'freeze',
      'quit-dialog-visible',
      'show',
      'focus',
      'cancelled',
    ]);
    expect(h.quitting()).toBe(false);
    expect(h.win.visible).toBe(true);
    expect(h.win.destroyed).toBe(false);
  });

  it('hides the window only after Close Anyway', async () => {
    const h = harness();
    h.dialogChoice = 'proceed';
    h.binding.onBeforeQuit({ preventDefault: () => h.calls.push('prevent') });
    h.flush();
    await drain();
    expect(h.calls).toEqual(['prevent', 'freeze', 'quit-dialog-visible', 'hide', 'teardown']);
    expect(h.quitting()).toBe(true);
    expect(h.win.destroyed).toBe(false);
  });

  it('does not open the dialog inside the close listener', async () => {
    const h = harness();
    h.binding.onWindowClose({ preventDefault: () => h.calls.push('prevent') }, h.win);
    expect(h.calls).toEqual(['prevent']);
    expect(h.win.destroyed).toBe(false);
    h.flush();
    await drain();
    expect(h.calls).toEqual(['prevent', 'dialog-visible']);
    expect(h.win.visible).toBe(true);
    expect(h.win.destroyed).toBe(false);
  });

  it('destroys the window only after the user confirms close', async () => {
    const h = harness();
    h.dialogChoice = 'proceed';
    h.binding.onWindowClose({ preventDefault: () => h.calls.push('prevent') }, h.win);
    h.flush();
    await drain();
    expect(h.calls).toEqual(['prevent', 'dialog-visible', 'consent', 'destroy']);
    expect(h.consent).toBe(true);
    expect(h.win.destroyed).toBe(true);
  });

  it('does not stack a second close dialog', () => {
    const h = harness();
    h.binding.onWindowClose({ preventDefault: () => h.calls.push('prevent') }, h.win);
    h.binding.onWindowClose({ preventDefault: () => h.calls.push('prevent-2') }, h.win);
    expect(h.calls.filter((call) => call.startsWith('prevent'))).toEqual(['prevent', 'prevent-2']);
    h.flush();
    h.flush();
    expect(h.calls.filter((call) => call.startsWith('dialog'))).toHaveLength(1);
  });

  it('lets a clean, consented, quitting, or test close finish', () => {
    const clean = harness();
    clean.dirty = { hasDirtyWork: false, details: '' };
    clean.binding.onWindowClose({ preventDefault: () => clean.calls.push('prevent') }, clean.win);
    expect(clean.calls).toEqual([]);

    const consented = harness();
    consented.consent = true;
    consented.binding.onWindowClose(
      { preventDefault: () => consented.calls.push('prevent') },
      consented.win
    );
    expect(consented.calls).toEqual([]);

    const suppressed = harness({ suppressed: true });
    suppressed.binding.onWindowClose(
      { preventDefault: () => suppressed.calls.push('prevent') },
      suppressed.win
    );
    expect(suppressed.calls).toEqual([]);

    const cutover = harness({ cutover: true });
    cutover.binding.onBeforeQuit({ preventDefault: () => cutover.calls.push('prevent') });
    expect(cutover.calls).toEqual([]);
    expect(cutover.quitting()).toBe(false);
  });

  it('blocks a second quit and window close while consent is still pending', async () => {
    const h = harness();
    h.binding.onBeforeQuit({ preventDefault: () => h.calls.push('prevent') });
    h.binding.onBeforeQuit({ preventDefault: () => h.calls.push('prevent-quit-2') });
    h.binding.onWindowClose({ preventDefault: () => h.calls.push('prevent-close') }, h.win);
    expect(h.calls).toEqual(['prevent', 'prevent-quit-2', 'prevent-close']);
    h.flush();
    await drain();
    expect(h.quitting()).toBe(false);
    expect(h.win.visible).toBe(true);
    expect(h.win.destroyed).toBe(false);
    expect(h.calls).not.toContain('teardown');
  });

  it('lets the authorized quit close the window after explicit discard', async () => {
    const h = harness();
    h.dialogChoice = 'proceed';
    h.binding.onBeforeQuit({ preventDefault: () => h.calls.push('prevent') });
    h.flush();
    await drain();
    h.binding.onBeforeQuit({ preventDefault: () => h.calls.push('unexpected-prevent-quit') });
    h.binding.onWindowClose(
      { preventDefault: () => h.calls.push('unexpected-prevent-close') },
      h.win
    );
    expect(h.calls).not.toContain('unexpected-prevent-quit');
    expect(h.calls).not.toContain('unexpected-prevent-close');
    expect(h.quitting()).toBe(true);
  });
});
