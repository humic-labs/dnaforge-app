import { listFinalizedAssemblyConstructIds } from '../../db/workspace-catalog';
import { pathIsAtOrUnder } from '../../shared/path-boundary';
import type { AssemblyMethod, DesignPrimer } from '../design/public/assembly-contract';
import { acceptedAssemblyVersionFromSidecar } from './accepted-reopen';
import {
  resolveAcceptedAssemblyRecord,
  type AcceptedRecordSelector,
  type ResolvedAcceptedAssemblyRecord,
} from './accepted-record-reader';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';

export interface AcceptedAssemblyOligoPrimerUse {
  primerId: string;
  primerName: string | null;
  partNumber: number | null;
  direction: 'forward' | 'reverse' | null;
  artifactRevision: number;
  sequenceContentHash: string;
  sequence: string | null;
  bindingSequence: string | null;
  tailSequence: string | null;
}

export interface AcceptedAssemblyOligoUse {
  constructId: string;
  packageId: string;
  packageRoot: string;
  acceptedAssemblyVersionId: string;
  designId: string;
  designName: string;
  acceptedAt: string;
  assemblyMethod: AssemblyMethod;
  isCurrentAccepted: boolean;
  primers: readonly AcceptedAssemblyOligoPrimerUse[];
}

export interface AcceptedAssemblyOligoUseFailure {
  constructId: string;
  message: string;
}

export interface AcceptedAssemblyOligoUsesReport {
  uses: readonly AcceptedAssemblyOligoUse[];
  unreadable: readonly AcceptedAssemblyOligoUseFailure[];
}

export interface AcceptedAssemblyOligoUsesInput {
  oligoId: string;
  workspaceRoot?: string | null;
}

export interface AcceptedAssemblyOligoUsesDeps {
  listFinalizedConstructIds(): Promise<readonly string[]>;
  resolveRecord(selector: AcceptedRecordSelector): Promise<ResolvedAcceptedAssemblyRecord>;
}

export const DEFAULT_ACCEPTED_ASSEMBLY_OLIGO_USES_DEPS: AcceptedAssemblyOligoUsesDeps = {
  listFinalizedConstructIds: listFinalizedAssemblyConstructIds,
  resolveRecord: (selector) => resolveAcceptedAssemblyRecord(selector),
};

export async function acceptedAssemblyUsesOfOligo(
  input: AcceptedAssemblyOligoUsesInput,
  deps: AcceptedAssemblyOligoUsesDeps = DEFAULT_ACCEPTED_ASSEMBLY_OLIGO_USES_DEPS
): Promise<AcceptedAssemblyOligoUsesReport> {
  if (!input.oligoId) return { uses: [], unreadable: [] };
  let constructIds: readonly string[];
  try {
    constructIds = await deps.listFinalizedConstructIds();
  } catch {
    return { uses: [], unreadable: [] };
  }

  const uses: AcceptedAssemblyOligoUse[] = [];
  const unreadable: AcceptedAssemblyOligoUseFailure[] = [];
  for (const constructId of constructIds) {
    try {
      const record = await deps.resolveRecord({ constructId });
      if (input.workspaceRoot && !pathIsAtOrUnder(record.packageRoot, input.workspaceRoot)) {
        continue;
      }
      uses.push(...usesInRecord(input.oligoId, record));
    } catch (error) {
      unreadable.push({ constructId, message: failureMessage(error) });
    }
  }
  return { uses: uses.sort(compareUses), unreadable };
}

function usesInRecord(
  oligoId: string,
  record: ResolvedAcceptedAssemblyRecord
): AcceptedAssemblyOligoUse[] {
  const currentAcceptedId = record.recordIsCurrent ? record.acceptedAssemblyVersionId : null;
  const uses: AcceptedAssemblyOligoUse[] = [];
  for (const payload of record.acceptedRecords) {
    const primers = primerUsesOfOligo(oligoId, payload);
    if (primers.length === 0) continue;
    const acceptedAssemblyVersionId = acceptedAssemblyVersionFromSidecar(payload).id;
    uses.push({
      constructId: record.constructId,
      packageId: record.packageId,
      packageRoot: record.packageRoot,
      acceptedAssemblyVersionId,
      designId: payload.projectionInput.designId,
      designName: payload.designName,
      acceptedAt: payload.acceptedAt,
      assemblyMethod: payload.construction.method,
      isCurrentAccepted: acceptedAssemblyVersionId === currentAcceptedId,
      primers,
    });
  }
  return uses;
}

function primerUsesOfOligo(
  oligoId: string,
  payload: AcceptedAssemblySidecarPayload
): AcceptedAssemblyOligoPrimerUse[] {
  const designPrimers = new Map<string, DesignPrimer>();
  for (const pair of payload.projectionInput.designPrimers) {
    designPrimers.set(pair.forward.id, pair.forward);
    designPrimers.set(pair.reverse.id, pair.reverse);
  }
  return (payload.savedPrimerOligos ?? [])
    .filter((entry) => entry.oligoId === oligoId)
    .map((entry) => {
      const primer = designPrimers.get(entry.primerId) ?? null;
      const sequence = primer ? primer.sequence.trim() : null;
      const bindingSequence = primer ? primer.pbs.sequence.trim() : null;
      return {
        primerId: entry.primerId,
        primerName: primer ? primer.name : null,
        partNumber: primer ? primer.fragmentIndex + 1 : null,
        direction: primer ? primer.direction : null,
        artifactRevision: entry.artifactRevision,
        sequenceContentHash: entry.sequenceContentHash,
        sequence,
        bindingSequence,
        tailSequence:
          sequence === null || bindingSequence === null
            ? null
            : sequence.slice(0, Math.max(0, sequence.length - bindingSequence.length)),
      };
    })
    .sort(comparePrimerUses);
}

function compareUses(left: AcceptedAssemblyOligoUse, right: AcceptedAssemblyOligoUse): number {
  return (
    right.acceptedAt.localeCompare(left.acceptedAt) ||
    left.designName.localeCompare(right.designName) ||
    left.packageRoot.localeCompare(right.packageRoot) ||
    left.acceptedAssemblyVersionId.localeCompare(right.acceptedAssemblyVersionId)
  );
}

function comparePrimerUses(
  left: AcceptedAssemblyOligoPrimerUse,
  right: AcceptedAssemblyOligoPrimerUse
): number {
  return (
    (left.partNumber ?? Number.MAX_SAFE_INTEGER) - (right.partNumber ?? Number.MAX_SAFE_INTEGER) ||
    (left.direction ?? '').localeCompare(right.direction ?? '') ||
    left.primerId.localeCompare(right.primerId)
  );
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
