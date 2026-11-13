import { describe, expect, it } from 'vitest';
import type { LimsRegistryPreview } from '../../shared/lims';
import { registryMetadataEditCapability } from './registry-metadata-edit-capability';

function preview(
  representation: LimsRegistryPreview['summary']['representation']
): LimsRegistryPreview {
  return {
    entity: { fields: {}, tombstone: false },
    summary: { representation, archived: false },
  } as LimsRegistryPreview;
}

describe('Registry metadata editor ownership', () => {
  it('requires the sequence metadata editor for file-backed nucleotide sequences', () => {
    expect(
      registryMetadataEditCapability(
        preview({ kind: 'file_sequence', canOpen: true, label: 'Sequence' }),
        false
      )
    ).toEqual({ kind: 'document', editor: 'sequence' });
  });
  it.each(['protein_sequence', 'track_view', 'molecular_document', 'notebook'] as const)(
    'does not advertise a metadata editor for the %s viewer',
    (kind) => {
      expect(
        registryMetadataEditCapability(preview({ kind, canOpen: true, label: kind }), false)
      ).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('metadata') });
    }
  );
  it('uses the document editor for every saved primer polymer', () => {
    for (const kind of ['oligo', 'rna_oligo']) {
      const record = preview({ kind: 'none', canOpen: false, label: kind });
      record.entity.kind = kind;
      record.entity.fields.artifact = {
        schema: 'dnaforge.primer',
        relativePath: 'primer.primer.json',
      };
      expect(registryMetadataEditCapability(record, false)).toEqual({
        kind: 'document',
        editor: 'primer',
      });
    }
  });
  it.each(['waypoint.entity.v1', 'waypoint.entity.v2'])(
    'uses the owning file writer for any schema-backed %s record',
    (schema) => {
      for (const kind of ['strain', 'custom_reagent', 'future_custom_type']) {
        const record = preview({ kind: 'none', canOpen: false, label: kind });
        record.entity.kind = kind;
        record.entity.fields.artifact = { schema, relativePath: 'record.entity.json' };
        expect(registryMetadataEditCapability(record, false)).toEqual({ kind: 'native_record' });
      }
    }
  );
  it('uses the same native metadata action for an arbitrary custom schema', () => {
    const record = preview({ kind: 'none', canOpen: false, label: 'Custom reagent' });
    record.nativeRecord = { schemaSnapshot: {} as never };
    expect(registryMetadataEditCapability(record, false)).toEqual({ kind: 'native_record' });
    expect(registryMetadataEditCapability(record, true)).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('original source'),
    });
  });
  it('explains archived and source-less records instead of silently omitting an action', () => {
    const record = preview({ kind: 'unresolved', canOpen: false, label: 'Unresolved sequence' });
    expect(registryMetadataEditCapability(record, false)).toMatchObject({
      kind: 'unavailable',
      reason: expect.any(String),
    });
    record.summary.archived = true;
    expect(registryMetadataEditCapability(record, false)).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringContaining('Restore'),
    });
  });
});
