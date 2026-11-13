import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LimsEntity } from '../../shared/lims';
import type { Primer } from './types';
import type { DBCatalogEntity } from '../../db/workspace-catalog';
import { buildPrimerArtifact, serializePrimerArtifact } from './primer-artifact';
import { resolveCanonicalPrimerReference } from './primer-references';

const mocks = vi.hoisted(() => ({
  getLimsEntity: vi.fn(),
  getPrimer: vi.fn(),
  readArtifact: vi.fn(),
  forward: vi.fn(),
  inverse: vi.fn(),
  catalog: vi.fn(),
  workspaceRootById: vi.fn(),
}));

vi.mock('./primer-services', () => ({
  primerServices: { persistence: mocks },
}));
vi.mock('../../db/primer-reference-search', () => ({
  findPrimerRegistryEntityId: mocks.forward,
  findPrimerLibraryIdsForRegistryEntityId: mocks.inverse,
}));
vi.mock('../../db/workspace-catalog', () => ({
  getCatalogEntityForWorkspaceRoot: mocks.catalog,
  getWorkspaceRootById: mocks.workspaceRootById,
}));

const ROOT = '/workspace/owner';
const folders = [{ name: 'Owner', path: ROOT, addedAt: 1 }];
const entity: LimsEntity = {
  id: 'registry-oligo',
  kind: 'oligo',
  schemaId: 'schema-entity-oligo',
  schemaRevisionId: 'revision-1',
  name: 'Canonical P01',
  registryId: 'o000001',
  fields: { sequence: 'ACGTACGTACGTACGT' },
  registrationStatus: 'registered',
  domainStatus: null,
  workspaceId: 1,
  actor: 'agent',
  eventSeq: 1,
  tombstone: false,
  createdAt: 1,
  updatedAt: 1,
  archivedAt: null,
};
const primer: Primer = {
  id: 'legacy-library-id',
  catalogNumber: 'PR-000001',
  name: 'Canonical P01',
  sequence: 'ACGTACGTACGTACGT',
  length: 16,
  tm: null,
  gcPercent: 50,
  origin: 'manual',
  originDetails: { limsEntityId: entity.id },
  status: 'designed',
  vendor: null,
  orderDate: null,
  application: null,
  scale: null,
  purification: null,
  modifications: null,
  stockLocation: null,
  concentration: null,
  notes: null,
  workspaceId: 1,
  createdAt: 1,
  updatedAt: 1,
};
const catalog: DBCatalogEntity = {
  id: primer.id,
  type: 'primer',
  name: primer.name,
  locator: `entity://primer/${primer.id}`,
  storage_type: 'file',
  status: 'active',
  workspace_id: 1,
  metadata: null,
  created_at: 1,
  updated_at: 1,
};

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.getLimsEntity.mockImplementation(async (id: string) => (id === entity.id ? entity : null));
  mocks.getPrimer.mockResolvedValue(primer);
  mocks.forward.mockImplementation(async (id: string) => (id === primer.id ? entity.id : null));
  mocks.inverse.mockResolvedValue([primer.id]);
  mocks.catalog.mockImplementation(async (_id: string, root: string) =>
    root === ROOT ? catalog : null
  );
  mocks.workspaceRootById.mockImplementation(async (id: number) => (id === 1 ? ROOT : null));
  const path = `${ROOT}/primers/P01.primer.json`;
  const artifact = await buildPrimerArtifact({
    id: primer.id,
    catalogNumber: primer.catalogNumber,
    name: primer.name,
    sequence: primer.sequence,
    workspaceRoot: ROOT,
    artifactPath: path,
    source: 'manual',
    binding: {
      id: 'saved-binding',
      targetDocumentId: 'sequence-document',
      targetFilePath: `${ROOT}/source.gb`,
      targetLength: 500,
      targetTopology: 'linear',
      targetFileContentHash: 'file-hash',
      targetNormalizedSequenceHash: 'sequence-hash',
      start: 100,
      end: 116,
      strand: 1,
    },
  });
  artifact.registry.entityId = entity.id;
  mocks.readArtifact.mockResolvedValue({
    path,
    artifact,
    content: serializePrimerArtifact(artifact),
    resolvedBindings: [],
  });
});

