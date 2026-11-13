import { runWorkflowAction } from '../../lib/workflow-telemetry';
import { isFileAuthoritativePrimerInput } from './primer-artifact-service';
import type { SavedPrimerArtifact } from './primer-artifact-service';
import { recordPrimers } from './record-primers';
import type { CreatePrimerInput } from './types';

interface CompletePrimerBinding {
  targetDocumentId: string;
  targetFilePath: string;
  targetLength: number;
  targetTopology: 'linear' | 'circular';
  bindingSequenceId: number;
  bindingStart: number;
  bindingEnd: number;
  bindingStrand: 1 | -1;
}

function completeBinding(input: CreatePrimerInput): CompletePrimerBinding | null {
  if (
    typeof input.targetFilePath !== 'string' ||
    typeof input.targetDocumentId !== 'string' ||
    input.targetDocumentId.length === 0 ||
    typeof input.targetLength !== 'number' ||
    (input.targetTopology !== 'linear' && input.targetTopology !== 'circular') ||
    typeof input.bindingSequenceId !== 'number' ||
    typeof input.bindingStart !== 'number' ||
    typeof input.bindingEnd !== 'number' ||
    (input.bindingStrand !== 1 && input.bindingStrand !== -1)
  ) {
    return null;
  }
  return {
    targetDocumentId: input.targetDocumentId,
    targetFilePath: input.targetFilePath,
    targetLength: input.targetLength,
    targetTopology: input.targetTopology,
    bindingSequenceId: input.bindingSequenceId,
    bindingStart: input.bindingStart,
    bindingEnd: input.bindingEnd,
    bindingStrand: input.bindingStrand,
  };
}

function hasAnyBindingField(input: CreatePrimerInput): boolean {
  return (
    input.targetFilePath != null ||
    input.targetDocumentId != null ||
    input.targetLength != null ||
    input.targetTopology != null ||
    input.bindingSequenceId != null ||
    input.bindingStart != null ||
    input.bindingEnd != null ||
    input.bindingStrand != null
  );
}

export class PrimerCreationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrimerCreationError';
    this.code = code;
  }
}

export async function createFileAuthoritativePrimer(
  input: CreatePrimerInput
): Promise<SavedPrimerArtifact> {
  const actionId = crypto.randomUUID();
  const recorded = await runWorkflowAction(
    { workflow: 'primer', action: 'create', actionId, workflowOrigin: 'direct' },
    async () => {
      if (!isFileAuthoritativePrimerInput(input)) {
        throw new PrimerCreationError(
          'primer_no_save_location',
          'Primer creation requires a project save location.'
        );
      }
      const binding = completeBinding(input);
      if (hasAnyBindingField(input) && !binding) {
        throw new PrimerCreationError(
          'primer_binding_incomplete',
          'Primer binding metadata is incomplete; select the target range again.'
        );
      }
      const result = await recordPrimers({
        primers: [
          {
            name: input.name,
            sequence: input.sequence,
            oligo: input.oligo,
            application: input.application,
            notes: input.notes,
            entitySchema: input.entitySchema,
            entityFields: input.entityFields,
            artifactPath: input.artifactPath,
            workspaceId: input.workspaceId,
            ...(binding ? { binding } : {}),
          },
        ],
        workspaceRoot: input.workspaceRoot,
        origin: input.origin ?? 'manual',
        deferCommit: false,
        parentActionId: actionId,
      });
      const failure = result.failed[0];
      if (failure) {
        throw new PrimerCreationError(
          failure.reason === 'error' ? 'primer_record_failed' : `primer_${failure.reason}`,
          failure.message
        );
      }
      return result;
    },
    (result) => {
      const created = result.recorded.filter((saved) => saved.created).length;
      return {
        status: created > 0 ? 'created' : 'success',
        outcomeKind: created > 0 ? 'record_created' : 'record_existing',
        recordWriteStatus: created > 0 ? 'written' : 'existing',
        affectedCount: created,
        artifactCorrelationId: result.recorded[0]?.artifact.id,
      };
    }
  );

  const saved = recorded.recorded[0];
  if (!saved) {
    throw new PrimerCreationError(
      'primer_no_artifact',
      'Primer creation did not produce an authoritative artifact.'
    );
  }
  return saved;
}
