import { describe, expect, it, vi } from 'vitest';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import { getComposedSequence, type DesignRegion, type SequenceDesign } from '../design/types';
import { computeDraftAssembly, reverseComplement } from '../design/algorithms/draft-assembly';
import { isPalindrome } from '../design/validation-constants';
import { realAssemblyPipelineScenarioById } from '../../test/scenarios/assembly-real-pipeline';
import {
  applyAssemblyWorkbenchCommand,
  createAssemblyWorkbenchViewState,
} from './AssemblyWorkbenchReducer';
import { ensureAssemblyWorkbenchIdentity } from './AssemblyWorkbenchIdentity';
import { createAssemblyWorkbenchSession } from './AssemblyWorkbenchSession';
import {
  GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP,
  GOLDEN_GATE_OFFSET_LIMIT_MAX_BP,
} from './AssemblyWorkbenchContract';
import {
  goldenGateOverhangLivePreviewForProductRow,
  goldenGateOverhangLivePrimersForRow,
} from './GoldenGateOverhangLivePreviewContract';
import {
  homologyOverlapLivePreviewForProductRow,
  homologyOverlapLivePrimersForRow,
} from './HomologyOverlapLivePreviewContract';
import { buildJunctionWorkbenchModels } from './model';
import { planGoldenGateAutoOptimization } from './AssemblyWorkbenchAutoOptimizer';
import { buildAssemblyOptimizationInput } from '../assembly/assembly-optimization-input';
import { createAppTmCalculator } from './settings';
import {
  getGoldenGateFidelityDatasetForEnzyme,
  scoreGoldenGateOverhangSet,
} from './golden-gate-fidelity/GoldenGateFidelityDataset';

