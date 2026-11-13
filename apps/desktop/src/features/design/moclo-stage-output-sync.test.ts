import { computeChecksum, loadAllEnzymes, type RestrictionEnzyme } from '@waypoint/sequence-utils';
import enzymeData from '../../../public/data/rebase/merged-enzymes.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeVirtualDigest,
  type VirtualDigestFragment,
} from '../assembly-panel/hooks/useVirtualDigest';
import {
  buildAcceptedAssemblyProjectionInput,
  buildSourceProvenanceSnapshot,
} from '../assembly/accepted-canonical';
import { getComposedSequenceForDesign } from './restriction-digest';
import { normalizeAssemblySlots } from './assembly-slots';
import {
  startMocloFactoryStageOutputSync,
  stopMocloFactoryStageOutputSync,
} from './moclo-stage-output-live';
import { reconcileMocloFactoryStageOutputs } from './moclo-stage-output-sync';
import { useDesignStore } from './store';
import type { DesignRegion, SequenceDesign } from './types';
import { ytkMocloFactoryExpressionCassette } from '../../test/scenarios/assembly-real-pipeline';

vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/sequence-utils')>();
  return { ...actual, loadAllEnzymes: vi.fn() };
});

const BSMBI = (enzymeData.enzymes as RestrictionEnzyme[]).find((enzyme) => enzyme.name === 'BsmBI');
if (!BSMBI) throw new Error('The checked-in REBASE data is missing BsmBI.');
const BSAI = (enzymeData.enzymes as RestrictionEnzyme[]).find((enzyme) => enzyme.name === 'BsaI');
if (!BSAI) throw new Error('The checked-in REBASE data is missing BsaI.');

const NOW = new Date('2026-09-01T20:00:00.000Z');

afterEach(() => {
  stopMocloFactoryStageOutputSync();
  useDesignStore.setState({ designs: {} });
  vi.mocked(loadAllEnzymes).mockReset();
});

function oneRegionSourceDesign(): SequenceDesign {
  const scenario = ytkMocloFactoryExpressionCassette();
  const original = Object.values(scenario.designs?.designs ?? {})[0];
  if (!original) throw new Error('The YTK factory scenario has no expression-cassette design.');
  const sequence = getComposedSequenceForDesign(original);
  const region: DesignRegion = {
    id: 'assembled-cassette-product',
    sourceSequenceId: original.id,
    sourceSequenceName: original.name,
    sourceStart: 0,
    sourceEnd: sequence.length,
    sequence,
    annotations: [],
    sourceSequence: sequence,
    sourceLength: sequence.length,
    sourceIsCircular: true,
    sourceType: 'pcr',
  };
  return {
    ...original,
    regions: [region],
    spacers: [],
    version: 7,
    mocloFactory: {
      runId: 'run-live-link',
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
      stageId: 'expression-cassette',
      stageInputs: [],
    },
  };
}

function digestInsert(sequence: string): VirtualDigestFragment {
  const fragment = computeVirtualDigest(sequence, BSMBI, [], { circular: true }).fragments.find(
    (candidate) => candidate.ggType === 'insert'
  );
  if (!fragment) throw new Error('The real YTK expression cassette has no BsmBI insert fragment.');
  return fragment;
}

