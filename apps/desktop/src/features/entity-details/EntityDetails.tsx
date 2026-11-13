import {
  userMessageWithValues,
  userEntityLabel,
  type UserMessage,
  toOptionalUserMessage,
  toUserMessage,
} from '@waypoint/user-messages';

import type { BackboneSegment } from '@waypoint/plasmid-viewer';
import { EntityAssemblyHistory } from './EntityAssemblyHistory';
import type { AcceptedAssemblySidecarPayload } from '../assembly/public/accepted-types';
import { useMetadataEditRequest } from '../canvas/public/use-metadata-edit-request';
import { useEffect, useRef, useState } from 'react';
import type { ExternalProviderSourceRequest } from '../../shared/benchling-migration-raw-source';
import type { LimsRegistrySummary, LimsPendingRef } from '../../shared/lims';
import { requestRegistryOpen } from '../../shared/registry-events';
import type { TabViewState } from '../canvas/public/types';
import { openLimsEntity } from '../lims/public/open-entity';
import {
  archiveLimsEntity,
  restoreLimsEntity,
  revertLimsEntity,
  confirmLimsPendingRef,
  rejectLimsPendingRefCandidate,
  dismissLimsPendingRef,
} from '../lims/public/operations';
import {
  OriginalProviderSourceDialog,
  RegistryHistoryTimeline,
} from '../lims/public/details-presenters';
import { useActionablePendingRefs } from '../lims/public/use-actionable-pending-refs';
import { useProjectEditFolders } from '../workspace-loader/public/use-project-edit-folders';
import { EntityDetailsPanel } from './EntityDetailsPanel';
import { SequenceOrganizationRecordStatus } from '../sequence/public/organization-record-status';
import { SavedRecordMetadataContext } from '../lims/public/saved-record-metadata-context';
import { EntityDetailsRelated } from './EntityDetailsRelated';
import { useEntityDetailsSession } from './session-cache';
import { peekEntityDetailsSession } from './session-cache';
import { resolveEntityRegistryReference } from '../../services/entity-registry-reference';
import { subscribeLimsRegistrationChanged } from '../lims/public/events';
import { SequenceRegistrationSection } from '../lims/public/registration-badge';
import { Notice } from '../../components/ui';
import type { EntityDetailsTarget, EntityDetailsRecord } from './types';

export interface EntityDetailsProps {
  target: EntityDetailsTarget;
  host?: 'metadata' | 'registry';
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onClassificationApplied?: () => Promise<void>;
  onSaved?: (record: EntityDetailsRecord, fields: readonly string[]) => void;
  onReloadSavedSequence?: () => Promise<void>;
  mutationBlock?: string | null;
  readOnly?: boolean;
  tabId?: string;
  nameEditRequestId?: number;
  metadataEditorTabId?: string;
  acceptedAssemblyRecord?: AcceptedAssemblySidecarPayload | null;
  assemblyReopenError?: UserMessage | null;
  onNameEditStarted?: () => void;
  onReopenAssembly?: () => Promise<void>;
  assemblyReopenStatus?: string;
  onAssemblyBackboneSegmentsChange?: (segments: BackboneSegment[] | undefined) => void;
  onOpenEntity?: (summary: LimsRegistrySummary, focus?: TabViewState) => void;
  onViewOriginalSource?: (dialog: {
    request: ExternalProviderSourceRequest;
    label: string;
  }) => void;
}

export function EntityDetails(props: EntityDetailsProps) {
  return props.target.sequenceFile && !props.target.managedSequence ? (
    <FileEntityDetails {...props} />
  ) : (
    <BoundEntityDetails {...props} />
  );
}

