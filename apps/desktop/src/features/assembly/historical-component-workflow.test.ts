import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcceptedAssemblySidecarPayload } from './accepted-types';
import type { ResolvedAcceptedAssemblyRecord } from './accepted-record-reader';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  readCopy: vi.fn(),
  reopen: vi.fn(),
}));

vi.mock('./accepted-record-reader', () => ({
  resolveAcceptedAssemblyRecord: mocks.resolve,
}));
vi.mock('../../db/sequence-package-working-copy-storage', () => ({
  readPackageAssemblyWorkingCopy: mocks.readCopy,
}));
vi.mock('./accepted-reopen-workflow', () => ({
  reopenAcceptedAssemblyWorkflow: mocks.reopen,
}));

import { catalogHistoricalAssemblyComponents } from './historical-component-composition';
import {
  inspectHistoricalAssemblyStageTarget,
  previewHistoricalAssemblyComponentStage,
  stageHistoricalAssemblyComponents,
} from './historical-component-workflow';

function accepted(): AcceptedAssemblySidecarPayload {
  const projectionInput = {
    schemaVersion: 1 as const,
    designId: 'original',
    constructId: 'construct-1',
    designName: 'Construct',
    topology: 'linear' as const,
    assemblyMethod: 'gibson' as const,
    backboneSequenceId: null,
    defaultHomologyLength: 2,
    productSequence: 'firstsecond',
    regions: [
      {
        id: 'left',
        sourceSequenceId: 'source-left',
        sourceSequenceName: 'Left',
        sourceType: 'pcr' as const,
        sourceStart: 0,
        sourceEnd: 5,
        sequence: 'first',
        annotations: [],
      },
      {
        id: 'right',
        sourceSequenceId: 'source-right',
        sourceSequenceName: 'Right',
        sourceType: 'pcr' as const,
        sourceStart: 0,
        sourceEnd: 6,
        sequence: 'second',
        annotations: [],
      },
    ],
    spacers: [],
    homologyRegions: [],
    designPrimers: [],
    sourceProvenance: [],
    canonicalDraftChecksum: 'sha256:accepted-base',
  };
  return {
    type: 'accepted_assembly',
    schemaVersion: 1,
    acceptedAssemblyVersionId: 'accepted-base',
    acceptedAt: '2026-09-30T00:00:00.000Z',
    designId: 'original',
    designName: 'Construct',
    construction: {
      method: 'gibson',
      topology: 'linear',
      regionCount: 2,
      spacerCount: 0,
      canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
    },
    projectionInput,
    validationSnapshot: {
      schemaVersion: 1,
      designId: 'original',
      designVersion: 1,
      assemblyMethod: 'gibson',
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-09-30T00:00:00.000Z',
      clean: true,
      issues: [],
    },
    artifacts: {
      productGenBankPath: 'contents/product.gb',
      sidecarJsonPath: 'contents/assembly.json',
      primerCsvPath: 'contents/primers.csv',
      primerFastaPath: 'contents/primers.fasta',
      productSequenceChecksum: 'sha256:product',
      primerCsvChecksum: 'sha256:csv',
      primerFastaChecksum: 'sha256:fasta',
      canonicalDraftChecksum: projectionInput.canonicalDraftChecksum,
    },
  };
}

describe('historical component staging preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCopy.mockResolvedValue(null);
    const payload = accepted();
    mocks.resolve.mockResolvedValue({
      constructId: 'construct-1',
      packageId: 'construct-1',
      packageRoot: '/workspace/construct-1',
      acceptedAssemblyVersionId: 'accepted-base',
      accepted: payload,
      acceptedRecords: [payload],
    } as ResolvedAcceptedAssemblyRecord);
  });

  it('exposes the exact new-copy base/version and refuses a bad target before reopen', async () => {
    const target = await inspectHistoricalAssemblyStageTarget({
      constructId: 'construct-1',
      baseAcceptedAssemblyVersionId: 'accepted-base',
    });
    expect(target.exists).toBe(false);
    expect(target.designVersion).toBe(0);
    expect(target.draftDigest).toMatch(/^sha256:/);
    expect(target.targets).toEqual(
      expect.arrayContaining([
        { kind: 'region', regionId: 'left' },
        { kind: 'primer-pair', regionId: 'left' },
        { kind: 'spacer', leftRegionId: 'left', rightRegionId: 'right' },
        { kind: 'join', leftRegionId: 'left', rightRegionId: 'right' },
      ])
    );
    const source = (await catalogHistoricalAssemblyComponents([accepted()])).components.find(
      (item) => item.kind === 'region' && item.regionId === 'left'
    );
    if (!source) throw new Error('Missing source region');
    const preview = await previewHistoricalAssemblyComponentStage({
      constructId: 'construct-1',
      baseAcceptedAssemblyVersionId: 'accepted-base',
      expectedDesignVersion: target.designVersion,
      expectedDraftDigest: target.draftDigest,
      selections: [{ source, target: { kind: 'region', regionId: 'missing-slot' } }],
    });
    expect(preview).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/target region/i),
    });
    await expect(
      stageHistoricalAssemblyComponents({
        constructId: 'construct-1',
        baseAcceptedAssemblyVersionId: 'accepted-base',
        expectedDesignVersion: target.designVersion,
        expectedDraftDigest: target.draftDigest,
        reopenIdempotencyKey: 'stage-once',
        selections: [{ source, target: { kind: 'region', regionId: 'missing-slot' } }],
      })
    ).rejects.toThrow(/target region/i);
    expect(mocks.reopen).not.toHaveBeenCalled();
  });
});
