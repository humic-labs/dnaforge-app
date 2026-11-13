import { describe, expect, it, vi } from 'vitest';
import { PARSER_DISPATCH_LIMITS } from '@waypoint/sequence-utils';
import { BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT } from '../../shared/sequence-entity-schema';
import type { LimsRegistryPreview } from '../../shared/lims';
import { loadEntityDetails } from './factory';
import { managedSequenceRepository } from '../sequence/public/managed-sequence-repository';

const mocks = vi.hoisted(() => ({
  preview: null as LimsRegistryPreview | null,
  read: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('../../platform', () => ({
  platform: () => ({ fs: { readTextFile: mocks.read, stat: mocks.stat } }),
}));
vi.mock('../lims/public/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lims/public/operations')>()),
  getLimsRegistryPreview: async () => mocks.preview,
  getLimsSchemas: async () => [],
}));

describe('file metadata ownership', () => {
  it('loads an archived accepted package without resolving its removed files', async () => {
    const id = 'archived-accepted-package';
    mocks.preview = {
      entity: { id, name: 'Archived assembly', fields: {}, registrationStatus: 'registered' },
      schemaSnapshot: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
      acceptedScientificOwner: true,
      summary: {
        archived: true,
        fieldValues: { topology: 'circular', size: 840 },
        representation: {
          openTarget: {
            kind: 'managed_sequence',
            document: {
              kind: 'managed-sequence',
              packageId: id,
              packageRoot: '/project/removed-assembly',
            },
          },
        },
      },
    } as LimsRegistryPreview;
    const resolve = vi
      .spyOn(managedSequenceRepository, 'resolve')
      .mockRejectedValue(new Error('The archived package files are absent.'));
    try {
      const definition = await loadEntityDetails({ entityId: id });
      expect(definition.record.name).toBe('Archived assembly');
      expect(definition.record.preview).toBe(mocks.preview);
      expect(definition.record.readOnlyReason).toBe('Restore this record before editing it.');
      expect(definition.save).toBeUndefined();
      expect(definition.rename).toBeUndefined();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      resolve.mockRestore();
    }
  });

  it.each(['chromosome.gb', 'original.dna', 'reference.fa'])(
    'reads %s metadata without loading scientific source bytes',
    async (path) => {
      mocks.read.mockReset();
      mocks.stat.mockReset();
      const id = `file:${path}`;
      mocks.preview = {
        entity: { id, name: path, fields: {}, registrationStatus: 'tracked' },
        schemaSnapshot: BUILTIN_SEQUENCE_SCHEMA_SNAPSHOT,
        summary: {
          fieldValues: { topology: 'linear', size: 50_000_000 },
          representation: {
            openTarget: {
              kind: 'sequence_file',
              documentId: id,
              sequence: {
                length: 50_000_000,
                topology: 'linear',
                sizeBytes: PARSER_DISPATCH_LIMITS.genbankIndexedBytes,
              },
            },
          },
        },
      } as LimsRegistryPreview;
      const definition = await loadEntityDetails({
        entityId: id,
        sequenceFile: {
          documentId: id,
          path: `/project/${path}`,
          name: path,
          readOnly: false,
          sequence: { id, name: path, sequence: '', length: 50_000_000, annotations: [] },
        },
      });
      expect(definition.record.readOnlyReason).toContain('read-only');
      expect(definition.record.properties.size).toBe(50_000_000);
      expect(definition.save).toBeUndefined();
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.stat).not.toHaveBeenCalled();
    }
  );
});
