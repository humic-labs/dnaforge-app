import { afterEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '../../features/canvas/store';
import { useDesignStore } from '../../features/design/store';
import { useRichSequenceClipboardStore } from '../../features/sequence-clipboard/store';
import { useSequenceStore } from '../../features/sequence/store';
import { getComposedSequence } from '../../features/design/types';
import { getComposedSequenceForDesign } from '../../features/design/restriction-digest';
import { searchNucleotide } from '@waypoint/sequence-utils';
import {
  checkInternalSitesInPcrRegions,
  validateGoldenGateAssembly,
} from '../../features/design/validation/golden-gate-overhangs';
import { applyScenario, resetAllStores } from './apply';
import {
  REAL_ASSEMBLY_PIPELINE_SCENARIOS,
  REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
  CIDAR_MOCLO_RED_TU_PACKAGE_IDS,
  YTK_MOCLO_FACTORY_DESIGN_ID,
  YTK_MOCLO_FACTORY_PACKAGE_IDS,
  YTK_MOCLO_FACTORY_PATHS,
  YTK_MOCLO_FACTORY_RUN_ID,
  assemblyCrossoverEditingShowcase,
  assemblyUiCleanupShowcase,
  cidarMocloRedFluorescentTu,
  cidarMocloMixedRouteRedFluorescentTu,
  ytkMocloFactoryExpressionCassette,
  realAssemblyPipelineAppScenario,
  realAssemblyGibsonPcrPcr,
  realAssemblyGibsonPcrPcrSpacerFinalization,
} from './assembly-real-pipeline';

describe('real assembly pipeline app scenarios', () => {
  afterEach(() => resetAllStores());

  it('provides one whole-assembly match and an empty query for native Tracks Find', () => {
    const scenario = realAssemblyGibsonPcrPcr();
    const design = Object.values(scenario.designs?.designs ?? {})[0];
    if (!design) throw new Error('Native Tracks Find assembly fixture is unavailable');
    expect(design.assemblyState).toBe('ready');
    const sequence = getComposedSequenceForDesign(design);
    expect(sequence.length).toBeGreaterThan(1);
    const options = { circular: true, reverseComplement: true };
    expect(searchNucleotide(sequence, sequence, options)).toHaveLength(1);
    expect(searchNucleotide(sequence, 'C'.repeat(30), options)).toHaveLength(0);
  });

  it('uses a fresh draft identity and workspace for every finalization fixture', () => {
    const first = realAssemblyGibsonPcrPcrSpacerFinalization();
    const second = realAssemblyGibsonPcrPcrSpacerFinalization();
    expect(first.designs?.activeDesignId).not.toBe(second.designs?.activeDesignId);
    expect(first.dev?.scenarioId).not.toBe(second.dev?.scenarioId);
    expect(first.canvas?.tabs[0].entityId).toBe(first.designs?.activeDesignId);
    expect(second.canvas?.tabs[0].entityId).toBe(second.designs?.activeDesignId);
  });

  it.each(REAL_ASSEMBLY_PIPELINE_SCENARIOS)(
    '$id hydrates the same design, sequence cache, canvas tab, and draft state used by dev/E2E',
    (scenario) => {
      applyScenario(realAssemblyPipelineAppScenario(scenario.id));

      const designState = useDesignStore.getState();
      const activeDesignId = designState.activeDesignId;
      expect(activeDesignId).toBeTruthy();
      const design = designState.designs[activeDesignId!];
      expect(design).toBeTruthy();
      expect(design.id).toContain(scenario.id);
      expect(design.name).toBe(scenario.label);
      expect(design.assemblyMethod).toBe(scenario.expected.method);
      expect(design.regions.map((region) => region.sourceType ?? 'pcr')).toEqual(
        scenario.expected.regionSourceTypes
      );
      expect((design.spacers ?? []).map((spacer) => spacer.sequence)).toEqual(
        scenario.expected.spacerSequences
      );

      if (scenario.expected.valid) {
        expect(design.assemblyState).toBe('ready');
        expect(design.status).toBe('computed');
        expect(design.designPrimers.map((pair) => pair.fragmentIndex)).toEqual(
          scenario.expected.primerPairIndices
        );
      } else {
        expect(design.assemblyState).toBe('drafting');
        expect(design.status).toBe('draft');
        expect(design.designPrimers).toEqual([]);
        if (scenario.expected.expectedValidationErrorCodes) {
          expect(design.validationErrors.map((error) => error.code)).toEqual(
            expect.arrayContaining(scenario.expected.expectedValidationErrorCodes)
          );
        }
      }

      const sequenceState = useSequenceStore.getState();
      expect(sequenceState.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID]).toBeTruthy();
      expect(sequenceState.sequences[REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID].sequence).toMatch(
        /^[ACGT]+$/
      );

      const canvasState = useCanvasStore.getState();
      const mainPanel = canvasState.panels.main;
      expect(mainPanel.tabs).toHaveLength(1);
      expect(mainPanel.activeTabId).toBe(mainPanel.tabs[0].id);
      expect(mainPanel.tabs[0]).toEqual(
        expect.objectContaining({
          type: 'design',
          entityId: design.id,
          label: scenario.label,
        })
      );
    }
  );

  it('hydrates the one-click UI cleanup scenario with real PCR clipboard provenance', () => {
    applyScenario(assemblyUiCleanupShowcase());

    const state = useDesignStore.getState();
    const copiedRegion = useRichSequenceClipboardStore.getState().copiedRegion;
    expect(copiedRegion).toEqual(
      expect.objectContaining({
        sourceId: REAL_ASSEMBLY_PIPELINE_DOCUMENT_ID,
        sourceName: 'pUC19 PCR fragment',
        sourceType: 'pcr',
      })
    );
    expect(copiedRegion?.sequence.length).toBeGreaterThan(0);
    expect(copiedRegion?.sourceSequence?.length).toBeGreaterThan(
      copiedRegion?.sequence.length ?? 0
    );
    const design = state.designs[state.activeDesignId ?? ''];
    expect(design?.regions).toHaveLength(2);
    expect(design?.regions.map((region) => region.sourceSequenceName)).toEqual(['pUC19', 'pUC19']);
    expect(design?.regions[0].sourceEnd).toBe(design?.regions[1].sourceStart);
    expect(checkInternalSitesInPcrRegions(design?.regions ?? [], 'BsmBI')).toEqual([]);
  });

  it('hydrates the crossover editing showcase with four unequal contiguous PCR parts', () => {
    applyScenario(assemblyCrossoverEditingShowcase());

    const state = useDesignStore.getState();
    const design = state.designs[state.activeDesignId ?? ''];
    const regions = design?.regions ?? [];
    expect(regions).toHaveLength(4);
    expect(new Set(regions.map((region) => region.sequence.length))).toHaveLength(4);
    expect(regions[0].sourceEnd).toBe(regions[1].sourceStart);
    expect(regions[1].sourceEnd).toBe(regions[2].sourceStart);
    expect(regions[2].sourceEnd).toBe(regions[3].sourceStart);
    expect(regions.every((region) => region.sourceSequenceName === 'pUC19')).toBe(true);
    expect(checkInternalSitesInPcrRegions(regions, 'BsmBI')).toEqual([]);
  });

  it('hydrates the real CIDAR red transcription-unit assembly with fixed BsaI fusion-site order', () => {
    applyScenario(cidarMocloRedFluorescentTu());

    const state = useDesignStore.getState();
    const design = state.designs[state.activeDesignId ?? ''];
    const regions = design?.regions ?? [];
    expect(design?.name).toBe('CIDAR MoClo — red fluorescent transcription unit');
    expect(design?.assemblyMethod).toBe('goldengate');
    expect(design?.goldenGateConfig?.enzyme).toBe('BsaI');
    expect(design?.backboneSequenceId).toBe(CIDAR_MOCLO_RED_TU_PACKAGE_IDS.destinationVector);
    expect(design?.goldenGateSchema).toEqual(
      expect.objectContaining({
        id: 'moclo-cidar:transcription-unit',
        enzyme: 'BsaI',
      })
    );
    expect(design?.regions.map((region) => region.schemaSlotId)).toEqual([
      'promoter',
      'rbs',
      'cds',
      'terminator',
      'destination-vector',
    ]);
    expect(regions).toHaveLength(5);
    expect(regions.map((region) => region.sourceSequenceName)).toEqual([
      'J23106_AB',
      'B0034m_BC',
      'E1010m_CD',
      'B0015_DE',
      'DVA_AE',
    ]);
    expect(regions.map((region) => region.sourceSequenceId)).toEqual(
      Object.values(CIDAR_MOCLO_RED_TU_PACKAGE_IDS)
    );
    expect(regions.every((region) => !/[\\/]|\.gb(?:k|ff)?$/i.test(region.sourceSequenceId))).toBe(
      true
    );
    expect(regions.map((region) => region.ggType)).toEqual([
      'insert',
      'insert',
      'insert',
      'insert',
      'backbone',
    ]);
    expect(regions.every((region) => region.sourceType === 'rd')).toBe(true);
    expect(regions.every((region) => region.rdSourceEnzyme === 'BsaI')).toBe(true);
    expect(new Set(regions.map((region) => region.sequence.length)).size).toBeGreaterThan(3);

    for (let index = 0; index < regions.length; index += 1) {
      const nextIndex = (index + 1) % regions.length;
      expect(regions[index].rdOverhangs?.downstream).toBe(regions[nextIndex].rdOverhangs?.upstream);
    }

    const validation = validateGoldenGateAssembly(regions, true, 'BsaI', {
      backboneSequenceId: CIDAR_MOCLO_RED_TU_PACKAGE_IDS.destinationVector,
    });
    expect(validation.conflicts).toEqual([]);
    expect(design?.designPrimers).toEqual([]);

    const composedSequence = getComposedSequence(regions, design?.spacers ?? []);
    expect(design?.goldenGateJunctions).toHaveLength(5);
    for (const junction of design?.goldenGateJunctions ?? []) {
      const actualFusionSite = Array.from(
        { length: junction.overhang.length },
        (_, offset) => composedSequence[(junction.overhangStart + offset) % composedSequence.length]
      ).join('');
      expect(actualFusionSite, `junction ${junction.junctionIndex} range`).toBe(junction.overhang);
    }
  });

  it('keeps the real CIDAR product fixed while mixing PCR and digest production routes', () => {
    const digestScenario = cidarMocloRedFluorescentTu();
    const digestDesign =
      digestScenario.designs?.designs[digestScenario.designs.activeDesignId ?? ''];
    applyScenario(cidarMocloMixedRouteRedFluorescentTu());

    const state = useDesignStore.getState();
    const design = state.designs[state.activeDesignId ?? ''];
    expect(design?.regions.map((region) => region.sourceType)).toEqual([
      'pcr',
      'rd',
      'pcr',
      'rd',
      'rd',
    ]);
    expect(design?.regions.filter((region) => region.sourceType === 'pcr')).toHaveLength(2);
    expect(
      design?.designPrimers.filter(
        (pair) => pair.forward.sequence.length > 0 || pair.reverse.sequence.length > 0
      )
    ).toHaveLength(2);
    expect(design?.goldenGateJunctions).toHaveLength(5);
    const composedSequence = getComposedSequence(design?.regions ?? [], design?.spacers ?? []);
    expect(composedSequence).toBe(
      getComposedSequence(digestDesign?.regions ?? [], digestDesign?.spacers ?? [])
    );
    for (const junction of design?.goldenGateJunctions ?? []) {
      const actualFusionSite = Array.from(
        { length: junction.overhang.length },
        (_, offset) => composedSequence[(junction.overhangStart + offset) % composedSequence.length]
      ).join('');
      expect(actualFusionSite, `junction ${junction.junctionIndex} product range`).toBe(
        junction.overhang
      );
    }

    const firstPcrForward = design?.designPrimers.find((pair) => pair.fragmentIndex === 0)?.forward;
    const secondPcrForward = design?.designPrimers.find(
      (pair) => pair.fragmentIndex === 2
    )?.forward;
    expect(firstPcrForward?.pbs.start).toBe(4);
    expect(secondPcrForward?.pbs.start).toBe(68);
  });

  it('hydrates a real YTK factory stage from the versioned kit definition and canonical digests', () => {
    const scenario = ytkMocloFactoryExpressionCassette();
    applyScenario(scenario);

    const state = useDesignStore.getState();
    const design = state.designs[YTK_MOCLO_FACTORY_DESIGN_ID];
    expect(design).toBeTruthy();
    expect(design.mocloFactory).toEqual({
      runId: YTK_MOCLO_FACTORY_RUN_ID,
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
      stageId: 'expression-cassette',
      stageInputs: [{ slotId: 'cassette-vector-output', sourceStageId: 'cassette-vector' }],
    });
    expect(design.goldenGateSchema).toEqual(
      expect.objectContaining({
        id: 'ytk:ytk-multigene-device:expression-cassette',
        enzyme: 'BsaI',
      })
    );
    expect(design.goldenGateSchema?.slots.map((slot) => slot.outgoingOverhang)).toEqual([
      'TATG',
      'ATCC',
      'GCTG',
      'AACG',
    ]);
    expect(design.regions.map((region) => region.rdOverhangs)).toEqual([
      expect.objectContaining({ upstream: 'AACG', downstream: 'TATG' }),
      expect.objectContaining({ upstream: 'TATG', downstream: 'ATCC' }),
      expect.objectContaining({ upstream: 'ATCC', downstream: 'GCTG' }),
      expect.objectContaining({ upstream: 'GCTG', downstream: 'AACG' }),
    ]);
    expect(design.regions.map((region) => region.sourceSequenceId)).toEqual([
      YTK_MOCLO_FACTORY_PACKAGE_IDS.promoter,
      YTK_MOCLO_FACTORY_PACKAGE_IDS.codingSequence,
      YTK_MOCLO_FACTORY_PACKAGE_IDS.terminator,
      YTK_MOCLO_FACTORY_PACKAGE_IDS.cassetteVector,
    ]);
    expect(design.backboneSequenceId).toBe(YTK_MOCLO_FACTORY_PACKAGE_IDS.cassetteVector);
    expect(JSON.parse(String(scenario.files?.[YTK_MOCLO_FACTORY_PATHS.kitDefinition])).schema).toBe(
      'dnaforge.moclo-kit'
    );
  });

  it('materializes complete MoClo packages without synthetic product-file identities', () => {
    const cidarScenario = cidarMocloRedFluorescentTu();
    const ytkScenario = ytkMocloFactoryExpressionCassette();

    expect(cidarScenario.workspace?.selectedPath).toBe('/workspace');
    expect(cidarScenario.sequenceSources).toBeUndefined();
    expect(
      Object.keys(cidarScenario.files ?? {}).filter(
        (path) => path.includes('/sequences/kits/moclo-cidar/') && path.endsWith('.gb')
      )
    ).toHaveLength(91);
    expect(
      Object.keys(cidarScenario.files ?? {}).filter(
        (path) =>
          path.includes('/sequences/kits/moclo-cidar/') && path.endsWith('/.forge/plasmid.json')
      )
    ).toHaveLength(91);
    const cidarKitDefinition = JSON.parse(
      String(cidarScenario.files?.['/workspace/.forge/moclo-kits/cidar.json'])
    ) as { id?: string; members?: unknown[]; partTypes?: unknown[]; recipes?: unknown[] };
    expect(cidarKitDefinition).toMatchObject({
      id: 'moclo-cidar',
      members: expect.any(Array),
      partTypes: [],
      recipes: [],
    });
    expect(cidarKitDefinition.members).toHaveLength(91);
    expect(ytkScenario.sequenceSources).toBeUndefined();
    expect(
      Object.keys(ytkScenario.files ?? {}).filter(
        (path) => path.includes('/sequences/kits/moclo-ytk/') && path.endsWith('.gb')
      )
    ).toHaveLength(96);
    expect(
      Object.keys(ytkScenario.files ?? {}).filter(
        (path) =>
          path.includes('/sequences/kits/moclo-ytk/') && path.endsWith('/.forge/plasmid.json')
      )
    ).toHaveLength(96);
  });
});
