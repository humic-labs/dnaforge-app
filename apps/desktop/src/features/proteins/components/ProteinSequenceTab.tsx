import { reportSaveFailure } from '../../../lib/report-save-failure';
import { useDocumentLifecycle } from '../../../shared/use-document-lifecycle';
import {
  toUserMessage,
  withUserMessage,
  userMessageWithValues,
  userMessageValue,
  userMessage,
} from '@waypoint/user-messages';
import { DraftSaveOwner } from '../../../lib/draft-save-owner';
import { subscribeLimsRegistrationChanged } from '../../lims/public/events';
import { SavedMolecularStructures } from '../../compute/public/SavedMolecularStructures';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inferCatalogFileKind } from '../../../shared/catalog-file-kind';
import { isAbsolutePathLike } from '../../../shared/path-boundary';
import type { FastaKindReadAuthority } from '../../../shared/fasta-kind';
import { resolveNativeFastaSourceAuthority } from '../../../services/native-catalog-destination';
import { FastaKindReadStatus } from '../../../components/FastaKindReadStatus';
import { getCatalogEntityForFilePath } from '../../../db/workspace-catalog';
import { queryLimsEntities } from '../../lims/public/operations';
import { resolveAminoAcidSequence } from '../../lims/public/protein-sequence';
import type { AminoAcidSequenceRef, LimsEntity, ProteinSequenceRef } from '../../../shared/lims';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { useDrawerState } from '../../sequence/public/hooks/useDrawerState';
import { SequenceDrawer } from '../../sequence/public/components/SequenceDrawer';
import { StructureDrawerContent } from '../../structure-drawer/public/components/StructureDrawerContent';
import { buildStructureDrawerRequestFromProteinEntity } from '../../structure-drawer/public/api/build-structure-request';
import { useStructureDrawerStore } from '../../structure-drawer/public';
import { useToastStore } from '../../../stores/toast-store';
import { ProteinResidueTrack, type ProteinResidueSelection } from './ProteinResidueTrack';
import { ProteinSequenceContextMenu } from './ProteinSequenceContextMenu';
import { BacktranslateResultDialog } from './BacktranslateResultDialog';
import { askAiAboutProtein } from '../ask-ai-about-protein';
import { usePredictStructureStore } from '../../compute/public/predict-structure';
import {
  resolveProteinEntityArtifactRevision,
  saveProteinSequence,
} from '../save-protein-sequence';

export interface ProteinSequenceTabProps {
  entityId: string;
  canvasTabId?: string;

  onUnavailable: () => void;
  legacyFasta?: Exclude<FastaKindReadAuthority, { status: 'declared' }>;
}

type ProteinTabState =
  | { status: 'loading' }
  | { status: 'error'; entity: LimsEntity; message: string; canOpenAsSequence: boolean }
  | {
      status: 'ready';
      entity: LimsEntity;
      bases: string;
      expectedContentHash: string | null;
      registered: boolean;
      readOnly: boolean;
      fastaAuthority: FastaKindReadAuthority | null;
      sourcePath: string | null;
    };

