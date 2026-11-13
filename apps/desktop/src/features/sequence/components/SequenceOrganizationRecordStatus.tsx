import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import type { SequencePackageDocument } from '../../../db/sequence-package';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../../shared/entity-schema';
import type { OrganizationRegistrySavedRecordResolutionRequest } from '../../../shared/org-registry-sync';
import {
  assertWorkspaceEditorsSettled,
  freezeWorkspaceEditorWrites,
} from '../../../services/workspace-editor-mutation-state';
import {
  SavedRecordOrganizationStatus,
  useOrganizationRecordSync,
} from '../../lims/public/organization-record-status';
import { managedSequenceRepository } from '../managed-sequence-repository';
import { useSequenceStore } from '../store';

export function SequenceOrganizationRecordStatus({
  documentRef,
  document,
  archivedSchema,
  dirty,
  readOnly,
  saving,
  onApplied,
  onBlockedChange,
}: {
  documentRef: ManagedSequenceDocumentRef;
  document: SequencePackageDocument | null;
  archivedSchema?: ProjectableEntitySchemaRevisionSnapshot;
  dirty: boolean;
  readOnly: boolean;
  saving: boolean;
  onApplied: (document: SequencePackageDocument) => Promise<void>;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const sync = useOrganizationRecordSync(documentRef.packageId);
  const sequenceDirty = useSequenceStore(
    (store) => store.dirtyPaths[documentRef.packageId] === true
  );
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const applyingRef = useRef(false);
  const epoch = useRef(0);
  const context = useRef({ documentRef, dirty, readOnly });
  context.current = { documentRef, dirty, readOnly };
  useEffect(() => {
    epoch.current++;
    applyingRef.current = false;
    setApplying(false);
    setError(null);
    return () => {
      epoch.current++;
    };
  }, [documentRef.packageId, documentRef.packageRoot]);
  useEffect(() => {
    onBlockedChange(applying || sync.resolving || Boolean(sync.pendingResolution));
  }, [applying, sync.resolving, sync.pendingResolution, onBlockedChange]);
  useEffect(() => () => onBlockedChange(false), [onBlockedChange]);
  const blocked =
    applying ||
    sync.resolving ||
    sync.busy ||
    dirty ||
    sequenceDirty ||
    saving ||
    readOnly ||
    (!document && !archivedSchema && !sync.pendingResolution);
  const resolve = async (choice?: OrganizationRegistrySavedRecordResolutionRequest['choice']) => {
    if (blocked || applyingRef.current) return;
    const captured = documentRef,
      requestEpoch = epoch.current;
    const scope = { workspaceRoot: captured.packageRoot, affectedEntityIds: [captured.packageId] };
    const isCurrent = () =>
      requestEpoch === epoch.current &&
      context.current.documentRef.packageId === captured.packageId &&
      context.current.documentRef.packageRoot === captured.packageRoot &&
      !context.current.dirty &&
      !context.current.readOnly &&
      !useSequenceStore.getState().isDirty(captured.packageId);
    let release: (() => void) | undefined;
    try {
      assertWorkspaceEditorsSettled(scope);
      release = freezeWorkspaceEditorWrites(scope);
      applyingRef.current = true;
      setApplying(true);
      setError(null);
      const result = await sync.resolve(choice);
      if (!result || !result.isCurrent() || !isCurrent()) return;
      const saved = await managedSequenceRepository.resolve(captured);
      if (!result.isCurrent() || !isCurrent()) return;
      if (
        result.entity.id !== captured.packageId ||
        saved.document.id !== captured.packageId ||
        saved.ref.packageId !== captured.packageId
      )
        throw new Error('The approved sequence identity changed before it could be reopened.');
      await onApplied(saved.document);
      if (!result.isCurrent() || !isCurrent()) return;
      sync.finishResolution(result.request);
      void sync.synchronize();
    } catch (cause) {
      if (requestEpoch === epoch.current)
        setError(toUserMessage(cause, 'failure.the-approved-sequence-could-not-be-reopened'));
    } finally {
      release?.();
      if (requestEpoch === epoch.current) {
        applyingRef.current = false;
        setApplying(false);
      }
    }
  };
  return (
    <>
      <SavedRecordOrganizationStatus
        organizationSync={sync}
        schema={document?.entity.schema ?? archivedSchema}
        testIdPrefix="sequence"
        resolutionBlocked={blocked}
        applyingResolution={applying}
        saving={saving}
        hasDraft={dirty || sequenceDirty}
        resolutionAccessMessage={
          readOnly
            ? 'The sequence home project must be available and writable before applying this change.'
            : null
        }
        resolveOrganizationVersion={resolve}
      />
      {error ? (
        <p role="alert" className="p-3 text-sm text-error">
          {toUserMessage(error, 'tracks.loadFailed')}
        </p>
      ) : null}
    </>
  );
}
