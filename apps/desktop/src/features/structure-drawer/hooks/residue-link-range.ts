import type { HoveredResidueKey } from '../state/hovered-residue-store';
import {
  hasStructureCodingBounds,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import { codonToBpRange } from '../utils/codon-residue-mapping';
import { linkedResidueIndexForStructureResidue } from '../utils/residue-target-mapping';

export function computeResidueLinkBpRange(
  hovered: HoveredResidueKey | null,
  links: Readonly<Record<string, StructureLinkEntry>>,
  documentId: string | null | undefined
): { id: string; start: number; end: number } | null {
  if (!hovered || !documentId) return null;
  const link = uniqueLinkForStructureAndDocument(links, hovered.structureId, documentId);
  if (!link || !hasStructureCodingBounds(link)) return null;

  const codonIndex = linkedResidueIndexForStructureResidue(link, hovered);
  if (codonIndex === null || codonIndex < 0) return null;

  const bpRange = codonToBpRange(codonIndex, {
    cdsStart: link.cdsStart,
    cdsEnd: link.cdsEnd,
    strand: link.strand,
  });
  if (!bpRange) return null;

  return {
    id: `residue-${hovered.structureId}-${hovered.chain}-${hovered.position}`,
    start: bpRange.start,
    end: bpRange.end,
  };
}

function uniqueLinkForStructureAndDocument(
  links: Readonly<Record<string, StructureLinkEntry>>,
  structureId: string,
  documentId: string
): StructureLinkEntry | null {
  const matches = Object.values(links).filter(
    (link) => link.structureId === structureId && link.sequenceDocumentId === documentId
  );
  if (matches.length !== 1) return null;
  return matches[0];
}
