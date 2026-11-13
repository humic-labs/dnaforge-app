import { describe, expect, it } from 'vitest';
import type { DesignRegion, HomologyRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import {
  assemblyUiCleanupShowcase,
  realAssemblyPipelineScenarioById,
} from '../../test/scenarios/assembly-real-pipeline';
import {
  ASSEMBLY_WORKBENCH_COMMAND_TYPES,
  ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION,
  createAssemblyWorkbenchSession,
} from './AssemblyWorkbenchSession';
import { GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP } from './AssemblyWorkbenchContract';
import { resolveEditableFieldCommand } from './editable-field-command';

describe('AssemblyWorkbenchSession', () => {
  it.each(['gibson', 'goldengate'] as const)(
    'projects saved %s fields as read-only and rejects resolved field commands',
    (method) => {
      const design = draftedDesign(method);
      const original = JSON.stringify(design);
      const session = createAssemblyWorkbenchSession(design, undefined, { readOnly: true });
      expect(session.readOnly).toBe(true);
      expect(session.editableFields.length).toBeGreaterThan(0);
      for (const field of session.editableFields) {
        expect(field.disabled).toBe(true);
        expect(field.constraints).toContainEqual(expect.objectContaining({ code: 'read-only' }));
        expect(
          resolveEditableFieldCommand(field, typeof field.value === 'string' ? field.value : 0)
        ).toEqual(expect.objectContaining({ status: 'rejected', reason: 'disabled' }));
      }
      expect(JSON.stringify(design)).toBe(original);
    }
  );
  it('builds a serializable MCP-shaped command surface for homology assemblies', () => {
    const design = draftedDesign('gibson');
    const session = createAssemblyWorkbenchSession(design);

    expect(session.schemaVersion).toBe(ASSEMBLY_WORKBENCH_SESSION_SCHEMA_VERSION);
    expect(session.designId).toBe(design.id);
    expect(session.mode).toBe('gibson');
    expect(session.commandSurface.commands).toEqual(ASSEMBLY_WORKBENCH_COMMAND_TYPES);
    expect(session.controls.junctions).toHaveLength(2);
    expect(session.controls.junctions[0].primers.length).toBeGreaterThan(0);
    expect(session.controls.junctions[0].homology?.totalLength).toBeGreaterThan(0);
    expect(session.controls.junctions[0].spacer).toEqual(
      expect.objectContaining({ sequence: '', length: 0, canEdit: true })
    );
    expect(session.strategy.supports.primerPbsLength).toBe(true);
    expect(session.strategy.supports.primerOverhangLength).toBe(true);
    expect(session.strategy.supports.spacerSequence).toBe(true);

    const roundTrip = JSON.parse(JSON.stringify(session));
    expect(roundTrip.commandSurface.commands).toContain('setPrimerPbsLength');
    expect(roundTrip.commandSurface.commands).toContain('setJunctionSpacer');
    expect(roundTrip.commandSurface.commands).toContain('setSourceContributionBoundary');
    expect(roundTrip.controls.junctions[0].primers[0].pbsLength).toBeGreaterThan(0);
  });

  it('emits a serializable editable-field manifest for junction automation', () => {
    const design = draftedDesign('gibson');
    const session = createAssemblyWorkbenchSession(design);

    expect(session.editableFields.map((field) => field.kind)).toEqual(
      expect.arrayContaining([
        'sourceContributionBoundary',
        'junctionSpacer',
        'primerPbs',
        'primerTail',
        'homologyArm',
      ])
    );

    const leftBoundary = session.editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === 'r1' &&
        field.target.side === 'downstream'
    );
    expect(leftBoundary).toEqual(
      expect.objectContaining({
        value: design.regions[0].sourceEnd,
        command: expect.objectContaining({
          type: 'setSourceContributionBoundary',
          valueKey: 'sourcePosition',
          payload: expect.objectContaining({
            regionId: 'r1',
            side: 'downstream',
            expectedDesignVersion: design.version,
          }),
        }),
      })
    );
    expect(leftBoundary?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'gibson-0-left',
        rowKind: 'left-source',
        bioCol: 0,
        role: 'boundary',
      })
    );

    const primerPbs = session.editableFields.find(
      (field) => field.kind === 'primerPbs' && field.target.side === 'left'
    );
    expect(primerPbs).toEqual(
      expect.objectContaining({
        range: expect.objectContaining({ min: 10 }),
        command: expect.objectContaining({
          type: 'setPrimerPbsLength',
          valueKey: 'length',
        }),
      })
    );
    expect(primerPbs?.range?.max).toBeGreaterThan(60);
    expect(primerPbs?.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowId: 'gibson-0-left',
          rowKind: 'left-source',
          role: 'pbs-start',
        }),
        expect.objectContaining({
          rowId: 'gibson-0-product',
          rowKind: 'product',
          role: 'pbs-start',
        }),
      ])
    );

    const junctionSpacer = session.editableFields.find(
      (field) => field.kind === 'junctionSpacer' && field.target.junctionIndex === 0
    );
    expect(junctionSpacer).toEqual(
      expect.objectContaining({
        value: '',
        units: 'sequence',
        command: expect.objectContaining({
          type: 'setJunctionSpacer',
          valueKey: 'sequence',
          payload: expect.objectContaining({
            junctionIndex: 0,
            expectedDesignVersion: design.version,
          }),
        }),
      })
    );

    const roundTrip = JSON.parse(JSON.stringify(session));
    expect(roundTrip.editableFields[0].id).toBe(session.editableFields[0].id);
  });

  it('exposes the full physical PBS range for every primer in the assembly map showcase', () => {
    const scenario = assemblyUiCleanupShowcase();
    const design = scenario.designs?.designs[scenario.designs.activeDesignId ?? ''];
    expect(design).toBeDefined();
    if (!design) return;

    const primerFields = createAssemblyWorkbenchSession(design).editableFields.filter(
      (field) => field.kind === 'primerPbs'
    );
    expect(primerFields).toHaveLength(design.designPrimers.length * 2);
    for (const field of primerFields) {
      expect(field.range?.max).toBeGreaterThan(60);
    }
  });

  it('uses source context length for source-boundary field ranges', () => {
    const design = draftedDesign('gibson');
    design.regions[0] = {
      ...design.regions[0],
      sourceSequence: undefined,
      sourceStart: 40,
      sourceEnd: 160,
      sequence: 'ACGT'.repeat(30),
    };

    const session = createAssemblyWorkbenchSession(design, undefined, {
      sourceContext: {
        ready: true,
        regions: {
          r1: {
            sequence: 'C'.repeat(220),
            sourceStart: 0,
            sourceEnd: 220,
            sourceLength: 260,
          },
        },
      },
    });

    const leftBoundary = session.editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === 'r1' &&
        field.target.side === 'downstream'
    );

    expect(leftBoundary?.range).toEqual({ min: 41, max: 260, step: 1, largeStep: 10 });
  });

  it('anchors right-side editable fields after spacer columns in the registered coordinate system', () => {
    const design = baseDesign('gibson');
    design.spacers = [{ id: 'spacer-j0', junctionIndex: 0, sequence: 'AAGC' }];
    const draft = computeDraftAssembly(design);
    design.homologyRegions = draft.homologyRegions;
    design.designPrimers = draft.designPrimers;
    design.assemblyState = 'ready';
    design.status = 'computed';
    design.version = 1;

    const session = createAssemblyWorkbenchSession(design);
    const rightBoundary = session.editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === 'r2' &&
        field.target.side === 'upstream'
    );
    const rightPbs = session.editableFields.find(
      (field) => field.kind === 'primerPbs' && field.target.side === 'right'
    );
    const homology = session.controls.junctions[0].homology!;

    expect(rightBoundary?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'gibson-0-right',
        rowKind: 'right-source',
        bioCol: 4,
        role: 'boundary',
      })
    );
    expect(rightPbs?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'gibson-0-right',
        rowKind: 'right-source',
        bioCol: 4,
        role: 'pbs-start',
      })
    );
    expect(homology.totalLength).toBe(homology.onLeft + homology.onRight);
    expect(homology.spacerLength).toBe(4);
    expect(homology.crossoverLength).toBe(homology.onLeft + homology.onRight);
  });

  it('reports PCR-to-RD spacer as reverse primer tail cargo, not homology length', () => {
    const design = baseDesign('gibson');
    design.topology = 'linear';
    design.regions = [
      region('pcr-left', 'ATGC'.repeat(24)),
      {
        ...region('rd-right', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(20)),
        sourceType: 'rd',
        rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
        rdSourceEnzyme: 'BsaI',
      },
    ];
    design.spacers = [{ id: 'spacer-j0', junctionIndex: 0, sequence: 'GGCC' }];
    const draft = computeDraftAssembly(design);
    design.homologyRegions = draft.homologyRegions;
    design.designPrimers = draft.designPrimers;
    design.assemblyState = 'ready';
    design.status = 'computed';
    design.version = 1;

    const session = createAssemblyWorkbenchSession(design);
    const homology = session.controls.junctions[0].homology!;
    const reversePrimer = session.controls.junctions[0].primers.find(
      (primer) => primer.direction === 'reverse'
    )!;

    expect(homology.onLeft).toBe(0);
    expect(homology.totalLength).toBe(homology.onRight);
    expect(design.designPrimers[0].reverse.overhang.length).toBe(homology.onRight);
    expect(reversePrimer.overhangLength).toBe(homology.onRight + 4);
  });

  it('reports RD-to-PCR spacer as forward primer tail cargo, not homology length', () => {
    const design = rdAdjacentHomologyDesign('gibson', 'left');
    const session = createAssemblyWorkbenchSession(design);
    const homology = session.controls.junctions[0].homology!;
    const forwardPrimer = session.controls.junctions[0].primers.find(
      (primer) => primer.direction === 'forward'
    )!;
    const pcrPrimerPair = design.designPrimers.find((pair) => pair.fragmentIndex === 1)!;

    expect(homology.onRight).toBe(0);
    expect(homology.totalLength).toBe(homology.onLeft);
    expect(pcrPrimerPair.forward.overhang.length).toBe(homology.onLeft);
    expect(forwardPrimer.overhangLength).toBe(homology.onLeft + 4);
  });

  it.each([
    ['RD-left/PCR-right', 'left' as const],
    ['PCR-left/RD-right', 'right' as const],
  ])('locks the PCR-side product homology handle for %s homology junctions', (_label, rdSide) => {
    const design = rdAdjacentHomologyDesign('gibson', rdSide);
    const session = createAssemblyWorkbenchSession(design);
    const fields = session.editableFields.filter(
      (field) => field.kind === 'homologyArm' && field.target.junctionIndex === 0
    );
    const leftArm = fields.find((field) => field.target.side === 'left');
    const rightArm = fields.find((field) => field.target.side === 'right');
    const expectedDisabledSide = rdSide === 'left' ? 'right' : 'left';
    const expectedEditableSide = rdSide;

    expect(leftArm).toBeDefined();
    expect(rightArm).toBeDefined();
    expect(
      fields.find((field) => field.target.side === expectedEditableSide)?.disabled
    ).toBeFalsy();
    expect(fields.find((field) => field.target.side === expectedDisabledSide)).toEqual(
      expect.objectContaining({
        disabled: true,
        value: 0,
        range: expect.objectContaining({ min: 0, max: 0 }),
      })
    );
  });

  it('surfaces persisted spacer controls for the selected junction', () => {
    const design = baseDesign('gibson');
    design.spacers = [{ id: 'spacer-j0', junctionIndex: 0, sequence: 'AAGC', name: 'J0 spacer' }];
    const draft = computeDraftAssembly(design);
    design.homologyRegions = draft.homologyRegions;
    design.designPrimers = draft.designPrimers;
    design.assemblyState = 'ready';
    design.status = 'computed';
    design.version = 1;

    const session = createAssemblyWorkbenchSession(design);

    expect(session.controls.junctions[0].spacer).toEqual({
      id: 'spacer-j0',
      junctionIndex: 0,
      sequence: 'AAGC',
      name: 'J0 spacer',
      length: 4,
      canEdit: true,
    });
  });

  it('proposes explicit commands for out-of-range homology choices', () => {
    const design = draftedDesign('gibson');
    design.homologyRegions = [
      {
        ...design.homologyRegions[0],
        encoding: { onLeft: 5, onRight: 5 },
      } satisfies HomologyRegion,
    ];

    const session = createAssemblyWorkbenchSession(design);

    expect(session.findings).toContainEqual(
      expect.objectContaining({
        code: 'homology-length-out-of-range',
        severity: 'error',
      })
    );
    expect(session.proposals[0].command).toEqual(
      expect.objectContaining({
        type: 'setHomologyEncoding',
        junctionIndex: 0,
      })
    );
  });

  it('does not warn at the 15 bp Gibson homology boundary', () => {
    const design = draftedDesign('gibson');
    design.homologyRegions = [
      {
        ...design.homologyRegions[0],
        encoding: { onLeft: 7, onRight: 8 },
        metadata: {
          ...design.homologyRegions[0].metadata,
          gcContent: 50,
          tmEstimate: 50,
        },
      } satisfies HomologyRegion,
    ];

    const session = createAssemblyWorkbenchSession(design);

    expect(session.findings).not.toContainEqual(
      expect.objectContaining({
        code: 'homology-length-suboptimal',
      })
    );
    expect(session.findings).not.toContainEqual(
      expect.objectContaining({
        code: 'homology-length-out-of-range',
      })
    );
  });

  it('warns above the 40 bp Gibson preferred homology boundary', () => {
    const design = draftedDesign('gibson');
    design.homologyRegions = [
      {
        ...design.homologyRegions[0],
        encoding: { onLeft: 20, onRight: 21 },
      } satisfies HomologyRegion,
    ];

    const session = createAssemblyWorkbenchSession(design);

    expect(session.findings).toContainEqual(
      expect.objectContaining({
        code: 'homology-length-suboptimal',
        severity: 'warning',
        message: 'Junction 1 has 41 bp homology; preferred range is 15-40 bp.',
      })
    );
  });

  it('treats homology GC metadata as percent units when validating and formatting findings', () => {
    const design = draftedDesign('gibson');
    design.homologyRegions = [
      {
        ...design.homologyRegions[0],
        metadata: {
          ...design.homologyRegions[0].metadata,
          gcContent: 27.3,
        },
      },
    ];

    const session = createAssemblyWorkbenchSession(design);

    expect(session.findings).toContainEqual(
      expect.objectContaining({
        code: 'homology-gc-suboptimal',
        message: 'Junction 1 GC content is 27.3%.',
      })
    );
    expect(session.findings).not.toContainEqual(
      expect.objectContaining({
        message: 'Junction 1 GC content is 2730%.',
      })
    );
  });

  it('surfaces Golden Gate internal-site checks as strategy findings', () => {
    const design = draftedDesign('goldengate');
    design.regions[0] = {
      ...design.regions[0],
      sequence: `AAAAAGGTCTCAAAAA${design.regions[0].sequence}`,
      sourceType: 'pcr',
    };

    const session = createAssemblyWorkbenchSession(design);

    expect(session.mode).toBe('goldengate');
    expect(session.strategy.supports.enzymeSelection).toBe(true);
    expect(session.strategy.supports.goldenGateOffset).toBe(true);
    expect(session.findings).toContainEqual(
      expect.objectContaining({
        code: 'goldengate-internal-site',
        severity: 'error',
        regionIndex: 0,
      })
    );
    expect(session.proposals).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ type: 'setGoldenGateEnzyme' }),
      })
    );
  });

  it('surfaces incompatible RD Golden Gate fragments as hard strategy findings', () => {
    const design = draftedDesign('goldengate');
    design.regions[0] = {
      ...design.regions[0],
      sourceType: 'rd',
      ggType: 'insert',
      rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
      rdSourceEnzyme: 'BsmBI',
      rdSourceEnzymeName: 'BsmBI',
    };

    const session = createAssemblyWorkbenchSession(design);

    expect(session.findings).toContainEqual(
      expect.objectContaining({
        code: 'goldengate-rd-enzyme-mismatch',
        severity: 'error',
        title: 'Incompatible RD enzyme',
        regionIndex: 0,
      })
    );
  });

  it('does not expose stale primers on an empty slot as controls or warnings', () => {
    const design = draftedDesign('goldengate');
    design.regions[0] = { ...design.regions[0], sequence: '', isPlaceholder: true };
    const stale = design.designPrimers.find((pair) => pair.fragmentIndex === 0)!;
    stale.forward.sequence = 'T';
    stale.forward.pbs.end = stale.forward.pbs.start + 1;
    const session = createAssemblyWorkbenchSession(design);
    expect(session.findings.filter((finding) => finding.primer?.fragmentIndex === 0)).toEqual([]);
    expect(
      session.controls.junctions
        .flatMap((junction) => junction.primers)
        .filter((primer) => primer.fragmentIndex === 0)
    ).toEqual([]);
  });

  it('does not validate RD fragment placeholders as PCR primer binding sites', () => {
    const design = realAssemblyPipelineScenarioById('goldengate-pcr-rd-pcr').buildDesign();
    const draft = computeDraftAssembly(design);
    const session = createAssemblyWorkbenchSession({
      ...design,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready',
      status: 'computed',
      version: 1,
    });

    expect(draft.designPrimers.find((pair) => pair.fragmentIndex === 1)?.forward.sequence).toBe('');
    expect(session.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'primer-pbs-out-of-range',
          message: expect.stringContaining('(RD) has a 0 bp binding site'),
        }),
      ])
    );
    expect(
      session.findings.filter(
        (finding) =>
          finding.code === 'primer-pbs-out-of-range' && finding.primer?.fragmentIndex === 1
      )
    ).toEqual([]);
  });

  it('does not expose Golden Gate offset controls for RD-matched overhang junctions', () => {
    const design = realAssemblyPipelineScenarioById('goldengate-pcr-rd-pcr').buildDesign();
    const draft = computeDraftAssembly(design);
    const draftedDesign = {
      ...design,
      designPrimers: draft.designPrimers,
      goldenGateJunctions: draft.goldenGateJunctions,
      assemblyState: 'ready' as const,
      status: 'computed' as const,
      version: 1,
    };

    const session = createAssemblyWorkbenchSession(draftedDesign);

    expect(draft.goldenGateJunctions?.map((junction) => junction.source.type)).toEqual([
      'pcr-matched-rd',
      'pcr-matched-rd',
      'pcr-designed',
    ]);
    expect(session.controls.junctions.map((junction) => junction.goldenGate?.isFixed)).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      session.editableFields
        .filter((field) => field.kind === 'goldenGateOverhang')
        .map((field) => field.target.junctionIndex)
    ).toEqual([2]);
  });

  it('emits Golden Gate PCR source drags and centers the product offset handle on the scar', () => {
    const design = draftedDesign('goldengate');
    const session = createAssemblyWorkbenchSession(design);

    const leftBoundary = session.editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === 'r1' &&
        field.target.side === 'downstream'
    );
    const rightBoundary = session.editableFields.find(
      (field) =>
        field.kind === 'sourceContributionBoundary' &&
        field.target.regionId === 'r2' &&
        field.target.side === 'upstream'
    );
    const overhangOffset = session.editableFields.find(
      (field) => field.kind === 'goldenGateOverhang' && field.target.junctionIndex === 0
    );
    const goldenGateControl = session.controls.junctions[0].goldenGate;
    const junction = design.goldenGateJunctions![0];
    const expectedScarCenterBioCol =
      (junction.overhangStart + junction.overhangEnd) / 2 - junction.junctionPosition;

    expect(leftBoundary?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'goldengate-0-left',
        rowKind: 'left-source',
        bioCol: 0,
        role: 'boundary',
      })
    );
    expect(rightBoundary?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'goldengate-0-right',
        rowKind: 'right-source',
        bioCol: 0,
        role: 'boundary',
      })
    );
    expect(overhangOffset?.anchors).toContainEqual(
      expect.objectContaining({
        rowId: 'goldengate-0-product',
        rowKind: 'product',
        bioCol: expectedScarCenterBioCol,
        role: 'boundary',
      })
    );
    expect(goldenGateControl?.offsetLimit).toBe(GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP);
    expect(overhangOffset?.range).toEqual({
      min: -GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP,
      max: GOLDEN_GATE_OFFSET_LIMIT_DEFAULT_BP,
      step: 1,
      largeStep: 5,
    });
  });
});

function draftedDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const design = baseDesign(method);
  const draft = computeDraftAssembly(design);
  design.homologyRegions = draft.homologyRegions;
  design.designPrimers = draft.designPrimers;
  design.goldenGateJunctions = draft.goldenGateJunctions;
  design.assemblyState = 'ready';
  design.status = 'computed';
  design.version = 1;
  return design;
}

function rdAdjacentHomologyDesign(
  method: SequenceDesign['assemblyMethod'],
  rdSide: 'left' | 'right'
): SequenceDesign {
  const design = baseDesign(method);
  design.topology = 'linear';
  design.spacers = [{ id: 'spacer-j0', junctionIndex: 0, sequence: 'GGCC' }];
  const pcr = region('pcr', 'ATGC'.repeat(28) + 'GATTACA'.repeat(4));
  const rd = {
    ...region('rd', 'TTAACCGGTTAACCGG' + 'CGTA'.repeat(24)),
    sourceType: 'rd' as const,
    rdOverhangs: { upstream: 'AATG', downstream: 'GCTA' },
    rdSourceEnzyme: 'BsaI',
  };
  design.regions = rdSide === 'left' ? [rd, pcr] : [pcr, rd];
  const draft = computeDraftAssembly(design);
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

function baseDesign(method: SequenceDesign['assemblyMethod']): SequenceDesign {
  const now = new Date('2026-04-30T00:00:00.000Z');
  return {
    id: `design-${method}`,
    name: `${method} workbench`,
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
