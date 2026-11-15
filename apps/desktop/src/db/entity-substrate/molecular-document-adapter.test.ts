import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../lib/analytics', () => ({ trackRendererEvent: vi.fn() }));
import { clearMockData, setMockFileContent } from '../../test/platform-mocks';
import { initializeTestSchema } from '../../test/initializeTestSchema';
import { molecularDocumentFixture } from '../../test/fixtures/molecular-documents';
import { platform } from '../../platform';
import { serializeMolecularDocument } from '../../shared/molecular-document';
import { coordinateDigest } from '../../shared/molecular-view';
import {
  getCatalogEntityForFilePath,
  resolveWorkspaceId,
  resolveWorkspaceScope,
} from '../workspace-catalog';
import { resolveArtifactFile } from '../workspace-artifacts';
import { reconcileWorkspaceEntities } from './reconcile-entities';
import {
  molecularDocumentAdapter,
  registerMolecularDocumentAdapter,
} from './molecular-document-adapter';
import { __resetEntityAdapterRegistryForTests, reconcileEntityFile } from './adapter';

describe('molecular document file projections', () => {
  beforeEach(async () => {
    clearMockData();
    await initializeTestSchema();
    await platform().lims.resetRegistry();
    __resetEntityAdapterRegistryForTests();
    registerMolecularDocumentAdapter();
    vi.spyOn(platform().molecularDocuments, 'reconcileSourceLinks').mockResolvedValue({
      entityId: 'native-entity',
      revision: 'native-revision',
      sourceLinkCount: 0,
    });
  });
  afterEach(() => {
    __resetEntityAdapterRegistryForTests();
    vi.restoreAllMocks();
  });

  it('rebuilds the catalog and Registry from a copied native file without any saved-result database rows', async () => {
    const document = await molecularDocumentFixture();
    const bytes = serializeMolecularDocument(document);
    const ids: string[] = [];
    for (const workspaceRoot of ['/projects/one', '/projects/copied']) {
      const path = `${workspaceRoot}/Pocket.dnaforge-molecular.json`;
      setMockFileContent(path, bytes);
      const binding = await resolveArtifactFile({ path, workspaceRoot });
      const context = {
        workspaceRoot,
        workspaceId: await resolveWorkspaceId(workspaceRoot),
        workspaceScope: await resolveWorkspaceScope(workspaceRoot),
      };
      const result = await reconcileEntityFile(
        molecularDocumentAdapter,
        bytes,
        path,
        Date.now(),
        context
      );
      expect(result.outcome).toBe('created');
      expect(result.id).toBe(binding.entity.id);
      expect(await getCatalogEntityForFilePath(path)).toMatchObject({
        id: result.id,
        type: 'molecular-document',
        name: document.name,
      });
      expect(await platform().lims.queryEntities({ id: result.id })).toMatchObject([
        {
          kind: 'molecular-document',
          name: document.name,
          fields: {
            currentReferenceId: document.currentReferenceId,
            revisionCount: 2,
            sourceCount: 1,
          },
        },
      ]);
      ids.push(result.id);
    }
    expect(new Set(ids).size).toBe(2);
    expect(document.id).not.toContain('::');
  });

  it('refreshes externally changed native files through the real workspace prebind path', async () => {
    const document = await molecularDocumentFixture();
    const workspaceRoot = '/projects/one';
    const path = `${workspaceRoot}/Pocket.dnaforge-molecular.json`;
    setMockFileContent(path, serializeMolecularDocument(document));
    const initial = await reconcileWorkspaceEntities(workspaceRoot, { candidatePaths: [path] });
    expect(initial.errors).toEqual([]);
    const entity = await getCatalogEntityForFilePath(path);
    expect(entity?.type).toBe('molecular-document');
    const changed = { ...document, currentReferenceId: document.history[0].referenceId };
    setMockFileContent(path, serializeMolecularDocument(changed));
    const next = await reconcileWorkspaceEntities(workspaceRoot, { candidatePaths: [path] });
    expect(next.errors).toEqual([]);
    expect(next.conflicts).toBe(0);
    expect(await platform().lims.queryEntities({ id: entity!.id })).toMatchObject([
      {
        name: changed.name,
        fields: { currentReferenceId: changed.currentReferenceId },
      },
    ]);
  });

  it('delegates source projection with its file identity, exact document hash and mutation capability', async () => {
    const document = await molecularDocumentFixture();
    const workspaceRoot = '/projects/one';
    const context = {
      workspaceRoot,
      workspaceId: await resolveWorkspaceId(workspaceRoot),
      workspaceScope: await resolveWorkspaceScope(workspaceRoot),
      mutationToken: 'existing-mutation',
    };
    const path = `${workspaceRoot}/Pocket.dnaforge-molecular.json`;
    const id = molecularDocumentAdapter.identity(document, context);
    await molecularDocumentAdapter.reconcileRelationships!(document, id, path, context);
    expect(platform().molecularDocuments.reconcileSourceLinks).toHaveBeenCalledWith(
      {
        path,
        workspaceRoot,
        entityId: id,
        documentHash: await coordinateDigest(serializeMolecularDocument(document)),
      },
      'existing-mutation'
    );
  });
});
