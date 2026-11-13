import { describe, expect, it } from 'vitest';
import type { DesignRegion, SequenceDesign } from '../design/public/types';
import { computeDraftAssembly } from '../design/public/algorithms/draft-assembly';
import { createAppTmCalculator } from './settings';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';

function draftedDesign(): SequenceDesign {
  const region = (id: string, sequence: string): DesignRegion => ({
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  });
  const design: SequenceDesign = {
    id: 'homology-pbs-restoration',
    name: 'Homology PBS restoration',
    topology: 'circular',
    regions: [region('left', 'ACGT'.repeat(60)), region('right', 'TGCA'.repeat(60))],
    spacers: [{ id: 'spacer', junctionIndex: 0, sequence: 'AGCTGT' }],
    assemblyMethod: 'gibson',
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    createdAt: new Date('2026-04-30T00:00:00Z'),
    updatedAt: new Date('2026-04-30T00:00:00Z'),
  };
  return ensureAssemblyWorkbenchIdentity({
    ...design,
    ...computeDraftAssembly(design, undefined, createAppTmCalculator(design.pcrPolymerase)),
    version: 1,
    assemblyState: 'ready',
    status: 'computed',
  });
}

describe('homology-derived primer binding windows', () => {
  it.each(['left', 'right'] as const)(
    'restores the exact Tm-sized PBS after clearing a valid %s intrusion',
    (side) => {
      const design = draftedDesign();
      const balanced = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: 0,
          encoding: { onLeft: 15, onRight: 15 },
          expectedDesignVersion: design.version,
        },
      });
      expect(balanced.status).toBe('applied');
      const before = balanced.nextDesign;
      const primer =
        side === 'left' ? before.designPrimers[1].forward : before.designPrimers[0].reverse;
      const originalPbs = primer.pbs;
      expect(originalPbs.end - originalPbs.start).not.toBe(20);
      const intruded = applyAssemblyWorkbenchCommand({
        design: before,
        viewState: balanced.nextViewState,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: 0,
          encoding: side === 'left' ? { onLeft: -5, onRight: 15 } : { onLeft: 15, onRight: -7 },
          expectedDesignVersion: before.version,
        },
      });
      expect(intruded.status).toBe('applied');
      const intrudedPrimer =
        side === 'left'
          ? intruded.nextDesign.designPrimers[1].forward
          : intruded.nextDesign.designPrimers[0].reverse;
      expect(intrudedPrimer.pbs).toMatchObject(
        side === 'left'
          ? { start: originalPbs.start + 5, end: originalPbs.end }
          : { start: originalPbs.start, end: originalPbs.end - 1 }
      );
      const restored = applyAssemblyWorkbenchCommand({
        design: intruded.nextDesign,
        viewState: intruded.nextViewState,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: 0,
          encoding: { onLeft: 15, onRight: 15 },
          expectedDesignVersion: intruded.nextDesign.version,
        },
      });
      expect(restored.status).toBe('applied');
      const restoredPrimer =
        side === 'left'
          ? restored.nextDesign.designPrimers[1].forward
          : restored.nextDesign.designPrimers[0].reverse;
      expect(restoredPrimer.pbs).toEqual(originalPbs);
      expect(restoredPrimer.sequence).toBe(restoredPrimer.overhang.sequence + originalPbs.sequence);
      expect(restoredPrimer.tm).toBe(primer.tm);
    }
  );
});
