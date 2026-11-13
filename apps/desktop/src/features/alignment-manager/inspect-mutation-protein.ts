import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { getWorkspaceResidueSelectionsStore } from '../structure-drawer/public/state/selected-codon-registry';
import {
  clearStructureInspection,
  openStructureInspection,
} from '../structure-drawer/public/structure-inspection';
import type { Mutation, VerificationTrack } from './types';
import { buildMutationProteinContext } from './utils/mutation-protein-context';

export function inspectMutationProtein({
  sequence,
  documentId,
  mutation,
  track,
  sourceWorkspaceRoot,
}: {
  sequence: AnnotatedSequence;
  documentId: string;
  mutation: Mutation;
  track: Pick<VerificationTrack, 'id' | 'label'>;
  sourceWorkspaceRoot?: string;
}): string | undefined {
  const result = buildMutationProteinContext({
    sequence,
    documentId,
    mutation,
    trackId: track.id,
    trackLabel: track.label,
  });
  if (!result.ok) {
    clearStructureInspection(documentId, result.reason);
    return result.reason;
  }
  const selections = getWorkspaceResidueSelectionsStore(documentId);
  if (!selections)
    return 'The sequence viewer is not ready to select this protein residue. Reopen the sequence and try again.';
  if (sourceWorkspaceRoot) result.request.sourceWorkspaceRoot = sourceWorkspaceRoot;
  const error = openStructureInspection(result.request, result.selections);
  if (error) return error;
  selections.set(result.selections);
  return undefined;
}
