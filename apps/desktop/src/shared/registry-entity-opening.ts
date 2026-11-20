import { entityKindLabel } from '@waypoint/scientific-artifacts/shared/entity-types';
import type {
  AminoAcidSequenceRef,
  DnaSequenceRef,
  FileDnaSequenceRef,
  LimsEntity,
  LimsRegistryOpenTarget,
  LimsRegistrySummary,
  ProteinSequenceRef,
} from './lims';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from './managed-sequence-document';
import { isSafeWorkspaceRelativePath } from './path-boundary';
import { PRIMER_ARTIFACT_SCHEMA } from './primer-artifact-schema';
import {
  ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA,
  ENTITY_RECORD_ARTIFACT_SUFFIX,
} from './registry-file-types';

type RegistryOpeningEntity = Pick<
  LimsEntity,
  'id' | 'kind' | 'name' | 'fields' | 'registrationStatus' | 'workspaceId'
>;

export function registryRepresentationForEntity(
  entity: RegistryOpeningEntity,
  sequence: DnaSequenceRef | undefined = entity.fields.sequence as DnaSequenceRef | undefined
): LimsRegistrySummary['representation'] & { openTarget: LimsRegistryOpenTarget } {
  if (entity.kind === 'molecular-document') {
    return {
      kind: 'molecular_document',
      label: entityKindLabel('molecular-document'),
      canOpen: true,
      openTarget: {
        kind: 'molecular_document',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
      },
    };
  }
  if (entity.kind === 'track-view') {
    return {
      kind: 'track_view',
      label: 'Saved Track view',
      canOpen: true,
      openTarget: {
        kind: 'track_view',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
      },
    };
  }
  const artifact = entity.fields.artifact as
    | { schema?: unknown; relativePath?: unknown }
    | undefined;
  if (
    artifact?.schema === PRIMER_ARTIFACT_SCHEMA &&
    typeof artifact.relativePath === 'string' &&
    isSafeWorkspaceRelativePath(artifact.relativePath)
  ) {
    return {
      kind: 'primer',
      label: 'Saved oligo',
      canOpen: true,
      openTarget: {
        kind: 'primer',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        workspaceId: entity.workspaceId,
        artifactRelativePath: artifact.relativePath,
      },
    };
  }
  const managedSequence = readManagedSequenceDocumentRef(
    entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
  );
  if (managedSequence) {
    return {
      kind: 'file_sequence',
      label: 'Managed DNA sequence',
      canOpen: true,
      openTarget: {
        kind: 'managed_sequence',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        registrationStatus: entity.registrationStatus,
        document: managedSequence,
      },
    };
  }

  if (entity.kind === 'protein') {
    const proteinSequence = entity.fields.sequence as
      | AminoAcidSequenceRef
      | ProteinSequenceRef
      | undefined;
    if (proteinSequence?.mode === 'file') {
      return {
        kind: 'protein_sequence',
        label: 'Protein sequence',
        canOpen: true,
        openTarget: {
          kind: 'protein_sequence',
          entityId: entity.id,
          entityKind: entity.kind,
          label: entity.name,
          filePath: proteinSequence.relPath,
          registrationStatus: entity.registrationStatus,
        },
      };
    }
    if (proteinSequence?.mode === 'inline') {
      return {
        kind: 'protein_sequence',
        label: 'Protein sequence',
        canOpen: true,
        openTarget: {
          kind: 'protein_sequence',
          entityId: entity.id,
          entityKind: entity.kind,
          label: entity.name,
          registrationStatus: entity.registrationStatus,
        },
      };
    }
    return {
      kind: 'unresolved',
      label: 'Unresolved protein sequence',
      canOpen: false,
      openTarget: recordDetailOpenTarget(entity, 'unresolved_sequence'),
    };
  }
  if (sequence?.mode === 'file') {
    if (typeof sequence.documentId !== 'string' || !sequence.documentId.trim()) {
      return {
        kind: 'unresolved',
        label: 'Sequence identity needs repair',
        canOpen: false,
        openTarget: recordDetailOpenTarget(entity, 'unresolved_sequence'),
      };
    }
    const topologyLabel = sequence.topology === 'circular' ? 'Circular' : 'Linear';

    const label =
      entity.kind === 'chromosome'
        ? `${topologyLabel} chromosome`
        : `${topologyLabel} DNA sequence`;
    return {
      kind: 'file_sequence',
      label,
      canOpen: true,
      openTarget: sequenceFileOpenTarget(entity, sequence),
    };
  }
  if (
    entity.kind === 'notebook' &&
    typeof entity.fields.packagePath === 'string' &&
    entity.fields.packagePath.trim()
  ) {
    const packagePath = entity.fields.packagePath;
    return {
      kind: 'notebook',
      label: 'Notebook entry',
      canOpen: true,
      openTarget: {
        kind: 'notebook',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        filePath: packagePath,
      },
    };
  }
  if (
    artifact?.schema === ENTITY_RECORD_ARTIFACT_CURRENT_SCHEMA &&
    typeof artifact.relativePath === 'string' &&
    artifact.relativePath.toLowerCase().endsWith(ENTITY_RECORD_ARTIFACT_SUFFIX) &&
    isSafeWorkspaceRelativePath(artifact.relativePath) &&
    entity.workspaceId !== null
  ) {
    return {
      kind: 'record_file',
      label: 'Saved record',
      canOpen: true,
      openTarget: {
        kind: 'record_file',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        workspaceId: entity.workspaceId,
        artifactRelativePath: artifact.relativePath,
      },
    };
  }

  if (entity.kind === 'genome' && (!sequence || sequence.mode === 'unresolved')) {
    return {
      kind: 'genome_assembly',
      label: 'Assembly',
      canOpen: false,
      openTarget: recordDetailOpenTarget(entity, 'unresolved_sequence'),
    };
  }
  if (sequence?.mode === 'inline') {
    return {
      kind: 'inline_sequence',
      label: entity.kind === 'oligo' ? 'Oligo sequence' : 'Stored sequence',
      canOpen: false,
      openTarget: {
        kind: 'record_detail',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        reason: 'inline_sequence',
        inlineSequence: {
          length: sequence.length,
          topology: sequence.topology,
          contentHash: sequence.contentHash,
        },
      },
    };
  }
  if (sequence?.mode === 'unresolved') {
    return {
      kind: 'unresolved',
      label:
        entity.kind === 'chromosome'
          ? 'Chromosome (no sequence file)'
          : entity.kind === 'dna_sequence'
            ? 'Needs sequence'
            : 'Unresolved sequence',
      canOpen: false,
      openTarget: recordDetailOpenTarget(entity, 'unresolved_sequence'),
    };
  }
  if (entity.kind === 'strain') {
    return {
      kind: 'strain_evidence',
      label: 'Strain evidence',
      canOpen: false,
      openTarget: recordDetailOpenTarget(entity, 'strain_evidence'),
    };
  }
  if (entity.kind === 'organism') {
    return {
      kind: 'organism_record',
      label: 'Organism record',
      canOpen: false,
      openTarget: recordDetailOpenTarget(entity, 'organism_record'),
    };
  }
  return {
    kind: 'none',
    label: 'Record metadata',
    canOpen: false,
    openTarget: recordDetailOpenTarget(entity, 'no_primary_representation'),
  };
}