function FileEntityDetails(props: EntityDetailsProps) {
  const [target, setTarget] = useState<EntityDetailsTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingTarget = useRef<EntityDetailsTarget | null>(null);
  const currentTarget = useRef(target);
  currentTarget.current = target;
  const latest = useRef(props);
  latest.current = props;
  const documentId = props.target.sequenceFile?.documentId ?? props.target.entityId;
  const path = props.target.sequenceFile?.path;
  useEffect(() => {
    let active = true;
    let request = 0;
    const resolve = async () => {
      const id = ++request;
      try {
        const entity = await resolveEntityRegistryReference({ kind: 'sequence', documentId }, true);
        if (!active || request !== id) return;
        const next = { ...latest.current.target, entityId: entity?.id ?? documentId };
        const current = currentTarget.current;
        const session = current ? peekEntityDetailsSession(current.entityId) : null;
        if (
          current &&
          current.entityId !== next.entityId &&
          (session?.dirty || session?.getSnapshot().saving)
        )
          pendingTarget.current = next;
        else setTarget(next);
        setError(null);
      } catch (cause) {
        if (active && request === id)
          setError(toUserMessage(cause, 'failure.the-sequence-registration-could-not-be-resolved'));
      }
    };
    void resolve();
    const unsubscribe = subscribeLimsRegistrationChanged(() => void resolve());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [documentId, path]);
  if (!target)
    return (
      <section className="h-full bg-bg p-3 text-xs text-fg-muted">
        {error ? (
          <Notice tone="error">{toUserMessage(error, 'operation.failed')}</Notice>
        ) : (
          'Loading metadata…'
        )}
      </section>
    );
  return (
    <BoundEntityDetails
      {...props}
      target={target}
      onDirtyChange={(dirty) => {
        props.onDirtyChange?.(dirty);
        if (!dirty && pendingTarget.current) {
          const next = pendingTarget.current;
          pendingTarget.current = null;
          setTarget(next);
        }
      }}
    />
  );
}

function BoundEntityDetails({
  target,
  host = 'metadata',
  onClose,
  onDirtyChange,
  onSaved,
  onReloadSavedSequence,
  mutationBlock,
  readOnly = false,
  tabId,
  nameEditRequestId,
  metadataEditorTabId,
  acceptedAssemblyRecord,
  assemblyReopenError,
  onNameEditStarted,
  onOpenEntity,
  onViewOriginalSource,
  onClassificationApplied,
  onReopenAssembly,
  assemblyReopenStatus,
  onAssemblyBackboneSegmentsChange,
}: EntityDetailsProps) {
  const { session, state } = useEntityDetailsSession(target);
  const [metadataRequest, setMetadataRequest] = useState<number>();
  useMetadataEditRequest(
    metadataEditorTabId,
    'sequence',
    () => {
      if (target.managedSequence) setMetadataRequest((value) => (value ?? 0) + 1);
    },
    Boolean(state.definition?.save) && !state.definition?.record.readOnlyReason && !state.loading
  );
  const folders = useProjectEditFolders();
  const pending = useActionablePendingRefs();
  const [organizationBlocked, setOrganizationBlocked] = useState(false);
  useEffect(() => {
    const reason =
      mutationBlock ||
      (organizationBlocked
        ? 'Finish the approved organization change before editing this record.'
        : null);
    if (!reason) return;
    return session.holdMutations(reason);
  }, [mutationBlock, organizationBlocked, session]);
  const [source, setSource] = useState<{
    request: ExternalProviderSourceRequest;
    label: string;
  } | null>(null);
  const actionBusy = state.saving || Boolean(state.mutationBlock);
  const savedGeneration = useRef(state.saveRevision);
  const callbacks = useRef({ onDirtyChange, onSaved });
  callbacks.current = { onDirtyChange, onSaved };
  useEffect(() => {
    callbacks.current.onDirtyChange?.(
      session.dirty ||
        state.saving ||
        state.completionPending ||
        state.activeField !== null ||
        Boolean(state.mutationBlock)
    );
    if (savedGeneration.current !== state.saveRevision) {
      savedGeneration.current = state.saveRevision;
      if (state.definition) callbacks.current.onSaved?.(state.definition.record, state.savedFields);
    }
  }, [session, state]);
  useEffect(() => () => callbacks.current.onDirtyChange?.(false), []);
  const previousFolders = useRef(folders);
  useEffect(() => {
    if (previousFolders.current !== folders) {
      previousFolders.current = folders;
      if (session.getSnapshot().loading && !session.getSnapshot().definition) return;
      void session.load();
    }
  }, [folders, session]);
  const record = state.definition?.record;
  const preview = record?.preview;
  const archivedOrganization = state.definition?.archivedSequenceOrganization;
  const sequenceOrganizationRef = record?.sequence?.ref ?? archivedOrganization?.ref;
  const open = (summary: LimsRegistrySummary, focus?: TabViewState) => {
    if (onOpenEntity) onOpenEntity(summary, focus);
    else
      void openLimsEntity({ entityId: summary.id, strategy: { kind: 'focused' }, focus }).catch(
        (cause) => session.showError(toUserMessage(cause, 'failure.the-entity-could-not-be-opened'))
      );
  };
  const action = async (operation: () => Promise<UserMessage | void>) => {
    await session.performAction(operation);
    await pending.reload();
  };
  const lifecycle = (summary: LimsRegistrySummary) => ({
    id: summary.id,
    expectedEventSeq: summary.eventSeq ?? undefined,
    operationId: crypto.randomUUID(),
    actor: 'local-user',
  });
  const lifecycleDisabledReason = state.saving
    ? 'Wait for the current changes to finish saving.'
    : session.dirty
      ? 'Update the entity or discard your changes before this action.'
      : preview?.summary.archived
        ? undefined
        : record?.readOnlyReason;
  const related = record ? (
    <>
      {record.sequence?.document || acceptedAssemblyRecord || assemblyReopenError ? (
        <EntityAssemblyHistory
          record={record}
          acceptedRecord={acceptedAssemblyRecord}
          error={assemblyReopenError}
          onReopen={onReopenAssembly}
          status={session.dirty || state.saving ? 'editing' : assemblyReopenStatus}
          onPreview={onAssemblyBackboneSegmentsChange}
        />
      ) : null}
      {preview ? (
        <EntityDetailsRelated
          host={host}
          registryPreview={preview}
          registryHistory={state.history}
          registryHistoryLoading={state.historyLoading}
          registryHistoryError={state.historyError}
          registryActionBusy={Boolean(lifecycleDisabledReason)}
          registryActionDisabledReason={toOptionalUserMessage(lifecycleDisabledReason)}
          registryActionNote={state.notice}
          openRegistrySummary={open}
          selectRegistrySummary={(summary) =>
            requestRegistryOpen({ entityId: summary.id, fallbackSearch: '' })
          }
          handleRestoreEntity={(summary) =>
            void action(async () => {
              await restoreLimsEntity(lifecycle(summary));
              return userMessageWithValues('record.restored', {
                name: userEntityLabel(summary.name),
              });
            })
          }
          handleRevertEntity={(summary) =>
            void action(async () => {
              const result = await revertLimsEntity(lifecycle(summary));
              return result.reverted
                ? userMessageWithValues('record.reverted', {
                    name: userEntityLabel(result.entity.name),
                  })
                : userMessageWithValues('record.noPreviousVersion', {
                    name: userEntityLabel(summary.name),
                  });
            })
          }
          handleArchiveEntity={(summary) =>
            void action(async () => {
              await archiveLimsEntity(lifecycle(summary));
              return userMessageWithValues('record.archived', {
                name: userEntityLabel(summary.name),
              });
            })
          }
          onViewOriginalSource={onViewOriginalSource ?? setSource}
          onClassificationApplied={async () => {
            await session.load();
            await onClassificationApplied?.();
          }}
          unconnectedRefs={pending.refs.filter((ref) => ref.referrerEntityId === target.entityId)}
          pendingActionBusy={actionBusy || state.saving || session.dirty}
          onConfirmPendingRef={(ref: LimsPendingRef, targetEntityId: string) =>
            void action(async () => {
              await confirmLimsPendingRef({ key: ref.key, targetEntityId });
            })
          }
          onRejectPendingRef={(ref, rejectedEntityId) =>
            void action(async () => {
              await rejectLimsPendingRefCandidate({ key: ref.key, rejectedEntityId });
            })
          }
          onDismissPendingRef={(ref) =>
            void action(async () => {
              await dismissLimsPendingRef({ key: ref.key });
            })
          }
        />
      ) : (
        <RegistryHistoryTimeline
          entries={state.history}
          schema={record.schema}
          loading={state.historyLoading}
          error={state.historyError}
        />
      )}
    </>
  ) : null;
  return (
    <>
      <EntityDetailsPanel
        key={target.entityId}
        session={session}
        state={state}
        readOnly={readOnly}
        onClose={onClose}
        nameEditRequestId={nameEditRequestId}
        metadataEditRequestId={metadataRequest}
        metadataEditorTabId={target.managedSequence ? undefined : metadataEditorTabId}
        onNameEditStarted={onNameEditStarted}
        related={
          <>
            {state.definition?.sequenceRegistration ? (
              <SequenceRegistrationSection
                {...state.definition.sequenceRegistration}
                readOnly={
                  Boolean(record?.readOnlyReason) ||
                  !state.definition.save ||
                  state.saving ||
                  session.dirty
                }
              />
            ) : null}
            {related}
          </>
        }
        registration={
          target.recordFile || state.definition?.savedRecord ? (
            <SavedRecordMetadataContext
              session={session}
              state={state}
              readOnly={readOnly}
              tabId={tabId}
            />
          ) : record && sequenceOrganizationRef ? (
            <SequenceOrganizationRecordStatus
              key={record.id}
              documentRef={sequenceOrganizationRef}
              document={record.sequence?.document ?? null}
              archivedSchema={archivedOrganization ? record.schema : undefined}
              dirty={session.dirty || state.activeField !== null}
              readOnly={
                (archivedOrganization?.readOnly ?? Boolean(record.readOnlyReason)) ||
                !onReloadSavedSequence
              }
              saving={state.saving}
              onBlockedChange={setOrganizationBlocked}
              onApplied={async () => {
                if (!onReloadSavedSequence)
                  throw new Error('The sequence reload owner is unavailable.');
                await onReloadSavedSequence();
                await session.load();
                const current = session.getSnapshot().definition?.record;
                if (current) onSaved?.(current, []);
              }}
            />
          ) : null
        }
        hasUnconnectedRefs={pending.refs.some((ref) => ref.referrerEntityId === target.entityId)}
        onShowInRegistry={
          host !== 'registry' && preview && record?.registrationStatus !== 'tracked'
            ? () => {
                void resolveEntityRegistryReference({ kind: 'entity', entityId: target.entityId })
                  .then((entity) => {
                    if (!entity)
                      throw new Error('This entity no longer has a Registry registration.');
                    requestRegistryOpen({ entityId: entity.id, fallbackSearch: '' });
                  })
                  .catch((cause) =>
                    session.showError(
                      toUserMessage(cause, 'failure.the-registration-could-not-be-opened')
                    )
                  );
              }
            : undefined
        }
        onOpen={
          preview?.summary.representation.canOpen && !preview.summary.archived
            ? () => open(preview.summary)
            : undefined
        }
      />
      {source ? (
        <OriginalProviderSourceDialog
          request={source.request}
          label={source.label}
          onClose={() => setSource(null)}
        />
      ) : null}
    </>
  );
}