describe('AssemblyWorkbenchReducer', () => {
  it.each(['gibson', 'nebuilder', 'goldengate'] as const)(
    'keeps an authored primer sequence and tail through %s redrafting',
    (method) => {
      const design = ensureAssemblyWorkbenchIdentity(draftedDesign(method));
      const primer = design.designPrimers[0].forward;
      const otherPrimers = design.designPrimers
        .flatMap((pair) => [pair.forward, pair.reverse])
        .filter((item) => item.id !== primer.id);
      const pbsSequence = 'T'.repeat(7);
      const overhangSequence = 'ACGT'.repeat(24);
      const edited = applyAssemblyWorkbenchCommand({
        design,
        viewState: createAssemblyWorkbenchViewState(design),
        command: {
          type: 'setPrimerContent',
          primerId: primer.id,
          name: 'Intentional mismatch primer',
          pbsSequence,
          overhangSequence,
          expectedDesignVersion: design.version,
        },
      });
      expect(edited?.status).toBe('applied');
      expect(edited.nextDesign.designPrimers[0].forward).toMatchObject({
        id: primer.id,
        name: 'Intentional mismatch primer',
        sequence: overhangSequence + pbsSequence,
        pbs: { sequence: pbsSequence },
        overhang: { sequence: overhangSequence, tailLength: overhangSequence.length },
        manuallyEdited: true,
      });
      expect(
        edited.nextDesign.designPrimers
          .flatMap((pair) => [pair.forward, pair.reverse])
          .filter((item) => item.id !== primer.id)
      ).toEqual(otherPrimers);
      expect(computeDraftAssembly(edited.nextDesign).designPrimers[0].forward).toMatchObject({
        id: primer.id,
        sequence: overhangSequence + pbsSequence,
        manuallyEdited: true,
      });
      const redrafted = applyAssemblyWorkbenchCommand({
        design: edited.nextDesign,
        viewState: edited.nextViewState,
        command: { type: 'draftAssembly', expectedDesignVersion: edited.nextDesign.version },
      });
      expect(redrafted.status).toBe('applied');
      expect(redrafted.nextDesign.designPrimers[0].forward).toMatchObject({
        id: primer.id,
        name: 'Intentional mismatch primer',
        sequence: overhangSequence + pbsSequence,
        pbs: { sequence: pbsSequence },
        manuallyEdited: true,
      });
    }
  );

  it('preserves exact authored chemistry through the production drafting algorithm', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const primerId = design.designPrimers[0].forward.id;
    const notation = '/5Phos/ACGTACGT/3SpC3/';
    const edited = applyAssemblyWorkbenchCommand({
      design,
      viewState: createAssemblyWorkbenchViewState(design),
      command: {
        type: 'setPrimerContent',
        primerId,
        oligo: { vendor: 'idt', notation },
        annealingLength: 4,
        expectedDesignVersion: design.version,
      },
    });
    expect(edited.status).toBe('applied');
    expect(computeDraftAssembly(edited.nextDesign).designPrimers[0].forward).toMatchObject({
      id: primerId,
      sequence: 'ACGTACGT',
      pbs: { sequence: 'ACGT' },
      overhang: { sequence: 'ACGT' },
      oligo: { notation },
    });
  });

  it('renames a generated primer without changing chemistry or freezing its scientific content', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const primer = design.designPrimers[0].forward;
    const edited = applyAssemblyWorkbenchCommand({
      design,
      viewState: createAssemblyWorkbenchViewState(design),
      command: {
        type: 'setPrimerContent',
        primerId: primer.id,
        name: 'Renamed',
        expectedDesignVersion: design.version,
      },
    });
    expect(edited.nextDesign.designPrimers[0].forward).toEqual({
      ...primer,
      name: 'Renamed',
      manuallyNamed: true,
    });
    expect(computeDraftAssembly(edited.nextDesign).designPrimers[0].forward).toMatchObject({
      name: 'Renamed',
    });
  });

  it('persists workbench primer IDs across region reorder', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const r1ForwardId = design.assemblyWorkbench?.primers.find(
      (primer) => primer.regionId === 'r1' && primer.direction === 'forward'
    )?.id;

    const reordered = ensureAssemblyWorkbenchIdentity({
      ...design,
      regions: [design.regions[1], design.regions[0]],
    });

    expect(
      reordered.assemblyWorkbench?.primers.find(
        (primer) => primer.regionId === 'r1' && primer.direction === 'forward'
      )?.id
    ).toBe(r1ForwardId);
  });

  it('moves junction IDs with the same adjacent region pair across reorder', () => {
    const design = ensureAssemblyWorkbenchIdentity({
      ...draftedDesign('gibson'),
      regions: [
        region('r1', 'ACGT'.repeat(60)),
        region('r2', 'TGCA'.repeat(60)),
        region('r3', 'GATC'.repeat(60)),
      ],
    });
    const originalR1R2 = design.assemblyWorkbench?.junctions.find(
      (junction) => junction.leftRegionId === 'r1' && junction.rightRegionId === 'r2'
    );

    const reordered = ensureAssemblyWorkbenchIdentity({
      ...design,
      regions: [design.regions[2], design.regions[0], design.regions[1]],
    });
    const movedR1R2 = reordered.assemblyWorkbench?.junctions.find(
      (junction) => junction.leftRegionId === 'r1' && junction.rightRegionId === 'r2'
    );

    expect(movedR1R2?.id).toBe(originalR1R2?.id);
    expect(movedR1R2?.slot).toBe(1);
  });

  it('rejects stale design-mutating commands before touching the design', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: design.designPrimers[0].forward.id,
        length: 25,
        expectedDesignVersion: design.version - 1,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'stale-design-version',
        actualDesignVersion: design.version,
      })
    );
    expect(result.nextDesign).toStrictEqual(design);
  });

  it('rejects design-mutating commands without expectedDesignVersion', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: design.designPrimers[0].forward.id,
        length: 25,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'stale-design-version',
      })
    );
  });

  it('rejects nested applyProposal commands instead of recursing', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'applyProposal',
        proposalId: 'outer',
        expectedDesignVersion: design.version,
        command: {
          type: 'applyProposal',
          proposalId: 'inner',
          command: { type: 'draftAssembly', expectedDesignVersion: design.version },
        },
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-command',
      })
    );
  });

  it('applies primer PBS commands through stable primer IDs', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const primerId = design.designPrimers[0].forward.id;
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId,
        length: 25,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.version).toBe(design.version + 1);
    expect(result.nextDesign.designPrimers[0].forward.id).toBe(primerId);
    expect(
      result.nextDesign.designPrimers[0].forward.pbs.end -
        result.nextDesign.designPrimers[0].forward.pbs.start
    ).toBe(25);
    expect(result.nextDesign.assemblyWorkbench?.primerEditIntents).toContainEqual(
      expect.objectContaining({
        regionId: 'r1',
        direction: 'forward',
        field: 'pbsLength',
        length: 25,
      })
    );
  });

  it('allows a manual PBS to use every physically available template base beyond 60 bp', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const primer = design.designPrimers[0].forward;
    const requestedLength = 80;
    const productBefore = getComposedSequence(design.regions, design.spacers);

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: primer.id,
        length: requestedLength,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(
      result.nextDesign.designPrimers[0].forward.pbs.end -
        result.nextDesign.designPrimers[0].forward.pbs.start
    ).toBe(requestedLength);
    expect(getComposedSequence(result.nextDesign.regions, result.nextDesign.spacers)).toBe(
      productBefore
    );
  });

  it('allows a reverse Golden Gate PBS to extend beyond 60 bp toward its part start', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const primer = design.designPrimers[0].reverse;
    const requestedLength = 80;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: primer.id,
        length: requestedLength,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(
      result.nextDesign.designPrimers[0].reverse.pbs.end -
        result.nextDesign.designPrimers[0].reverse.pbs.start
    ).toBe(requestedLength);
  });

  it('reapplies primer PBS edit intents after spacer redrafts', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const primerId = design.designPrimers[0].forward.id;
    const pbsEdit = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId,
        length: 27,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(pbsEdit.status).toBe('applied');

    const spacerEdit = applyAssemblyWorkbenchCommand({
      design: pbsEdit.nextDesign,
      viewState: pbsEdit.nextViewState,
      command: {
        type: 'setJunctionSpacer',
        junctionIndex: 0,
        sequence: 'AAGC',
        expectedDesignVersion: pbsEdit.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(spacerEdit.status).toBe('applied');
    expect(spacerEdit.nextDesign.designPrimers[0].forward.id).toBe(primerId);
    expect(
      spacerEdit.nextDesign.designPrimers[0].forward.pbs.end -
        spacerEdit.nextDesign.designPrimers[0].forward.pbs.start
    ).toBe(27);
  });

  it('supports homology preview updates without recomputing primers', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const homology = design.homologyRegions[0];
    const originalPrimers = structuredClone(design.designPrimers);

    const preview = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: homology.junctionIndex,
        encoding: {
          onLeft: homology.encoding.onLeft + 2,
          onRight: homology.encoding.onRight,
        },
        recomputePrimers: false,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(preview.status).toBe('applied');
    expect(preview.nextDesign.homologyRegions[0].encoding.onLeft).toBe(
      homology.encoding.onLeft + 2
    );
    expect(preview.nextDesign.designPrimers).toEqual(originalPrimers);

    const commit = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: homology.junctionIndex,
        encoding: {
          onLeft: homology.encoding.onLeft + 2,
          onRight: homology.encoding.onRight,
        },
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(commit.status).toBe('applied');
    expect(commit.nextDesign.designPrimers).not.toEqual(originalPrimers);
  });

  it.each([
    ['gibson', 'left' as const],
    ['gibson', 'right' as const],
    ['nebuilder', 'left' as const],
    ['nebuilder', 'right' as const],
  ] satisfies Array<[SequenceDesign['assemblyMethod'], 'left' | 'right']>)(
    'rejects two-sided %s homology encodings when the %s side is a restriction digest fragment',
    (method, rdSide) => {
      const design = ensureAssemblyWorkbenchIdentity(rdAdjacentHomologyDesign(method, rdSide));
      const viewState = createAssemblyWorkbenchViewState(design);
      const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
      const invalidEncoding =
        rdSide === 'left'
          ? { onLeft: homology.encoding.onLeft, onRight: 1 }
          : { onLeft: 1, onRight: homology.encoding.onRight };
      const validEncoding =
        rdSide === 'left'
          ? { onLeft: homology.encoding.onLeft + 1, onRight: 0 }
          : { onLeft: 0, onRight: homology.encoding.onRight + 1 };

      expect(homology.encoding).toEqual(
        rdSide === 'left'
          ? expect.objectContaining({ onRight: 0 })
          : expect.objectContaining({ onLeft: 0 })
      );

      const invalid = applyAssemblyWorkbenchCommand({
        design,
        viewState,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: 0,
          encoding: invalidEncoding,
          expectedDesignVersion: design.version,
        },
        now: new Date('2026-04-30T00:00:00.000Z'),
      });

      expect(invalid.status).toBe('rejected');
      expect(invalid.errors).toContainEqual(
        expect.objectContaining({
          code: 'invalid-command-value',
          message: expect.stringMatching(/restriction-digest/i),
        })
      );
      expect(invalid.nextDesign).toStrictEqual(design);

      const valid = applyAssemblyWorkbenchCommand({
        design,
        viewState,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex: 0,
          encoding: validEncoding,
          expectedDesignVersion: design.version,
        },
        now: new Date('2026-04-30T00:01:00.000Z'),
      });

      expect(valid.status).toBe('applied');
      expect(
        valid.nextDesign.homologyRegions.find((item) => item.junctionIndex === 0)?.encoding
      ).toEqual(validEncoding);
    }
  );

  it('keeps restored method drafts intact when workbench mode switching auto-draft is requested', () => {
    const initialDesign = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const initialViewState = createAssemblyWorkbenchViewState(initialDesign);
    const initialHomology = initialDesign.homologyRegions[0];
    const customEncoding = {
      onLeft: initialHomology.encoding.onLeft + 3,
      onRight: initialHomology.encoding.onRight,
    };

    const customizedGibson = applyAssemblyWorkbenchCommand({
      design: initialDesign,
      viewState: initialViewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: initialHomology.junctionIndex,
        encoding: customEncoding,
        recomputePrimers: false,
        expectedDesignVersion: initialDesign.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(customizedGibson.status).toBe('applied');
    const gibsonDraft = {
      homologyRegions: structuredClone(customizedGibson.nextDesign.homologyRegions),
      designPrimers: structuredClone(customizedGibson.nextDesign.designPrimers),
      assemblyWorkbench: structuredClone(customizedGibson.nextDesign.assemblyWorkbench),
    };

    const switchedToGoldenGate = applyAssemblyWorkbenchCommand({
      design: customizedGibson.nextDesign,
      viewState: customizedGibson.nextViewState,
      command: {
        type: 'setAssemblyMode',
        method: 'goldengate',
        enzyme: 'BsaI',
        draft: true,
        expectedDesignVersion: customizedGibson.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });
    expect(switchedToGoldenGate.status).toBe('applied');
    expect(switchedToGoldenGate.nextDesign.assemblyMethod).toBe('goldengate');
    expect(switchedToGoldenGate.nextDesign.assemblyState).toBe('ready');
    expect(switchedToGoldenGate.nextDesign.goldenGateJunctions?.length).toBeGreaterThan(0);

    const goldenGateJunctionId = switchedToGoldenGate.nextDesign.assemblyWorkbench?.junctions[0].id;
    const adjustedGoldenGate = applyAssemblyWorkbenchCommand({
      design: switchedToGoldenGate.nextDesign,
      viewState: switchedToGoldenGate.nextViewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId: goldenGateJunctionId,
        offset: 2,
        expectedDesignVersion: switchedToGoldenGate.nextDesign.version,
      },
      now: new Date('2026-04-30T00:02:00.000Z'),
    });
    expect(adjustedGoldenGate.status).toBe('applied');
    const goldenGateDraft = {
      goldenGateConfig: structuredClone(adjustedGoldenGate.nextDesign.goldenGateConfig),
      goldenGateJunctions: structuredClone(adjustedGoldenGate.nextDesign.goldenGateJunctions),
      designPrimers: structuredClone(adjustedGoldenGate.nextDesign.designPrimers),
      assemblyWorkbench: structuredClone(adjustedGoldenGate.nextDesign.assemblyWorkbench),
    };

    const restoredGibson = applyAssemblyWorkbenchCommand({
      design: adjustedGoldenGate.nextDesign,
      viewState: adjustedGoldenGate.nextViewState,
      command: {
        type: 'setAssemblyMode',
        method: 'gibson',
        draft: true,
        expectedDesignVersion: adjustedGoldenGate.nextDesign.version,
      },
      now: new Date('2026-04-30T00:03:00.000Z'),
    });
    expect(restoredGibson.status).toBe('applied');
    expect(restoredGibson.nextDesign.assemblyMethod).toBe('gibson');
    expect(restoredGibson.nextDesign.assemblyState).toBe('ready');
    expect(restoredGibson.nextDesign.homologyRegions).toEqual(gibsonDraft.homologyRegions);
    expect(restoredGibson.nextDesign.designPrimers).toEqual(gibsonDraft.designPrimers);
    expect(restoredGibson.nextDesign.assemblyWorkbench).toEqual(gibsonDraft.assemblyWorkbench);

    const restoredGoldenGate = applyAssemblyWorkbenchCommand({
      design: restoredGibson.nextDesign,
      viewState: restoredGibson.nextViewState,
      command: {
        type: 'setAssemblyMode',
        method: 'goldengate',
        enzyme: 'BsaI',
        draft: true,
        expectedDesignVersion: restoredGibson.nextDesign.version,
      },
      now: new Date('2026-04-30T00:04:00.000Z'),
    });
    expect(restoredGoldenGate.status).toBe('applied');
    expect(restoredGoldenGate.nextDesign.assemblyMethod).toBe('goldengate');
    expect(restoredGoldenGate.nextDesign.assemblyState).toBe('ready');
    expect(restoredGoldenGate.nextDesign.goldenGateConfig).toEqual(
      goldenGateDraft.goldenGateConfig
    );
    expect(restoredGoldenGate.nextDesign.goldenGateJunctions).toEqual(
      goldenGateDraft.goldenGateJunctions
    );
    expect(restoredGoldenGate.nextDesign.designPrimers).toEqual(goldenGateDraft.designPrimers);
    expect(restoredGoldenGate.nextDesign.assemblyWorkbench).toEqual(
      goldenGateDraft.assemblyWorkbench
    );
  });

  it('sets a junction spacer through stable junction IDs and redrafts spacer-aware primers', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;
    const originalEncoding = design.homologyRegions[0].encoding;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setJunctionSpacer',
        junctionId,
        sequence: 'aR nY',
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.version).toBe(design.version + 1);
    expect(result.nextDesign.spacers).toEqual([
      expect.objectContaining({ junctionIndex: 0, sequence: 'aRnY' }),
    ]);
    expect(getComposedSequence(result.nextDesign.regions, result.nextDesign.spacers)).toContain(
      'aRnY'
    );
    expect(result.nextDesign.homologyRegions[0].encoding).toEqual(originalEncoding);
    expect(result.nextDesign.assemblyState).toBe('ready');
    expect(result.nextDesign.designPrimers[1].forward.overhang.spacerSequence).toBe('aRnY');
    expect(result.nextDesign.designPrimers[0].reverse.overhang.spacerSequence).toBe('RnYt');
  });

  it('keeps an explicitly cleared draft primer-free when a spacer is edited', () => {
    const drafted = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const cleared: SequenceDesign = {
      ...drafted,
      assemblyState: 'drafting',
      status: 'draft',
      homologyRegions: [],
      goldenGateJunctions: [],
      designPrimers: [],
      assemblyWorkbench: drafted.assemblyWorkbench
        ? {
            ...drafted.assemblyWorkbench,
            primerEditIntents: [],
            autoDraftPrimers: false,
          }
        : undefined,
    };
    const junctionId = cleared.assemblyWorkbench?.junctions[0]?.id;

    const result = applyAssemblyWorkbenchCommand({
      design: cleared,
      viewState: createAssemblyWorkbenchViewState(cleared),
      command: {
        type: 'setJunctionSpacer',
        junctionId,
        sequence: 'aRnY',
        expectedDesignVersion: cleared.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.spacers).toEqual([
      expect.objectContaining({ junctionIndex: 0, sequence: 'aRnY' }),
    ]);
    expect(result.nextDesign.designPrimers).toEqual([]);
    expect(result.nextDesign.goldenGateJunctions).toEqual([]);
    expect(result.nextDesign.assemblyWorkbench?.primerEditIntents).toEqual([]);
    expect(result.nextDesign.assemblyWorkbench?.autoDraftPrimers).toBe(false);
    expect(result.nextDesign.assemblyState).toBe('drafting');
    expect(result.nextDesign.status).toBe('draft');
  });

  it('lets a downstream forward primer tail consume its own PBS from the 5 prime edge', () => {
    const automaticDesign = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const prepared = applyAssemblyWorkbenchCommand({
      design: automaticDesign,
      viewState: createAssemblyWorkbenchViewState(automaticDesign),
      command: {
        type: 'setPrimerPbsLength',
        primerId: automaticDesign.designPrimers[1].forward.id,
        length: 20,
        expectedDesignVersion: automaticDesign.version,
      },
    });
    expect(prepared.status).toBe('applied');
    const design = prepared.nextDesign;
    expect(design.designPrimers[1].forward.pbs.sequence).toHaveLength(20);
    const viewState = createAssemblyWorkbenchViewState(design);
    const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
    const primer = design.designPrimers[1].forward;
    const composed = getComposedSequence(design.regions, design.spacers);
    const requestedTail = homology.encoding.onLeft + 5;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerOverhangLength',
        primerId: primer.id,
        length: requestedTail,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    const updatedHomology = result.nextDesign.homologyRegions.find(
      (item) => item.junctionIndex === 0
    )!;
    const updatedPrimer = result.nextDesign.designPrimers[1].forward;
    expect(updatedHomology.encoding).toEqual(homology.encoding);
    expect(updatedPrimer.pbs.start).toBe(primer.pbs.start + 5);
    expect(updatedPrimer.pbs.end).toBe(primer.pbs.end);
    expect(updatedPrimer.pbs.end - updatedPrimer.pbs.start).toBe(15);
    expect(updatedPrimer.overhang.length).toBe(requestedTail);
    expect(updatedPrimer.overhang.sequence).toBe(
      composed.slice(updatedHomology.start, updatedPrimer.pbs.start)
    );
    expect(updatedPrimer.sequence).toBe(
      updatedPrimer.overhang.sequence + updatedPrimer.pbs.sequence
    );
  });

  it('lets an upstream reverse primer tail consume its own PBS from the 5 prime edge', () => {
    const automaticDesign = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const prepared = applyAssemblyWorkbenchCommand({
      design: automaticDesign,
      viewState: createAssemblyWorkbenchViewState(automaticDesign),
      command: {
        type: 'setPrimerPbsLength',
        primerId: automaticDesign.designPrimers[0].reverse.id,
        length: 20,
        expectedDesignVersion: automaticDesign.version,
      },
    });
    expect(prepared.status).toBe('applied');
    const design = prepared.nextDesign;
    expect(design.designPrimers[0].reverse.pbs.sequence).toHaveLength(20);
    const viewState = createAssemblyWorkbenchViewState(design);
    const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
    const primer = design.designPrimers[0].reverse;
    const composed = getComposedSequence(design.regions, design.spacers);
    const requestedTail = homology.encoding.onRight + design.spacers[0].sequence.length + 5;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerOverhangLength',
        primerId: primer.id,
        length: requestedTail,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    const updatedHomology = result.nextDesign.homologyRegions.find(
      (item) => item.junctionIndex === 0
    )!;
    const updatedPrimer = result.nextDesign.designPrimers[0].reverse;
    expect(updatedHomology.encoding).toEqual(homology.encoding);
    expect(updatedPrimer.pbs.start).toBe(primer.pbs.start);
    expect(updatedPrimer.pbs.end).toBe(primer.pbs.end - 5);
    expect(updatedPrimer.pbs.end - updatedPrimer.pbs.start).toBe(15);
    expect(updatedPrimer.overhang.length).toBe(requestedTail);
    expect(updatedPrimer.overhang.sequence).toBe(
      reverseComplement(composed.slice(updatedPrimer.pbs.end, updatedHomology.end))
    );
    expect(updatedPrimer.sequence).toBe(
      updatedPrimer.overhang.sequence + updatedPrimer.pbs.sequence
    );
  });

  it('rejects primer tails that would consume past the available PBS template', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const viewState = createAssemblyWorkbenchViewState(design);
    const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
    const primer = design.designPrimers[1].forward;
    const pbsLength = primer.pbs.end - primer.pbs.start;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerOverhangLength',
        primerId: primer.id,
        length: homology.encoding.onLeft + pbsLength + 1,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-command-value',
      })
    );
    expect(result.nextDesign.designPrimers[1].forward).toEqual(primer);
  });

  it('preserves a custom homology primer 5 prime PBS edge across later overlap edits', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const viewState = createAssemblyWorkbenchViewState(design);
    const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
    const primer = design.designPrimers[1].forward;
    const tailEdit = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerOverhangLength',
        primerId: primer.id,
        length: homology.encoding.onLeft + 5,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(tailEdit.status).toBe('applied');

    const shiftedHomology = tailEdit.nextDesign.homologyRegions.find(
      (item) => item.junctionIndex === 0
    )!;
    const pbsStartAfterTailEdit = tailEdit.nextDesign.designPrimers[1].forward.pbs.start;
    const overlapEdit = applyAssemblyWorkbenchCommand({
      design: tailEdit.nextDesign,
      viewState: tailEdit.nextViewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: {
          onLeft: shiftedHomology.encoding.onLeft + 2,
          onRight: shiftedHomology.encoding.onRight,
        },
        expectedDesignVersion: tailEdit.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(overlapEdit.status).toBe('applied');
    const updatedPrimer = overlapEdit.nextDesign.designPrimers[1].forward;
    expect(updatedPrimer.pbs.start).toBe(pbsStartAfterTailEdit);
    expect(updatedPrimer.pbs.end).toBe(tailEdit.nextDesign.designPrimers[1].forward.pbs.end);
    expect(updatedPrimer.overhang.sequence).toBe(
      getComposedSequence(overlapEdit.nextDesign.regions, overlapEdit.nextDesign.spacers).slice(
        overlapEdit.nextDesign.homologyRegions.find((item) => item.junctionIndex === 0)!.start,
        updatedPrimer.pbs.start
      )
    );
  });

  it('previews product overlap drags from custom primer PBS edges before commit', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const design = ensureAssemblyWorkbenchIdentity(
        draftedDesignFromBase({
          ...baseDesign('gibson'),
          spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
        })
      );
      const viewState = createAssemblyWorkbenchViewState(design);
      const homology = design.homologyRegions.find((item) => item.junctionIndex === 0)!;
      const primer = design.designPrimers[1].forward;
      const tailEdit = applyAssemblyWorkbenchCommand({
        design,
        viewState,
        command: {
          type: 'setPrimerOverhangLength',
          primerId: primer.id,
          length: homology.encoding.onLeft + 5,
          expectedDesignVersion: design.version,
        },
        now: new Date('2026-04-30T00:00:00.000Z'),
      });
      expect(tailEdit.status).toBe('applied');

      const junctionIndex = 0;
      const session = createAssemblyWorkbenchSession(tailEdit.nextDesign, tailEdit.nextViewState);
      const field = session.editableFields.find(
        (item) =>
          item.kind === 'homologyArm' &&
          item.target.junctionIndex === junctionIndex &&
          item.target.side === 'left'
      );
      const model = buildJunctionWorkbenchModels(tailEdit.nextDesign).find(
        (item) => item.junctionIndex === junctionIndex
      );
      const productRow = model?.rows.find((row) => row.kind === 'product');
      expect(field).toBeDefined();
      expect(model).toBeDefined();
      expect(productRow).toBeDefined();

      const nextOnLeft = tailEdit.nextDesign.homologyRegions[0].encoding.onLeft + 2;
      const livePreview = homologyOverlapLivePreviewForProductRow(productRow!, field!, nextOnLeft);
      expect(livePreview).not.toBeNull();
      const liveByRow = Object.fromEntries(
        model!.rows.map((row) => {
          const livePrimers = homologyOverlapLivePrimersForRow(row, livePreview!, junctionIndex);
          expect(livePrimers).not.toBeNull();
          return [row.kind, homologyPrimerFullOverlaySnapshot(livePrimers!)];
        })
      );

      const result = applyAssemblyWorkbenchCommand({
        design: tailEdit.nextDesign,
        viewState: tailEdit.nextViewState,
        command: {
          type: 'setHomologyEncoding',
          junctionIndex,
          encoding: {
            onLeft: nextOnLeft,
            onRight: tailEdit.nextDesign.homologyRegions[0].encoding.onRight,
          },
          expectedDesignVersion: tailEdit.nextDesign.version,
        },
        now: new Date('2026-04-30T00:01:00.000Z'),
      });
      expect(result.status).toBe('applied');

      const settledModel = buildJunctionWorkbenchModels(result.nextDesign).find(
        (item) => item.junctionIndex === junctionIndex
      );
      expect(settledModel).toBeDefined();
      const settledByRow = Object.fromEntries(
        settledModel!.rows.map((row) => [
          row.kind,
          homologyPrimerFullOverlaySnapshot(row.primers ?? []),
        ])
      );
      expect(settledByRow).toEqual(liveByRow);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('keeps the outward homology primer pair physically coherent when the left boundary consumes forward PBS', () => {
    const automaticDesign = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const prepared = applyAssemblyWorkbenchCommand({
      design: automaticDesign,
      viewState: createAssemblyWorkbenchViewState(automaticDesign),
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: { onLeft: 15, onRight: 15 },
        expectedDesignVersion: automaticDesign.version,
      },
    });
    expect(prepared.status).toBe('applied');
    const design = prepared.nextDesign;
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionIndex = 0;
    const beforeHomology = design.homologyRegions.find(
      (item) => item.junctionIndex === junctionIndex
    )!;
    const beforeUpstreamReverse = design.designPrimers[0].reverse;
    const beforeDownstreamForward = design.designPrimers[1].forward;
    const requestedPbsIntrusionBp = 5;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex,
        encoding: {
          onLeft: -requestedPbsIntrusionBp,
          onRight: beforeHomology.encoding.onRight,
        },
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    const afterHomology = result.nextDesign.homologyRegions.find(
      (item) => item.junctionIndex === junctionIndex
    )!;
    const afterUpstreamReverse = result.nextDesign.designPrimers[0].reverse;
    const afterDownstreamForward = result.nextDesign.designPrimers[1].forward;
    const composed = getComposedSequence(result.nextDesign.regions, result.nextDesign.spacers);
    const spacerLength = result.nextDesign.spacers[0].sequence.length;
    const productOrigin = beforeHomology.junctionPosition - spacerLength;
    const productStartBioCol = spacerLength - afterHomology.encoding.onLeft;
    const productEndBioCol = spacerLength + afterHomology.encoding.onRight;
    const expectedOverlapTemplate = circularSlice(
      composed,
      productOrigin + productStartBioCol,
      productEndBioCol - productStartBioCol
    );
    const reverseOverhangTemplate = reverseComplement(afterUpstreamReverse.overhang.sequence);

    expect(afterDownstreamForward.pbs.start).toBe(
      beforeDownstreamForward.pbs.start + requestedPbsIntrusionBp
    );
    expect(afterDownstreamForward.pbs.end).toBe(beforeDownstreamForward.pbs.end);
    expect(afterDownstreamForward.overhang.length).toBe(0);

    expect(afterUpstreamReverse.pbs).toEqual(beforeUpstreamReverse.pbs);
    expect(afterUpstreamReverse.overhang).toEqual(beforeUpstreamReverse.overhang);
    expect(afterUpstreamReverse.sequence).toBe(
      afterUpstreamReverse.overhang.sequence + afterUpstreamReverse.pbs.sequence
    );

    expect(expectedOverlapTemplate.length).toBeGreaterThan(0);
    expect(afterDownstreamForward.pbs.sequence.startsWith(expectedOverlapTemplate)).toBe(true);
    expect(reverseOverhangTemplate.endsWith(expectedOverlapTemplate)).toBe(true);
    expect(reverseOverhangTemplate).toContain(result.nextDesign.spacers[0].sequence);
  });

  it('treats left-boundary PBS intrusion as derived homology state rather than permanent primer state', () => {
    const automaticDesign = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const prepared = applyAssemblyWorkbenchCommand({
      design: automaticDesign,
      viewState: createAssemblyWorkbenchViewState(automaticDesign),
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: { onLeft: 15, onRight: 15 },
        expectedDesignVersion: automaticDesign.version,
      },
    });
    expect(prepared.status).toBe('applied');
    const design = prepared.nextDesign;
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionIndex = 0;
    const originalHomology = design.homologyRegions.find(
      (item) => item.junctionIndex === junctionIndex
    )!;
    const originalUpstreamReverse = design.designPrimers[0].reverse;
    const originalDownstreamForward = design.designPrimers[1].forward;

    expectHomologyJunctionPairPhysicallyCoherent(design, junctionIndex);

    const intruded = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex,
        encoding: {
          onLeft: -5,
          onRight: originalHomology.encoding.onRight,
        },
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(intruded.status).toBe('applied');
    expect(intruded.nextDesign.designPrimers[1].forward.pbs.start).toBe(
      originalDownstreamForward.pbs.start + 5
    );
    expect(intruded.nextDesign.designPrimers[0].reverse).toEqual(originalUpstreamReverse);
    expectHomologyJunctionPairPhysicallyCoherent(intruded.nextDesign, junctionIndex);

    const restored = applyAssemblyWorkbenchCommand({
      design: intruded.nextDesign,
      viewState: intruded.nextViewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex,
        encoding: originalHomology.encoding,
        expectedDesignVersion: intruded.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(restored.status).toBe('applied');
    expect(restored.nextDesign.designPrimers[1].forward.pbs).toEqual(originalDownstreamForward.pbs);
    expect(restored.nextDesign.designPrimers[0].reverse).toEqual(originalUpstreamReverse);
    expectHomologyJunctionPairPhysicallyCoherent(restored.nextDesign, junctionIndex);
  });

  it('treats right-boundary PBS intrusion as derived homology state rather than permanent primer state', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      draftedDesignFromBase({
        ...baseDesign('gibson'),
        spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      })
    );
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionIndex = 0;
    const originalHomology = design.homologyRegions.find(
      (item) => item.junctionIndex === junctionIndex
    )!;
    const originalUpstreamReverse = design.designPrimers[0].reverse;
    const originalDownstreamForward = design.designPrimers[1].forward;
    const spacerLength = design.spacers[0].sequence.length;
    const requestedPbsIntrusionBp = 1;

    expectHomologyJunctionPairPhysicallyCoherent(design, junctionIndex);

    const intruded = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex,
        encoding: {
          onLeft: originalHomology.encoding.onLeft,
          onRight: -spacerLength - requestedPbsIntrusionBp,
        },
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(intruded.status).toBe('applied');
    expect(intruded.nextDesign.designPrimers[0].reverse.pbs.end).toBe(
      originalUpstreamReverse.pbs.end - requestedPbsIntrusionBp
    );
    expect(intruded.nextDesign.designPrimers[1].forward).toEqual(originalDownstreamForward);
    expectHomologyJunctionPairPhysicallyCoherent(intruded.nextDesign, junctionIndex);

    const restored = applyAssemblyWorkbenchCommand({
      design: intruded.nextDesign,
      viewState: intruded.nextViewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex,
        encoding: originalHomology.encoding,
        expectedDesignVersion: intruded.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(restored.status).toBe('applied');
    expect(restored.nextDesign.designPrimers[0].reverse.pbs).toEqual(originalUpstreamReverse.pbs);
    expect(restored.nextDesign.designPrimers[1].forward).toEqual(originalDownstreamForward);
    expectHomologyJunctionPairPhysicallyCoherent(restored.nextDesign, junctionIndex);
  });

  it('removes a spacer by setting an empty spacer sequence', () => {
    const design = ensureAssemblyWorkbenchIdentity({
      ...draftedDesign('gibson'),
      spacers: [{ id: 'spacer-existing', junctionIndex: 0, sequence: 'AAGC' }],
      version: 3,
    });
    const redrafted = draftedDesignFromBase(design);
    const viewState = createAssemblyWorkbenchViewState(redrafted);

    const result = applyAssemblyWorkbenchCommand({
      design: redrafted,
      viewState,
      command: {
        type: 'setJunctionSpacer',
        junctionIndex: 0,
        sequence: '',
        expectedDesignVersion: redrafted.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.spacers).toEqual([]);
    expect(result.nextDesign.designPrimers).toHaveLength(redrafted.designPrimers.length);
  });

  it('rejects non-DNA spacer sequences before mutating the design', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setJunctionSpacer',
        junctionIndex: 0,
        sequence: 'ATXG',
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid-command-value',
      })
    );
    expect(result.nextDesign).toStrictEqual(design);
  });

  it('applies source contribution boundary edits from explicit source context', () => {
    const drafted = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const sourcePrefix = 'TTAA';
    const sourceSuffix = 'GGCC';
    const originalSequence = drafted.regions[0].sequence;
    const sourceSequence = `${sourcePrefix}${originalSequence}${sourceSuffix}`;
    const design = ensureAssemblyWorkbenchIdentity({
      ...drafted,
      regions: [
        {
          ...drafted.regions[0],
          sourceStart: sourcePrefix.length,
          sourceEnd: sourcePrefix.length + originalSequence.length,
        },
        drafted.regions[1],
      ],
    });
    const viewState = createAssemblyWorkbenchViewState(design);
    const nextSourceEnd = design.regions[0].sourceEnd + 2;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      sourceContext: {
        ready: true,
        regions: {
          r1: {
            sequence: sourceSequence,
            sourceStart: 0,
            sourceEnd: sourceSequence.length,
            annotations: [
              {
                name: 'boundary feature',
                type: 'misc_feature',
                start: design.regions[0].sourceEnd - 1,
                end: nextSourceEnd,
                strand: 'forward',
              },
            ],
          },
        },
      },
      command: {
        type: 'setSourceContributionBoundary',
        regionId: 'r1',
        side: 'downstream',
        sourcePosition: nextSourceEnd,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.nextDesign.version).toBe(design.version + 1);
    expect(result.nextDesign.regions[0].sourceEnd).toBe(nextSourceEnd);
    expect(result.nextDesign.regions[0].sequence).toBe(
      sourceSequence.slice(sourcePrefix.length, nextSourceEnd)
    );
    expect(result.nextDesign.regions[0].annotations).toContainEqual(
      expect.objectContaining({
        name: 'boundary feature',
        start: originalSequence.length - 1,
        end: originalSequence.length + 2,
      })
    );
    expect(result.nextDesign.assemblyState).toBe('ready');
    expect(result.nextDesign.designPrimers).toHaveLength(design.designPrimers.length);
  });

  it('treats visible primer PBS lengths as authoritative over stale edit intents during source redraft', () => {
    const drafted = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const design = ensureAssemblyWorkbenchIdentity({
      ...drafted,
      assemblyWorkbench: {
        ...(drafted.assemblyWorkbench ?? { junctions: [], primers: [] }),
        primerEditIntents: drafted.regions.flatMap((region, fragmentIndex) =>
          (['forward', 'reverse'] as const).map((direction) => ({
            id: `stale-${region.id}-${direction}`,
            regionId: region.id,
            direction,
            junctionIndex: direction === 'forward' ? (fragmentIndex + 1) % 2 : fragmentIndex,
            field: 'pbsLength' as const,
            length: 33,
            updatedAtVersion: 999,
          }))
        ),
      },
    });
    const sourcePrefix = 'TTAA';
    const sourceSuffix = 'GGCC';
    const originalSequence = design.regions[0].sequence;
    const sourceSequence = `${sourcePrefix}${originalSequence}${sourceSuffix}`;
    const shifted = ensureAssemblyWorkbenchIdentity({
      ...design,
      regions: [
        {
          ...design.regions[0],
          sourceStart: sourcePrefix.length,
          sourceEnd: sourcePrefix.length + originalSequence.length,
        },
        design.regions[1],
      ],
    });
    const viewState = createAssemblyWorkbenchViewState(shifted);
    const beforeLengths = primerPbsLengths(shifted);
    expect(beforeLengths).toEqual([20, 20, 20, 20]);

    const result = applyAssemblyWorkbenchCommand({
      design: shifted,
      viewState,
      sourceContext: {
        ready: true,
        regions: {
          r1: {
            sequence: sourceSequence,
            sourceStart: 0,
            sourceEnd: sourceSequence.length,
          },
        },
      },
      command: {
        type: 'setSourceContributionBoundary',
        regionId: 'r1',
        side: 'downstream',
        sourcePosition: shifted.regions[0].sourceEnd + 2,
        expectedDesignVersion: shifted.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(primerPbsLengths(result.nextDesign)).toEqual(beforeLengths);
    expect(result.nextDesign.assemblyWorkbench?.primerEditIntents).toHaveLength(4);
  });

  it('preserves product-edited Golden Gate offsets when a source crossover edit redrafts the junction', () => {
    const drafted = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const sourcePrefix = 'TTAA';
    const sourceSuffix = 'GGCC';
    const originalSequence = drafted.regions[0].sequence;
    const sourceSequence = `${sourcePrefix}${originalSequence}${sourceSuffix}`;
    const design = ensureAssemblyWorkbenchIdentity({
      ...drafted,
      regions: [
        {
          ...drafted.regions[0],
          sourceStart: sourcePrefix.length,
          sourceEnd: sourcePrefix.length + originalSequence.length,
        },
        drafted.regions[1],
      ],
    });
    const viewState = createAssemblyWorkbenchViewState(design);
    const targetOffset = 4;

    const offsetEdit = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionIndex: 0,
        offset: targetOffset,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(offsetEdit.status).toBe('applied');

    const nextSourceEnd = offsetEdit.nextDesign.regions[0].sourceEnd + 2;
    const sourceEdit = applyAssemblyWorkbenchCommand({
      design: offsetEdit.nextDesign,
      viewState: offsetEdit.nextViewState,
      sourceContext: {
        ready: true,
        regions: {
          r1: {
            sequence: sourceSequence,
            sourceStart: 0,
            sourceEnd: sourceSequence.length,
          },
        },
      },
      command: {
        type: 'setSourceContributionBoundary',
        regionId: 'r1',
        side: 'downstream',
        sourcePosition: nextSourceEnd,
        expectedDesignVersion: offsetEdit.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(sourceEdit.status).toBe('applied');
    const junction = sourceEdit.nextDesign.goldenGateJunctions?.[0];
    expect(junction).toEqual(expect.objectContaining({ junctionIndex: 0, offset: targetOffset }));
    expect(junction?.overhangStart).toBe(junction!.junctionPosition - 2 + targetOffset);
    expect(junction?.overhangEnd).toBe(junction!.overhangStart + 4);
    expect(junction?.overhang).toBe(
      circularSlice(
        getComposedSequence(sourceEdit.nextDesign.regions, sourceEdit.nextDesign.spacers),
        junction!.overhangStart,
        4
      )
    );
  });

  it('rejects source boundary edits when the loaded source window is too small', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      sourceContext: {
        ready: true,
        regions: {
          r1: {
            sequence: design.regions[0].sequence,
            sourceStart: design.regions[0].sourceStart,
            sourceEnd: design.regions[0].sourceEnd,
            sourceLength: design.regions[0].sourceEnd + 20,
          },
        },
      },
      command: {
        type: 'setSourceContributionBoundary',
        regionId: 'r1',
        side: 'downstream',
        sourcePosition: design.regions[0].sourceEnd + 1,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'source-window-too-small',
        targetId: 'r1',
      })
    );
    expect(result.nextDesign).toStrictEqual(design);
  });

  it('rejects fixed restriction-digest Golden Gate overhang offsets in the reducer', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedRdDesign());
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: 1,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'fixed-goldengate-junction',
        targetId: junctionId,
      })
    );
  });

  it('rejects RD-matched Golden Gate overhang offsets in the reducer', () => {
    const design = ensureAssemblyWorkbenchIdentity(
      draftedRealPipelineDesign('goldengate-pcr-rd-pcr')
    );
    const viewState = createAssemblyWorkbenchViewState(design);
    const targetJunction = design.goldenGateJunctions?.find(
      (junction) => junction.source.type === 'pcr-matched-rd'
    );
    const junctionId = design.assemblyWorkbench?.junctions.find(
      (junction) => junction.slot === targetJunction?.junctionIndex
    )?.id;

    expect(targetJunction).toEqual(
      expect.objectContaining({ source: expect.objectContaining({ type: 'pcr-matched-rd' }) })
    );

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: targetJunction!.offset === 0 ? 1 : 0,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'fixed-goldengate-junction',
        targetId: junctionId,
      })
    );
    expect(result.nextDesign).toStrictEqual(design);
    expect(result.nextViewState).toStrictEqual(viewState);
  });

  it('allows Golden Gate PCR overhang offsets beyond the old four-base limit by default', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: 8,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP).toBeGreaterThan(8);
    expect(result.status).toBe('applied');
    expect(result.nextDesign.goldenGateJunctions?.[0]).toEqual(
      expect.objectContaining({ offset: 8 })
    );
  });

  it('treats unchanged Golden Gate PCR overhang offsets as a no-op', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;
    const offset = design.goldenGateJunctions?.[0].offset ?? 0;

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('noop');
    expect(result.nextDesign).toStrictEqual(design);
    expect(result.nextViewState).toStrictEqual(viewState);
    expect(result.appliedCommands).toEqual([]);
    expect(result.projectionInvalidated).toBe(false);
    expect(result.nextDesign.version).toBe(design.version);
    expect(result.nextDesign.designPrimers).toEqual(design.designPrimers);
  });

  it.each([
    ['without spacer', [], -4],
    ['without spacer', [], -3],
    ['without spacer', [], 1],
    ['without spacer', [], 3],
    ['without spacer', [], 4],
    ['with 1 bp spacer', [{ id: 'spacer-0', junctionIndex: 0, sequence: 'A' }], -4],
    ['with 1 bp spacer', [{ id: 'spacer-0', junctionIndex: 0, sequence: 'A' }], 4],
    ['with 6 bp spacer', [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }], -4],
    ['with 6 bp spacer', [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }], 4],
  ] satisfies Array<[string, SequenceDesign['spacers'], number]>)(
    'settles Golden Gate product overhang drags to the full previewed primer overlays %s offset %i',
    (_label, spacers, nextOffset) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const design = ensureAssemblyWorkbenchIdentity(
          draftedDesignFromBase({ ...baseDesign('goldengate'), spacers })
        );
        const viewState = createAssemblyWorkbenchViewState(design);
        const junctionIndex = 0;
        const session = createAssemblyWorkbenchSession(design, viewState);
        const field = session.editableFields.find(
          (item) =>
            item.kind === 'goldenGateOverhang' && item.target.junctionIndex === junctionIndex
        );
        const model = buildJunctionWorkbenchModels(design).find(
          (item) => item.junctionIndex === junctionIndex
        );
        const productRow = model?.rows.find((row) => row.kind === 'product');
        expect(field).toBeDefined();
        expect(model).toBeDefined();
        expect(productRow).toBeDefined();

        const livePreview = goldenGateOverhangLivePreviewForProductRow(
          productRow!,
          field!,
          nextOffset
        );
        expect(livePreview).not.toBeNull();
        const liveByRow = Object.fromEntries(
          model!.rows.map((row) => {
            const livePrimers = goldenGateOverhangLivePrimersForRow(
              row,
              livePreview!,
              junctionIndex
            );
            expect(livePrimers).not.toBeNull();
            return [row.kind, goldenGatePrimerFullOverlaySnapshot(livePrimers!)];
          })
        );

        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState,
          command: {
            type: 'setGoldenGateOffset',
            junctionIndex,
            offset: nextOffset,
            expectedDesignVersion: design.version,
          },
          now: new Date('2026-04-30T00:00:00.000Z'),
        });
        expect(result.status).toBe('applied');

        const settledModel = buildJunctionWorkbenchModels(result.nextDesign).find(
          (item) => item.junctionIndex === junctionIndex
        );
        expect(settledModel).toBeDefined();
        const settledByRow = Object.fromEntries(
          settledModel!.rows.map((row) => [
            row.kind,
            goldenGatePrimerFullOverlaySnapshot(row.primers ?? []),
          ])
        );
        expect(settledByRow).toEqual(liveByRow);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }
  );

  it.each([
    ['gibson without spacer left arm', 'gibson', [], 'left', 34],
    ['gibson without spacer right arm', 'gibson', [], 'right', 36],
    [
      'gibson with spacer left arm',
      'gibson',
      [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      'left',
      34,
    ],
    [
      'gibson with spacer right arm',
      'gibson',
      [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      'right',
      36,
    ],
    ['nebuilder without spacer left arm', 'nebuilder', [], 'left', 34],
    ['nebuilder without spacer right arm', 'nebuilder', [], 'right', 36],
    [
      'nebuilder with spacer left arm',
      'nebuilder',
      [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      'left',
      34,
    ],
    [
      'nebuilder with spacer right arm',
      'nebuilder',
      [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AGCTGT' }],
      'right',
      36,
    ],
  ] satisfies Array<
    [string, SequenceDesign['assemblyMethod'], SequenceDesign['spacers'], 'left' | 'right', number]
  >)(
    'settles homology product overlap drags to the full previewed primer overlays %s',
    (_label, method, spacers, side, nextValue) => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const design = ensureAssemblyWorkbenchIdentity(
          draftedDesignFromBase({ ...baseDesign(method), spacers })
        );
        const viewState = createAssemblyWorkbenchViewState(design);
        const junctionIndex = 0;
        const session = createAssemblyWorkbenchSession(design, viewState);
        const field = session.editableFields.find(
          (item) =>
            item.kind === 'homologyArm' &&
            item.target.junctionIndex === junctionIndex &&
            item.target.side === side
        );
        const model = buildJunctionWorkbenchModels(design).find(
          (item) => item.junctionIndex === junctionIndex
        );
        const productRow = model?.rows.find((row) => row.kind === 'product');
        expect(field).toBeDefined();
        expect(model).toBeDefined();
        expect(productRow).toBeDefined();

        const livePreview = homologyOverlapLivePreviewForProductRow(productRow!, field!, nextValue);
        expect(livePreview).not.toBeNull();
        const liveByRow = Object.fromEntries(
          model!.rows.map((row) => {
            const livePrimers = homologyOverlapLivePrimersForRow(row, livePreview!, junctionIndex);
            expect(livePrimers).not.toBeNull();
            return [row.kind, homologyPrimerFullOverlaySnapshot(livePrimers!)];
          })
        );

        const encoding = { ...field!.command.payload.encoding };
        if (side === 'left') encoding.onLeft = nextValue;
        else encoding.onRight = nextValue;
        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState,
          command: {
            type: 'setHomologyEncoding',
            junctionIndex,
            encoding,
            expectedDesignVersion: design.version,
          },
          now: new Date('2026-04-30T00:00:00.000Z'),
        });
        expect(result.status).toBe('applied');

        const settledModel = buildJunctionWorkbenchModels(result.nextDesign).find(
          (item) => item.junctionIndex === junctionIndex
        );
        expect(settledModel).toBeDefined();
        const settledByRow = Object.fromEntries(
          settledModel!.rows.map((row) => [
            row.kind,
            homologyPrimerFullOverlaySnapshot(row.primers ?? []),
          ])
        );
        expect(settledByRow).toEqual(liveByRow);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    }
  );

  it('stores a Golden Gate offset limit and enforces it for later offset edits', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;

    const limited = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffsetLimit',
        limit: 12,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(limited.status).toBe('applied');
    expect(limited.nextDesign.goldenGateConfig?.offsetLimitBp).toBe(12);

    const atLimit = applyAssemblyWorkbenchCommand({
      design: limited.nextDesign,
      viewState: limited.nextViewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: 12,
        expectedDesignVersion: limited.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });
    expect(atLimit.status).toBe('applied');

    const beyondLimit = applyAssemblyWorkbenchCommand({
      design: limited.nextDesign,
      viewState: limited.nextViewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: 13,
        expectedDesignVersion: limited.nextDesign.version,
      },
      now: new Date('2026-04-30T00:02:00.000Z'),
    });
    expect(beyondLimit.status).toBe('rejected');
    expect(beyondLimit.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-command-value' })
    );
  });

  it('rejects Golden Gate offset limits that would invalidate current offsets', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('goldengate'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const junctionId = design.assemblyWorkbench?.junctions[0].id;

    const offset = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId,
        offset: 8,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(offset.status).toBe('applied');

    const lowered = applyAssemblyWorkbenchCommand({
      design: offset.nextDesign,
      viewState: offset.nextViewState,
      command: {
        type: 'setGoldenGateOffsetLimit',
        limit: 7,
        expectedDesignVersion: offset.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    expect(lowered.status).toBe('rejected');
    expect(lowered.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-command-value' })
    );
    expect(GOLDEN_GATE_OFFSET_LIMIT_MAX_BP).toBeGreaterThan(7);
  });

  it('auto-optimizes Golden Gate PCR offsets while preserving RD-locked junctions', () => {
    const design = ensureAssemblyWorkbenchIdentity(autoOptimizableGoldenGateDesign());
    const viewState = createAssemblyWorkbenchViewState(design);
    const beforeJunctions = design.goldenGateJunctions ?? [];
    const dataset = getGoldenGateFidelityDatasetForEnzyme(
      design.goldenGateConfig?.enzyme ?? 'BsaI'
    );
    const lockedBefore = beforeJunctions.find(
      (junction) => junction.source.type !== 'pcr-designed'
    );

    expect(dataset?.key).toBe('BsaI-HFv2');
    expect(beforeJunctions.filter((junction) => junction.overhang === 'ATAT')).toHaveLength(2);
    expect(lockedBefore).toBeDefined();
    const beforeFidelity = scoreGoldenGateOverhangSet(
      beforeJunctions.map((junction) => junction.overhang),
      dataset!
    );

    const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design));
    expect(plan.status).toBe('planned');
    if (plan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan');
    expect(plan.datasetKey).toBe('BsaI-HFv2');
    expect(plan.beforeFidelity.valid).toBe(false);
    expect(plan.afterFidelity.valid).toBe(true);
    expect(plan.topCombinations.length).toBeGreaterThan(1);
    expect(plan.topCombinations[0].rank).toBe(0);
    expect(plan.topCombinations[0].changedCount).toBe(0);
    expect(Array.from(plan.topCombinations[0].offsetsByJunctionIndex.entries())).toEqual([]);
    expect(plan.topCombinations[0].choices.map((choice) => choice.overhang)).toEqual(
      beforeJunctions.map((junction) => junction.overhang)
    );
    expect(plan.topCombinations[0].choices.map((choice) => choice.offset)).toEqual(
      beforeJunctions.map((junction) => junction.offset)
    );

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'autoOptimize',
        scope: 'all',
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('applied');
    expect(result.errors).toEqual([]);
    const afterJunctions = result.nextDesign.goldenGateJunctions ?? [];
    const afterFidelity = scoreGoldenGateOverhangSet(
      afterJunctions.map((junction) => junction.overhang),
      dataset!
    );
    const editableAfter = afterJunctions.filter(
      (junction) => junction.source.type === 'pcr-designed'
    );
    const editableOverhangs = editableAfter.map((junction) => junction.overhang);
    expect(new Set(editableOverhangs).size).toBe(editableOverhangs.length);
    expect(editableOverhangs).not.toContain('ATAT');
    expect(editableOverhangs.some((overhang) => isPalindrome(overhang))).toBe(false);
    expect(
      afterJunctions.find((junction) => junction.junctionIndex === lockedBefore?.junctionIndex)
    ).toEqual(lockedBefore);
    expect(beforeFidelity.valid).toBe(false);
    expect(afterFidelity.valid).toBe(true);
    expect(result.nextDesign.designPrimers).not.toEqual(design.designPrimers);

    for (const rankedChoice of plan.topCombinations.slice(1, 4)) {
      const rankedResult = applyAssemblyWorkbenchCommand({
        design,
        viewState,
        command: {
          type: 'autoOptimize',
          scope: 'all',
          candidateRank: rankedChoice.rank,
          expectedDesignVersion: design.version,
        },
        now: new Date('2026-04-30T00:00:00.000Z'),
      });
      expect(rankedResult.status).toBe('applied');
      expect(
        (rankedResult.nextDesign.goldenGateJunctions ?? []).map((junction) => junction.overhang)
      ).toEqual(rankedChoice.choices.map((choice) => choice.overhang));
      expect(
        (rankedResult.nextDesign.goldenGateJunctions ?? []).map((junction) => junction.offset)
      ).toEqual(rankedChoice.choices.map((choice) => choice.offset));
    }

    let pbsEditedDesign = design;
    for (const [primer, length] of [
      [design.designPrimers[0].forward, 27],
      [design.designPrimers[1].reverse, 33],
    ] as const) {
      const pbsResult = applyAssemblyWorkbenchCommand({
        design: pbsEditedDesign,
        viewState,
        command: {
          type: 'setPrimerPbsLength',
          primerId: primer.id,
          fragmentIndex: primer.fragmentIndex,
          direction: primer.direction,
          length,
          expectedDesignVersion: pbsEditedDesign.version,
        },
        now: new Date('2026-04-30T00:00:00.000Z'),
      });
      expect(pbsResult.status).toBe('applied');
      pbsEditedDesign = pbsResult.nextDesign;
    }
    const pbsEditedLengths = primerPbsLengths(pbsEditedDesign);
    expect(pbsEditedLengths).not.toEqual(primerPbsLengths(design));

    const rankedPreviewAfterPbsEdits = applyAssemblyWorkbenchCommand({
      design: pbsEditedDesign,
      viewState,
      command: {
        type: 'autoOptimize',
        scope: 'all',
        candidateRank: 1,
        expectedDesignVersion: pbsEditedDesign.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(rankedPreviewAfterPbsEdits.status).toBe('applied');
    expect(primerPbsLengths(rankedPreviewAfterPbsEdits.nextDesign)).toEqual(pbsEditedLengths);
  });

  it('excludes Golden Gate candidates that cannot preserve a user-edited PBS', () => {
    const design = ensureAssemblyWorkbenchIdentity(autoOptimizableGoldenGateDesign());
    const viewState = createAssemblyWorkbenchViewState(design);
    const unconstrainedPlan = planGoldenGateAutoOptimization(
      buildAssemblyOptimizationInput(design)
    );
    expect(unconstrainedPlan.status).toBe('planned');
    if (unconstrainedPlan.status !== 'planned') {
      throw new Error('Expected Golden Gate optimizer plan');
    }
    const reversePrimer = design.designPrimers[1].reverse;
    const pbsEdit = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: reversePrimer.id,
        fragmentIndex: reversePrimer.fragmentIndex,
        direction: reversePrimer.direction,
        length: 33,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(pbsEdit.status).toBe('applied');
    expect(
      pbsEdit.nextDesign.designPrimers[1].reverse.pbs.end -
        pbsEdit.nextDesign.designPrimers[1].reverse.pbs.start
    ).toBe(33);

    const constrainedPlan = planGoldenGateAutoOptimization(
      buildAssemblyOptimizationInput(pbsEdit.nextDesign)
    );
    expect(constrainedPlan.status).toBe('planned');
    if (constrainedPlan.status !== 'planned') {
      throw new Error('Expected constrained Golden Gate optimizer plan');
    }
    expect(constrainedPlan.topCombinations.length).toBeGreaterThan(1);

    const expectedPbsLengths = primerPbsLengths(pbsEdit.nextDesign);
    for (const combination of constrainedPlan.topCombinations.slice(1)) {
      const result = applyAssemblyWorkbenchCommand({
        design: pbsEdit.nextDesign,
        viewState: pbsEdit.nextViewState,
        command: {
          type: 'autoOptimize',
          scope: 'all',
          candidateRank: combination.rank,
          expectedDesignVersion: pbsEdit.nextDesign.version,
        },
        now: new Date('2026-04-30T00:01:00.000Z'),
      });

      expect(result.status).toBe('applied');
      expect(result.errors).toEqual([]);
      expect(primerPbsLengths(result.nextDesign)).toEqual(expectedPbsLengths);
      expect(
        (result.nextDesign.goldenGateJunctions ?? []).map((junction) => junction.offset)
      ).toEqual(combination.choices.map((choice) => choice.offset));
    }
  });

  it.each([
    {
      name: 'linear forward primer',
      topology: 'linear' as const,
      spacerSequence: '',
      junctionIndex: 0,
      edits: [{ fragmentIndex: 1, direction: 'forward' as const, length: 34 }],
    },
    {
      name: 'linear spacer and both adjacent primers',
      topology: 'linear' as const,
      spacerSequence: 'GCTA',
      junctionIndex: 0,
      edits: [
        { fragmentIndex: 0, direction: 'reverse' as const, length: 36 },
        { fragmentIndex: 1, direction: 'forward' as const, length: 34 },
      ],
    },
    {
      name: 'circular closure without a spacer',
      topology: 'circular' as const,
      spacerSequence: '',
      junctionIndex: 1,
      edits: [
        { fragmentIndex: 1, direction: 'reverse' as const, length: 33 },
        { fragmentIndex: 0, direction: 'forward' as const, length: 33 },
      ],
    },
    {
      name: 'circular closure with a spacer',
      topology: 'circular' as const,
      spacerSequence: 'GCTA',
      junctionIndex: 1,
      edits: [
        { fragmentIndex: 1, direction: 'reverse' as const, length: 36 },
        { fragmentIndex: 0, direction: 'forward' as const, length: 34 },
      ],
    },
  ])(
    'plans and applies only PBS-preserving candidates for $name',
    ({ topology, spacerSequence, junctionIndex, edits }) => {
      let design = ensureAssemblyWorkbenchIdentity(
        pbsGeometryGoldenGateDesign(topology, spacerSequence, junctionIndex)
      );
      let viewState = createAssemblyWorkbenchViewState(design);

      for (const edit of edits) {
        const pair = design.designPrimers[edit.fragmentIndex];
        const primer = edit.direction === 'forward' ? pair.forward : pair.reverse;
        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState,
          command: {
            type: 'setPrimerPbsLength',
            primerId: primer.id,
            fragmentIndex: edit.fragmentIndex,
            direction: edit.direction,
            length: edit.length,
            expectedDesignVersion: design.version,
          },
          now: new Date('2026-04-30T00:01:00.000Z'),
        });
        expect(result.status).toBe('applied');
        design = result.nextDesign;
        viewState = result.nextViewState;
        const editedPair = design.designPrimers[edit.fragmentIndex];
        const editedPrimer = edit.direction === 'forward' ? editedPair.forward : editedPair.reverse;
        expect(editedPrimer.pbs.end - editedPrimer.pbs.start).toBe(edit.length);
      }

      const expectedPbsLengths = primerPbsLengths(design);
      const plan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design), {
        scopeJunctionIndex: junctionIndex,
      });
      expect(plan.status).toBe('planned');
      if (plan.status !== 'planned') {
        throw new Error('Expected constrained Golden Gate optimizer plan');
      }
      expect(plan.topCombinations.length).toBeGreaterThan(1);

      for (const combination of plan.topCombinations.slice(1)) {
        const result = applyAssemblyWorkbenchCommand({
          design,
          viewState,
          command: {
            type: 'autoOptimize',
            scope: 'selected-junction',
            candidateRank: combination.rank,
            expectedDesignVersion: design.version,
          },
          now: new Date('2026-04-30T00:02:00.000Z'),
        });

        expect(result.status).toBe('applied');
        expect(result.errors).toEqual([]);
        expect(primerPbsLengths(result.nextDesign)).toEqual(expectedPbsLengths);
        expect(
          result.nextDesign.goldenGateJunctions?.find(
            (junction) => junction.junctionIndex === junctionIndex
          )?.offset
        ).toBe(
          combination.choices.find((choice) => choice.junctionIndex === junctionIndex)?.offset
        );
      }
    }
  );

  it('fingerprints Golden Gate optimization inputs from assembly geometry and PBS constraints', () => {
    const design = ensureAssemblyWorkbenchIdentity(autoOptimizableGoldenGateDesign());
    const baseline = buildAssemblyOptimizationInput(design);

    const renamedPrimers: SequenceDesign = {
      ...design,
      designPrimers: design.designPrimers.map((pair) => ({
        ...pair,
        forward: { ...pair.forward, name: `${pair.forward.name} renamed` },
        reverse: { ...pair.reverse, name: `${pair.reverse.name} renamed` },
      })),
      version: design.version + 10,
    };
    expect(buildAssemblyOptimizationInput(renamedPrimers).optimizationFingerprint).toBe(
      baseline.optimizationFingerprint
    );

    const viewState = createAssemblyWorkbenchViewState(design);
    const pbsEdited = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setPrimerPbsLength',
        primerId: design.designPrimers[0].forward.id,
        fragmentIndex: design.designPrimers[0].fragmentIndex,
        direction: 'forward',
        length: 31,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(pbsEdited.status).toBe('applied');
    expect(buildAssemblyOptimizationInput(pbsEdited.nextDesign).optimizationFingerprint).not.toBe(
      baseline.optimizationFingerprint
    );

    const editableJunction = (design.goldenGateJunctions ?? []).find(
      (junction) => junction.source.type === 'pcr-designed'
    );
    if (!editableJunction) throw new Error('Expected editable Golden Gate junction.');
    const offsetEdited = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId: design.assemblyWorkbench?.junctions.find(
          (junction) => junction.slot === editableJunction.junctionIndex
        )?.id,
        offset: editableJunction.offset + 1,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(offsetEdited.status).toBe('applied');
    expect(buildAssemblyOptimizationInput(offsetEdited.nextDesign).optimizationFingerprint).toBe(
      baseline.optimizationFingerprint
    );

    const spacerChanged: SequenceDesign = {
      ...design,
      spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'GATTACA' }],
      version: design.version + 1,
    };
    expect(buildAssemblyOptimizationInput(spacerChanged).optimizationFingerprint).not.toBe(
      baseline.optimizationFingerprint
    );

    const sourceBoundaryChanged: SequenceDesign = {
      ...design,
      regions: [
        {
          ...design.regions[0],
          sourceStart: design.regions[0].sourceStart + 1,
          sourceEnd: design.regions[0].sourceEnd + 1,
        },
        ...design.regions.slice(1),
      ],
      version: design.version + 1,
    };
    expect(buildAssemblyOptimizationInput(sourceBoundaryChanged).optimizationFingerprint).not.toBe(
      baseline.optimizationFingerprint
    );

    const offsetLimitChanged: SequenceDesign = {
      ...design,
      goldenGateConfig: { enzyme: 'BsaI', offsetLimitBp: 3 },
      version: design.version + 1,
    };
    expect(buildAssemblyOptimizationInput(offsetLimitChanged).optimizationFingerprint).not.toBe(
      baseline.optimizationFingerprint
    );
  });

  it('keeps programmed Golden Gate optimizer candidate rows stable when only the current offset is dragged', () => {
    const design = ensureAssemblyWorkbenchIdentity(autoOptimizableGoldenGateDesign());
    const viewState = createAssemblyWorkbenchViewState(design);
    const beforePlan = planGoldenGateAutoOptimization(buildAssemblyOptimizationInput(design), {
      topCombinationCount: 8,
    });
    expect(beforePlan.status).toBe('planned');
    if (beforePlan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan');
    const editableJunction = (design.goldenGateJunctions ?? []).find(
      (junction) => junction.source.type === 'pcr-designed'
    );
    if (!editableJunction) throw new Error('Expected editable Golden Gate junction.');

    const dragged = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setGoldenGateOffset',
        junctionId: design.assemblyWorkbench?.junctions.find(
          (junction) => junction.slot === editableJunction.junctionIndex
        )?.id,
        offset: editableJunction.offset + 1,
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(dragged.status).toBe('applied');

    const afterPlan = planGoldenGateAutoOptimization(
      buildAssemblyOptimizationInput(dragged.nextDesign),
      { topCombinationCount: 8 }
    );
    expect(afterPlan.status).toBe('planned');
    if (afterPlan.status !== 'planned') throw new Error('Expected Golden Gate optimizer plan');
    expect(optimizedGoldenGateRows(afterPlan)).toEqual(optimizedGoldenGateRows(beforePlan));
    expect(afterPlan.topCombinations[0].choices.map((choice) => choice.offset)).not.toEqual(
      beforePlan.topCombinations[0].choices.map((choice) => choice.offset)
    );
  });

  it('rejects Golden Gate auto optimization when no four-base paper dataset exists', () => {
    const design = ensureAssemblyWorkbenchIdentity({
      ...autoOptimizableGoldenGateDesign(),
      goldenGateConfig: { enzyme: 'SapI', offsetLimitBp: 6 },
    });
    const viewState = createAssemblyWorkbenchViewState(design);

    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'autoOptimize',
        scope: 'all',
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });

    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        code: 'optimizer-data-unavailable',
        message: expect.stringContaining(
          'No bundled four-base empirical ligation-fidelity dataset'
        ),
      })
    );
    expect(result.nextDesign).toEqual(design);
  });

  it('auto-optimizes homology junctions back to Tm-sized encodings through the reducer', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const viewState = createAssemblyWorkbenchViewState(design);
    const degraded = applyAssemblyWorkbenchCommand({
      design,
      viewState,
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: { onLeft: 1, onRight: 1 },
        expectedDesignVersion: design.version,
      },
      now: new Date('2026-04-30T00:00:00.000Z'),
    });
    expect(degraded.status).toBe('applied');
    expect(degraded.nextDesign.homologyRegions[0].metadata?.sequence).toHaveLength(2);

    const result = applyAssemblyWorkbenchCommand({
      design: degraded.nextDesign,
      viewState: degraded.nextViewState,
      command: {
        type: 'autoOptimize',
        scope: 'selected-junction',
        expectedDesignVersion: degraded.nextDesign.version,
      },
      now: new Date('2026-04-30T00:01:00.000Z'),
    });

    const expectedDraft = computeDraftAssembly(
      degraded.nextDesign,
      undefined,
      createAppTmCalculator(degraded.nextDesign.pcrPolymerase)
    ).homologyRegions[0];
    expect(result.status).toBe('applied');
    expect(result.errors).toEqual([]);
    expect(result.nextDesign.homologyRegions[0].encoding).toEqual(expectedDraft.encoding);
    expect(result.nextDesign.homologyRegions[0].metadata?.sequence).toHaveLength(
      expectedDraft.metadata?.sequence.length ?? 0
    );
    expectHomologyJunctionPairPhysicallyCoherent(result.nextDesign, 0);
  });

  it('rejects a negative overlap without changing the valid primer windows', () => {
    const design = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    expect(design.homologyRegions[0].encoding).toEqual({ onLeft: 30, onRight: 0 });
    const result = applyAssemblyWorkbenchCommand({
      design,
      viewState: createAssemblyWorkbenchViewState(design),
      command: {
        type: 'setHomologyEncoding',
        junctionIndex: 0,
        encoding: { onLeft: -5, onRight: 0 },
        expectedDesignVersion: design.version,
      },
    });
    expect(result.status).toBe('rejected');
    expect(result.errors).toContainEqual({
      code: 'invalid-command-value',
      commandType: 'setHomologyEncoding',
      message: 'Homology boundaries must define a non-negative product overlap length.',
    });
    expect(result.nextDesign).toEqual(design);
  });

  it('shares a 30 base PCR product overlap when the upstream primer is only 26 bases', () => {
    const automaticDesign = ensureAssemblyWorkbenchIdentity(draftedDesign('gibson'));
    const prepared = applyAssemblyWorkbenchCommand({
      design: automaticDesign,
      viewState: createAssemblyWorkbenchViewState(automaticDesign),
      command: {
        type: 'setPrimerPbsLength',
        primerId: automaticDesign.designPrimers[0].reverse.id,
        length: 26,
        expectedDesignVersion: automaticDesign.version,
      },
    });
    expect(prepared.status).toBe('applied');
    const design = prepared.nextDesign;
    const upstream = design.designPrimers[0];
    const downstream = design.designPrimers[1];
    const overlap = design.regions[0].sequence.slice(-30);
    const upstreamProduct = reconstructPcrProduct(design, upstream);
    const downstreamProduct = reconstructPcrProduct(design, downstream);

    expect(upstream.reverse.sequence).toHaveLength(26);
    expect(overlap).toHaveLength(30);
    expect(reverseComplement(upstream.reverse.sequence).endsWith(overlap)).toBe(false);
    expect(upstreamProduct.sequence).toBe(design.regions[0].sequence);
    expect(downstreamProduct.sequence).toBe(
      overlap + design.regions[1].sequence + design.regions[0].sequence.slice(0, 30)
    );
    expect(upstreamProduct.source).toEqual({
      regionId: design.regions[0].id,
      start: 0,
      end: design.regions[0].sequence.length,
      sequence: design.regions[0].sequence,
    });
    expect(downstreamProduct.source).toEqual({
      regionId: design.regions[1].id,
      start: 0,
      end: design.regions[1].sequence.length,
      sequence: design.regions[1].sequence,
    });
    expect(upstreamProduct.sequence.endsWith(overlap)).toBe(true);
    expect(downstreamProduct.sequence.startsWith(overlap)).toBe(true);
    expectHomologyJunctionPairPhysicallyCoherent(design, 0);
  });
});

function draftedDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const design = baseDesign(method);
  const draft = computeDraftAssembly(
    design,
    undefined,
    createAppTmCalculator(design.pcrPolymerase)
  );
  design.homologyRegions = draft.homologyRegions;
  design.designPrimers = draft.designPrimers;
  design.goldenGateJunctions = draft.goldenGateJunctions;
  design.assemblyState = 'ready';
  design.status = 'computed';
  design.version = 1;
  return design;
}

function draftedRdDesign(): SequenceDesign {
  const design = baseDesign('goldengate');
  design.regions = [
    rdRegion('r1', 'ACGT'.repeat(60), { upstream: 'AATG', downstream: 'GCAA' }),
    rdRegion('r2', 'TGCA'.repeat(60), { upstream: 'GCAA', downstream: 'AATG' }),
  ];
  return draftedDesignFromBase(design);
}

function autoOptimizableGoldenGateDesign(): SequenceDesign {
  const design = baseDesign('goldengate');
  design.topology = 'linear';
  design.regions = [
    region('r1', 'C'.repeat(32) + 'GAT'),
    region('r2', 'ATG' + 'C'.repeat(30) + 'CAT'),
    region('r3', 'ATC' + 'G'.repeat(30) + 'GGA'),
    rdRegion('rd', 'A'.repeat(64), { upstream: 'AATG', downstream: 'GCAA' }),
  ];
  design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
  return draftedDesignFromBase(design);
}

