import { expect, it, vi } from 'vitest';
import type { LimsRegistryPreview } from '../../shared/lims';
import { loadEntityDetails } from './factory';

const mocks = vi.hoisted(() => ({ preview: null as LimsRegistryPreview | null }));
vi.mock('../../db/workspace-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/workspace-catalog')>()),
  getCurrentCatalogFileForEntity: async () => null,
}));
vi.mock('../lims/public/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lims/public/operations')>()),
  getLimsRegistryPreview: async () => mocks.preview,
}));

it('loads a database-only record without inventing saved-file recovery state', async () => {
  mocks.preview = {
    entity: {
      id: 'database-record',
      kind: 'comparison',
      name: 'Legacy specimen',
      fields: {},
      registrationStatus: 'registered',
      eventSeq: 1,
      workspaceId: null,
    },
    schemaSnapshot: {
      schemaId: 'comparison',
      schemaRevisionId: 'comparison-v1',
      name: 'comparison',
      displayName: 'Comparison',
      baseKind: 'strain',
      version: 1,
      fields: [{ key: 'batch', label: 'Batch', type: 'text' }],
    },
    summary: {
      fieldValues: { batch: 'Legacy batch' },
      archived: false,
      representation: { kind: 'none', label: 'Record', canOpen: false },
    },
  } as LimsRegistryPreview;
  const definition = await loadEntityDetails({ entityId: 'database-record' });
  expect(definition.record).toMatchObject({
    id: 'database-record',
    name: 'Legacy specimen',
    fields: { batch: 'Legacy batch' },
    schema: { schemaRevisionId: 'comparison-v1' },
  });
  expect(definition.savedRecord).toBeUndefined();
  expect(definition.record.path).toBeUndefined();
});

it('keeps an imported record archivable while its source-preserved metadata stays read-only', async () => {
  mocks.preview = {
    entity: {
      id: 'imported-record',
      kind: 'record',
      name: 'Reagent Alpha',
      fields: {
        sourceMetadata: {
          origin: { connectorType: 'benchling', sourceId: 'bfi_UIREC01' },
        },
      },
      registrationStatus: 'registered',
      eventSeq: 1,
      workspaceId: null,
    },
    schemaSnapshot: {
      schemaId: 'reagent',
      schemaRevisionId: 'reagent-r1',
      name: 'reagent',
      displayName: 'Reagent',
      baseKind: 'record',
      version: 1,
      fields: [{ key: 'amount', label: 'Amount', type: 'number' }],
    },
    summary: {
      fieldValues: { amount: 0 },
      archived: false,
      representation: { kind: 'none', label: 'Record', canOpen: false },
    },
  } as LimsRegistryPreview;
  const definition = await loadEntityDetails({ entityId: 'imported-record' });
  expect(definition.record.readOnlyReason).toBe(
    'This imported record preserves its original source. View original source to inspect it.'
  );
  expect(definition.record.lifecycleReadOnlyReason).toBeNull();
});
