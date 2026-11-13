import { describe, expect, it } from 'vitest';
import { computeChecksum, listManagedGenBankAnnotations } from '@waypoint/sequence-utils';
import type {
  AcceptedAssemblyProjectionInput,
  AcceptedAssemblyValidationSnapshot,
} from './accepted-types';
import { prepareAcceptedAssemblyFiles } from './accepted-writer';

describe('accepted assembly annotation identity', () => {
  it('stamps a persistent ID before checksumming the finalized product bytes', async () => {
    const projectionInput: AcceptedAssemblyProjectionInput = {
      schemaVersion: 1,
      designId: 'draft-1',
      constructId: 'construct-1',
      designName: 'Construct',
      topology: 'linear',
      assemblyMethod: 'gibson',
      backboneSequenceId: null,
      defaultHomologyLength: 2,
      productSequence: 'NNNN',
      regions: [
        {
          id: 'region-1',
          sourceSequenceId: 'source-1',
          sourceSequenceName: 'Source',
          sourceType: 'pcr',
          sourceStart: 0,
          sourceEnd: 4,
          sequence: 'NNNN',
          annotations: [
            {
              name: 'Feature',
              type: 'misc_feature',
              start: 0,
              end: 2,
              strand: 'forward',
            },
          ],
        },
      ],
      spacers: [],
      homologyRegions: [],
      designPrimers: [],
      sourceProvenance: [],
      canonicalDraftChecksum: 'sha256:projection',
    };
    const validationSnapshot: AcceptedAssemblyValidationSnapshot = {
      schemaVersion: 1,
      designId: 'draft-1',
      designVersion: 1,
      assemblyMethod: 'gibson',
      projectionInputChecksum: projectionInput.canonicalDraftChecksum,
      validatedAt: '2026-09-30T00:00:00.000Z',
      clean: true,
      issues: [],
    };
    const files = await prepareAcceptedAssemblyFiles({
      projectionInput,
      validationSnapshot,
      writeTarget: { absoluteProductPath: '/workspace/product.gb' },
      workspaceFolders: {},
      acceptedVersionId: 'accepted-1',
      packageId: 'construct-1',
    });
    const annotations = listManagedGenBankAnnotations(files.productGenBankContent);
    expect(annotations).toHaveLength(1);
    expect(annotations[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(files.productGenBankChecksum).toBe(await computeChecksum(files.productGenBankContent));
  });
});