describe('canonical primer references', () => {
  it.each([entity.id, primer.id])(
    'resolves %s without assuming Registry and library IDs are equal',
    async (id) => {
      const result = await resolveCanonicalPrimerReference({ id }, folders);
      expect(result).toMatchObject({
        entityId: entity.id,
        registryEntityId: entity.id,
        primerId: primer.id,
        locator: `entity://primer/${entity.id}`,
        workspaceRoot: ROOT,
        deepLinkParams: null,
        localOnly: false,
        data: { registryEntityId: entity.id, primerId: primer.id },
      });
      expect(result.data).not.toHaveProperty('targetDocumentId');
    }
  );

  it('takes attachment coordinates from the saved artifact', async () => {
    const result = await resolveCanonicalPrimerReference(
      { id: entity.id, bindingId: 'saved-binding', bindingStart: 101, bindingEnd: 116 },
      folders
    );
    expect(result.deepLinkParams).toEqual({ bindingStart: 101, bindingEnd: 116 });
    expect(result.data).toMatchObject({
      bindingId: 'saved-binding',
      targetDocumentId: 'sequence-document',
    });
  });

  it.each([
    { bindingId: 'invented-binding' },
    { bindingId: 'saved-binding', bindingStart: 100 },
    { documentId: 'other-sequence' },
  ])('refuses an attachment assertion that disagrees with saved state: %j', async (assertion) => {
    await expect(
      resolveCanonicalPrimerReference({ id: entity.id, ...assertion }, folders)
    ).rejects.toThrow(/attachment/);
  });

  it.each([{ kind: 'protein' }, { archivedAt: 2 }, { tombstone: true }])(
    'refuses an unavailable or wrong-kind Registry entity: %j',
    async (change) => {
      mocks.getLimsEntity.mockResolvedValue({ ...entity, ...change });
      await expect(resolveCanonicalPrimerReference({ id: entity.id }, folders)).rejects.toThrow(
        /active canonical/
      );
      expect(mocks.readArtifact).not.toHaveBeenCalled();
    }
  );

  it('refuses a nonexistent canonical entity', async () => {
    await expect(resolveCanonicalPrimerReference({ id: 'invented' }, folders)).rejects.toThrow(
      /existing canonical/
    );
  });

  it('refuses a contradictory artifact Registry identity', async () => {
    const read = await mocks.readArtifact();
    read.artifact.registry.entityId = 'other-oligo';
    await expect(resolveCanonicalPrimerReference({ id: entity.id }, folders)).rejects.toThrow(
      /identity disagree/
    );
  });

  it('preserves installation-local standalone Registry oligos without inventing an owner', async () => {
    mocks.getLimsEntity.mockResolvedValue({ ...entity, workspaceId: null });
    mocks.inverse.mockResolvedValue([]);
    expect(await resolveCanonicalPrimerReference({ id: entity.id }, folders)).toMatchObject({
      registryEntityId: entity.id,
      primerId: null,
      workspaceRoot: null,
      localOnly: true,
      data: { registryEntityId: entity.id, localOnly: true },
      deepLinkParams: null,
    });
    await expect(
      resolveCanonicalPrimerReference({ id: entity.id, bindingId: 'invented' }, folders)
    ).rejects.toThrow(/owning the primer attachment/);
  });

  it('retains the durable provenance project of a database-only canonical oligo', async () => {
    mocks.inverse.mockResolvedValue([]);
    expect(await resolveCanonicalPrimerReference({ id: entity.id }, folders)).toMatchObject({
      registryEntityId: entity.id,
      primerId: null,
      workspaceRoot: ROOT,
      localOnly: true,
      data: { registryEntityId: entity.id, localOnly: true },
      deepLinkParams: null,
    });
    expect(mocks.workspaceRootById).toHaveBeenCalledWith(entity.workspaceId);
  });

  it('refuses the wrong owning project', async () => {
    const other = { name: 'Other', path: '/workspace/other', addedAt: 1 };
    await expect(
      resolveCanonicalPrimerReference({ id: entity.id, workspace: other.path }, [...folders, other])
    ).rejects.toThrow(/selected project/);
  });
});

it('retains the distinct source project in a canonical binding reference', async () => {
  const read = await mocks.readArtifact();
  const binding = read.artifact.bindings[0];
  binding.target.projectId = 'source-project';
  read.resolvedBindings = [{ binding, sequenceId: 42 }];
  const result = await resolveCanonicalPrimerReference(
    { id: entity.id, bindingId: binding.id },
    folders
  );
  expect(result.workspaceRoot).toBe(ROOT);
  expect(result.data).toMatchObject({
    registryEntityId: entity.id,
    targetDocumentId: binding.target.documentId,
    targetProjectId: 'source-project',
  });
  read.resolvedBindings = [];
  await expect(
    resolveCanonicalPrimerReference({ id: entity.id, bindingId: binding.id }, folders)
  ).rejects.toThrow(/source project is unavailable/);
});