export function ProteinSequenceTab({
  entityId,
  canvasTabId,
  onUnavailable,
  legacyFasta: legacyReadRequest,
}: ProteinSequenceTabProps) {
  const [state, setState] = useState<ProteinTabState>({ status: 'loading' });
  const folders = useWorkspaceStore((workspace) => workspace.folders);
  const workspaceRoots = useMemo(() => folders.map((folder) => folder.path), [folders]);

  const { activeDrawer, drawerWidth, openDrawer, closeDrawer, setDrawerWidth } =
    useDrawerState(entityId);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    selection: ProteinResidueSelection | null;
  } | null>(null);
  const [backtranslateSequence, setBacktranslateSequence] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveOwner = useMemo(() => new DraftSaveOwner(), [entityId]);
  saveOwner.observeDraft(editDraft ?? '');
  useEffect(() => {
    setEditDraft(null);
    setSaving(false);
    return () => saveOwner.retire();
  }, [saveOwner]);

  const handleViewStructure = useCallback(() => {
    if (state.status !== 'ready' || state.readOnly) return;
    const request = buildStructureDrawerRequestFromProteinEntity({
      entityId: state.entity.id,
      aaSequence: state.bases,
      label: state.entity.name,
    });
    if (!request) return;
    void useStructureDrawerStore.getState().open(request);
    openDrawer('structure');
  }, [openDrawer, state]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      const isProteinFilePath =
        isAbsolutePathLike(entityId) && inferCatalogFileKind(entityId) === 'fasta';
      const fastaAuthority = isProteinFilePath
        ? await resolveNativeFastaSourceAuthority(entityId)
        : null;
      if (
        fastaAuthority &&
        (fastaAuthority.status === 'declared'
          ? fastaAuthority.kind
          : fastaAuthority.legacyReadView) !== 'protein'
      )
        throw withUserMessage(
          new Error(
            'This FASTA source is not available in the protein view. Open its current native destination.'
          ),
          'protein.nativeDnaSource'
        );
      const legacyFasta = fastaAuthority && fastaAuthority.status !== 'declared';
      const catalogEntity = isProteinFilePath ? await getCatalogEntityForFilePath(entityId) : null;
      const catalogProteinId = isProteinFilePath
        ? !legacyFasta && catalogEntity?.type === 'protein'
          ? catalogEntity.id
          : null
        : entityId;
      const registeredEntity = catalogProteinId
        ? (
            await queryLimsEntities({
              id: catalogProteinId,
              includeArchived: true,
              limit: 1,
            })
          )[0]
        : isProteinFilePath && !legacyFasta
          ? (
              await queryLimsEntities({
                kind: 'protein',
                sequenceDocumentId: entityId,
                includeArchived: true,
                limit: 1,
              })
            )[0]
          : undefined;
      const entity =
        registeredEntity ??
        (isProteinFilePath
          ? {
              ...unregisteredProteinEntity(entityId),
              ...(fastaAuthority?.status === 'declared'
                ? {
                    id: fastaAuthority.entityId,
                    name: catalogEntity?.name ?? unregisteredProteinEntity(entityId).name,
                  }
                : {}),
            }
          : null);
      if (!entity || entity.tombstone) {
        if (!cancelled) onUnavailable();
        return;
      }

      const projectedRef = entity.fields.sequence as
        | AminoAcidSequenceRef
        | ProteinSequenceRef
        | undefined;
      let ref = projectedRef;
      let packageContentHash: string | null = null;
      let sourcePath = isAbsolutePathLike(entityId) ? entityId : null;
      if (projectedRef?.mode === 'inline' && 'aminoAcids' in projectedRef) {
        try {
          const resolution = await resolveProteinEntityArtifactRevision({
            entity,
            workspaceRoots,
          });
          if (resolution.status === 'missing-authority') {
            if (!cancelled) onUnavailable();
            return;
          }
          const { revision } = resolution;
          ref = revision.artifact.fields.sequence as ProteinSequenceRef;
          packageContentHash = revision.contentHash;
          sourcePath = revision.artifactPath;
        } catch (error) {
          if (!cancelled) {
            setState({
              status: 'error',
              entity,
              message: toUserMessage(error, 'structure.failed'),
              canOpenAsSequence: false,
            });
          }
          return;
        }
      }
      const resolved = ref
        ? await resolveAminoAcidSequence(ref)
        : ({ status: 'unresolved' } as const);
      if (cancelled) return;

      if (resolved.status === 'loaded') {
        setState({
          status: 'ready',
          entity,
          bases: resolved.bases,
          expectedContentHash:
            packageContentHash ??
            (registeredEntity && ref?.mode === 'file' && !('representation' in ref)
              ? (ref.fileContentHash ?? ref.contentHash ?? null)
              : null),
          registered: registeredEntity !== undefined,
          readOnly:
            Boolean(legacyFasta) || (!registeredEntity && fastaAuthority?.status !== 'declared'),
          fastaAuthority,
          sourcePath,
        });
      } else if (resolved.status === 'missing') {
        onUnavailable();
      } else if (resolved.status === 'error') {
        setState({
          status: 'error',
          entity,
          message: toUserMessage(resolved.error, 'structure.failed'),
          canOpenAsSequence:
            isProteinFilePath &&
            !legacyFasta &&
            resolved.error.includes('contains multiple records'),
        });
      } else {
        setState({
          status: 'error',
          entity,
          message: 'This protein has no resolved amino-acid sequence.',
          canOpenAsSequence: false,
        });
      }
    })().catch((error: unknown) => {
      if (!cancelled)
        setState({
          status: 'error',
          entity: unregisteredProteinEntity(entityId),
          message: toUserMessage(error, 'structure.failed'),
          canOpenAsSequence: false,
        });
    });

    return () => {
      cancelled = true;
    };
  }, [entityId, onUnavailable, workspaceRoots, legacyReadRequest]);

  const currentState = useRef(state);
  currentState.current = state;
  useEffect(() => {
    let active = true;
    let request = 0;
    const unsubscribe = subscribeLimsRegistrationChanged((detail) => {
      const current = currentState.current;
      if (current.status !== 'ready' || (detail.entityId && detail.entityId !== current.entity.id))
        return;
      const id = ++request;
      void (async () => {
        const entity = (
          await queryLimsEntities({ id: current.entity.id, includeArchived: true, limit: 1 })
        )[0];
        if (!entity || entity.tombstone) return;
        const ref = entity.fields.sequence as ProteinSequenceRef | undefined;
        if (!ref || ref.mode !== 'inline') return;
        const resolution = await resolveProteinEntityArtifactRevision({ entity, workspaceRoots });
        if (resolution.status !== 'ready') return;
        const sequence = await resolveAminoAcidSequence(
          resolution.revision.artifact.fields.sequence as ProteinSequenceRef
        );
        if (!active || request !== id || sequence.status !== 'loaded') return;
        setState((previous) =>
          previous.status === 'ready' &&
          previous.entity.id === entity.id &&
          previous.bases === sequence.bases
            ? { ...previous, entity, expectedContentHash: resolution.revision.contentHash }
            : previous
        );
      })().catch((error) => {
        if (active && request === id)
          useToastStore
            .getState()
            .addToast(toUserMessage(error, 'failure.protein-metadata-could-not-be-refreshed'), {
              definition: 'protein-sequence-tab-handle-save',
            });
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [entityId, workspaceRoots]);

  const handleSave = async (): Promise<boolean> => {
    if (state.status !== 'ready' || state.readOnly) return false;
    if (editDraft === null || editDraft === state.bases) return true;
    if (!state.expectedContentHash) return false;
    const operation = saveOwner.begin();
    if (!operation) return false;
    setSaving(true);
    try {
      const saved = await saveProteinSequence({
        entity: state.entity,
        bases: editDraft,
        expectedContentHash: state.expectedContentHash,
        workspaceRoots,
      });
      const outcome = saveOwner.finish(operation);
      if (outcome === 'retired') return false;
      if (saved.status === 'missing-authority') {
        setEditDraft(null);
        onUnavailable();
        return false;
      }
      setState({
        status: 'ready',
        entity: saved.entity,
        bases: saved.bases,
        expectedContentHash: saved.expectedContentHash,
        registered: true,
        readOnly: false,
        fastaAuthority: state.fastaAuthority,
        sourcePath: state.sourcePath,
      });
      if (outcome === 'saved') {
        setEditDraft(null);
        useToastStore.getState().addToast(userMessage('notice.protein-sequence-saved'), {
          definition: 'protein-sequence-tab-protein-sequence-saved',
        });
      }
      return outcome === 'saved';
    } catch (error) {
      reportSaveFailure('[ProteinSequenceTab] Save failed:', { entityId }, error);
      if (saveOwner.finish(operation) === 'retired') return false;
      useToastStore.getState().addToast(toUserMessage(error, 'structure.failed'), {
        definition: 'protein-sequence-tab-handle-save',
      });
      return false;
    } finally {
      if (saveOwner.isCurrent(operation)) setSaving(false);
    }
  };

  useDocumentLifecycle({
    target: { kind: 'tab', tabId: canvasTabId ?? entityId },
    tabId: canvasTabId,
    isDirty: () =>
      state.status === 'ready' &&
      !state.readOnly &&
      editDraft !== null &&
      editDraft !== state.bases,
    save: handleSave,
    discard: () => {
      saveOwner.retire();
      setEditDraft(null);
    },
  });

  if (state.status === 'loading') {
    return (
      <div
        className="h-full flex items-center justify-center text-sm text-fg-muted"
        data-testid="protein-tab-loading"
      >
        Loading…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="h-full flex items-center justify-center p-6 text-center"
        data-testid="protein-tab-error"
      >
        <div className="max-w-md space-y-2">
          <div className="text-4xl text-fg-muted" aria-hidden="true">
            !
          </div>
          <p className="text-sm text-fg-muted">
            {toUserMessage(state.message, 'tracks.loadFailed')}
          </p>
          {state.canOpenAsSequence ? (
            <button
              type="button"
              className="rounded border border-border px-3 py-1.5 text-sm font-medium text-fg wp-interactive"
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('waypoint:open-entity', {
                    detail: {
                      entityId,
                      entityType: 'sequence',
                      label: state.entity.name,
                    },
                  })
                );
              }}
            >
              Open in sequence viewer
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const { entity, bases } = state;
  const sourceCds = typeof entity.fields.sourceCds === 'string' ? entity.fields.sourceCds : null;
  const organism = typeof entity.fields.organism === 'string' ? entity.fields.organism : null;

  const scopedSequence = (selection: ProteinResidueSelection | null) =>
    selection ? bases.slice(selection.start - 1, selection.end) : bases;

  const handleCopySequence = () => {
    const text = scopedSequence(contextMenu?.selection ?? null);
    void navigator.clipboard.writeText(text);
    useToastStore.getState().addToast(
      userMessageWithValues('notice.copied-value-residues', {
        value0: userMessageValue(text.length),
      }),
      {
        definition: 'protein-sequence-tab-copied-3-residues',
      }
    );
  };

  const handleBacktranslate = () => {
    if (state.readOnly) return;
    setBacktranslateSequence(scopedSequence(contextMenu?.selection ?? null));
  };

  const handleAskAI = () => {
    if (state.readOnly) return;
    void askAiAboutProtein(entity, contextMenu?.selection ?? null);
  };

  const handlePredictStructure = (selection: ProteinResidueSelection | null) => {
    if (state.readOnly) return;
    usePredictStructureStore.getState().open({
      sequence: scopedSequence(selection),
      name: selection ? `${entity.name} ${selection.start}-${selection.end}` : entity.name,
      preferredRoot: state.sourcePath,
    });
  };

  return (
    <div className="flex h-full" data-testid="protein-sequence-tab">
      <div className="h-full flex-1 overflow-auto p-4">
        {state.fastaAuthority && state.fastaAuthority.status !== 'declared' && (
          <FastaKindReadStatus authority={state.fastaAuthority} />
        )}
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="text-sm font-semibold text-fg">{entity.name}</h2>
          <span className="text-xs text-fg-subtle">
            {entity.registryId ?? (state.registered ? entity.id : 'Unregistered file')}
          </span>
          <span className="text-xs text-fg-subtle">· {bases.length} aa</span>
          <div className="ml-auto flex items-center gap-2">
            {!state.readOnly && state.expectedContentHash && (
              <button
                type="button"
                data-testid="protein-edit-sequence"
                onClick={() => setEditDraft(bases)}
                disabled={editDraft !== null}
                className="rounded border border-border px-2 py-1 text-xs font-medium text-fg-muted wp-interactive disabled:opacity-50"
              >
                Edit sequence
              </button>
            )}
            {!state.readOnly && (
              <>
                <button
                  type="button"
                  data-testid="protein-view-structure"
                  onClick={handleViewStructure}
                  className="rounded border border-border px-2 py-1 text-xs font-medium text-fg-muted wp-interactive "
                >
                  View Structure
                </button>
                <button
                  type="button"
                  data-testid="protein-predict-structure"
                  onClick={() => handlePredictStructure(null)}
                  className="rounded border border-border px-2 py-1 text-xs font-medium text-fg-muted wp-interactive "
                >
                  Predict Structure
                </button>
              </>
            )}
          </div>
        </div>
        {!state.readOnly && (
          <SavedMolecularStructures molecule={{ kind: 'protein', sequence: bases }} />
        )}
        {(sourceCds || organism) && (
          <div className="mb-4 flex flex-wrap gap-x-3 text-xs text-fg-muted">
            {sourceCds && <span>Source CDS: {sourceCds}</span>}
            {organism && <span>Organism: {organism}</span>}
          </div>
        )}
        {editDraft === null ? (
          <ProteinResidueTrack
            bases={bases}
            onContextMenu={({ x, y, selection }) => setContextMenu({ x, y, selection })}
          />
        ) : (
          <div className="space-y-3" data-testid="protein-sequence-editor">
            <textarea
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              aria-label="Amino-acid sequence"
              spellCheck={false}
              className="min-h-48 w-full resize-y rounded border border-border bg-bg p-3 font-mono text-sm uppercase tracking-wide text-fg focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditDraft(null)}
                disabled={saving}
                className="rounded border border-border px-3 py-1.5 text-xs font-medium text-fg-muted wp-interactive disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="protein-save-sequence"
                onClick={() => void handleSave()}
                disabled={saving || editDraft.trim().length === 0}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
      {activeDrawer === 'structure' && (
        <SequenceDrawer width={drawerWidth} onWidthChange={setDrawerWidth}>
          <StructureDrawerContent onCloseDrawer={closeDrawer} />
        </SequenceDrawer>
      )}
      {contextMenu && (
        <ProteinSequenceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          isOpen
          onClose={() => setContextMenu(null)}
          hasSelection={contextMenu.selection !== null}
          readOnly={state.readOnly}
          onCopySequence={handleCopySequence}
          onBacktranslate={handleBacktranslate}
          onAskAI={handleAskAI}
          onViewStructure={handleViewStructure}
          onPredictStructure={() => handlePredictStructure(contextMenu.selection)}
        />
      )}
      <BacktranslateResultDialog
        sequence={backtranslateSequence}
        onClose={() => setBacktranslateSequence(null)}
      />
    </div>
  );
}

function unregisteredProteinEntity(filePath: string): LimsEntity {
  const fileName = filePath.replace(/\\/gu, '/').split('/').pop() || 'Protein';
  return {
    id: filePath,
    kind: 'protein',
    schemaId: null,
    schemaRevisionId: 'unregistered-file',
    name: fileName.replace(/\.(?:faa|fna|fasta|fa)$/iu, '') || fileName,
    registryId: null,
    fields: {
      sequence: {
        mode: 'file',
        relPath: filePath,
        length: 0,
        contentHash: '',
        sourceFormat: 'fasta',
      } satisfies AminoAcidSequenceRef,
    },
    registrationStatus: 'unresolved',
    domainStatus: null,
    workspaceId: null,
    actor: null,
    eventSeq: null,
    tombstone: false,
    createdAt: 0,
    updatedAt: 0,
    archivedAt: null,
  };
}
