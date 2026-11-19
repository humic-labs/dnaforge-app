import { parentDirOf } from '../../../shared/move-target';
import { useDocumentDraft } from '../../../shared/use-document-draft';
import { serializePrimerArtifact, sha256Hex } from '../primer-artifact';
import { publishedPrimerDraft, restorePrimerDraftSettings } from '../primer-draft-settings';
import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import {
  toUserMessage,
  withUserMessage,
  userMessageWithValues,
  userMessageValue,
  userMessage,
} from '@waypoint/user-messages';
import { EntityDetails } from '../../entity-details/public/EntityDetails';
import { useOptionalEntityDetailsSession } from '../../entity-details/public/session';
import { subscribeLimsRegistrationChanged } from '../../lims/public/events';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRef } from 'react';
import { observeWorkflowAction } from '../../../lib/workflow-telemetry';
import { MetadataIcon } from '../../../components/icons';
import { useToastStore } from '../../../stores/toast-store';
import { useAuthStore } from '../../../stores/auth-store';
import type { Tab } from '../../canvas/public/types';
import { useCanvasStore } from '../../canvas/public/store';
import { useMetadataEditRequest } from '../../canvas/public/use-metadata-edit-request';
import { SequenceDrawer } from '../../sequence/public/components/SequenceDrawer';
import { createFileAuthoritativePrimer } from '../create-file-authoritative-primer';
import type { CreatePrimerInput } from '../types';
import { PrimerAssemblyUses } from './PrimerAssemblyUses';
import { PrimerCreationForm } from './PrimerCreationForm';
import { PrimerOrganizationRecordStatus } from './PrimerOrganizationRecordStatus';
import { PrimerSequenceInput } from './PrimerSequenceInput';
import { primerDraftDisplayName } from '../primer-draft-name';
import { primerServices } from '../primer-services';
import {
  PrimerPublicationPendingError,
  type PendingPrimerArtifactPublication,
  type ReadPrimerArtifactResult,
} from '../primer-artifact-service';
import { requestTabClose } from '../../canvas/public/artifact-document-lifecycle';
import {
  oligoOrderTypeLabel,
  parseIdtOligoNotation,
  type OligoOrderType,
} from '../oligo-modifications';
import {
  fingerprintText,
  NEW_DOCUMENT_BASELINE,
  useUnsavedDraftRecovery,
  type NewDraftPayload,
} from '../../../shared/unsaved-draft-recovery';

interface PrimerCreationTabProps {
  tab: Tab;
  panelId: string;
}

const MIN_DRAWER_WIDTH = 380;
const MAX_DRAWER_WIDTH = 560;