function dependentDesign(fragment: VirtualDigestFragment): SequenceDesign {
  const empty = (id: string, name: string): DesignRegion => ({
    id,
    sourceSequenceId: 'placeholder',
    sourceSequenceName: name,
    sourceStart: 0,
    sourceEnd: 0,
    sequence: '',
    annotations: [],
    isPlaceholder: true,
    sourceType: 'pcr',
  });
  return {
    id: 'multigene-device',
    constructId: 'construct-multigene-device',
    name: 'YTK multigene device',
    topology: 'circular',
    regions: [empty('cassette-slot', 'Expression cassette'), empty('vector-slot', 'Vector')],
    spacers: [],
    version: 3,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'goldengate',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateConfig: { enzyme: 'BsmBI' },
    goldenGateJunctions: [],
    goldenGateSchema: {
      id: 'ytk:device',
      name: 'YTK multigene device',
      revision: 1,
      origin: {
        type: 'kit',
        kitId: 'ytk',
        kitName: 'Yeast Toolkit (YTK)',
        schemaId: 'ytk-multigene-device:multigene-device',
      },
      enzyme: 'BsmBI',
      slots: [
        {
          id: 'cassette',
          label: 'Expression cassette',
          outgoingOverhang: fragment.downstream.sequence,
          preferredRoles: [{ label: 'Expression cassette' }],
        },
        {
          id: 'vector',
          label: 'Destination vector',
          outgoingOverhang: fragment.upstream.sequence,
          preferredRoles: [{ label: 'Destination vector' }],
        },
      ],
    },
    mocloFactory: {
      runId: 'run-live-link',
      kitId: 'ytk',
      kitRevision: 1,
      recipeId: 'ytk-multigene-device',
      stageId: 'multigene-device',
      stageInputs: [{ slotId: 'cassette', sourceStageId: 'expression-cassette' }],
    },
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function mutateFragmentBase(sequence: string, fragment: VirtualDigestFragment): string {
  const index = (fragment.startPosition + Math.floor(fragment.length / 2)) % sequence.length;
  const replacement = sequence[index] === 'A' ? 'C' : 'A';
  return `${sequence.slice(0, index)}${replacement}${sequence.slice(index + 1)}`;
}

describe('MoClo live stage-output propagation', () => {
  it('marks a fresh dependent slot unresolved before an upstream design exists', () => {
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);

    const reconciled = reconcileMocloFactoryStageOutputs({
      designs: { [downstream.id]: downstream },
      enzymes: [BSMBI],
      now: NOW,
    })[downstream.id];

    expect(reconciled.regions[0]).toMatchObject({
      sourceSequenceId: 'placeholder',
      sequence: '',
      isPlaceholder: true,
      mocloStageOutput: {
        status: 'unresolved',
        sourceStageId: 'expression-cassette',
      },
    });
  });

  it('does not retry the same reconciliation forever when enzyme loading fails', async () => {
    const source = oneRegionSourceDesign();
    const downstream = dependentDesign(digestInsert(getComposedSequenceForDesign(source)));
    useDesignStore.setState({ designs: { [downstream.id]: downstream } });
    vi.mocked(loadAllEnzymes).mockRejectedValue(new Error('temporary enzyme load failure'));

    startMocloFactoryStageOutputSync();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(loadAllEnzymes).toHaveBeenCalledTimes(1);
  });

  it('does not let a stopped generation mutate designs after enzyme loading resolves', async () => {
    const source = oneRegionSourceDesign();
    const downstream = dependentDesign(digestInsert(getComposedSequenceForDesign(source)));
    const designs = { [downstream.id]: downstream };
    let resolveEnzymes!: (enzymes: RestrictionEnzyme[]) => void;
    vi.mocked(loadAllEnzymes).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnzymes = resolve;
      })
    );
    useDesignStore.setState({ designs });

    startMocloFactoryStageOutputSync();
    await vi.waitFor(() => expect(loadAllEnzymes).toHaveBeenCalledTimes(1));
    stopMocloFactoryStageOutputSync();
    resolveEnzymes([BSAI, BSMBI]);
    for (let index = 0; index < 4; index += 1) await Promise.resolve();

    expect(useDesignStore.getState().designs).toBe(designs);
  });

  it('resolves a two-hop YTK factory dependency chain in one pass', () => {
    const scenario = ytkMocloFactoryExpressionCassette();
    const originalExpression = Object.values(scenario.designs?.designs ?? {})[0];
    if (!originalExpression?.mocloFactory) {
      throw new Error('The YTK factory scenario has no expression-cassette context.');
    }
    const cassetteVectorRegion = originalExpression.regions.find(
      (region) => region.id === 'ytk-cassette-vector'
    );
    if (!cassetteVectorRegion?.sourceSequence) {
      throw new Error('The YTK cassette-vector fixture has no source sequence.');
    }
    const cassetteVector: SequenceDesign = {
      ...originalExpression,
      id: 'cassette-vector-product',
      name: 'YTK cassette vector product',
      regions: [
        {
          ...cassetteVectorRegion,
          id: 'cassette-vector-product-region',
          sourceStart: 0,
          sourceEnd: cassetteVectorRegion.sourceSequence.length,
          sequence: cassetteVectorRegion.sourceSequence,
          annotations: [],
        },
      ],
      spacers: [],
      goldenGateSchema: undefined,
      mocloFactory: {
        ...originalExpression.mocloFactory,
        runId: 'run-live-link',
        stageId: 'cassette-vector',
        stageInputs: [],
      },
    };
    const expression: SequenceDesign = {
      ...originalExpression,
      mocloFactory: {
        ...originalExpression.mocloFactory,
        runId: 'run-live-link',
      },
    };
    const multigeneFragment = digestInsert(getComposedSequenceForDesign(expression));
    const multigene = dependentDesign(multigeneFragment);

    const reconciled = reconcileMocloFactoryStageOutputs({
      designs: {
        [cassetteVector.id]: cassetteVector,
        [expression.id]: expression,
        [multigene.id]: multigene,
      },
      enzymes: [BSAI, BSMBI],
      now: NOW,
    });

    expect(
      reconciled[expression.id].regions.find((region) => region.mocloStageOutput?.status === 'live')
        ?.mocloStageOutput
    ).toMatchObject({
      sourceStageId: 'cassette-vector',
      sourceDesignId: cassetteVector.id,
    });
    expect(reconciled[multigene.id].regions[0]).toMatchObject({
      sourceSequenceId: expression.id,
      sourceType: 'rd',
      mocloStageOutput: {
        status: 'live',
        sourceStageId: 'expression-cassette',
        sourceDesignId: expression.id,
      },
    });
  });

  it('subscribes to draft changes and propagates them without an explicit refresh', async () => {
    vi.mocked(loadAllEnzymes).mockResolvedValue([BSMBI]);
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);
    useDesignStore.setState({
      designs: { [source.id]: source, [downstream.id]: downstream },
    });

    startMocloFactoryStageOutputSync();
    await vi.waitFor(() => {
      expect(useDesignStore.getState().designs[downstream.id].regions[0].sourceType).toBe('rd');
    });
    const firstSequence = useDesignStore.getState().designs[downstream.id].regions[0].sequence;
    const changedSequence = mutateFragmentBase(source.regions[0].sequence, fragment);
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [source.id]: {
          ...source,
          regions: [
            {
              ...source.regions[0],
              sequence: changedSequence,
              sourceSequence: changedSequence,
            },
          ],
          version: source.version + 1,
        },
      },
    }));

    await vi.waitFor(() => {
      expect(useDesignStore.getState().designs[downstream.id].regions[0].sequence).not.toBe(
        firstSequence
      );
    });
  });

  it('preserves directly supplied material until a matching upstream design exists', () => {
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);
    const manuallySupplied: SequenceDesign = normalizeAssemblySlots({
      ...downstream,
      regions: [
        {
          ...downstream.regions[0],
          sourceSequenceId: 'manual-expression-cassette',
          sourceSequenceName: 'Manually supplied expression cassette',
          sourceEnd: 8,
          sequence: 'ACGTACGT',
          isPlaceholder: false,
        },
        downstream.regions[1],
      ],
    });

    const designs = { [manuallySupplied.id]: manuallySupplied };
    const reconciled = reconcileMocloFactoryStageOutputs({
      designs,
      enzymes: [BSMBI],
      now: NOW,
    });

    expect(reconciled).toBe(designs);
    expect(reconciled[manuallySupplied.id]).toBe(manuallySupplied);
    expect(reconciled[manuallySupplied.id].regions[0]).toMatchObject({
      sourceSequenceId: 'manual-expression-cassette',
      sequence: 'ACGTACGT',
      isPlaceholder: false,
    });
  });

  it('re-digests the changing upstream product and updates the dependent slot', () => {
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);

    const first = reconcileMocloFactoryStageOutputs({
      designs: { [source.id]: source, [downstream.id]: downstream },
      enzymes: [BSMBI],
      now: NOW,
    });
    const firstLinked = first[downstream.id];
    expect(firstLinked.regions[0]).toMatchObject({
      id: 'cassette-slot',
      sourceSequenceId: source.id,
      sourceType: 'rd',
      rdSourceEnzyme: 'BsmBI',
      isPlaceholder: false,
    });
    expect(firstLinked.regions[0].sourceSequenceName).toContain(source.name);
    expect(firstLinked.regions[0].sequence).not.toHaveLength(0);

    const changedSequence = mutateFragmentBase(source.regions[0].sequence, fragment);
    const changedSource: SequenceDesign = {
      ...source,
      regions: [
        {
          ...source.regions[0],
          sequence: changedSequence,
          sourceSequence: changedSequence,
          sourceEnd: changedSequence.length,
          sourceLength: changedSequence.length,
        },
      ],
      version: source.version + 1,
    };
    const second = reconcileMocloFactoryStageOutputs({
      designs: { ...first, [source.id]: changedSource },
      enzymes: [BSMBI],
      now: new Date('2026-09-01T20:01:00.000Z'),
    });

    expect(second[downstream.id].regions[0].sequence).not.toBe(firstLinked.regions[0].sequence);
    expect(second[downstream.id].version).toBe(firstLinked.version + 1);
  });

  it('clears a previously managed slot instead of retaining stale upstream sequence', () => {
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);
    const linked = reconcileMocloFactoryStageOutputs({
      designs: { [source.id]: source, [downstream.id]: downstream },
      enzymes: [BSMBI],
      now: NOW,
    })[downstream.id];

    const withoutSource = reconcileMocloFactoryStageOutputs({
      designs: { [linked.id]: linked },
      enzymes: [BSMBI],
      now: new Date('2026-09-01T20:01:00.000Z'),
    })[linked.id];

    expect(withoutSource.version).toBe(linked.version + 1);
    expect(withoutSource.regions[0]).toMatchObject({
      sourceSequenceId: 'placeholder',
      sequence: '',
      isPlaceholder: true,
      mocloStageOutput: {
        status: 'unresolved',
        sourceStageId: 'expression-cassette',
      },
    });
  });

  it('freezes the resolved child sequence and checksum in an accepted projection', async () => {
    const source = oneRegionSourceDesign();
    const fragment = digestInsert(getComposedSequenceForDesign(source));
    const downstream = dependentDesign(fragment);
    const linked = reconcileMocloFactoryStageOutputs({
      designs: { [source.id]: source, [downstream.id]: downstream },
      enzymes: [BSMBI],
      now: NOW,
    })[downstream.id];
    const linkedRegion = linked.regions[0];
    const sourceChecksum = await computeChecksum(linkedRegion.sourceSequence ?? '');
    const accepted = await buildAcceptedAssemblyProjectionInput(linked, {
      constructId: linked.constructId,
      sourceProvenance: linked.regions.map((region) =>
        buildSourceProvenanceSnapshot(region, {
          sourceSequenceChecksum: region.id === linkedRegion.id ? sourceChecksum : undefined,
          sourceSequenceVersionId: region.id === linkedRegion.id ? sourceChecksum : undefined,
        })
      ),
    });

    const changedSequence = mutateFragmentBase(source.regions[0].sequence, fragment);
    const changedSource: SequenceDesign = {
      ...source,
      regions: [
        {
          ...source.regions[0],
          sequence: changedSequence,
          sourceSequence: changedSequence,
        },
      ],
      version: source.version + 1,
    };
    const changed = reconcileMocloFactoryStageOutputs({
      designs: { [source.id]: changedSource, [downstream.id]: linked },
      enzymes: [BSMBI],
      now: new Date('2026-09-01T20:01:00.000Z'),
    })[downstream.id];

    expect(accepted.regions[0].sequence).toBe(linkedRegion.sequence);
    expect(accepted.regions[0].sequence).not.toBe(changed.regions[0].sequence);
    expect(accepted.sourceProvenance[0].sourceSequenceVersionId).toBe(sourceChecksum);
  });
});
