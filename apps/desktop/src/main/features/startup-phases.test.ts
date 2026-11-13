// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatStartupPhases,
  markStartupPhase,
  resetStartupPhasesForTest,
  STARTUP_PHASES,
  startupPhaseLog,
} from './startup-phases';

afterEach(() => resetStartupPhasesForTest());

describe('main process startup phases', () => {
  it('records each phase in order for the boot log', () => {
    STARTUP_PHASES.forEach((phase, index) => markStartupPhase(phase, index + 1));
    expect(startupPhaseLog()).toEqual(
      STARTUP_PHASES.map((phase, index) => ({ phase, at: index + 1 }))
    );
    expect(formatStartupPhases()).toBe(
      'startup_phases working-directory features-loaded features-prepared feature-ipc-registered main-window-ready'
    );
  });

  it('REJECTS loading the feature list before background-launch-cwd, naming the phase order', () => {
    expect(() => markStartupPhase('features-loaded')).toThrow(
      'Startup phase "features-loaded" ran out of order. Phases must run as working-directory → features-loaded → features-prepared → feature-ipc-registered → main-window-ready; reached so far: none.'
    );
  });

  it('rejects a phase that repeats or skips ahead', () => {
    markStartupPhase('working-directory');
    expect(() => markStartupPhase('working-directory')).toThrow(
      /reached so far: working-directory/
    );
    expect(() => markStartupPhase('feature-ipc-registered')).toThrow(/ran out of order/);
  });

  it('main/index.ts imports background-launch-cwd before anything that loads the feature list', () => {
    const source = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
    const cwd = source.indexOf("import './background-launch-cwd';");
    expect(cwd).toBeGreaterThan(-1);
    for (const specifier of ["from './ipc'", "from './features'"]) {
      const at = source.indexOf(specifier);
      expect(at, specifier).toBeGreaterThan(cwd);
    }
    expect(STARTUP_PHASES[0]).toBe('working-directory');
  });
});
