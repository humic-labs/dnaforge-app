import type { RestrictionEnzyme } from '@waypoint/sequence-utils';
import { beginWorkflowAction, observeWorkflowAction } from '../../lib/workflow-telemetry';
import { createDigestWorkflow } from '../../features/assembly-panel/digest-workflow';

export function digestEnzyme(name = 'EcoRI', recognition = 'GAATTC'): RestrictionEnzyme {
  return {
    name,
    recognition_sequence: recognition,
    recognition_sequence_length: recognition.length,
    cut_position_top: 1,
    cut_position_bottom: 5,
    overhang_type: '5_prime',
    overhang_length: 4,
    enzyme_type: 'Type_II',
  } as RestrictionEnzyme;
}

export function digestTelemetryHarness() {
  let serial = 0;
  let context: string | null = 'capture-generation-1';
  let accepted = true;
  const events: Array<{ event: string; properties: Record<string, unknown> }> = [];
  const createId = () => `550e8400-e29b-41d4-a716-${String(++serial).padStart(12, '0')}`;
  const dependencies = {
    createId,
    now: () => 1_792_584_000_000 + serial,
    track: (event: string, properties: Record<string, unknown>) => {
      if (!accepted) return false;
      events.push({ event, properties });
      return true;
    },
    isIdentified: () => false,
  };
  const owner = createDigestWorkflow({
    createId,
    context: () => context,
    begin: (input) => beginWorkflowAction(input, dependencies),
    observe: (input) => observeWorkflowAction(input, dependencies),
  });
  return {
    owner,
    events,
    setCollectionAccepted: (next: boolean) => {
      accepted = next;
    },
    changeContext: (next: string | null) => {
      context = next;
    },
    results: (action: string) =>
      events.filter(
        ({ properties }) =>
          properties.workflow === 'digest' &&
          properties.workflow_action === action &&
          properties.action_phase !== 'start'
      ),
  };
}
