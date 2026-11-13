import { toUserMessage, renderUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Notice } from '../../components/ui';
import { CloseIcon } from '../../components/icons';
import { MetadataEditingScope } from '../../shared/components/entity-metadata/MetadataEditing';
import { EntityMetadataFieldEditor, RegistryRecordValue } from '../lims/public/metadata-fields';
import {
  MetadataFieldList,
  MetadataFieldRow,
  MetadataValue,
} from '../../shared/components/entity-metadata/MetadataLayout';
import { MetadataField } from '../../shared/components/entity-metadata/MetadataField';
import { MetadataPicker } from '../../shared/components/entity-metadata/MetadataPicker';
import { useSequenceStore } from '../sequence/public/store';
import { SequenceProperties } from '../../shared/components/SequenceProperties';
import { MetadataAdditionalDetails } from '../../shared/components/MetadataAdditionalDetails';
import { otherEntityMetadata } from '../../shared/entity-record';
import { registrationStatusLabel } from '../../shared/lims';
import { publicEntitySchemaFields } from '../../shared/public-entity-metadata';
import { GeneticCodeControl } from '../sequence/public/components/GeneticCodeControl';
import { geneticCodeTriggerLabel } from '../sequence/public/genetic-code-field-model';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../../shared/entity-schema';
import { RegistryFailedTag } from '../lims/public/details-presenters';
import { OligoProperties } from './OligoProperties';
import type { EntityDetailsSession, EntityDetailsState } from './session';
import { useMetadataEditRequest } from '../canvas/public/use-metadata-edit-request';

