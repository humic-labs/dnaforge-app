import { beforeEach, describe, expect, it } from 'vitest';
import type { AcceptedAssemblyVersion } from '../assembly/accepted-types';
import { useDesignStore } from './store';
import type { SequenceDesign } from './types';

describe('design store accepted assembly commits', () => {
  beforeEach(() => {
    useDesignStore.setState({
      designs: {},
      activeDesignId: null,
      pendingDispatchId: null,
    });
  });

  it('commits accepted assembly versions only against the expected draft version', () => {
    const design = createDesign();
    const accepted = acceptedVersion('accepted-1');
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const stale = useDesignStore
      .getState()
      .commitAcceptedAssemblyVersion(design.id, accepted, design.version + 1);
    expect(stale).toBe(false);
    expect(useDesignStore.getState().designs[design.id].acceptedAssemblyVersions).toBeUndefined();

    const committed = useDesignStore
      .getState()
      .commitAcceptedAssemblyVersion(design.id, accepted, design.version);
    const next = useDesignStore.getState().designs[design.id];

    expect(committed).toBe(true);
    expect(next.assemblyState).toBe('assembled');
    expect(next.status).toBe('assembled');
    expect(next.version).toBe(design.version + 1);
    expect(next.activeAcceptedAssemblyVersionId).toBe('accepted-1');
    expect(next.acceptedAssemblyVersions?.map((version) => version.id)).toEqual(['accepted-1']);
  });

  it('replaces an accepted assembly version lifecycle without overwriting concurrent draft edits', () => {
    const design = createDesign();
    const writing = { ...acceptedVersion('accepted-1'), lifecycleState: 'writing' as const };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const reserved = useDesignStore
      .getState()
      .commitAcceptedAssemblyVersion(design.id, writing, design.version);
    expect(reserved).toBe(true);
    useDesignStore.setState((state) => ({
      designs: {
        ...state.designs,
        [design.id]: {
          ...state.designs[design.id],
          name: 'Edited while writing',
          version: state.designs[design.id].version + 1,
        },
      },
    }));

    const written = { ...writing, lifecycleState: 'written' as const };
    const replaced = useDesignStore.getState().replaceAcceptedAssemblyVersion(design.id, written);
    const next = useDesignStore.getState().designs[design.id];

    expect(replaced).toBe(true);
    expect(next.name).toBe('Edited while writing');
    expect(next.acceptedAssemblyVersions).toHaveLength(1);
    expect(next.acceptedAssemblyVersions?.[0].lifecycleState).toBe('written');
    expect(next.activeAcceptedAssemblyVersionId).toBe('accepted-1');
  });

  it('does not mark the design assembled while an accepted assembly write is pending or failed', () => {
    const design = createDesign();
    const writing = { ...acceptedVersion('accepted-1'), lifecycleState: 'writing' as const };
    useDesignStore.setState({
      designs: { [design.id]: design },
      activeDesignId: design.id,
    });

    const reserved = useDesignStore
      .getState()
      .commitAcceptedAssemblyVersion(design.id, writing, design.version);
    const pending = useDesignStore.getState().designs[design.id];
    expect(reserved).toBe(true);
    expect(pending.assemblyState).toBe('ready');
    expect(pending.status).toBe('computed');
    expect(pending.activeAcceptedAssemblyVersionId).toBeNull();
    expect(pending.acceptedAssemblyVersions?.[0].lifecycleState).toBe('writing');

    const failed = { ...writing, lifecycleState: 'write_failed' as const };
    const replaced = useDesignStore.getState().replaceAcceptedAssemblyVersion(design.id, failed);
    const next = useDesignStore.getState().designs[design.id];

    expect(replaced).toBe(true);
    expect(next.assemblyState).toBe('ready');
    expect(next.status).toBe('computed');
    expect(next.activeAcceptedAssemblyVersionId).toBeNull();
    expect(next.acceptedAssemblyVersions?.[0].lifecycleState).toBe('write_failed');
  });

  it('reopens a written accepted assembly version as a new active editable draft', () => {
    const accepted = acceptedVersion('accepted-reopen');

    const reopenedId = useDesignStore.getState().reopenAcceptedAssemblyVersion(accepted, {
      designId: 'reopened-design',
      now: new Date('2026-05-17T05:00:00.000Z'),
    });
    const reopened = useDesignStore.getState().designs[reopenedId];

    expect(reopenedId).toBe('reopened-design');
    expect(useDesignStore.getState().activeDesignId).toBe('reopened-design');
    expect(reopened.name).toBe('Accepted design');
    expect(reopened.assemblyMethod).toBe('gibson');
    expect(reopened.assemblyState).toBe('ready');
    expect(reopened.status).toBe('computed');
    expect(reopened.regions.map((region) => region.id)).toEqual(['left', 'right']);
    expect(reopened.spacers).toEqual([{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }]);
    expect(reopened.acceptedAssemblyVersions?.map((version) => version.id)).toEqual([
      'accepted-reopen',
    ]);
    expect(reopened.activeAcceptedAssemblyVersionId).toBe('accepted-reopen');
  });
});

function createDesign(): SequenceDesign {
  const now = new Date('2026-05-17T00:00:00.000Z');
  return {
    id: 'design-1',
    name: 'Accepted design',
    topology: 'circular',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Source left',
        sourceStart: 0,
        sourceEnd: 4,
        sequence: 'ATGC',
        annotations: [],
        sourceType: 'pcr',
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Source right',
        sourceStart: 0,
        sourceEnd: 4,
        sequence: 'GCTA',
        annotations: [],
        sourceType: 'pcr',
      },
    ],
    spacers: [],
    version: 2,
    assemblyState: 'ready',
    validationErrors: [],
    proposedPlans: [],
    status: 'computed',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function acceptedVersion(id: string): AcceptedAssemblyVersion {
  return {
    id,
    schemaVersion: 1,
    lifecycleState: 'written',
    acceptedAt: '2026-05-17T00:01:00.000Z',
    canonicalDraftChecksum: 'sha256:canonical',
    projectionInput: {
      schemaVersion: 1,
      designId: 'design-1',
      designName: 'Accepted design',
      topology: 'circular',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 30,
      productSequence: 'ATGCAAAGCTA',
      regions: [
        {
          id: 'left',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'ATGC',
          annotations: [],
        },
        {
          id: 'right',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'GCTA',
          annotations: [],
        },
      ],
      spacers: [{ id: 'spacer-1', junctionIndex: 0, sequence: 'AAA' }],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [
        {
          regionId: 'left',
          sourceType: 'pcr',
          sourceSequenceId: 'source-left',
          sourceSequenceName: 'Source left',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
        {
          regionId: 'right',
          sourceType: 'pcr',
          sourceSequenceId: 'source-right',
          sourceSequenceName: 'Source right',
          copiedDirection: 'forward',
          selectedSourceRange: { start: 0, end: 4 },
          includedSourceSegments: [{ start: 0, end: 4, role: 'included-template' }],
          sourceAnnotations: [],
          copiedAnnotations: [],
        },
      ],
      canonicalDraftChecksum: 'sha256:canonical',
    },
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'design-1',
      designVersion: 2,
      assemblyMethod: 'gibson',
      projectionInputChecksum: 'sha256:canonical',
      validatedAt: '2026-05-17T00:00:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: '/workspace/assemblies/accepted.gb',
      sidecarJsonPath: '/workspace/assemblies/accepted.waypoint-assembly.json',
      productSequenceChecksum: 'sha256:product',
      sidecarChecksum: 'sha256:sidecar',
      canonicalDraftChecksum: 'sha256:canonical',
    },
  };
}