function pbsGeometryGoldenGateDesign(
  topology: SequenceDesign['topology'],
  spacerSequence: string,
  junctionIndex: number
): SequenceDesign {
  const design = baseDesign('goldengate');
  design.id = `goldengate-pbs-${topology}-${spacerSequence.length}`;
  design.topology = topology;
  design.regions = [
    region('r1', 'ACGTTGCAGATCCGTAACGGTACCTGATCGTACGTA'),
    region('r2', 'TGCAGGATCTAACCGTATGCTAGCGTACCTGATGCA'),
  ];
  design.spacers =
    spacerSequence.length > 0
      ? [{ id: 'pbs-geometry-spacer', junctionIndex, sequence: spacerSequence }]
      : [];
  design.goldenGateConfig = { enzyme: 'BsaI', offsetLimitBp: 6 };
  design.selectedJunctionIndex = junctionIndex;
  return draftedDesignFromBase(design);
}

function rdAdjacentHomologyDesign(
  method: SequenceDesign['assemblyMethod'],
  rdSide: 'left' | 'right'
): SequenceDesign {
  const design = baseDesign(method);
  design.topology = 'linear';
  design.spacers = [{ id: 'spacer-0', junctionIndex: 0, sequence: 'GGCC' }];
  const pcr = region('pcr', 'ATGC'.repeat(28) + 'GATTACA'.repeat(4));
  const rd = rdRegion('rd', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(24), {
    upstream: 'AATG',
    downstream: 'GCTA',
  });
  design.regions = rdSide === 'left' ? [rd, pcr] : [pcr, rd];
  return draftedDesignFromBase(design);
}

