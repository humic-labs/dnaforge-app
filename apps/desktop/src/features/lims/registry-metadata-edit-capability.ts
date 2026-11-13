import type { LimsRegistryPreview, LimsRegistryRepresentationKind } from '../../shared/lims';
import { PRIMER_ARTIFACT_SCHEMA } from '@waypoint/scientific-artifacts/shared/primers/primer-artifact';
import { isEntityRecordArtifactProjection } from '../../shared/registry-file-types';
import type { MetadataEditorTabType } from '../canvas/public/types';

const REPRESENTATION_EDITORS = {
  record_file: null,
  primer: 'primer',
  file_sequence: 'sequence',
  protein_sequence: null,
  track_view: null,
  molecular_document: null,
  inline_sequence: null,
  genome_assembly: null,
  strain_evidence: null,
  organism_record: null,
  notebook: null,
  unresolved: null,
  none: null,
} as const satisfies Record<LimsRegistryRepresentationKind, MetadataEditorTabType | null>;

export type RegistryMetadataEditCapability =
  | { kind: 'native_record' }
  | { kind: 'document'; editor: MetadataEditorTabType }
  | { kind: 'unavailable'; reason: string };

export function registryMetadataEditCapability(
  preview: LimsRegistryPreview,
  hasOriginalSource: boolean
): RegistryMetadataEditCapability {
  if (preview.summary.archived || preview.entity.tombstone)
    return { kind: 'unavailable', reason: 'Restore this record before editing it.' };
  if (hasOriginalSource)
    return {
      kind: 'unavailable',
      reason:
        'This imported record preserves its original source. View original source to inspect it.',
    };
  if (preview.nativeRecord || isEntityRecordArtifactProjection(preview.entity.fields))
    return { kind: 'native_record' };
  const artifact = preview.entity.fields.artifact;
  if (
    artifact !== null &&
    typeof artifact === 'object' &&
    'schema' in artifact &&
    artifact.schema === PRIMER_ARTIFACT_SCHEMA
  )
    return { kind: 'document', editor: 'primer' };
  const editor = REPRESENTATION_EDITORS[preview.summary.representation.kind];
  if (editor) return { kind: 'document', editor };
  return {
    kind: 'unavailable',
    reason: 'This record has no metadata editor. Its saved metadata remains available here.',
  };
}