export function sequenceFileOpenTarget(
  entity: RegistryOpeningEntity,
  sequence: FileDnaSequenceRef
): LimsRegistryOpenTarget {
  if (typeof sequence.documentId !== 'string' || !sequence.documentId.trim())
    return recordDetailOpenTarget(entity, 'unresolved_sequence');
  return {
    kind: 'sequence_file',
    entityId: entity.id,
    entityKind: entity.kind,
    label: entity.name,
    documentId: sequence.documentId,
    registrationStatus: entity.registrationStatus,
    sequence: {
      topology: sequence.topology,
      length: sequence.length,
      contentHash: sequence.contentHash,
      fileContentHash: sequence.fileContentHash,
      normalizedSequenceHash: sequence.normalizedSequenceHash,
      sourceFormat: sequence.sourceFormat,
      sequenceId: sequence.sequenceId,
      sizeBytes: sequence.sizeBytes,
      modifiedAt: sequence.modifiedAt,
    },
    source: typeof entity.fields.source === 'string' ? entity.fields.source : undefined,
  };
}

export function recordDetailOpenTarget(
  entity: RegistryOpeningEntity,
  reason: Extract<LimsRegistryOpenTarget, { kind: 'record_detail' }>['reason']
): LimsRegistryOpenTarget {
  return {
    kind: 'record_detail',
    entityId: entity.id,
    entityKind: entity.kind,
    label: entity.name,
    reason,
  };
}
