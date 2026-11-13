import type { HoveredResidueKey } from '../state/hovered-residue-store';
import {
  hasStructureCodingBounds,
  type StructureLinkEntry,
} from '../state/use-structure-link-registry';
import { bpToCodonIndex } from './codon-residue-mapping';
import { structureResiduesForLinkedResidueIndex } from './residue-target-mapping';

export interface SequenceCodonHover {
  start: number;
  end: number;
  strand: 1 | -1;
}

export function hoveredResidueForSequenceCodon(
  codon: SequenceCodonHover,
  entityId: string,
  links: Record<string, StructureLinkEntry>
): HoveredResidueKey | null {
  for (const id in links) {
    const link = links[id];
    if (!hasStructureCodingBounds(link)) continue;
    if (link.sequenceDocumentId !== entityId) continue;
    if (link.strand !== codon.strand) continue;
    if (codon.start < link.cdsStart || codon.end > link.cdsEnd) continue;
    const codonIndex = bpToCodonIndex(codon.start, {
      cdsStart: link.cdsStart,
      cdsEnd: link.cdsEnd,
      strand: link.strand,
    });
    if (codonIndex == null) continue;
    const target = structureResiduesForLinkedResidueIndex(link, codonIndex)[0];
    if (!target) continue;
    return {
      structureId: link.structureId,
      chain: target.chain,
      position: target.position,
      ...(target.baseChain ? { baseChain: target.baseChain } : {}),
      ...(target.labelAsymId ? { labelAsymId: target.labelAsymId } : {}),
      ...(target.authAsymId ? { authAsymId: target.authAsymId } : {}),
      ...(target.entityId ? { entityId: target.entityId } : {}),
      ...(target.labelSeqId !== undefined ? { labelSeqId: target.labelSeqId } : {}),
      ...(target.operator ? { operator: target.operator } : {}),
    };
  }
  return null;
}
