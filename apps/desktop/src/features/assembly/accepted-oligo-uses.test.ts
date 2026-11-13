import { describe, expect, it, vi } from 'vitest';
import type { DesignPrimer, DesignPrimerPair } from '../design/public/assembly-contract';
import {
  acceptedAssemblyUsesOfOligo,
  type AcceptedAssemblyOligoUsesDeps,
} from './accepted-oligo-uses';
import type {
  AcceptedAssemblyPrimerOligo,
  AcceptedAssemblyProjectionInput,
  AcceptedAssemblySidecarPayload,
} from './accepted-types';
import type { ResolvedAcceptedAssemblyRecord } from './accepted-record-reader';

const TAIL = 'AGAGGAGAAATACTA';
const BINDING = 'ATGAGTTTATGGAAAAAAATCAGCCTCGG';

function designPrimer(input: {
  id: string;
  name: string;
  direction: 'forward' | 'reverse';
  fragmentIndex: number;
  tail: string;
  binding: string;
}): DesignPrimer {
  return {
    id: input.id,
    name: input.name,
    sequence: `${input.tail}${input.binding}`,
    pbs: { start: 0, end: input.binding.length, sequence: input.binding },
    overhang: {
      length: input.tail.length,
      sequence: input.tail,
      tailLength: input.tail.length,
    },
    direction: input.direction,
    fragmentIndex: input.fragmentIndex,
    junctionIndex: 0,
  };
}

function designPrimerPair(fragmentIndex: number): DesignPrimerPair {
  return {
    fragmentIndex,
    forward: designPrimer({
      id: `p-f-${fragmentIndex}`,
      name: `F${fragmentIndex + 1} forward`,
      direction: 'forward',
      fragmentIndex,
      tail: TAIL,
      binding: BINDING,
    }),
    reverse: designPrimer({
      id: `p-r-${fragmentIndex}`,
      name: `F${fragmentIndex + 1} reverse`,
      direction: 'reverse',
      fragmentIndex,
      tail: '',
      binding: 'CCCCCCCCCCCCCCCC',
    }),
  };
}

function projectionInput(input: {
  designId: string;
  designName: string;
  designPrimers: readonly DesignPrimerPair[];
}): AcceptedAssemblyProjectionInput {
  return {
    schemaVersion: 1,
    designId: input.designId,
    designName: input.designName,
    topology: 'circular',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    productSequence: 'ATGC',
    regions: [],
    spacers: [],
    homologyRegions: [],
    designPrimers: input.designPrimers,
    sourceProvenance: [],
    canonicalDraftChecksum: `sha256:${input.designId}`,
  };
}

function sidecar(input: {
  acceptedAssemblyVersionId: string;
  acceptedAt: string;
  designId?: string;
  designName?: string;
  designPrimers?: readonly DesignPrimerPair[];
  savedPrimerOligos?: readonly AcceptedAssemblyPrimerOligo[];
}): AcceptedAssemblySidecarPayload {
  const designId = input.designId ?? 'design-1';
  const designName = input.designName ?? 'TamB Gibson';
  const projection = projectionInput({
    designId,
    designName,
    designPrimers: input.designPrimers ?? [designPrimerPair(0)],
  });
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: input.acceptedAssemblyVersionId,
    lifecycleState: 'written',
    acceptedAt: input.acceptedAt,
    designId,
    designName,
    construction: {
      method: 'gibson',
      topology: 'circular',
      canonicalDraftChecksum: projection.canonicalDraftChecksum,
      regionCount: 0,
      spacerCount: 0,
    },
    projectionInput: projection,
    validationSnapshot: {
      schemaVersion: 1,
      designId,
      designVersion: 12,
      assemblyMethod: 'gibson',
      projectionInputChecksum: projection.canonicalDraftChecksum,
      validatedAt: input.acceptedAt,
      clean: true,
      issues: [],
    },
    ...(input.savedPrimerOligos ? { savedPrimerOligos: input.savedPrimerOligos } : {}),
    artifacts: {
      productGenBankPath: 'pConstruct.gb',
      sidecarJsonPath: '.forge/plasmid.json',
      primerCsvPath: 'primers/pConstruct.primers.csv',
      primerFastaPath: 'primers/pConstruct.primers.fasta',
      productSequenceChecksum: 'sha256:product',
      productGenBankChecksum: 'sha256:genbank',
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum: projection.canonicalDraftChecksum,
    },
  };
}

function resolvedRecord(input: {
  constructId: string;
  packageRoot: string;
  acceptedRecords: readonly AcceptedAssemblySidecarPayload[];
  currentIndex?: number;
}): ResolvedAcceptedAssemblyRecord {
  const currentIndex = input.currentIndex ?? input.acceptedRecords.length - 1;
  const current = input.acceptedRecords[currentIndex]!;
  return {
    constructId: input.constructId,
    packageId: input.constructId,
    packageRoot: input.packageRoot,
    productPath: `${input.packageRoot}/pConstruct.gb`,
    metaPath: `${input.packageRoot}/.forge/plasmid.json`,
    acceptedAssemblyVersionId: current.acceptedAssemblyVersionId!,
    accepted: current,
    acceptedRecords: [...input.acceptedRecords],
    recordIsCurrent: true,
    integrity: {
      productGenBank: 'verified',
      expectedChecksum: 'sha256:genbank',
      actualChecksum: 'sha256:genbank',
    },
    catalogEvents: [],
  };
}

