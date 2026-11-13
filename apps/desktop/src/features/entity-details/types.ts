import type { UserMessage } from '@waypoint/user-messages';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../shared/entity-schema';
import type {
  LimsEntityHistoryEntry,
  LimsRegistryPreview,
  LimsRegistrationStatus,
} from '../../shared/lims';
import type { ManagedSequenceDocumentRef } from '../../shared/managed-sequence-document';
import type { SequencePackageDocument } from '../../db/sequence-package';
import type { SavedRecordMetadataRecovery } from '../lims/public/registry-metadata-edit';

export interface EntityDetailsTarget {
  entityId: string;
  recordFile?: boolean;
  managedSequence?: ManagedSequenceDocumentRef;
  sequenceFile?: {
    documentId?: string;
    path: string;
    name: string;
    sequence: AnnotatedSequence;
    readOnly: boolean;
  };
}

export interface OligoDetailsValues {
  kind: 'oligo';
  notation: string;
  orderType: 'dna' | 'rna';
}

export interface EntityDetailsValues {
  scientific?: OligoDetailsValues;
  name: string;
  fields: Record<string, unknown>;
  schema: ProjectableEntitySchemaRevisionSnapshot;
  refreshGeneticCodeRevision: boolean;
}

export interface EntityDetailsRecord extends EntityDetailsValues {
  id: string;
  registryId: string | null;
  registrationStatus: LimsRegistrationStatus;
  path?: string;
  readOnlyReason?: UserMessage;
  lifecycleReadOnlyReason?: UserMessage | null;
  properties: Record<string, unknown>;
  preview: LimsRegistryPreview | null;
  sequence?: {
    ref?: ManagedSequenceDocumentRef;
    document?: SequencePackageDocument;
    data: AnnotatedSequence;
  };
}

export interface EntityDetailsDefinition {
  record: EntityDetailsRecord;
  pendingCompletion?: () => Promise<void>;
  savedRecord?: SavedRecordMetadataRecovery;
  archivedSequenceOrganization?: {
    ref: ManagedSequenceDocumentRef;
    readOnly: boolean;
  };
  sequenceRegistration?: {
    documentId: string;
    sourcePath: string;
    topology: 'circular' | 'linear';
    length: number;
  };
  canEditName?: boolean;
  readOnlyFields?: readonly string[];
  editableIntrinsics?: readonly string[];
  validate?: (update: EntityDetailsValues) => string | null;
  save?: (update: EntityDetailsValues) => Promise<void>;
  rename?: (name: string) => Promise<void>;
  schemaChoices?: () => Promise<ProjectableEntitySchemaRevisionSnapshot[]>;
}

export interface EntityDetailsPorts {
  load: (target: EntityDetailsTarget) => Promise<EntityDetailsDefinition>;
  history: (entityId: string) => Promise<LimsEntityHistoryEntry[]>;
  changed: (entityId: string) => void;
}
