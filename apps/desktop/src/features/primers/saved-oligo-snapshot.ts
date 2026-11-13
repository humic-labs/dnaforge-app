import { tmModelLabel } from '../design/public/algorithms/tm-model';
import type { SavedOligoSnapshot } from '../design/public/saved-primer-links';
import type { PrimerArtifactV1 } from './primer-artifact';

export function savedOligoSnapshot(artifact: PrimerArtifactV1): SavedOligoSnapshot {
  const tm = artifact.computed.tmCalculation;
  return {
    oligoId: artifact.id,
    catalogNumber: artifact.catalogNumber,
    name: artifact.name,
    bases: artifact.sequence.bases,
    sequenceContentHash: artifact.sequence.contentHash,
    artifactRevision: artifact.artifactRevision,
    chemistry: artifact.oligo ?? null,
    bindingSequence:
      artifact.annealing?.pbsSequence ?? artifact.designProvenance?.pbsSequence ?? null,
    tmC: artifact.computed.tmC,
    tmConcentrationNm: tm?.provider.conc_nM ?? null,
    tmModelLabel: tm ? tmModelLabel(tm.model) : null,
    bindings: artifact.bindings.map((binding) => ({
      id: binding.id,
      documentId: binding.target.documentId,
      start: binding.coordinates.start,
      end: binding.coordinates.end,
      strand: binding.coordinates.strand,
      placement: binding.source,
      confirmed: Boolean(binding.alignment),
      sourceDigest: binding.target.normalizedSequenceHash || null,
    })),
  };
}