function draftedRealPipelineDesign(
  scenarioId: Parameters<typeof realAssemblyPipelineScenarioById>[0]
): SequenceDesign {
  const design = realAssemblyPipelineScenarioById(scenarioId).buildDesign();
  return draftedDesignFromBase(design);
}

function draftedDesignFromBase(design: SequenceDesign): SequenceDesign {
  const draft = computeDraftAssembly(
    design,
    undefined,
    createAppTmCalculator(design.pcrPolymerase)
  );
  return {
    ...design,
    homologyRegions: draft.homologyRegions,
    designPrimers: draft.designPrimers,
    goldenGateJunctions: draft.goldenGateJunctions,
    assemblyState: 'ready',
    status: 'computed',
    version: 1,
  };
}

function primerPbsLengths(design: SequenceDesign): number[] {
  return design.designPrimers.flatMap((pair) => [
    pair.forward.pbs.end - pair.forward.pbs.start,
    pair.reverse.pbs.end - pair.reverse.pbs.start,
  ]);
}

function optimizedGoldenGateRows(
  plan: Extract<ReturnType<typeof planGoldenGateAutoOptimization>, { status: 'planned' }>
) {
  return plan.topCombinations.slice(1).map((combination) => ({
    rank: combination.rank,
    fidelity: combination.fidelity.fidelity,
    choices: combination.choices.map((choice) => ({
      junctionIndex: choice.junctionIndex,
      offset: choice.offset,
      overhang: choice.overhang,
      locked: choice.locked,
    })),
  }));
}

function baseDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-04-30T00:00:00.000Z');
  return {
    id: `reducer-${method}`,
    name: `${method} reducer`,
    topology: 'circular',
    regions: [region('r1', 'ACGT'.repeat(60)), region('r2', 'TGCA'.repeat(60))],
    spacers: [],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: method,
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: method === 'goldengate' ? { enzyme: 'BsaI' } : undefined,
    goldenGateJunctions: method === 'goldengate' ? [] : undefined,
    designPrimers: [],
    selectedJunctionIndex: 0,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function region(id: string, sequence: string): DesignRegion {
  return {
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceType: 'pcr',
  };
}

function rdRegion(
  id: string,
  sequence: string,
  rdOverhangs: NonNullable<DesignRegion['rdOverhangs']>
): DesignRegion {
  return {
    ...region(id, sequence),
    sourceType: 'rd',
    rdOverhangs,
    rdSourceEnzyme: 'BsaI',
  };
}

function goldenGatePrimerThreePrimeEndpoints(primers: PrimerDisplay[]) {
  return primers
    .filter(
      (primer) =>
        !primer.isScarMarkerOnly &&
        primer.cutPositionInOverhang !== undefined &&
        primer.junctionIndex === 0
    )
    .map((primer) => ({
      key: primer.sourcePrimerId ?? primer.id,
      direction: primer.direction,
      start: primer.start,
      end: primer.end,
      threePrime: primer.direction === 'forward' ? primer.end : primer.start,
      overhangLength: primer.overhangLength,
    }))
    .sort((a, b) => `${a.direction}:${a.key}`.localeCompare(`${b.direction}:${b.key}`));
}

function goldenGatePrimerFullOverlaySnapshot(primers: PrimerDisplay[]) {
  return primers
    .filter(
      (primer) =>
        !primer.isScarMarkerOnly &&
        primer.cutPositionInOverhang !== undefined &&
        primer.junctionIndex === 0
    )
    .map((primer) => ({
      key: primer.sourcePrimerId ?? primer.id,
      direction: primer.direction,
      start: primer.start,
      end: primer.end,
      threePrime: primer.direction === 'forward' ? primer.end : primer.start,
      overhangLength: primer.overhangLength,
      bases: primer.bases,
      length: primer.bases.length,
    }))
    .sort((a, b) => `${a.direction}:${a.key}`.localeCompare(`${b.direction}:${b.key}`));
}

function homologyPrimerFullOverlaySnapshot(primers: PrimerDisplay[]) {
  return primers
    .filter(
      (primer) =>
        !primer.isScarMarkerOnly &&
        primer.cutPositionInOverhang === undefined &&
        primer.junctionIndex === 0
    )
    .map((primer) => ({
      key: primer.sourcePrimerId ?? primer.id,
      direction: primer.direction,
      start: primer.start,
      end: primer.end,
      threePrime: primer.direction === 'forward' ? primer.end : primer.start,
      overhangLength: primer.overhangLength,
      bases: primer.bases,
      length: primer.bases.length,
    }))
    .sort((a, b) => `${a.direction}:${a.key}`.localeCompare(`${b.direction}:${b.key}`));
}

function expectHomologyJunctionPairPhysicallyCoherent(
  design: SequenceDesign,
  junctionIndex: number
) {
  const composed = getComposedSequence(design.regions, design.spacers);
  const homology = design.homologyRegions.find((item) => item.junctionIndex === junctionIndex);
  const spacer =
    design.spacers.find((item) => item.junctionIndex === junctionIndex)?.sequence ?? '';
  const upstream = design.designPrimers.find(
    (pair) => pair.reverse.junctionIndex === junctionIndex
  );
  const downstream = design.designPrimers.find(
    (pair) => pair.forward.junctionIndex === junctionIndex
  );
  expect(homology).toBeDefined();
  expect(homology?.junctionPosition).toBeDefined();
  expect(upstream).toBeDefined();
  expect(downstream).toBeDefined();
  if (!homology || homology.junctionPosition === undefined || !upstream || !downstream) {
    throw new Error(
      'The physical overlap oracle requires a homology junction and both PCR products.'
    );
  }

  const productOrigin = homology.junctionPosition - spacer.length;
  const productStartBioCol = spacer.length - homology.encoding.onLeft;
  const productEndBioCol = spacer.length + homology.encoding.onRight;
  const overlapTemplate = circularSlice(
    composed,
    productOrigin + productStartBioCol,
    productEndBioCol - productStartBioCol
  );
  const downstreamForward = downstream.forward;
  const upstreamReverse = upstream.reverse;
  const downstreamPbsTemplate = composed.slice(
    downstreamForward.pbs.start,
    downstreamForward.pbs.end
  );
  const upstreamPbsTemplate = composed.slice(upstreamReverse.pbs.start, upstreamReverse.pbs.end);
  const downstreamProduct = reconstructPcrProduct(design, downstream);
  const upstreamProduct = reconstructPcrProduct(design, upstream);

  expect(overlapTemplate.length).toBeGreaterThan(0);
  expect(downstreamForward.pbs.sequence).toBe(downstreamPbsTemplate);
  expect(upstreamReverse.pbs.sequence).toBe(reverseComplement(upstreamPbsTemplate));
  expect(downstreamForward.overhang.length).toBe(downstreamForward.overhang.sequence.length);
  expect(upstreamReverse.overhang.length).toBe(upstreamReverse.overhang.sequence.length);
  expect(downstreamForward.sequence).toBe(
    downstreamForward.overhang.sequence + downstreamForward.pbs.sequence
  );
  expect(upstreamReverse.sequence).toBe(
    upstreamReverse.overhang.sequence + upstreamReverse.pbs.sequence
  );
  expect(downstreamProduct.sequence.startsWith(overlapTemplate)).toBe(true);
  expect(upstreamProduct.sequence.endsWith(overlapTemplate)).toBe(true);
}

function reconstructPcrProduct(
  design: SequenceDesign,
  pair: SequenceDesign['designPrimers'][number]
) {
  const region = design.regions[pair.fragmentIndex];
  expect(region.sourceType).toBe('pcr');
  expect(pair.forward.direction).toBe('forward');
  expect(pair.reverse.direction).toBe('reverse');
  expect(pair.forward.fragmentIndex).toBe(pair.fragmentIndex);
  expect(pair.reverse.fragmentIndex).toBe(pair.fragmentIndex);
  const regionStart = design.regions
    .slice(0, pair.fragmentIndex)
    .reduce(
      (offset, source, index) =>
        offset +
        source.sequence.length +
        (design.spacers.find((spacer) => spacer.junctionIndex === index)?.sequence.length ?? 0),
      0
    );
  const forwardStart = pair.forward.pbs.start - regionStart;
  const forwardEnd = pair.forward.pbs.end - regionStart;
  const reverseStart = pair.reverse.pbs.start - regionStart;
  const reverseEnd = pair.reverse.pbs.end - regionStart;
  for (const coordinate of [forwardStart, forwardEnd, reverseStart, reverseEnd]) {
    expect(Number.isInteger(coordinate)).toBe(true);
  }
  expect(forwardStart).toBeGreaterThanOrEqual(0);
  expect(forwardEnd).toBeGreaterThan(forwardStart);
  expect(forwardEnd).toBeLessThanOrEqual(region.sequence.length);
  expect(reverseStart).toBeGreaterThanOrEqual(0);
  expect(reverseEnd).toBeGreaterThan(reverseStart);
  expect(reverseEnd).toBeLessThanOrEqual(region.sequence.length);
  expect(forwardEnd).toBeLessThanOrEqual(reverseEnd);
  expect(reverseStart).toBeGreaterThanOrEqual(forwardStart);
  expect(pair.forward.pbs.sequence).toBe(region.sequence.slice(forwardStart, forwardEnd));
  expect(pair.reverse.pbs.sequence).toBe(
    reverseComplement(region.sequence.slice(reverseStart, reverseEnd))
  );
  const copiedTemplate = region.sequence.slice(forwardStart, reverseEnd);
  return {
    sequence:
      pair.forward.overhang.sequence +
      copiedTemplate +
      reverseComplement(pair.reverse.overhang.sequence),
    source: { regionId: region.id, start: forwardStart, end: reverseEnd, sequence: copiedTemplate },
  };
}

function circularSlice(sequence: string, start: number, length: number): string {
  let result = '';
  for (let index = 0; index < length; index++) {
    const pos = (((start + index) % sequence.length) + sequence.length) % sequence.length;
    result += sequence[pos];
  }
  return result;
}
