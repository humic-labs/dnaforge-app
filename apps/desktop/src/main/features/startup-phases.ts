export const STARTUP_PHASES = [
  'working-directory',
  'features-loaded',
  'features-prepared',
  'feature-ipc-registered',
  'main-window-ready',
] as const;

export type StartupPhase = (typeof STARTUP_PHASES)[number];

export interface StartupPhaseRecord {
  readonly phase: StartupPhase;
  readonly at: number;
}

const reached: StartupPhaseRecord[] = [];

export function markStartupPhase(phase: StartupPhase, at: number = Date.now()): void {
  const expected = STARTUP_PHASES[reached.length];
  if (phase !== expected) {
    const sofar = reached.map((record) => record.phase).join(' → ') || 'none';
    throw new Error(
      `Startup phase "${phase}" ran out of order. Phases must run as ${STARTUP_PHASES.join(' → ')}; reached so far: ${sofar}.`
    );
  }
  reached.push({ phase, at });
}

export function startupPhaseLog(): readonly StartupPhaseRecord[] {
  return [...reached];
}

export function formatStartupPhases(records: readonly StartupPhaseRecord[] = reached): string {
  return `startup_phases ${records.map((record) => record.phase).join(' ')}`;
}

export function enforcesStartupPhases(): boolean {
  return Boolean(process.versions.electron) && process.type === 'browser';
}

export function resetStartupPhasesForTest(): void {
  reached.length = 0;
}
