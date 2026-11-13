// @vitest-environment node

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { AssemblyState } from '../design/types';
import type { AssemblyCommand } from './commands';
import { ASSEMBLY_COMMAND_TYPES } from './commands';
import { ASSEMBLY_STATES, transitionAssemblyState } from './state-machine';

const commandFor = (type: AssemblyCommand['type']): Pick<AssemblyCommand, 'type'> => ({ type });

describe('assembly state machine', () => {
  it('returns a legal result for any state and command without throwing', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ASSEMBLY_STATES),
        fc.constantFrom(...ASSEMBLY_COMMAND_TYPES),
        (state, type) => {
          const result = transitionAssemblyState(state, commandFor(type));

          if (result.ok) {
            expect(ASSEMBLY_STATES).toContain(result.value.next);
            expect(result.value.sideEffects.every((effect) => effect.type)).toBe(true);
          } else {
            expect(['bad_input', 'state_conflict']).toContain(result.error.kind);
          }
        }
      )
    );
  });

  it('aborts pending validation when an edit arrives mid-validation', () => {
    const result = transitionAssemblyState('validating', commandFor('addFragment'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.next).toBe('drafting');
      expect(result.value.sideEffects).toContainEqual({ type: 'abort_pending' });
    }
  });

  it('deduplicates double validate while validation is already pending', () => {
    const result = transitionAssemblyState('validating', commandFor('validate'), {
      pendingDispatchId: 'dispatch-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('state_conflict');
    }
  });

  it('refuses run from assembled', () => {
    expectConflict('assembled', 'run');
  });

  it('refuses run from preflight', () => {
    expectConflict('preflight', 'run');
  });

  it('refuses validate while another validate is pending', () => {
    const result = transitionAssemblyState('drafting', commandFor('validate'), {
      pendingDispatchId: 'dispatch-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('state_conflict');
    }
  });

  it('aborts an in-flight run when reset arrives', () => {
    const result = transitionAssemblyState('running', commandFor('reset'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.next).toBe('preflight');
      expect(result.value.sideEffects).toContainEqual({ type: 'abort_pending' });
    }
  });
});

function expectConflict(state: AssemblyState, type: AssemblyCommand['type']) {
  const result = transitionAssemblyState(state, commandFor(type));

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.kind).toBe('state_conflict');
    expect(result.error.currentState).toBe(state);
  }
}
