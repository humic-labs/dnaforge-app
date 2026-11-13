// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  workspaces,
  indexedFiles,
  sequences,
  catalogEntities,
  catalogEntityFiles,
  catalogEntityLinks,
  workspaceSyncBindings,
  workspaceSyncDevice,
  workspaceSyncQueue,
  workspaceSyncRestoreLocks,
  workspaceSyncVersions,
  type Workspace,
  type IndexedFile,
  type Sequence,
  type CatalogEntity,
  type CatalogEntityFile,
  type CatalogEntityLink,
} from './schema';

describe('Database Schema', () => {
  describe('workspaces table', () => {
    it('has correct column names', () => {
      const columns = Object.keys(workspaces);
      expect(columns).toContain('id');
      expect(columns).toContain('name');
      expect(columns).toContain('path');
      expect(columns).toContain('createdAt');
      expect(columns).toContain('lastOpenedAt');
    });

    it('serializes every project lifecycle date in milliseconds', () => {
      const timestamp = 1_787_000_000_123;
      const date = new Date(timestamp);

      expect(workspaces.createdAt.mapToDriverValue(date)).toBe(timestamp);
      expect(workspaces.lastOpenedAt.mapToDriverValue(date)).toBe(timestamp);
      expect(workspaces.archivedAt.mapToDriverValue(date)).toBe(timestamp);
      expect(workspaces.trashedAt.mapToDriverValue(date)).toBe(timestamp);
    });
  });

  describe('workspace sync tables', () => {
    it('has local sync device, binding, queue, version, and restore-lock columns', () => {
      expect(Object.keys(workspaceSyncDevice)).toEqual(
        expect.arrayContaining(['id', 'deviceId', 'createdAt', 'updatedAt'])
      );
      expect(Object.keys(workspaceSyncBindings)).toEqual(
        expect.arrayContaining([
          'workspaceId',
          'workspaceUuid',
          'ownerAccountId',
          'ownerOrgId',
          'remoteWorkspaceId',
          'enabled',
          'remoteLatestVersionId',
          'remoteLatestVersionNumber',
          'remoteLatestContentSha256',
          'lastAckedLocalHeadSha',
        ])
      );
      expect(Object.keys(workspaceSyncQueue)).toEqual(
        expect.arrayContaining([
          'id',
          'workspaceId',
          'operation',
          'status',
          'idempotencyKey',
          'localHeadSha',
          'bundleContentSha256',
          'attemptCount',
        ])
      );
      expect(Object.keys(workspaceSyncVersions)).toEqual(
        expect.arrayContaining([
          'id',
          'workspaceId',
          'remoteVersionId',
          'versionNumber',
          'contentSha256',
          'fileCount',
          'sizeBytes',
          'status',
          'isLatest',
        ])
      );
      expect(Object.keys(workspaceSyncRestoreLocks)).toEqual(
        expect.arrayContaining([
          'workspaceId',
          'lockId',
          'sourceRemoteVersionId',
          'status',
          'startedAt',
          'expiresAt',
        ])
      );
    });
  });

  describe('indexedFiles table', () => {
    it('has correct column names', () => {
      const columns = Object.keys(indexedFiles);
      expect(columns).toContain('id');
      expect(columns).toContain('workspaceId');
      expect(columns).toContain('path');
      expect(columns).toContain('name');
      expect(columns).toContain('extension');
    });
  });

  describe('sequences table', () => {
    it('has correct column names', () => {
      const columns = Object.keys(sequences);
      expect(columns).toContain('id');
      expect(columns).toContain('fileId');
      expect(columns).toContain('name');
      expect(columns).toContain('length');
      expect(columns).toContain('sequenceType');
    });
  });

  describe('catalog tables', () => {
    it('has catalog entity columns', () => {
      const columns = Object.keys(catalogEntities);
      expect(columns).toContain('id');
      expect(columns).toContain('type');
      expect(columns).toContain('name');
      expect(columns).toContain('locator');
      expect(columns).toContain('storageType');
      expect(columns).toContain('workspaceId');
      expect(columns).toContain('metadata');
    });

    it('has catalog file binding columns', () => {
      const columns = Object.keys(catalogEntityFiles);
      expect(columns).toContain('id');
      expect(columns).toContain('entityId');
      expect(columns).toContain('path');
      expect(columns).toContain('relativePath');
      expect(columns).toContain('fileKind');
    });

    it('has catalog link columns', () => {
      const columns = Object.keys(catalogEntityLinks);
      expect(columns).toContain('id');
      expect(columns).toContain('sourceEntityId');
      expect(columns).toContain('relation');
      expect(columns).toContain('targetEntityId');
      expect(columns).toContain('confidence');
    });
  });

  describe('type exports', () => {
    it('exports Workspace type', () => {
      const workspace: Workspace = {
        id: 1,
        name: 'Test',
        path: '/test',
        createdAt: new Date(),
        lastOpenedAt: null,
      };
      expect(workspace.id).toBe(1);
    });

    it('exports IndexedFile type', () => {
      const file: IndexedFile = {
        id: 1,
        workspaceId: 1,
        path: '/test/file.gb',
        name: 'file.gb',
        extension: 'gb',
        sizeBytes: 1000,
        modifiedAt: new Date(),
        indexedAt: new Date(),
        metadata: null,
      };
      expect(file.id).toBe(1);
    });

    it('exports Sequence type', () => {
      const seq: Sequence = {
        id: 1,
        fileId: 1,
        name: 'pUC19',
        description: 'Cloning vector',
        length: 2686,
        sequenceType: 'dna',
        circular: true,
        sequence: 'ATGC...',
      };
      expect(seq.id).toBe(1);
    });

    it('exports catalog types', () => {
      const entity: CatalogEntity = {
        id: 'entity-1',
        type: 'sequence',
        name: 'pUC19',
        locator: 'file:///lab/pUC19.gb',
        storageType: 'file',
        status: 'active',
        workspaceId: 1,
        metadata: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const file: CatalogEntityFile = {
        id: 'file-1',
        entityId: entity.id,
        workspaceId: 1,
        path: '/lab/pUC19.gb',
        relativePath: 'pUC19.gb',
        fileKind: 'genbank',
        contentHash: null,
        sizeBytes: null,
        modifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const link: CatalogEntityLink = {
        id: 'link-1',
        sourceEntityId: entity.id,
        relation: 'uses_reference',
        targetEntityId: 'entity-2',
        confidence: 'suggested',
        evidence: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      expect(file.entityId).toBe(entity.id);
      expect(link.sourceEntityId).toBe(entity.id);
    });
  });
});
