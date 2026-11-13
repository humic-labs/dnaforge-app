import { describe, expect, it } from 'vitest';
import { buildRealAssemblyPipelineDesign } from '../../../test/scenarios/assembly-real-pipeline';
import { getComposedSequenceForDesign } from '../../design/restriction-digest';
import {
  projectDesignDetail,
  projectDesignHeader,
  projectDesignTmResolution,
} from './design-projection';
import { useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL, OWCZARZY_TM_MODEL } from '../../design/algorithms/tm-model';

describe('design projection', () => {
  it('keeps the compact header byte-for-byte compatible with observe_app_state', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr-spacer');

    expect(projectDesignHeader(design)).toEqual({
      id: design.id,
      name: design.name,
      topology: 'circular',
      assemblyMethod: 'gibson',
      assemblyState: 'ready',
      status: 'computed',
      version: 1,
      regionCount: 2,
      homologyRegionCount: 2,
      goldenGateJunctionCount: 0,
      primerPairCount: 2,
      validationErrorCount: 0,
    });
  });

  it('projects RD physical ends, spacers, product bases, and primers without spreading regions', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-rd-pcr-two-spacers');
    const detail = projectDesignDetail(design);

    expect(Object.keys(detail).sort()).toEqual(
      [
        'assemblyIssueErrorCount',
        'assemblyIssues',
        'assemblyMethod',
        'assemblyState',
        'blocksExport',
        'blocksFinalize',
        'blocksRun',
        'composedSequence',
        'composedSequenceIncluded',
        'composedSequenceLength',
        'composedSequencePreview',
        'emptySlotCount',
        'gaps',
        'goldenGateEnzyme',
        'goldenGateJunctionCount',
        'goldenGateJunctions',
        'goldenGateSchema',
        'homologyRegionCount',
        'id',
        'junctionCount',
        'mocloFactory',
        'name',
        'orphanedSpacers',
        'pcrPolymerase',
        'primerPairCount',
        'primers',
        'regionCount',
        'regions',
        'slotCount',
        'slots',
        'spacerIntegrityWarnings',
        'spacers',
        'status',
        'tmResolution',
        'topology',
        'validationErrorCount',
        'validationErrors',
        'version',
      ].sort()
    );
    expect(detail.composedSequence).toBe(getComposedSequenceForDesign(design));
    expect(detail.composedSequenceIncluded).toBe(true);
    expect(detail.composedSequenceLength).toBe(detail.composedSequence?.length);
    expect(detail.composedSequencePreview).toBeNull();
    expect(detail.goldenGateSchema).toBeNull();
    expect(detail.mocloFactory).toBeNull();
    expect(detail.tmResolution).toMatchObject({
      source: 'default',
      pendingNebVerification: false,
      primerCount: design.designPrimers.length * 2,
    });
    expect(detail.spacers.map((spacer) => spacer.sequence)).toEqual(
      design.spacers.map((spacer) => spacer.sequence)
    );
    expect(detail.primers).toHaveLength(design.designPrimers.length);

    const rdIndex = design.regions.findIndex((region) => region.sourceType === 'rd');
    const pcrIndex = design.regions.findIndex((region) => region.sourceType === 'pcr');
    expect(rdIndex).toBeGreaterThanOrEqual(0);
    expect(pcrIndex).toBeGreaterThanOrEqual(0);
    expect(detail.regions[rdIndex]).toMatchObject({
      sourceType: 'rd',
      ggType: design.regions[rdIndex].ggType,
      rdSourceEnzyme: design.regions[rdIndex].rdSourceEnzyme,
      rdEnds: {
        upstream: {
          overhangType: design.regions[rdIndex].rdEnds?.upstream?.overhangType,
          strand: design.regions[rdIndex].rdEnds?.upstream?.strand,
        },
        downstream: {
          overhangType: design.regions[rdIndex].rdEnds?.downstream?.overhangType,
          strand: design.regions[rdIndex].rdEnds?.downstream?.strand,
        },
      },
    });
    expect(detail.regions[pcrIndex]).toMatchObject({
      sourceType: 'pcr',
      ggType: null,
      rdOverhangs: null,
      rdSourceEnzyme: null,
      rdSourceEnzymeName: null,
      rdEnds: null,
    });
    expect(detail.regions[rdIndex]).not.toHaveProperty('sequence');
    expect(detail.regions[rdIndex]).not.toHaveProperty('sourceSequence');
    expect(detail.regions[rdIndex]).not.toHaveProperty('sourceAnnotations');
  });

  it('surfaces both silent spacer-integrity failure classes', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr-spacer', {
      drafted: false,
    });
    const baseSpacer = design.spacers[0];
    design.spacers = [
      baseSpacer,
      { ...baseSpacer, id: 'duplicate-spacer' },
      { ...baseSpacer, id: 'orphaned-spacer', junctionIndex: design.regions.length + 2 },
    ];

    const detail = projectDesignDetail(design);
    expect(detail.spacerIntegrityWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'DUPLICATE_SPACERS_AT_JUNCTION',
          junctionIndex: baseSpacer.junctionIndex,
          spacerIds: expect.arrayContaining([baseSpacer.id, 'duplicate-spacer']),
        }),
        expect.objectContaining({
          code: 'ORPHANED_SPACER',
          spacerId: 'orphaned-spacer',
        }),
      ])
    );
  });

  it('reports the explicit app-wide Tm model after a design polymerase is cleared', () => {
    const previous = useSettingsStore.getState();
    useSettingsStore.setState({
      tmModel: OWCZARZY_TM_MODEL,
      tmModelExplicit: true,
    });
    try {
      const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr-spacer');
      design.pcrPolymerase = null;

      expect(projectDesignTmResolution(design)).toMatchObject({
        model: OWCZARZY_TM_MODEL,
        source: 'user-setting',
      });
    } finally {
      useSettingsStore.setState({
        tmModel: previous.tmModel ?? DEFAULT_TM_MODEL,
        tmModelExplicit: previous.tmModelExplicit,
      });
    }
  });

  it('does not count authoritative Tm provenance from a different model or concentration', () => {
    const previous = useSettingsStore.getState();
    useSettingsStore.setState({
      primerConcNm: 500,
      tmModel: DEFAULT_TM_MODEL,
      tmModelExplicit: false,
    });
    try {
      const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr-spacer');
      design.pcrPolymerase = 'q5-0';
      design.designPrimers = design.designPrimers.map((pair) => ({
        ...pair,
        forward: {
          ...pair.forward,
          tmProvenance: {
            source: 'neb',
            verified: true,
            model: { kind: 'neb', prodcode: 'phusion-0', polymerase: 'phusion' },
            concNm: 250,
          },
        },
        reverse: {
          ...pair.reverse,
          tmProvenance: {
            source: 'neb',
            verified: true,
            model: { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' },
            concNm: 500,
          },
        },
      }));

      const resolution = projectDesignTmResolution(design);

      expect(resolution.model).toEqual({ kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' });
      expect(resolution.verifiedPrimerCount).toBe(design.designPrimers.length);
      expect(resolution.pendingNebVerification).toBe(true);
    } finally {
      useSettingsStore.setState({
        primerConcNm: previous.primerConcNm,
        tmModel: previous.tmModel ?? DEFAULT_TM_MODEL,
        tmModelExplicit: previous.tmModelExplicit,
      });
    }
  });

  it('reports the canonical linear junction count instead of assuming circular closure', () => {
    const design = buildRealAssemblyPipelineDesign('gibson-pcr-pcr-spacer', {
      drafted: false,
    });
    design.topology = 'linear';

    const detail = projectDesignDetail(design);

    expect(detail.regions).toHaveLength(2);
    expect(detail.junctionCount).toBe(1);
    expect(detail.gaps).toHaveLength(1);
  });
});
