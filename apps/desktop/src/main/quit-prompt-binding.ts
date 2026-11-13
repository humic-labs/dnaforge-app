import {
  armQuitOrchestration,
  armWindowClosePrompt,
  scheduleAfterCurrentEvent,
} from './quit-prompt-timing';

export interface QuitPromptWindow {
  isDestroyed(): boolean;
  show?: () => void;
  hide?: () => void;
  focus?: () => void;
  destroy?: () => void;
}

export interface QuitPromptControls {
  freezeRenderer: () => void;
  restoreRenderer: () => void;
  concealRenderer: () => void;
}

export interface QuitPromptBindingDeps {
  isSuppressed: () => boolean;
  isCutoverBuild: () => boolean;
  getDirty: () => { hasDirtyWork: boolean; details: string };
  readDirty?: () => Promise<{ hasDirtyWork: boolean; details: string }>;
  isUpdateStaged: () => boolean;
  hasConsent: () => boolean;
  grantConsent: () => void;
  showDialog: (
    win: QuitPromptWindow | null,
    opts: { staged: boolean; details: string }
  ) => Promise<'proceed' | 'cancel'>;
  getWindow: () => QuitPromptWindow | null;
  runQuit: (controls: QuitPromptControls) => Promise<{ cancelled: boolean }>;
  onQuitSettled?: (result: { cancelled: boolean }) => void;
  onQuitFailed?: (err: unknown) => void;
  schedule?: (run: () => void) => void;
}

export interface QuitPromptBinding {
  onWindowClose(event: { preventDefault(): void }, win: QuitPromptWindow): void;
  onBeforeQuit(event: { preventDefault(): void }): void;
  isQuitting(): boolean;
}

function liveWindow(win: QuitPromptWindow | null): QuitPromptWindow | null {
  if (!win || win.isDestroyed()) return null;
  return win;
}

function showWindow(win: QuitPromptWindow | null): void {
  const live = liveWindow(win);
  if (!live || typeof live.show !== 'function') return;
  live.show();
  if (typeof live.focus === 'function') live.focus();
}

function hideWindow(win: QuitPromptWindow | null): void {
  const live = liveWindow(win);
  if (!live || typeof live.hide !== 'function') return;
  live.hide();
}

export function createQuitPromptBinding(deps: QuitPromptBindingDeps): QuitPromptBinding {
  let quitPhase: 'working' | 'pending' | 'authorized' = 'working';
  let closePromptPhase: 'idle' | 'pending' = 'idle';
  const schedule = deps.schedule ?? scheduleAfterCurrentEvent;
  const controls: QuitPromptControls = {
    freezeRenderer() {},
    restoreRenderer() {
      showWindow(deps.getWindow());
    },
    concealRenderer() {
      quitPhase = 'authorized';
      hideWindow(deps.getWindow());
    },
  };

  async function presentClosePrompt(win: QuitPromptWindow): Promise<void> {
    try {
      if (win.isDestroyed() || quitPhase !== 'working') return;
      let dirty: { hasDirtyWork: boolean; details: string };
      try {
        dirty = deps.readDirty ? await deps.readDirty() : deps.getDirty();
      } catch {
        dirty = {
          hasDirtyWork: true,
          details: 'open documents',
        };
      }
      if (win.isDestroyed() || quitPhase !== 'working') return;
      if (!dirty.hasDirtyWork) {
        deps.grantConsent();
        win.destroy?.();
        return;
      }
      const decision = await deps.showDialog(win, {
        staged: deps.isUpdateStaged(),
        details: dirty.details,
      });
      if (decision === 'cancel' || win.isDestroyed() || quitPhase !== 'working') return;
      deps.grantConsent();
      win.destroy?.();
    } finally {
      closePromptPhase = 'idle';
    }
  }

  return {
    isQuitting: () => quitPhase !== 'working',
    onWindowClose(event, win) {
      if (quitPhase === 'pending') {
        event.preventDefault();
        return;
      }
      const arm = armWindowClosePrompt({
        event,
        suppressed: deps.isSuppressed(),
        alreadyQuitting: quitPhase !== 'working',
        hasConsent: deps.hasConsent(),
        dirty: deps.readDirty ? true : deps.getDirty().hasDirtyWork,
        promptAlreadyOpen: closePromptPhase === 'pending',
        schedule,
        run: () => {
          void presentClosePrompt(win);
        },
      });
      if (arm === 'defer') closePromptPhase = 'pending';
    },
    onBeforeQuit(event) {
      if (quitPhase === 'pending') {
        event.preventDefault();
        return;
      }
      const arm = armQuitOrchestration({
        event,
        alreadyQuitting: quitPhase !== 'working',
        bypass: deps.isCutoverBuild(),
        schedule,
        run: () => {
          try {
            Promise.resolve(deps.runQuit(controls))
              .then((result) => {
                if (result.cancelled) {
                  quitPhase = 'working';
                }
                deps.onQuitSettled?.(result);
              })
              .catch((err: unknown) => {
                deps.onQuitFailed?.(err);
              });
          } catch (err) {
            deps.onQuitFailed?.(err);
          }
        },
      });
      if (arm === 'armed' && quitPhase === 'working') quitPhase = 'pending';
    },
  };
}
