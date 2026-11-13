export function scheduleAfterCurrentEvent(run: () => void): void {
  setImmediate(run);
}

export function quitPromptSuppressed(
  isPackaged: boolean,
  waypointTest: string | undefined
): boolean {
  return !isPackaged && waypointTest === '1';
}

export type QuitArm = 'bypass' | 'already-quitting' | 'armed';

export function armQuitOrchestration(options: {
  event: { preventDefault(): void };
  alreadyQuitting: boolean;
  bypass: boolean;
  schedule: (run: () => void) => void;
  run: () => void;
}): QuitArm {
  if (options.bypass) return 'bypass';
  if (options.alreadyQuitting) return 'already-quitting';
  options.event.preventDefault();
  options.schedule(options.run);
  return 'armed';
}

export type CloseArm = 'allow' | 'defer';

export function armWindowClosePrompt(options: {
  event: { preventDefault(): void };
  suppressed: boolean;
  alreadyQuitting: boolean;
  hasConsent: boolean;
  dirty: boolean;
  promptAlreadyOpen: boolean;
  schedule: (run: () => void) => void;
  run: () => void;
}): CloseArm {
  if (options.suppressed || options.alreadyQuitting || options.hasConsent || !options.dirty) {
    return 'allow';
  }
  options.event.preventDefault();
  if (!options.promptAlreadyOpen) options.schedule(options.run);
  return 'defer';
}
