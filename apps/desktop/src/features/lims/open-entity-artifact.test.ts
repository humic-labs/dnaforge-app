import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTITY_ARTIFACT_CURRENT_SCHEMA } from './entity-artifact';

const mocks = vi.hoisted(() => ({
  present: vi.fn(),
  load: vi.fn(),
  read: vi.fn(),
  preview: vi.fn(),
  readable: vi.fn(),
}));
vi.mock('../canvas/public/present-document', () => ({ presentDocument: mocks.present }));
vi.mock('../../lib/readable-content-telemetry', () => ({
  registerPendingReadableContent: mocks.readable,
}));
vi.mock('./entity-record-document', () => ({
  loadSavedEntityRecord: mocks.load,
  readEntityArtifactFile: mocks.read,
}));
vi.mock('./operations', () => ({ getLimsRegistryPreview: mocks.preview }));
vi.mock('../../shared/registry-entity-opening', () => ({
  registryRepresentationForEntity: () => ({ openTarget: { kind: 'record_file' } }),
}));

import { openEntityArtifact, openSavedEntityRecord } from './open-entity-artifact';

beforeEach(() => {
  vi.clearAllMocks();
  const loaded = {
    path: '/workspace/Saved protein.entity.json',
    artifact: {
      schema: ENTITY_ARTIFACT_CURRENT_SCHEMA,
      id: 'protein-id',
      kind: 'protein',
      name: 'Saved protein',
    },
  };
  mocks.load.mockResolvedValue(loaded);
  mocks.read.mockResolvedValue(loaded);
  mocks.preview.mockResolvedValue({ entity: { id: 'protein-id' } });
  mocks.present.mockReturnValue({ status: 'presented', tabId: 'protein-record-tab' });
});

describe('saved entity tab identity', () => {
  it('preserves protein identity when opening its saved record', async () => {
    await openSavedEntityRecord('protein-id', {});
    expect(mocks.present).toHaveBeenCalledWith(
      { type: 'record', entityId: 'protein-id', entityKind: 'protein', label: 'Saved protein' },
      undefined
    );
  });

  it('preserves protein identity when its file uses the record editor', async () => {
    await openEntityArtifact({
      target: { kind: 'file', path: '/workspace/Saved protein.entity.json' },
      label: 'Saved protein',
    });
    expect(mocks.present).toHaveBeenCalledWith(
      { type: 'record', entityId: 'protein-id', entityKind: 'protein', label: 'Saved protein' },
      undefined
    );
  });
});