export function PrimerCreationTab({ tab, panelId }: PrimerCreationTabProps) {
  const context = tab.artifactDocument?.kind === 'primer' ? tab.artifactDocument : undefined;
  const isActive = useCanvasStore((state) => state.panels[panelId]?.activeTabId === tab.id);
  const observedArtifactRef = useRef<string | null>(null);
  const closeTab = useCanvasStore((state) => state.closeTab);
  const updateTab = useCanvasStore((state) => state.updateTab);

  const recovered = tab.recoveredDraft;
  const draft = useDocumentDraft(() => ({
    sequence: recovered?.sequence ?? '',
    name: recovered?.name ?? '',
    orderType: (recovered?.orderType as OligoOrderType | undefined) ?? context?.orderType ?? 'dna',
    settings: restorePrimerDraftSettings(recovered?.form),
  }));
  const [previousPublication, setPreviousPublication] = useState(recovered?.publishedPrimer);
  const publication = useRef(previousPublication);
  const { sequence, name: draftName, orderType, settings } = draft.value;
  const { edit, read } = draft;
  const setSequence = useCallback((sequence: string) => edit({ sequence }), [edit]);
  const setDraftName = useCallback((name: string) => edit({ name }), [edit]);
  const setOrderType = useCallback((orderType: OligoOrderType) => edit({ orderType }), [edit]);
  const readRevision = useCallback(() => read().revision, [read]);
  const [restoredName, setRestoredName] = useState<string | null>(null);
  const [loadedArtifact, setLoadedArtifact] = useState<ReadPrimerArtifactResult | null>(null);
  const pendingRecovery = useRef<{ sequence?: string; name?: string } | null>(null);
  const metadataEntityId = loadedArtifact?.artifact.registry.entityId;
  const { session: metadataSession, state: metadataState } = useOptionalEntityDetailsSession(
    metadataEntityId ? { entityId: metadataEntityId } : null
  );
  const loadedOrderType =
    metadataState?.draft?.scientific?.orderType ??
    (loadedArtifact ? (loadedArtifact.artifact.oligo?.orderType ?? 'dna') : undefined);
  useEffect(() => {
    if (!context || !loadedOrderType || context.orderType === loadedOrderType) return;
    updateTab(panelId, tab.id, { artifactDocument: { ...context, orderType: loadedOrderType } });
  }, [context, loadedOrderType, panelId, tab.id, updateTab]);
  useEffect(() => {
    const scientific = metadataState?.draft?.scientific;
    if (!metadataSession || !scientific) return;
    if (pendingRecovery.current) {
      const restored = pendingRecovery.current;
      pendingRecovery.current = null;
      metadataSession.stageScientific({
        ...scientific,
        notation: restored.sequence ?? scientific.notation,
      });
      if (restored.name) metadataSession.stage('$name', { valid: true, value: restored.name });
      return;
    }
    setSequence(scientific.notation);
    setOrderType(scientific.orderType);
    if (metadataState.draft) setDraftName(metadataState.draft.name);
    updateTab(panelId, tab.id, {
      label: metadataState.definition?.record.name ?? tab.label,
    });
  }, [metadataSession, metadataState, panelId, tab.id, tab.label, updateTab]);
  useDocumentLifecycle(
    metadataSession
      ? {
          target: { kind: 'tab', tabId: tab.id },
          tabId: tab.id,
          readRevision: metadataSession.readRevision,
          isDirty: () =>
            metadataSession.dirty ||
            metadataSession.getSnapshot().saving ||
            metadataSession.getSnapshot().completionPending,
          save: metadataSession.saveForClose,
          discard: () => metadataSession.discard(),
        }
      : null
  );
  const updateSequence = (notation: string) => {
    setSequence(notation);
    if (metadataState?.draft?.scientific)
      metadataSession?.stageScientific({ ...metadataState.draft.scientific, notation });
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingPublication, setPendingPublication] =
    useState<PendingPrimerArtifactPublication | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [organizationBlocked, setOrganizationBlocked] = useState(false);
  const accountId = useAuthStore((state) =>
    state.state.status === 'signed-in' ? state.state.session.accountId : null
  );
  const requestEpoch = useRef(0);
  const contextRef = useRef({
    tabId: tab.id,
    path: context?.artifactPath,
    workspaceRoot: context?.workspaceRoot,
    accountId,
  });
  contextRef.current = {
    tabId: tab.id,
    path: context?.artifactPath,
    workspaceRoot: context?.workspaceRoot,
    accountId,
  };
  const requestIsCurrent = useCallback((epoch: number, captured: typeof contextRef.current) => {
    const auth = useAuthStore.getState().state;
    const activeAccount = auth.status === 'signed-in' ? auth.session.accountId : null;
    return (
      requestEpoch.current === epoch &&
      activeAccount === captured.accountId &&
      contextRef.current.tabId === captured.tabId &&
      contextRef.current.path === captured.path &&
      contextRef.current.workspaceRoot === captured.workspaceRoot &&
      contextRef.current.accountId === captured.accountId
    );
  }, []);
  const [loading, setLoading] = useState(Boolean(context?.artifactPath));
  const [formResetNonce, setFormResetNonce] = useState(0);
  const [readNonce, setReadNonce] = useState(0);
  const [metadataOpen, setMetadataOpen] = useState(true);
  useMetadataEditRequest(tab.id, 'primer', () => {
    setMetadataOpen(true);
    return false;
  });
  const [drawerWidth, setDrawerWidth] = useState(420);
  useEffect(() => {
    if (!tab.viewState?.entityDetailsOpen) return;
    setMetadataOpen(true);
    useCanvasStore.getState().setTabViewState(panelId, tab.id, { entityDetailsOpen: false });
  }, [panelId, tab.id, tab.viewState?.entityDetailsOpen]);
  const oligoKindLabel = oligoOrderTypeLabel(orderType);

  const parsedSequence = useMemo(
    () => parseIdtOligoNotation(sequence, { orderType }),
    [orderType, sequence]
  );
  const cancel = () => {
    if (!loadedArtifact) {
      requestTabClose(panelId, tab.id);
      return;
    }
    if (metadataSession) {
      metadataSession.discard();
      void metadataSession.load();
      return;
    }
    setSequence(loadedArtifact.artifact.oligo?.notation ?? loadedArtifact.artifact.sequence.bases);
    setOrderType(loadedArtifact.artifact.oligo?.orderType ?? 'dna');
    updateTab(panelId, tab.id, {
      label: loadedArtifact.artifact.name,
    });
    setFormResetNonce((value) => value + 1);
  };
  const updateDraftName = useCallback(
    (name: string) => {
      setDraftName(name);
      updateTab(panelId, tab.id, {
        label: primerDraftDisplayName(name, oligoKindLabel),
      });
    },
    [oligoKindLabel, panelId, tab.id, updateTab]
  );

  const isNewDraft = context?.persistence === 'draft';
  const savedPrimerFingerprint = loadedArtifact
    ? fingerprintText(
        JSON.stringify([
          loadedArtifact.artifact.name,
          loadedArtifact.artifact.oligo?.notation ?? loadedArtifact.artifact.sequence.bases,
        ])
      )
    : null;
  const recoveryPayload = useMemo<NewDraftPayload | undefined>(
    () =>
      context
        ? {
            tabType: 'primer',
            label: primerDraftDisplayName(draftName, oligoKindLabel),
            artifactDocument: context,
            fields: {
              sequence,
              name: draftName,
              orderType,
              ...(Object.keys(settings).length ? { form: JSON.stringify(settings) } : {}),
              ...(previousPublication ? { publishedPrimer: previousPublication } : {}),
            },
          }
        : undefined,
    [context, draftName, oligoKindLabel, orderType, sequence, settings, previousPublication]
  );
  const draftDirty = Boolean(sequence || draftName || Object.keys(settings).length);
  const { completePublishedDraft } = useUnsavedDraftRecovery<NewDraftPayload>({
    key: !context
      ? null
      : isNewDraft
        ? `new:${tab.id}`
        : context.artifactPath
          ? `primer:${context.artifactPath}`
          : null,
    name: recoveryPayload?.label ?? oligoKindLabel,
    baseline: isNewDraft ? NEW_DOCUMENT_BASELINE : savedPrimerFingerprint,
    dirty: metadataSession ? metadataSession.dirty : draftDirty,
    payload: recoveryPayload,
    onRestore: (restored) => {
      if (pendingPublication || publicationBusy || organizationBlocked) return;
      pendingRecovery.current = restored.fields;
      edit({ settings: restorePrimerDraftSettings(restored.fields.form) });
      setSequence(restored.fields.sequence ?? '');
      setDraftName(restored.fields.name ?? '');
      setRestoredName(restored.fields.name ?? '');
      setFormResetNonce((value) => value + 1);
    },
    discardTarget: { kind: 'tab', tabId: tab.id },
  });

  useEffect(() => {
    const artifactPath = context?.artifactPath;
    if (!artifactPath || !context) return;
    let active = true;
    const epoch = ++requestEpoch.current;
    const captured = contextRef.current;
    setLoading(true);
    setLoadedArtifact(null);
    setPendingPublication(null);
    setPublicationBusy(false);
    setLoadError(null);
    void primerServices.persistence
      .readArtifactAtPath(artifactPath, context.workspaceRoot)
      .then((loaded) => {
        if (!active || !requestIsCurrent(epoch, captured)) return;
        setLoadedArtifact(loaded);
        setSequence(loaded.artifact.oligo?.notation ?? loaded.artifact.sequence.bases);
        setOrderType(loaded.artifact.oligo?.orderType ?? 'dna');
        updateTab(panelId, tab.id, { label: loaded.artifact.name });
      })
      .catch((error: unknown) => {
        if (!active || !requestIsCurrent(epoch, captured)) return;
        if (error instanceof PrimerPublicationPendingError) setPendingPublication(error.pending);
        setLoadError(toUserMessage(error, 'failure.failed-to-open-primer'));
      })
      .finally(() => {
        if (active && requestIsCurrent(epoch, captured)) setLoading(false);
      });
    return () => {
      active = false;
      requestEpoch.current++;
    };
  }, [
    context?.artifactPath,
    context?.workspaceRoot,
    panelId,
    tab.id,
    updateTab,
    accountId,
    readNonce,
    requestIsCurrent,
  ]);

  useEffect(() => {
    if (!context?.artifactPath || !loadedArtifact) return;
    const artifactPath = context.artifactPath;
    let active = true;
    const epoch = requestEpoch.current;
    const captured = contextRef.current;
    const unsubscribe = subscribeLimsRegistrationChanged((detail) => {
      if (detail.entityId && detail.entityId !== loadedArtifact.artifact.registry.entityId) return;
      void primerServices.persistence
        .readArtifactAtPath(artifactPath, context.workspaceRoot)
        .then((next) => {
          if (!active || !requestIsCurrent(epoch, captured)) return;
          if (metadataSession?.dirty) return;
          setLoadedArtifact(next);
          updateTab(panelId, tab.id, { label: next.artifact.name });
        })
        .catch((cause) => {
          if (active && requestIsCurrent(epoch, captured))
            metadataSession?.showError(
              toUserMessage(cause, 'failure.the-saved-oligo-could-not-be-refreshed')
            );
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    context?.artifactPath,
    context?.workspaceRoot,
    loadedArtifact,
    metadataSession,
    panelId,
    tab.id,
    updateTab,
    accountId,
    requestIsCurrent,
  ]);

  useEffect(() => {
    if (!isActive || !loadedArtifact || loading || loadError) return;
    const id = loadedArtifact.artifact.id;
    if (observedArtifactRef.current === id) return;
    observedArtifactRef.current = id;
    observeWorkflowAction({
      workflow: 'primer',
      action: 'open',
      initiator: 'system',
      artifactCorrelationId: id,
      outcomeKind: 'reopened_confirmed',
      status: 'completed',
      usableResult: false,
      valueDelivered: false,
    });
  }, [isActive, loadedArtifact, loading, loadError]);

  const save = async (input: CreatePrimerInput): Promise<void | false> => {
    if (pendingPublication || publicationBusy || organizationBlocked || loadedArtifact)
      return false;
    const revision = draft.revision;
    if (!input.workspaceRoot || readRevision() !== revision) return false;
    const previous = publication.current
      ? publishedPrimerDraft.parse(JSON.parse(publication.current))
      : undefined;
    if (
      previous &&
      (!input.artifactPath ||
        parentDirOf(input.artifactPath.replaceAll('\\', '/')) !==
          parentDirOf(previous.path.replaceAll('\\', '/')))
    ) {
      throw withUserMessage(
        new Error('The destination changed after first save.'),
        'primer.firstSaveFolderChanged'
      );
    }
    const saved = previous
      ? await primerServices.persistence.updateArtifactContent({
          artifactPath: previous.path,
          workspaceRoot: input.workspaceRoot,
          name: input.name,
          sequence: input.sequence,
          oligo: input.oligo,
          application: input.application,
          notes: input.notes,
          entitySchema: input.entitySchema,
          entityFields: input.entityFields,
          expectedArtifactRevision: previous.revision,
          expectedContentSha256: previous.sha256,
          acceptedRevision: previous.accepted,
        })
      : await createFileAuthoritativePrimer({ ...input, origin: 'manual' });
    const current = () => readRevision() === revision;
    if (!current() || !(await completePublishedDraft(current)) || !current()) {
      if (previous || saved.created) {
        const checkpoint = JSON.stringify({
          path: saved.artifactPath,
          revision: saved.artifact.artifactRevision,
          sha256: await sha256Hex(serializePrimerArtifact(saved.artifact)),
          accepted: saved.acceptedRevision,
        });
        publication.current = checkpoint;
        setPreviousPublication(checkpoint);
      }
      return false;
    }
    window.dispatchEvent(
      new CustomEvent('waypoint:workspace-files-changed', {
        detail: { workspaceRoot: input.workspaceRoot, revealPath: saved.artifactPath },
      })
    );
    useToastStore.getState().addToast(
      userMessageWithValues('notice.created-primer-value', {
        value0: userMessageValue(saved.artifact.name),
      }),
      {
        definition: 'primer-creation-tab-created-primer-example',
      }
    );
    closeTab(panelId, tab.id);
  };

  const retryPublication = async () => {
    if (!pendingPublication || !context?.workspaceRoot || publicationBusy) return;
    const pending = pendingPublication;
    const epoch = requestEpoch.current;
    const captured = contextRef.current;
    setPublicationBusy(true);
    try {
      const saved = await primerServices.persistence.resumeArtifactSave({
        entityId: pending.entityId,
        operationId: pending.operationId,
        workspaceRoot: context.workspaceRoot,
      });
      if (!requestIsCurrent(epoch, captured)) return;
      const loaded = await primerServices.persistence.readArtifactAtPath(
        saved.artifactPath,
        context.workspaceRoot
      );
      if (!requestIsCurrent(epoch, captured)) return;
      if (loaded.artifact.id !== pending.entityId)
        throw new Error('The saved primer identity changed before Retry could reopen it.');
      setLoadedArtifact(loaded);
      setSequence(loaded.artifact.oligo?.notation ?? loaded.artifact.sequence.bases);
      setOrderType(loaded.artifact.oligo?.orderType ?? 'dna');
      setPendingPublication(null);
      setLoadError(null);
      setFormResetNonce((value) => value + 1);
      updateTab(panelId, tab.id, { label: loaded.artifact.name });
      for (const sequenceId of new Set(
        loaded.resolvedBindings.map((binding) => binding.sequenceId)
      ))
        primerServices.persistence.notifyBindingsChanged(sequenceId);
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot: context.workspaceRoot, revealPath: loaded.path },
        })
      );
      useToastStore.getState().addToast(
        userMessageWithValues('notice.saved-primer-value', {
          value0: userMessageValue(loaded.artifact.name),
        }),
        {
          definition: 'primer-creation-tab-updated-primer-example',
        }
      );
    } catch (error) {
      reportSaveFailure('[PrimerCreationTab] Save completion failed:', { tabId: tab.id }, error);
      if (!requestIsCurrent(epoch, captured)) return;

      setLoadError(toUserMessage(error, 'failure.the-primer-save-could-not-finish'));
    } finally {
      if (requestIsCurrent(epoch, captured)) setPublicationBusy(false);
    }
  };
  const applyOrganizationPrimer = useCallback(
    (loaded: ReadPrimerArtifactResult) => {
      setLoadedArtifact(loaded);
      setSequence(loaded.artifact.oligo?.notation ?? loaded.artifact.sequence.bases);
      setOrderType(loaded.artifact.oligo?.orderType ?? 'dna');
      setDraftName(loaded.artifact.name);
      setRestoredName(null);
      setPendingPublication(null);
      setLoadError(null);
      setFormResetNonce((value) => value + 1);
      updateTab(panelId, tab.id, { label: loaded.artifact.name });
      void metadataSession?.load();
      for (const sequenceId of new Set(
        [...(loadedArtifact?.resolvedBindings ?? []), ...loaded.resolvedBindings].map(
          (binding) => binding.sequenceId
        )
      ))
        primerServices.persistence.notifyBindingsChanged(sequenceId);
      window.dispatchEvent(
        new CustomEvent('waypoint:workspace-files-changed', {
          detail: { workspaceRoot: context?.workspaceRoot, revealPath: loaded.path },
        })
      );
    },
    [
      context?.workspaceRoot,
      loadedArtifact?.resolvedBindings,
      metadataSession,
      panelId,
      tab.id,
      updateTab,
    ]
  );
  const organizationControl = context?.artifactPath ? (
    <PrimerOrganizationRecordStatus
      tabId={tab.id}
      path={context.artifactPath}
      workspaceRoot={context.workspaceRoot}
      accountId={accountId}
      loaded={loadedArtifact}
      dirty={Boolean(tab.isDirty)}
      readOnly={Boolean(tab.readOnly)}
      saving={publicationBusy || Boolean(pendingPublication)}
      loading={loading}
      onApplied={applyOrganizationPrimer}
      onBlockedChange={setOrganizationBlocked}
    />
  ) : null;
  const retryControl = pendingPublication ? (
    <div
      className="shrink-0 border-b border-border p-3 text-sm"
      role="alert"
      data-testid="primer-pending-save"
    >
      <p>
        {loadError != null
          ? toUserMessage(loadError, 'failure.this-primer-has-an-unfinished-save')
          : userMessage('failure.this-primer-has-an-unfinished-save')}
      </p>
      <button
        type="button"
        className="mt-2 rounded border border-border px-3 py-1.5"
        data-testid="primer-retry-save"
        disabled={publicationBusy}
        onClick={() => void retryPublication()}
      >
        {publicationBusy ? 'Finishing save…' : 'Retry save'}
      </button>
    </div>
  ) : null;

  if (!context) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-error" role="alert">
        This primer tab is missing its workspace destination.
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg">
        {organizationControl}
        <div className="flex flex-1 items-center justify-center text-sm text-fg-muted">
          Opening primer…
        </div>
      </div>
    );
  }

  if (loadError && !loadedArtifact) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg">
        {organizationControl}
        {retryControl ?? (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-sm text-error"
            role="alert"
          >
            <p>{toUserMessage(loadError, 'primer.failed')}</p>
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5"
              onClick={() => setReadNonce((value) => value + 1)}
            >
              Reload primer
            </button>
          </div>
        )}
      </div>
    );
  }

  const renderDrawer = (contents: React.ReactElement) =>
    metadataOpen ? (
      <SequenceDrawer
        width={drawerWidth}
        onWidthChange={(width) =>
          setDrawerWidth(Math.min(MAX_DRAWER_WIDTH, Math.max(MIN_DRAWER_WIDTH, width)))
        }
      >
        {contents}
      </SequenceDrawer>
    ) : null;
  const primerForm = (
    <PrimerCreationForm
      key={`${loadedArtifact?.artifact.artifactRevision ?? 'draft'}:${formResetNonce}`}
      workspaceRoot={context.workspaceRoot}
      initialSaveDir={context.destinationPath}
      fixedArtifactPath={context.artifactPath}
      initialName={restoredName ?? loadedArtifact?.artifact.name ?? recovered?.name}
      initialEntitySchema={loadedArtifact?.artifact.entity?.schema}
      initialEntityFields={loadedArtifact?.artifact.entity?.fields}
      initialOrderType={loadedArtifact?.artifact.oligo?.orderType ?? 'dna'}
      orderType={orderType}
      draftKindLabel={oligoKindLabel}
      externalSequenceEditor={{ value: sequence, onChange: setSequence }}
      onSave={save}
      onCancel={cancel}
      documentDraft={{
        tabId: tab.id,
        revision: draft.revision,
        readRevision,
        dirty: draftDirty,
        visible: metadataOpen,
        settings,
        editSettings: (change) => edit({ settings: { ...read().value.settings, ...change } }),
        render: renderDrawer,
      }}
      onNameChange={updateDraftName}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="primer-creation-tab">
      {organizationControl}
      {retryControl}
      <fieldset
        className="flex min-h-0 min-w-0 flex-1 border-0 p-0"
        disabled={
          publicationBusy ||
          Boolean(pendingPublication) ||
          organizationBlocked ||
          Boolean(tab.readOnly)
        }
      >
        <main className="min-w-0 flex-1 overflow-hidden" aria-label="Primer editor">
          <div
            data-testid="primer-canvas-column"
            className="flex h-full min-h-0 w-full flex-col px-8 py-7"
          >
            <div className="mb-3 flex shrink-0 items-center justify-between">
              <div
                data-testid="primer-order-type"
                className="text-[10px] font-medium uppercase tracking-wide text-fg-muted"
              >
                {oligoKindLabel}
              </div>
              <div className="text-xs tabular-nums text-fg-muted">
                {parsedSequence.bases.trim().length} nt
              </div>
            </div>

            <div data-testid="primer-standalone-sequence-editor" className="min-h-0 w-full flex-1">
              <PrimerSequenceInput
                value={sequence}
                disabled={Boolean(
                  loadedArtifact &&
                  (!metadataState?.definition?.save ||
                    metadataState.saving ||
                    metadataState.requiresReload)
                )}
                onChange={(next) => {
                  updateSequence(next);
                }}
                rows={3}
                variant="canvas"
                showPrimeLabels
                autoFocus
                orderType={orderType}
                placeholder="Type or paste bases · / for modifications"
              />
            </div>
          </div>
        </main>

        {loadedArtifact
          ? renderDrawer(
              <EntityDetails
                metadataEditorTabId={tab.id}
                target={{ entityId: loadedArtifact.artifact.registry.entityId }}
                mutationBlock={
                  organizationBlocked
                    ? 'Finish the approved organization change before editing this primer.'
                    : null
                }
                onClose={() => setMetadataOpen(false)}
              />
            )
          : primerForm}

        <aside
          className="w-12 shrink-0 border-l border-border bg-bg-subtle"
          data-testid="primer-tool-rail"
        >
          <div className="border-b border-border p-1.5">
            <div className="pb-1 pr-px text-center text-[8px] uppercase text-fg-muted">Details</div>
            <button
              type="button"
              onClick={() => setMetadataOpen((open) => !open)}
              aria-label="Metadata"
              aria-pressed={metadataOpen}
              data-testid="primer-toolbar-metadata"
              className={`relative flex h-8 w-full items-center justify-center rounded transition-colors ${
                metadataOpen ? 'text-accent' : 'text-fg-muted wp-interactive '
              }`}
            >
              {metadataOpen ? (
                <span className="absolute -right-1.5 -top-0.5 h-[calc(100%+4px)] w-0.5 bg-accent" />
              ) : null}
              <MetadataIcon className={metadataOpen ? 'opacity-100' : 'opacity-65'} />
            </button>
          </div>
        </aside>
      </fieldset>
      {loadedArtifact ? <PrimerAssemblyUses artifact={loadedArtifact.artifact} /> : null}
    </div>
  );
}
