import { describe, expect, it } from 'vitest';
import type {
  MigrationRun,
  ProjectionReceipt,
  SourceObject,
} from '../../shared/benchling-migration';
import { buildRendererValidationRequest } from './renderer-validation';

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('renderer migration validation request builder', () => {
  it('sends the real native registration input for pathless catalog records', async () => {
    const input = validationInput(['source-0']);
    input.run.createdAt = '2026-08-29T12:00:00.000Z';
    input.receipts = [
      {
        ...receipt('source-0', 0),
        destination: {
          kind: 'catalog-record',
          parentRelativePath: '',
          displayName: 'Strain A',
          catalogType: 'sample',
          presentationKind: 'strain',
        },
        nativeRepresentation: 'strain',
      },
    ];
    const source = {
      id: 'source-0',
      stableId: 'bfi_STRAINAA',
      sourceType: 'strain',
      name: 'Strain A',
      metadata: {},
      content: {
        kind: 'benchling_strain',
        displayName: 'Strain A',
        fields: [{ label: 'Genotype', value: 'deltaX', position: 0 }],
      },
    } as SourceObject;
    input.receipts[0] = {
      ...input.receipts[0],
      catalogPayload: {
        sourceObjectId: source.id,
        providerStableId: source.stableId,
        sourceType: source.sourceType,
        name: source.name,
        registryId: null,
        metadata: source.metadata,
        content: source.content,
      },
    } as ProjectionReceipt;
    source.content = {};
    const request = await buildRendererValidationRequest(
      { ...input, sourceObjects: [source] },
      REQUEST_ID,
      {
        assertContainedRegularFile: async () => {
          throw new Error('Catalog records must not read files.');
        },
      }
    );
    expect(request.items[0]).toMatchObject({
      surface: 'lims_registry',
      catalogRecord: { kind: 'strain', name: 'Strain A' },
    });
    expect(request.items[0]).not.toHaveProperty('destinationPath');
  });

  it('checks contained paths with bounded concurrency and preserves item order', async () => {
    const selectedSourceObjectIds = Array.from({ length: 40 }, (_, index) => `source-${index}`);
    let active = 0;
    let maximumActive = 0;
    const request = await buildRendererValidationRequest(
      validationInput(selectedSourceObjectIds),
      REQUEST_ID,
      {
        assertContainedRegularFile: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          active -= 1;
        },
      }
    );

    expect(maximumActive).toBe(16);
    expect(active).toBe(0);
    expect(request.items.map((item) => item.sourceObjectId)).toEqual(selectedSourceObjectIds);
  });

  it('reports the first path failure by input order rather than completion order', async () => {
    const input = validationInput(['source-0', 'source-1']);
    await expect(
      buildRendererValidationRequest(input, REQUEST_ID, {
        assertContainedRegularFile: async (_workspacePath, path) => {
          if (path.endsWith('0.txt')) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
            throw new Error('first path failed');
          }
          throw new Error('second path failed sooner');
        },
      })
    ).rejects.toThrow('first path failed');
  });
});

function validationInput(selectedSourceObjectIds: string[]) {
  return {
    run: {
      id: 'migration-run-1',
      workspaceId: 'workspace-1',
      workspacePath: '/workspace',
    } as MigrationRun,
    sourceObjects: [],
    receipts: selectedSourceObjectIds.map(receipt),
    resolutions: [],
    selectedSourceObjectIds,
  };
}

function receipt(sourceObjectId: string, index: number): ProjectionReceipt {
  return {
    id: `receipt-${index}`,
    runId: 'migration-run-1',
    sourceObjectId,
    destinationObjectId: `destination-${index}`,
    destinationPath: `Benchling Imports/Text/object-${index}/object-${index}.txt`,
    projection: 'native',
    converterId: 'benchling-text-v1',
    converterVersion: '1',
    sourceHash: 'a'.repeat(64),
    destinationHash: 'b'.repeat(64),
    warnings: [],
    exception: null,
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}
