import type { UserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import {
  consumeManagedSequenceNameEdit,
  acknowledgeManagedSequenceRename,
} from '../public/managed-sequence-rename';
import type { AnnotatedSequence, GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import type { SequencePresentation } from '../../../shared/sequence-presentation';
import type { SequencePackageDocument } from '../../../db/sequence-package';
import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import type { AcceptedAssemblySidecarPayload } from '../../assembly/public/accepted-types';
import { EntityDetails } from '../../entity-details/public/EntityDetails';

interface SequenceMetadataDrawerProps {
  documentRef?: ManagedSequenceDocumentRef;
  sequenceDocumentId: string;
  filePath: string;
  readOnly?: boolean;
  presentation: SequencePresentation;
  sequenceLength: number;
  sequenceTopology: 'circular' | 'linear';

  sequence: AnnotatedSequence;
  onClose: () => void;

  onDirtyChange?: (dirty: boolean) => void;
  onReloadSavedSequence?: () => Promise<void>;
  onSaved: (
    document: SequencePackageDocument,
    geneticCode: GeneticCodeSpec | null | undefined
  ) => void;

  nameEditRequestId?: number;
  metadataEditorTabId?: string;
  onReopenAssembly?: () => Promise<void>;
  assemblyReopenStatus?: 'missing' | 'checking' | 'available' | 'opening' | 'error';
  assemblyReopenError?: UserMessage | null;
  acceptedAssemblyRecord?: AcceptedAssemblySidecarPayload | null;
  onAssemblyBackboneSegmentsChange?: (segments: BackboneSegment[] | undefined) => void;
}

export function SequenceMetadataDrawer(props: SequenceMetadataDrawerProps) {
  const [nameRequest, setNameRequest] = useState<number>();
  useEffect(() => {
    if (
      props.nameEditRequestId &&
      !props.readOnly &&
      consumeManagedSequenceNameEdit(props.nameEditRequestId)
    )
      setNameRequest(props.nameEditRequestId);
  }, [props.nameEditRequestId, props.readOnly]);
  return (
    <div className="h-full min-h-0" data-testid="sequence-metadata-drawer">
      <EntityDetails
        target={{
          entityId: props.documentRef?.packageId ?? props.sequenceDocumentId,
          managedSequence: props.documentRef,
          sequenceFile: {
            documentId: props.sequenceDocumentId,
            path: props.filePath,
            name: props.presentation.name,
            sequence: props.sequence,
            readOnly: Boolean(props.readOnly),
          },
        }}
        metadataEditorTabId={props.metadataEditorTabId}
        acceptedAssemblyRecord={props.acceptedAssemblyRecord}
        assemblyReopenError={props.assemblyReopenError}
        onReopenAssembly={props.readOnly ? undefined : props.onReopenAssembly}
        assemblyReopenStatus={props.assemblyReopenStatus}
        onAssemblyBackboneSegmentsChange={props.onAssemblyBackboneSegmentsChange}
        onClose={props.onClose}
        onDirtyChange={props.onDirtyChange}
        onReloadSavedSequence={props.onReloadSavedSequence}
        nameEditRequestId={nameRequest}
        onNameEditStarted={() => {
          if (props.documentRef && nameRequest)
            acknowledgeManagedSequenceRename(props.documentRef.packageId, nameRequest);
          setNameRequest(undefined);
        }}
        onSaved={(record, fields) => {
          if (record.sequence?.document)
            props.onSaved(
              record.sequence.document,
              fields.includes('geneticCode')
                ? (record.sequence.data.chosenGeneticCode ?? null)
                : undefined
            );
        }}
      />
    </div>
  );
}
