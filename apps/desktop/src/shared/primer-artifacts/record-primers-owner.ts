import type { PrimerApplication, PrimerOrigin } from './types';
import { defaultPrimerArtifactPath, type PrimerEntitySchemaSnapshot } from './primer-artifact';
import type { PrimerAnnealingSegment } from './primer-artifact';
import type { PrimerOligoCompositionV1 } from './oligo-modifications';
import {
  PrimerHistoryError,
  PrimerProjectionError,
  type FileAuthoritativePrimerInput,
  type SavedPrimerArtifact,
  type PrimerArtifactPersistencePort,
} from './primer-artifact-owner';
import type { WorkspaceMutationRunner } from '../artifact-operation-ports';
export interface RecordablePrimer {
  artifactId?: string;
  name: string;
  sequence: string;

  oligo?: PrimerOligoCompositionV1;
  annealing?: PrimerAnnealingSegment;

  tm?: number;
  application?: PrimerApplication;
  notes?: string | null;
  entitySchema?: PrimerEntitySchemaSnapshot;
  entityFields?: Record<string, unknown>;

  artifactStem?: string;

  artifactPath?: string;
  workspaceId?: number;

  binding?: {
    targetDocumentId: string;
    targetFilePath: string;
    targetLength: number;
    targetTopology: 'linear' | 'circular';
    bindingSequenceId: number;
    bindingStart: number;
    bindingEnd: number;
    bindingStrand: 1 | -1;
  };
}

export interface RecordPrimersInput {
  primers: RecordablePrimer[];
  workspaceRoot: string;
  origin: PrimerOrigin;

  deferCommit?: boolean;

  mutationToken?: string;

  parentActionId?: string;
}

export type RecordPrimerFailureReason = 'path-collision' | 'projection' | 'history' | 'error';

export interface RecordPrimersResult {
  recorded: SavedPrimerArtifact[];
  skipped: { input: RecordablePrimer; reason: 'duplicate' }[];
  failed: {
    input: RecordablePrimer;
    reason: RecordPrimerFailureReason;
    message: string;
    artifactPath?: string;
  }[];
}
export interface createPrimerRecorderDependencies {
  primerServices: {
    persistence: Pick<PrimerArtifactPersistencePort, 'writeAndProjectArtifact' | 'saveArtifact'>;
  };
  withRendererWorkspaceMutation: WorkspaceMutationRunner;
}
export function createPrimerRecorder(dependencies: createPrimerRecorderDependencies) {
  const { primerServices, withRendererWorkspaceMutation } = dependencies;
  function toFileAuthoritativeInput(
    primer: RecordablePrimer,
    workspaceRoot: string,
    origin: PrimerOrigin
  ): FileAuthoritativePrimerInput {
    const artifactPath =
      primer.artifactPath ??
      defaultPrimerArtifactPath(workspaceRoot, primer.artifactStem ?? primer.name);
    return {
      name: primer.name,
      artifactId: primer.artifactId,
      sequence: primer.sequence,
      oligo: primer.oligo,
      ...(primer.annealing ? { annealing: primer.annealing } : {}),
      artifactPath,
      workspaceRoot,
      requireRegistry: true,
      origin,
      application: primer.application,
      notes: primer.notes ?? undefined,
      entitySchema: primer.entitySchema,
      entityFields: primer.entityFields,
      workspaceId: primer.workspaceId,
      ...(primer.binding
        ? {
            targetFilePath: primer.binding.targetFilePath,
            targetDocumentId: primer.binding.targetDocumentId,
            targetLength: primer.binding.targetLength,
            targetTopology: primer.binding.targetTopology,
            bindingSequenceId: primer.binding.bindingSequenceId,
            bindingStart: primer.binding.bindingStart,
            bindingEnd: primer.binding.bindingEnd,
            bindingStrand: primer.binding.bindingStrand,
          }
        : {}),
    };
  }

  function classifyFailure(error: unknown): {
    reason: RecordPrimerFailureReason;
    message: string;
    artifactPath?: string;
  } {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof PrimerProjectionError)
      return { reason: 'projection', message, artifactPath: error.artifactPath };
    if (error instanceof PrimerHistoryError)
      return { reason: 'history', message, artifactPath: error.artifactPath };
    if (/already exists/i.test(message)) return { reason: 'path-collision', message };
    return { reason: 'error', message };
  }

  async function recordPrimers(input: RecordPrimersInput): Promise<RecordPrimersResult> {
    return withRendererWorkspaceMutation(
      input.workspaceRoot,
      (mutationToken) => recordPrimersInMutation(input, mutationToken),
      input.mutationToken
    );
  }

  async function recordPrimersInMutation(
    input: RecordPrimersInput,
    mutationToken?: string
  ): Promise<RecordPrimersResult> {
    const result: RecordPrimersResult = { recorded: [], skipped: [], failed: [] };
    const deferCommit = input.deferCommit ?? false;

    for (const primer of input.primers) {
      try {
        const fileInput = toFileAuthoritativeInput(primer, input.workspaceRoot, input.origin);
        if (deferCommit) {
          const written = await primerServices.persistence.writeAndProjectArtifact(fileInput, {
            mutationToken,
            parentActionId: input.parentActionId,
          });
          if (written.created) {
            result.recorded.push({
              artifactPath: written.artifactPath,
              artifact: written.artifact,
              limsEntity: written.limsEntity,
              primer: written.primer,
              gitCommitted: false,
              created: true,
            });
          } else {
            result.skipped.push({ input: primer, reason: 'duplicate' });
          }
        } else {
          result.recorded.push(
            await primerServices.persistence.saveArtifact(fileInput, {
              mutationToken,
              parentActionId: input.parentActionId,
            })
          );
        }
      } catch (error) {
        result.failed.push({ input: primer, ...classifyFailure(error) });
      }
    }

    return result;
  }
  return { recordPrimers };
}
