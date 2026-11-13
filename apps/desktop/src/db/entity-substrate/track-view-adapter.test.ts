import { beforeEach, describe, expect, it } from 'vitest';
import { clearMockData } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { platform } from '../../platform';
import { getCatalogEntity, getCatalogEntityForFilePath } from '../workspace-catalog';
import { reconcileEntityFile } from './adapter';
import { trackViewAdapter } from './track-view-adapter';
import { serializeTrackViewDocument } from '../../shared/track-view';
import { trackViewFixture } from '../../shared/track-view-fixture';

describe('Track view catalog projection', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
    await platform().lims.resetRegistry();
  });
  it('rebuilds the catalog and Registry projections from the authoritative view file', async () => {
    const value = trackViewFixture();
    const path = '/profile/Track views/track-view-11111111.dnaforge-track-view.json';
    const bytes = serializeTrackViewDocument(value);
    const context = { workspaceRoot: null };
    const fileMtimeMs = Date.now();
    expect(
      (await reconcileEntityFile(trackViewAdapter, bytes, path, fileMtimeMs, context)).outcome
    ).toBe('created');
    expect(await getCatalogEntityForFilePath(path)).toMatchObject({
      id: value.id,
      type: 'track-view',
      name: 'Genes',
      workspace_id: null,
    });
    expect(await platform().lims.queryEntities({ id: value.id })).toMatchObject([
      {
        id: value.id,
        kind: 'track-view',
        name: 'Genes',
        workspaceId: null,
        tombstone: false,
        fields: {
          referenceAssemblyId: value.reference.assemblyId,
          referenceName: value.reference.name,
          trackCount:
            value.dataTracks.length + value.bamTracks.length + (value.variantSource ? 1 : 0),
          artifactFingerprint: trackViewAdapter.projectionFingerprint(value),
        },
      },
    ]);
    await platform().db.execute('DELETE FROM catalog_entity_files WHERE entity_id = ?', [value.id]);
    await platform().db.execute('DELETE FROM catalog_entities WHERE id = ?', [value.id]);
    expect(
      (await reconcileEntityFile(trackViewAdapter, bytes, path, fileMtimeMs, context)).outcome
    ).toBe('created');
    expect(await getCatalogEntity(String(value.id))).toMatchObject({
      type: 'track-view',
      name: 'Genes',
    });
    expect(await getCatalogEntityForFilePath(path)).toMatchObject({ id: value.id });
    expect(await platform().lims.queryEntities({ id: value.id })).toHaveLength(1);

    await platform().lims.archiveEntity({ id: value.id, actor: 'test' });
    expect(
      (await reconcileEntityFile(trackViewAdapter, bytes, path, fileMtimeMs, context)).outcome
    ).toBe('created');
    expect(
      await platform().lims.queryEntities({ id: value.id, includeArchived: true })
    ).toMatchObject([{ id: value.id, name: 'Genes', tombstone: false }]);
  });
});