export function EntityDetailsPanel({
  session,
  state,
  onClose,
  onShowInRegistry,
  onOpen,
  related,
  registration,
  nameEditRequestId,
  metadataEditRequestId,
  onNameEditStarted,
  metadataEditorTabId,
  hasUnconnectedRefs = false,
  readOnly = false,
}: {
  session: EntityDetailsSession;
  state: EntityDetailsState;
  onClose: () => void;
  onShowInRegistry?: () => void;
  onOpen?: () => void;
  related?: ReactNode;
  registration?: ReactNode;
  nameEditRequestId?: number;
  metadataEditRequestId?: number;
  onNameEditStarted?: () => void;
  metadataEditorTabId?: string;
  hasUnconnectedRefs?: boolean;
  readOnly?: boolean;
}) {
  const { definition, draft, saving } = state;
  const error: UserMessage | null = state.error;
  const record = definition?.record;
  const sequence = record?.sequence;
  const viewedSequence = useSequenceStore((store) =>
    sequence
      ? store.sequences[
          sequence.ref?.packageId ?? session.target.sequenceFile?.documentId ?? record?.id ?? ''
        ]
      : undefined
  );
  const disabled =
    readOnly ||
    saving ||
    state.requiresReload ||
    Boolean(state.mutationBlock) ||
    Boolean(record?.readOnlyReason) ||
    !definition?.save;
  const [schemaChoices, setSchemaChoices] = useState<ProjectableEntitySchemaRevisionSnapshot[]>([]);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const schemaRequest = useRef(0);
  useEffect(
    () => () => {
      schemaRequest.current++;
    },
    []
  );
  const previousCode = useRef<unknown>();
  const previousSchema = useRef(draft?.schema);
  const finishSchema = () => {
    schemaRequest.current++;
    setSchemaLoading(false);
  };
  const loadSchemas = async () => {
    if (!definition?.schemaChoices) return;
    const request = ++schemaRequest.current;
    previousSchema.current = session.getSnapshot().draft?.schema;
    setSchemaChoices([]);
    setSchemaLoading(true);
    try {
      const choices = await definition.schemaChoices();
      if (request === schemaRequest.current)
        setSchemaChoices(choices.sort((a, b) => a.displayName.localeCompare(b.displayName)));
    } catch (cause) {
      if (request === schemaRequest.current)
        session.showError(toUserMessage(cause, 'failure.schemas-could-not-be-loaded'));
    } finally {
      if (request === schemaRequest.current) setSchemaLoading(false);
    }
  };
  const metadataRequestField =
    draft && record
      ? publicEntitySchemaFields(draft.schema, record.preview?.entity.kind).find(
          (field) =>
            !field.readOnly && !field.intrinsic && !definition?.readOnlyFields?.includes(field.key)
        )?.key
      : undefined;
  const editing = session.editing;
  const otherMetadata = draft ? otherEntityMetadata(draft.schema, draft.fields) : [];
  const requestCounter = useRef(0);
  const [requestedField, setRequestedField] = useState<{
    entityId: string;
    key: string;
    id: number;
  }>();
  const editableFields = draft
    ? publicEntitySchemaFields(draft.schema).filter(
        (field) =>
          !field.readOnly && !field.intrinsic && !definition?.readOnlyFields?.includes(field.key)
      )
    : [];
  const requestFieldKey =
    editableFields.find((field) => field.key === 'description')?.key ??
    editableFields[0]?.key ??
    (definition?.canEditName !== false ? '$name' : undefined);
  useMetadataEditRequest(
    metadataEditorTabId,
    sequence ? 'sequence' : 'primer',
    () => {
      if (!requestFieldKey) return false;
      setRequestedField({
        entityId: session.target.entityId,
        key: requestFieldKey,
        id: --requestCounter.current,
      });
    },
    Boolean(record && draft && !state.loading && !disabled && requestFieldKey)
  );
  const currentRequest =
    requestedField?.entityId === session.target.entityId ? requestedField : undefined;

  return (
    <MetadataEditingScope key={state.generation} coordinator={session.editingCoordinator}>
      <section
        className="flex h-full min-h-0 flex-col bg-bg text-sm"
        data-testid="entity-details-panel"
        data-entity-id={session.target.entityId}
        data-editing={editing}
        data-workspace-mutation-entity-id={session.target.entityId}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-border px-3 py-2.5">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
              Metadata
              {hasUnconnectedRefs ? <RegistryFailedTag testId="lims-registry-failed" /> : null}
              {editing ? (
                <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                  Editing
                </span>
              ) : null}
            </h2>
            <p className="mt-0.5 truncate text-[11px] text-fg-muted">
              {draft?.schema.displayName ?? 'Entity'}
            </p>
          </div>
          <Button
            onClick={() => session.requestClose(onClose)}
            aria-label="Close metadata"
            variant="icon"
          >
            <CloseIcon size={13} />
          </Button>
        </header>
        <div
          data-testid="entity-details-scroll"
          className="metadata-scroll-area min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3"
        >
          {registration}
          {state.mutationBlock ? (
            <p role="status" className="text-sm text-fg-muted">
              {state.mutationBlock}
            </p>
          ) : null}
          {state.loading ? <p className="text-xs text-fg-muted">Loading metadata…</p> : null}
          {record && draft ? (
            <>
              {onShowInRegistry || onOpen ? (
                <div className="flex flex-wrap gap-2">
                  {onShowInRegistry ? (
                    <Button variant="secondary" onClick={onShowInRegistry} disabled={saving}>
                      Show in Registry
                    </Button>
                  ) : null}
                  {onOpen ? (
                    <Button variant="secondary" onClick={onOpen} disabled={saving}>
                      Open
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {record.readOnlyReason ? (
                <p
                  data-testid={
                    sequence ? 'sequence-metadata-read-only' : 'registry-record-read-only'
                  }
                  role="status"
                  className="text-xs text-fg-muted"
                >
                  {toUserMessage(record.readOnlyReason, 'record.readOnly')}
                </p>
              ) : null}
              <section data-testid="lims-registry-record-fields" aria-label="Record metadata">
                <MetadataFieldList testId="sequence-metadata-fields">
                  <MetadataFieldRow label="Name">
                    <EntityMetadataFieldEditor
                      field={{ key: 'name', label: 'Name', type: 'text', required: true }}
                      value={definition.rename ? record.name : draft.name}
                      storedDraft={state.fieldDrafts.$name ?? null}
                      onStoredDraftChange={(value) => session.storeFieldDraft('$name', value)}
                      disabled={disabled}
                      onCommit={
                        definition.save && definition.canEditName !== false
                          ? async (value) => {
                              if (definition.rename) await session.rename(String(value));
                              else session.stage('$name', { valid: true, value });
                            }
                          : undefined
                      }
                      onDraftChange={(value) => session.stage('$name', value)}
                      onEditingChange={(active) => {
                        session.fieldEditing('$name', active);
                        if (active) onNameEditStarted?.();
                      }}
                      editRequestId={
                        currentRequest?.key === '$name'
                          ? currentRequest.id
                          : (nameEditRequestId ??
                            (!metadataRequestField ? metadataEditRequestId : undefined))
                      }
                      triggerLabel={sequence ? 'Edit sequence name' : 'Edit Name'}
                      triggerTestId={sequence ? 'sequence-metadata-rename-button' : undefined}
                      inputId={sequence ? 'sequence-metadata-name' : undefined}
                      inputTestId={sequence ? 'sequence-metadata-name' : undefined}
                      renderValue={
                        sequence
                          ? (value) => (
                              <output
                                aria-label="Sequence name"
                                data-testid="sequence-metadata-name"
                                className="select-text text-sm font-semibold text-fg"
                              >
                                {value}
                              </output>
                            )
                          : undefined
                      }
                      readOnlyDisplay={
                        sequence ? (
                          <output
                            aria-label="Sequence name"
                            data-testid="sequence-metadata-name"
                            className="select-text text-sm font-semibold text-fg"
                          >
                            {draft.name}
                          </output>
                        ) : undefined
                      }
                    />
                  </MetadataFieldRow>
                  <MetadataFieldRow label="ID">
                    <MetadataValue>{record.registryId || '-'}</MetadataValue>
                  </MetadataFieldRow>
                  <MetadataFieldRow label="Schema">
                    {definition.schemaChoices ? (
                      <MetadataField
                        label="Schema"
                        display={draft.schema.displayName}
                        disabled={disabled}
                        onBegin={() => void loadSchemas()}
                        onFinish={finishSchema}
                        onCancel={() => {
                          if (previousSchema.current) session.selectSchema(previousSchema.current);
                          finishSchema();
                        }}
                        onEditingChange={(active) => session.fieldEditing('$schema', active)}
                      >
                        {(fieldSession) => (
                          <MetadataPicker
                            ariaLabel="Schema"
                            testId="sequence-metadata-schema"
                            value={draft.schema.schemaRevisionId}
                            options={[
                              ...(!schemaChoices.some(
                                (schema) =>
                                  schema.schemaRevisionId === draft.schema.schemaRevisionId
                              )
                                ? [
                                    {
                                      value: draft.schema.schemaRevisionId,
                                      label: draft.schema.displayName,
                                    },
                                  ]
                                : []),
                              ...schemaChoices.map((schema) => ({
                                value: schema.schemaRevisionId,
                                label: schema.displayName,
                                description: `${schema.name} · v${schema.version}`,
                              })),
                            ]}
                            onValueChange={(id) => {
                              const schema = schemaChoices.find(
                                (schema) => schema.schemaRevisionId === id
                              );
                              if (schema) session.selectSchema(schema);
                            }}
                            onSelect={() => fieldSession.finish(true)}
                            defaultOpen
                            loading={schemaLoading}
                            searchLabel="Search schemas"
                            menuAttributes={{ 'data-metadata-field': fieldSession.ownerId }}
                          />
                        )}
                      </MetadataField>
                    ) : (
                      <MetadataValue>{draft.schema.displayName}</MetadataValue>
                    )}
                  </MetadataFieldRow>
                  {record.registrationStatus !== 'tracked' ? (
                    <MetadataFieldRow label="Registry status">
                      <MetadataValue>
                        {registrationStatusLabel(record.registrationStatus)}
                      </MetadataValue>
                    </MetadataFieldRow>
                  ) : null}
                  {publicEntitySchemaFields(draft.schema, record.preview?.entity.kind).map(
                    (field) => (
                      <MetadataFieldRow
                        key={field.key}
                        label={field.label}
                        description={field.description}
                        required={field.required}
                      >
                        {field.key === 'sequence' && draft.scientific ? (
                          <EntityMetadataFieldEditor
                            field={{
                              key: '$scientific',
                              label: field.label,
                              type: 'long_text',
                              required: true,
                            }}
                            value={draft.scientific.notation}
                            disabled={disabled}
                            onCommit={async (value) =>
                              session.stageScientific({
                                ...draft.scientific!,
                                notation: String(value),
                              })
                            }
                            onDraftChange={(value) => {
                              if (!value.valid) session.stage('$scientific', value);
                              else
                                session.stageScientific({
                                  ...draft.scientific!,
                                  notation: String(value.value),
                                });
                            }}
                            onEditingChange={(active) =>
                              session.fieldEditing('$scientific', active)
                            }
                            storedDraft={state.fieldDrafts.$scientific ?? null}
                            onStoredDraftChange={(value) =>
                              session.storeFieldDraft('$scientific', value)
                            }
                          />
                        ) : field.intrinsic === 'sequence.geneticCode' && sequence ? (
                          <MetadataField
                            label={field.label}
                            display={geneticCodeTriggerLabel(String(draft.fields[field.key]))}
                            disabled={
                              disabled ||
                              !definition.editableIntrinsics?.includes('sequence.geneticCode')
                            }
                            onBegin={() => {
                              previousCode.current = session.getSnapshot().draft?.fields[field.key];
                            }}
                            onCancel={() =>
                              session.stage(field.key, { valid: true, value: previousCode.current })
                            }
                            onEditingChange={(active) => session.fieldEditing(field.key, active)}
                          >
                            {(fieldSession) => (
                              <div className="space-y-2">
                                <GeneticCodeControl
                                  sequence={viewedSequence ?? sequence.data}
                                  value={String(draft.fields[field.key])}
                                  onChange={(value) =>
                                    session.stage(field.key, { valid: true, value })
                                  }
                                  onSelect={() => fieldSession.finish(true)}
                                  defaultOpen
                                  showStatusTitle={false}
                                  menuAttributes={{ 'data-metadata-field': fieldSession.ownerId }}
                                  testId="sequence-metadata-genetic-code"
                                />
                              </div>
                            )}
                          </MetadataField>
                        ) : (
                          <EntityMetadataFieldEditor
                            field={
                              field.intrinsic === 'sequence.topology' && sequence
                                ? { ...field, required: true }
                                : field
                            }
                            sourceEntityId={session.target.entityId}
                            value={draft.fields[field.key]}
                            editRequestId={
                              currentRequest?.key === field.key
                                ? currentRequest.id
                                : field.key === metadataRequestField
                                  ? metadataEditRequestId
                                  : undefined
                            }
                            storedDraft={state.fieldDrafts[field.key] ?? null}
                            onStoredDraftChange={(value) =>
                              session.storeFieldDraft(field.key, value)
                            }
                            onCommit={
                              definition.save &&
                              !definition.readOnlyFields?.includes(field.key) &&
                              (!field.intrinsic ||
                                definition.editableIntrinsics?.includes(field.intrinsic))
                                ? async (value) => session.stage(field.key, { valid: true, value })
                                : undefined
                            }
                            disabled={disabled}
                            onDraftChange={(value) => session.stage(field.key, value)}
                            onEditingChange={(active) => session.fieldEditing(field.key, active)}
                            readOnlyDisplay={
                              field.intrinsic === 'sequence.topology' && sequence ? (
                                <output aria-label="Topology" className="select-text">
                                  {draft.fields[field.key] === 'circular' ? 'Circular' : 'Linear'}
                                </output>
                              ) : (
                                <RegistryRecordValue
                                  type={field.type}
                                  value={draft.fields[field.key]}
                                />
                              )
                            }
                          />
                        )}
                      </MetadataFieldRow>
                    )
                  )}
                </MetadataFieldList>
              </section>
              {draft.scientific ? <OligoProperties value={draft.scientific} /> : null}
              {Object.keys(record.properties).length ? (
                <SequenceProperties
                  values={
                    sequence && viewedSequence
                      ? { ...record.properties, size: viewedSequence.length }
                      : record.properties
                  }
                  sizeTestId={sequence ? 'sequence-metadata-size' : undefined}
                  sizeUnit={sequence ? 'bp' : undefined}
                />
              ) : null}
              <MetadataAdditionalDetails entries={otherMetadata} />
              {related}
            </>
          ) : null}
          {draft && definition?.validate?.(draft) ? (
            <Notice tone="error">
              {toUserMessage(definition.validate(draft), 'record.validationFailed')}
            </Notice>
          ) : null}
        </div>
        {error || (state.requiresReload && !saving) ? (
          <div className="shrink-0 space-y-2 px-3 py-2">
            {error ? <Notice tone="error">{renderUserMessage(error)}</Notice> : null}
            {state.requiresReload && !saving ? (
              <Button
                variant="secondary"
                disabled={readOnly || Boolean(state.mutationBlock)}
                onClick={() => void session.retryCompletion()}
              >
                {state.completionPending ? 'Retry save' : 'Reload metadata'}
              </Button>
            ) : null}
          </div>
        ) : null}
        {record && editing ? (
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-3 py-2.5">
            <Button
              variant="secondary"
              onClick={session.discard}
              disabled={
                saving ||
                (state.completionPending && state.saveConfirmed) ||
                Boolean(state.mutationBlock)
              }
              data-testid="sequence-metadata-cancel"
            >
              Discard changes
            </Button>
            <Button
              onClick={() => void session.save()}
              disabled={
                disabled ||
                !session.dirty ||
                state.invalid.size > 0 ||
                !draft?.name.trim() ||
                Boolean(definition?.rename && draft.name.trim() !== record.name)
              }
              data-testid="sequence-metadata-save"
            >
              {saving ? 'Saving…' : 'Update entity'}
            </Button>
          </footer>
        ) : null}
      </section>
    </MetadataEditingScope>
  );
}
