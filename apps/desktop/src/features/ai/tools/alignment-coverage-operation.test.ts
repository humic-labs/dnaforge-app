import { beforeEach, describe, expect, it } from 'vitest';

import { useCanvasStore } from '../../canvas/public/store';
import { useLaneContractStore } from '../../sequence/public/lane-contract-store';
import { execTool, resetCanvasStore } from './test-helpers';
import {
  createPrepareManagedAlignmentCoverageTool as originalCreatePrepareManagedAlignmentCoverageTool,
  managedAlignmentCoverageStartSchema,
  projectManagedAlignmentCoveragePreparation,
} from './alignment-coverage-operation';
import { checkedSequenceToolFactory as checkedToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { operationsAlignmentCoveragePreparationStartOutputSchema } from './operation-output-schemas';
const createPrepareManagedAlignmentCoverageTool = checkedToolFactory(
  originalCreatePrepareManagedAlignmentCoverageTool,
  operationsAlignmentCoveragePreparationStartOutputSchema
);

const GENERATION = {
  contract: 'aligned-read-source-generation.v1' as const,
  alignment: {
    canonicalPath: '/data/sample.bam',
    size: 20,
    mtimeNs: '1',
    ctimeNs: '2',
  },
  index: {
    canonicalPath: '/data/sample.bam.bai',
    size: 10,
    mtimeNs: '3',
    ctimeNs: '4',
  },
};

function mountTrack(): { readonly tabId: string; readonly trackId: string } {
  const tabId = useCanvasStore.getState().openTab('main', {
    type: 'sequence',
    entityId: 'assembly:grch38',
    sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:grch38' },
    label: 'GRCh38',
    indexedGenome: {
      sourcePath: '/references/grch38.fa',
      sourceExt: '.fa',
      chrom: 'chr1',
      assembly: {
        assemblyId: 'grch38',
        displayName: 'GRCh38',
        chromosomes: [
          {
            chrom: 'chr1',
            displayName: 'chr1',
            length: 100,
            manifest: { chrom: 'chr1', fastaPath: 'chr1.fa', faiPath: 'chr1.fa.fai' },
          },
          {
            chrom: 'chr2',
            displayName: 'chr2',
            length: 200,
            manifest: { chrom: 'chr2', fastaPath: 'chr2.fa', faiPath: 'chr2.fa.fai' },
          },
        ],
      },
    },
  });
  const dataset = {
    kind: 'pileup' as const,
    trackType: 'pileup-genomewide' as const,
    trackId: 'pileup-grch38-sample',
    label: 'GRCh38: sample.bam',
    color: 0x4a90d9,
    laneHeightPx: 3,
    maxLanes: 80,
    overflowBandHeightPx: 36,
    trackPx: 276,
    records: [],
    source: {
      bamPath: '/data/sample.bam',
      indexPath: '/data/sample.bam.bai',
      generation: GENERATION,
    },
  };
  useLaneContractStore.getState().addLane(tabId, 'grch38', dataset);
  return { tabId, trackId: dataset.trackId };
}

beforeEach(() => {
  resetCanvasStore();
  useLaneContractStore.getState().clear();
});

describe('managed alignment-coverage agent preparation', () => {
  it('resolves identifiers through the mounted app state into the exact managed input', async () => {
    const { trackId } = mountTrack();

    const result = await execTool<Record<string, unknown>>(
      createPrepareManagedAlignmentCoverageTool(),
      { assemblyId: 'grch38', trackId }
    );

    expect(result).toEqual({
      ok: true,
      input: {
        assemblyId: 'grch38',
        bamPath: '/data/sample.bam',
        indexPath: '/data/sample.bam.bai',
        sourceGeneration: GENERATION,
        chroms: ['chr1', 'chr2'],
      },
    });
  });

  it('fails closed for an unmounted identity or a track without exact admission', async () => {
    expect(
      await execTool(createPrepareManagedAlignmentCoverageTool(), {
        assemblyId: 'grch38',
        trackId: 'missing',
      })
    ).toMatchObject({ ok: false, code: 'ALIGNMENT_TRACK_NOT_FOUND' });

    const { tabId, trackId } = mountTrack();
    const lane = useLaneContractStore.getState().lanesForOwner(tabId)[0]!;
    useLaneContractStore.getState().replaceLaneDataset(tabId, trackId, 'grch38', {
      ...lane.dataset,
      source: { ...lane.dataset.source!, generation: undefined },
    });
    expect(
      await execTool(createPrepareManagedAlignmentCoverageTool(), {
        assemblyId: 'grch38',
        trackId,
      })
    ).toMatchObject({ ok: false, code: 'ALIGNMENT_TRACK_NOT_ADMITTED' });
  });

  it('keeps private paths out of the renderer audit projection', () => {
    const result = {
      ok: true,
      input: {
        assemblyId: 'grch38',
        bamPath: '/private/sample.bam',
        indexPath: '/private/sample.bam.bai',
        sourceGeneration: GENERATION,
        chroms: ['chr1', 'chr2'],
      },
    };

    expect(projectManagedAlignmentCoveragePreparation(result)).toEqual({
      input: { assemblyId: 'grch38', chromCount: 2 },
    });
    expect(JSON.stringify(projectManagedAlignmentCoveragePreparation(result))).not.toContain(
      '/private'
    );
    expect(
      projectManagedAlignmentCoveragePreparation({
        input: { assemblyId: 'grch38', chroms: 'chr1' },
      })
    ).toEqual({});
  });

  it('uses the exact identifier-only schema exposed by the managed agent tool', () => {
    expect(
      managedAlignmentCoverageStartSchema.safeParse({
        assemblyId: 'grch38',
        trackId: 'track-1',
      }).success
    ).toBe(true);
    expect(
      managedAlignmentCoverageStartSchema.safeParse({
        assemblyId: 'grch38',
        trackId: 'track-1',
        bamPath: '/private/sample.bam',
      }).success
    ).toBe(false);
  });
});
