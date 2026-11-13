import { describe, expect, it } from 'vitest';
import {
  captureNativeSourceFolderMemberships,
  addNativeSourceFolderMemberships,
} from './native-source-memberships';
import type { SourceObject, ProjectionReceipt } from '../../shared/benchling-migration';
import { NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA } from '../native-workspace-materializer';

describe('native source folder memberships', () => {
  it.each(['Other', 'Other--renamed', 'Other--renamed/Sub'])(
    'keeps both memberships and replays the physical parent %s',
    (parent) => {
      const original = parent.endsWith('/Sub') ? 'Other/Sub' : 'Other';
      const memberships = captureNativeSourceFolderMemberships('run-1', [
        'Yeast/Shared (seq_SHARED01).gb',
        `${original}/Shared (seq_SHARED01).gb`,
      ]);
      expect(memberships.map((membership) => membership.relativePath)).toEqual([original, 'Yeast']);
      const source: SourceObject = {
        id: 'seq_SHARED01',
        stableId: 'seq_SHARED01',
        sourceType: 'dna_sequence',
        name: 'Shared',
        aliases: [],
        sourceUrl: '',
        attachmentHashes: [],
        memberships: [],
        relationships: [],
        content: null,
        sourcePath: `${original}/Shared (seq_SHARED01).gb`,
        metadata: { workspaceAppend: { sourceFolderMemberships: memberships } },
      };
      const receipt: ProjectionReceipt = {
        id: 'receipt-1',
        runId: 'run-1',
        sourceObjectId: source.id,
        destinationObjectId: 'shared-entity',
        destinationPath: `${parent}/Shared.gb`,
        projection: 'native',
        converterId: 'test',
        converterVersion: '1',
        sourceHash: 'source-hash',
        destinationHash: 'destination-hash',
        warnings: [],
        exception: null,
        createdAt: '2000-01-01T00:00:00Z',
        destination: { kind: 'file', relativePath: `${parent}/Shared.gb` },
      };
      const plan = addNativeSourceFolderMemberships({
        scopeId: 'run-1',
        plan: {
          schema: NATIVE_WORKSPACE_MATERIALIZATION_SCHEMA,
          entities: [],
          links: [],
          events: [],
        },
        sourceObjects: [source],
        receipts: [receipt],
        currentManifest: {
          schema: 'dnaforge.native-workspace-manifest.v2',
          entities: [],
          links: [],
        },
      });
      expect(plan.entities.map((entity) => entity.placement)).toEqual([
        ...(original.includes('/')
          ? [{ kind: 'file', relativePath: 'Other--renamed', fileKind: 'folder' }]
          : []),
        { kind: 'file', relativePath: parent, fileKind: 'folder' },
        { kind: 'file', relativePath: 'Yeast', fileKind: 'folder' },
      ]);
      expect(plan.links).toHaveLength(original.includes('/') ? 3 : 2);
      expect(
        plan.links
          .filter((link) => link.evidence?.kind === 'folder_membership')
          .every((link) => link.targetRawId === 'shared-entity' && link.relation === 'contains')
      ).toBe(true);
      const repeated = addNativeSourceFolderMemberships({
        scopeId: 'run-1',
        plan: { ...plan, entities: [], links: [] },
        sourceObjects: [source],
        receipts: [receipt],
        currentManifest: {
          schema: 'dnaforge.native-workspace-manifest.v2',
          entities: [
            ...plan.entities.map((entity) => ({
              id: entity.rawId,
              type: entity.type,
              name: entity.name,
              placement: entity.placement!,
              metadata: entity.metadata ?? undefined,
            })),
            {
              id: 'shared-entity',
              type: 'sequence',
              name: 'Shared',
              placement: { kind: 'file', relativePath: `${parent}/Shared.gb`, fileKind: 'genbank' },
            },
          ],
          links: plan.links.map((link) => ({
            sourceId: link.sourceRawId,
            targetId: link.targetRawId,
            relation: link.relation,
          })),
        },
      });
      expect(repeated.entities).toEqual([]);
      expect(repeated.links).toEqual([]);
    }
  );
});