function savedOligo(
  primerId: string,
  artifactRevision: number,
  oligoId = 'oligo-380'
): AcceptedAssemblyPrimerOligo {
  return {
    primerId,
    oligoId,
    artifactRevision,
    sequenceContentHash: `sha256:${oligoId}-r${artifactRevision}`,
  };
}

function depsFor(
  records: ReadonlyMap<string, ResolvedAcceptedAssemblyRecord | Error>
): AcceptedAssemblyOligoUsesDeps {
  return {
    listFinalizedConstructIds: async () => [...records.keys()],
    resolveRecord: async (selector) => {
      const found = selector.constructId ? records.get(selector.constructId) : undefined;
      if (found === undefined) throw new Error(`Construct is not file-backed: unknown`);
      if (found instanceof Error) throw found;
      return found;
    },
  };
}

describe('accepted assembly uses of a saved oligo', () => {
  it('reports the finalized assembly, its primers and the revision pinned at acceptance', async () => {
    const accepted = sidecar({
      acceptedAssemblyVersionId: 'accepted-1',
      acceptedAt: '2026-10-01T12:00:00.000Z',
      savedPrimerOligos: [savedOligo('p-f-0', 2)],
    });
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [accepted],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.unreadable).toEqual([]);
    expect(report.uses).toEqual([
      {
        constructId: 'construct-1',
        packageId: 'construct-1',
        packageRoot: '/workspace/pConstruct',
        acceptedAssemblyVersionId: 'accepted-1',
        designId: 'design-1',
        designName: 'TamB Gibson',
        acceptedAt: '2026-10-01T12:00:00.000Z',
        assemblyMethod: 'gibson',
        isCurrentAccepted: true,
        primers: [
          {
            primerId: 'p-f-0',
            primerName: 'F1 forward',
            partNumber: 1,
            direction: 'forward',
            artifactRevision: 2,
            sequenceContentHash: 'sha256:oligo-380-r2',
            sequence: `${TAIL}${BINDING}`,
            bindingSequence: BINDING,
            tailSequence: TAIL,
          },
        ],
      },
    ]);
  });

  it('keeps the pinned revision after the oligo is edited to a higher revision', async () => {
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [
              sidecar({
                acceptedAssemblyVersionId: 'accepted-1',
                acceptedAt: '2026-10-01T12:00:00.000Z',
                savedPrimerOligos: [savedOligo('p-f-0', 2)],
              }),
            ],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.uses[0]!.primers[0]).toMatchObject({
      artifactRevision: 2,
      sequenceContentHash: 'sha256:oligo-380-r2',
    });
  });

  it('skips an accepted record that recorded no saved oligos', async () => {
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [
              sidecar({
                acceptedAssemblyVersionId: 'accepted-legacy',
                acceptedAt: '2026-09-01T12:00:00.000Z',
              }),
            ],
          }),
        ],
      ])
    );

    await expect(acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps)).resolves.toEqual({
      uses: [],
      unreadable: [],
    });
  });

  it('skips an accepted record whose saved oligos name a different oligo', async () => {
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [
              sidecar({
                acceptedAssemblyVersionId: 'accepted-1',
                acceptedAt: '2026-10-01T12:00:00.000Z',
                savedPrimerOligos: [savedOligo('p-f-0', 1, 'oligo-999')],
              }),
            ],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.uses).toEqual([]);
  });

  it('keeps reading the other packages when one package cannot be read', async () => {
    const readable = resolvedRecord({
      constructId: 'construct-c',
      packageRoot: '/workspace/pThird',
      acceptedRecords: [
        sidecar({
          acceptedAssemblyVersionId: 'accepted-c',
          acceptedAt: '2026-10-05T12:00:00.000Z',
          designName: 'Third construct',
          savedPrimerOligos: [savedOligo('p-f-0', 4)],
        }),
      ],
    });
    const deps = depsFor(
      new Map<string, ResolvedAcceptedAssemblyRecord | Error>([
        ['construct-b', new Error('Accepted assembly record does not exist: /gone/plasmid.json')],
        ['construct-c', readable],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.uses.map((use) => use.constructId)).toEqual(['construct-c']);
    expect(report.unreadable).toEqual([
      {
        constructId: 'construct-b',
        message: 'Accepted assembly record does not exist: /gone/plasmid.json',
      },
    ]);
  });

  it('reports a project that is not open as unreadable instead of throwing', async () => {
    const deps = depsFor(
      new Map<string, ResolvedAcceptedAssemblyRecord | Error>([
        ['construct-1', new Error('Accepted assembly is outside the active writable project.')],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report).toEqual({
      uses: [],
      unreadable: [
        {
          constructId: 'construct-1',
          message: 'Accepted assembly is outside the active writable project.',
        },
      ],
    });
  });

  it('yields an empty report when the finalized-assembly index cannot be queried', async () => {
    const report = await acceptedAssemblyUsesOfOligo(
      { oligoId: 'oligo-380' },
      {
        listFinalizedConstructIds: async () => {
          throw new Error('Platform not initialized. Call initPlatform() first.');
        },
        resolveRecord: async () => {
          throw new Error('must not resolve');
        },
      }
    );

    expect(report).toEqual({ uses: [], unreadable: [] });
  });

  it('marks a superseded accepted version and orders the newest acceptance first', async () => {
    const prior = sidecar({
      acceptedAssemblyVersionId: 'accepted-prior',
      acceptedAt: '2026-08-01T12:00:00.000Z',
      savedPrimerOligos: [savedOligo('p-f-0', 1)],
    });
    const current = sidecar({
      acceptedAssemblyVersionId: 'accepted-current',
      acceptedAt: '2026-10-01T12:00:00.000Z',
      savedPrimerOligos: [savedOligo('p-f-0', 3)],
    });
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [prior, current],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(
      report.uses.map((use) => [use.acceptedAssemblyVersionId, use.isCurrentAccepted])
    ).toEqual([
      ['accepted-current', true],
      ['accepted-prior', false],
    ]);
  });

  it('orders the primers of one acceptance by part and direction', async () => {
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [
              sidecar({
                acceptedAssemblyVersionId: 'accepted-1',
                acceptedAt: '2026-10-01T12:00:00.000Z',
                designPrimers: [designPrimerPair(0), designPrimerPair(1)],
                savedPrimerOligos: [
                  savedOligo('p-f-1', 2),
                  savedOligo('p-r-0', 2),
                  savedOligo('p-f-0', 2),
                ],
              }),
            ],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.uses[0]!.primers.map((primer) => primer.primerId)).toEqual([
      'p-f-0',
      'p-r-0',
      'p-f-1',
    ]);
  });

  it('reports a saved oligo whose primer is absent from the frozen recipe without bases', async () => {
    const deps = depsFor(
      new Map([
        [
          'construct-1',
          resolvedRecord({
            constructId: 'construct-1',
            packageRoot: '/workspace/pConstruct',
            acceptedRecords: [
              sidecar({
                acceptedAssemblyVersionId: 'accepted-1',
                acceptedAt: '2026-10-01T12:00:00.000Z',
                savedPrimerOligos: [savedOligo('p-retired', 2)],
              }),
            ],
          }),
        ],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo({ oligoId: 'oligo-380' }, deps);

    expect(report.uses[0]!.primers).toEqual([
      {
        primerId: 'p-retired',
        primerName: null,
        partNumber: null,
        direction: null,
        artifactRevision: 2,
        sequenceContentHash: 'sha256:oligo-380-r2',
        sequence: null,
        bindingSequence: null,
        tailSequence: null,
      },
    ]);
  });

  it('keeps only the packages inside the requested workspace root', async () => {
    const inside = resolvedRecord({
      constructId: 'construct-inside',
      packageRoot: '/workspace/project/pInside',
      acceptedRecords: [
        sidecar({
          acceptedAssemblyVersionId: 'accepted-inside',
          acceptedAt: '2026-10-01T12:00:00.000Z',
          savedPrimerOligos: [savedOligo('p-f-0', 2)],
        }),
      ],
    });
    const outside = resolvedRecord({
      constructId: 'construct-outside',
      packageRoot: '/workspace/other/pOutside',
      acceptedRecords: [
        sidecar({
          acceptedAssemblyVersionId: 'accepted-outside',
          acceptedAt: '2026-10-02T12:00:00.000Z',
          savedPrimerOligos: [savedOligo('p-f-0', 2)],
        }),
      ],
    });
    const deps = depsFor(
      new Map([
        ['construct-inside', inside],
        ['construct-outside', outside],
      ])
    );

    const report = await acceptedAssemblyUsesOfOligo(
      { oligoId: 'oligo-380', workspaceRoot: '/workspace/project' },
      deps
    );

    expect(report.uses.map((use) => use.constructId)).toEqual(['construct-inside']);
  });

  it('reads nothing when no oligo is named', async () => {
    const listFinalizedConstructIds = vi.fn(async () => ['construct-1']);
    const report = await acceptedAssemblyUsesOfOligo(
      { oligoId: '' },
      {
        listFinalizedConstructIds,
        resolveRecord: async () => {
          throw new Error('must not resolve');
        },
      }
    );

    expect(report).toEqual({ uses: [], unreadable: [] });
    expect(listFinalizedConstructIds).not.toHaveBeenCalled();
  });
});
