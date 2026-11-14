import { reportSaveFailure } from '../../lib/report-save-failure';
import { documentLifecycle } from '../../shared/document-lifecycle';
import { useDocumentLifecycle } from '../../shared/use-document-lifecycle';
import { toUserMessage, userMessage, userEntityLabel } from '@waypoint/user-messages';

import { DraftSaveOwner } from '../../lib/draft-save-owner';
import { inferCatalogFileKind } from '../../shared/catalog-file-kind';
import { openDocument } from '../document-opening/public/open-document';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSONContent } from '@tiptap/core';
import {
  getCatalogEntityForFilePath,
  getCatalogWorkspaceRootForFilePath,
} from '../../db/workspace-catalog';
import { platform } from '../../platform';
import { scientificPackageKindForMetaPath } from '../../shared/scientific-package';
import { savedFormulaResultExplanation } from '../../shared/source-formula-result';
import {
  resolveNativeCatalogDestination,
  type NativeCatalogDestination,
} from '../../services/native-catalog-destination';
import { useCanvasStore } from '../canvas/public/store';
import { useDesignStore } from '../design/public';
import {
  registrationFromProtocol,
  usePaperProtocolReviewStore,
} from '../paper-protocol-review/public/store';
import { resolveMigrationSequenceDestinationPath } from '../../services/legacy-migration-sequence-destination';
import { usePageStore } from '../page/public';
import { openSequenceFile } from '../document-opening/public/compat';
import {
  resolveWorkspaceRevealPath,
  useWorkspaceStore,
  type WorkspaceFolder,
} from '../../stores/workspaceStore';
import { findContainingPathBoundary } from '../../shared/path-boundary';
import {
  addProtocolStep,
  appendProtocolRunTextAmendment,
  deleteProtocolStep,
  migrationWorkspaceMarkerPath,
  migrationWorkspaceRootForDocument,
  moveProtocolStep,
  parseScientificDocument,
  renameScientificDocument,
  safeExternalHttpUrl,
  serializeScientificDocument,
  updateProtocolOverview,
  updateProtocolStep,
  updateProteinSequence,
  type ScientificDocument,
  type ScientificLegacyCollectionDocument,
  type ScientificProtocolDocument,
  type ScientificProtocolRunDocument,
  type ScientificRichText,
} from './model';
import { useScientificDocumentFileWatcher } from './useScientificDocumentFileWatcher';
import { saveNativeScientificPackage } from './native-package';
import { withWorkspaceArtifactOpen } from '../../services/workspace-artifact-open';
import { isWorkspaceMutationBusyError } from '../../services/workspace-mutation-transaction';
import { readDesktopScientificDocument } from './services/desktop-scientific-documents';
import { commitReadableContent, failReadableContent } from '../../lib/readable-content-telemetry';

type ScientificDocumentTabProps = { filePath: string; canvasTabId?: string };

type AmendmentDraft = { path: string; reason: string; value: string };
type ProtocolStepDraft = { title: string; contentText: string };

export function resolveProtocolSourcePath(
  workspaceFolders: WorkspaceFolder[],
  protocolPath: string,
  workspacePath: string
): string | null {
  const directlyResolved = resolveWorkspaceRevealPath(workspaceFolders, workspacePath);
  if (directlyResolved) return directlyResolved;

  const owningWorkspace = findContainingPathBoundary(workspaceFolders, protocolPath);
  return owningWorkspace ? resolveWorkspaceRevealPath([owningWorkspace], workspacePath) : null;
}

const EMPTY_AMENDMENT: AmendmentDraft = {
  path: '/outputs/result',
  reason: '',
  value: '',
};

export function ScientificDocumentTab({ filePath, canvasTabId }: ScientificDocumentTabProps) {
  const [document, setDocument] = useState<ScientificDocument | null>(null);
  const [originalText, setOriginalText] = useState<string | null>(null);
  const [originalCanonicalText, setOriginalCanonicalText] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [proteinDraft, setProteinDraft] = useState('');
  const [protocolOverviewDraft, setProtocolOverviewDraft] = useState('');
  const [protocolStepDrafts, setProtocolStepDrafts] = useState<Record<string, ProtocolStepDraft>>(
    {}
  );
  const [workspaceUnlocked, setWorkspaceUnlocked] = useState(false);
  const [resolvedWorkspaceRoot, setResolvedWorkspaceRoot] = useState<string | null>(null);
  const [nativeDestinations, setNativeDestinations] = useState<
    Readonly<Record<string, NativeCatalogDestination>>
  >({});
  const [destinationNavigationMessage, setDestinationNavigationMessage] = useState<string | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [amendment, setAmendment] = useState<AmendmentDraft>(EMPTY_AMENDMENT);
  const openInFocusedPanel = useCanvasStore((state) => state.openInFocusedPanel);
  const upsertPageFromArtifact = usePageStore((state) => state.upsertPageFromArtifact);
  const upsertDesignFromArtifact = useDesignStore((state) => state.upsertDesignFromArtifact);
  const saveOwner = useMemo(() => new DraftSaveOwner(), [filePath]);
  const saveInFlight = useRef<{ owner: DraftSaveOwner; promise: Promise<boolean> } | null>(null);
  useEffect(() => {
    setSaving(false);
    setSaved(false);
    return () => saveOwner.retire();
  }, [saveOwner]);
  const reviewRootRef = useRef<HTMLDivElement>(null);
  const workspaceFolders = useWorkspaceStore((state) => state.folders);
  const selectedReviewStep = usePaperProtocolReviewStore((state) => state.selectedStep);
  const hoveredReviewStep = usePaperProtocolReviewStore((state) => state.hoveredStep);
  const selectReviewStep = usePaperProtocolReviewStore((state) => state.selectStep);
  const hoverReviewStep = usePaperProtocolReviewStore((state) => state.hoverStep);

  const adoptDocumentText = useCallback(
    (text: string) => {
      const parsed = parseScientificDocument(filePath, text);
      setDocument(parsed);
      setOriginalText(text);
      setOriginalCanonicalText(serializeScientificDocument(parsed));
      setTitleDraft(parsed.title);
      setProteinDraft(parsed.kind === 'protein' ? parsed.aminoAcids : '');
      setProtocolOverviewDraft(parsed.kind === 'protocol' ? parsed.overview.text : '');
      setProtocolStepDrafts(parsed.kind === 'protocol' ? stepDraftsForProtocol(parsed) : {});
    },
    [filePath]
  );
  const migrationWorkspaceRoot = useMemo(
    () => migrationWorkspaceRootForDocument(filePath),
    [filePath]
  );
  const mountedWorkspaceRoot = useMemo(
    () => findContainingPathBoundary(workspaceFolders, filePath)?.path ?? null,
    [filePath, workspaceFolders]
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setError(null);
      setNativeDestinations({});
      setResolvedWorkspaceRoot(migrationWorkspaceRoot);
      setDestinationNavigationMessage(null);
      try {
        const nativePackageKind = scientificPackageKindForMetaPath(filePath);
        const markerPath = nativePackageKind ? null : migrationWorkspaceMarkerPath(filePath);
        const catalogWorkspaceRoot = await getCatalogWorkspaceRootForFilePath(filePath).catch(
          () => null
        );
        const effectiveWorkspaceRoot =
          catalogWorkspaceRoot ?? migrationWorkspaceRoot ?? mountedWorkspaceRoot;
        if (!effectiveWorkspaceRoot) {
          throw new Error('The project containing this scientific document is unavailable.');
        }
        const [readResult, unlocked] = await Promise.all([
          readDesktopScientificDocument({
            filePath,
            workspaceRoot: effectiveWorkspaceRoot,
            signal: controller.signal,
          }),
          nativePackageKind
            ? Promise.resolve(true)
            : markerPath
              ? platform()
                  .fs.readTextFile(markerPath)
                  .then((markerText) => {
                    const marker = JSON.parse(markerText) as { status?: unknown };
                    return marker.status === 'unlocked';
                  })
                  .catch(() => false)
              : Promise.resolve(true),
        ]);
        if (cancelled) return;
        if (!readResult.ok) throw new Error(readResult.error.message);
        const text = readResult.document.content;
        adoptDocumentText(text);
        commitReadableContent(filePath);
        const parsed = parseScientificDocument(filePath, text);
        setResolvedWorkspaceRoot(effectiveWorkspaceRoot);
        setWorkspaceUnlocked(unlocked);
        if (effectiveWorkspaceRoot) {
          const destinationResults = await Promise.all(
            collectNativeDestinationIds(parsed).map(async (rawId) => {
              try {
                return {
                  entry: [
                    rawId,
                    await resolveNativeCatalogDestination({
                      workspaceRoot: effectiveWorkspaceRoot,
                      rawId,
                      readTextFileSlice: platform().fs.readTextFileSlice,
                    }),
                  ] as const,
                  error: null,
                };
              } catch (destinationError) {
                return {
                  entry: [rawId, null] as const,
                  error: toUserMessage(destinationError, 'failure.reference-lookup-failed'),
                };
              }
            })
          );
          if (!cancelled) {
            const destinationEntries = destinationResults.map((result) => result.entry);
            setNativeDestinations(
              Object.fromEntries(
                destinationEntries.filter(
                  (entry): entry is readonly [string, NativeCatalogDestination] => entry[1] !== null
                )
              )
            );
            const firstFailure = destinationResults.find((result) => result.error !== null)?.error;
            if (firstFailure) {
              setDestinationNavigationMessage(
                `Some preserved project references are unavailable: ${firstFailure}`
              );
            }
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          failReadableContent(filePath);
          setError(toUserMessage(loadError, 'failure.failed-to-open-document'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [adoptDocumentText, filePath, migrationWorkspaceRoot, mountedWorkspaceRoot]);

  const resolveDestination = useCallback(
    (targetId: string) => nativeDestinations[targetId] ?? null,
    [nativeDestinations]
  );

  const openDestination = useCallback(
    (target: NativeCatalogDestination) => {
      if (!workspaceUnlocked) return;
      setDestinationNavigationMessage(null);
      if (target.locator.kind === 'workspace_page') {
        window.dispatchEvent(
          new CustomEvent('waypoint:open-entity', {
            detail: {
              entityType: 'native-catalog',
              entityId: target.rawId,
              label: target.title,
              owningRoot: resolvedWorkspaceRoot,
            },
          })
        );
        return;
      }
      if (target.locator.kind === 'lims_entity') {
        window.dispatchEvent(
          new CustomEvent('waypoint:open-entity', {
            detail: {
              entityType: 'native-catalog',
              entityId: target.rawId,
              label: target.title,
              owningRoot: resolvedWorkspaceRoot,
            },
          })
        );
        return;
      }
      if (target.locator.kind === 'legacy_fasta') {
        void openDocument({
          target: { kind: 'file', path: target.locator.absolutePath },
          label: target.title,
          placement: { kind: 'focused' },
        }).then((result) => {
          if ('message' in result)
            setDestinationNavigationMessage(toUserMessage(result.message, 'operation.failed'));
        });
        return;
      }
      if (
        target.source === 'legacy_index' &&
        resolvedWorkspaceRoot &&
        inferCatalogFileKind(target.locator.absolutePath) === 'fasta' &&
        (target.locator.tabType === 'sequence' || target.locator.tabType === 'protein')
      ) {
        void openDocument({
          target: {
            kind: 'legacy-migration-file',
            workspaceRoot: resolvedWorkspaceRoot,
            targetId: target.rawId,
          },
          placement: { kind: 'focused' },
        }).then((result) => {
          if ('message' in result)
            setDestinationNavigationMessage(toUserMessage(result.message, 'operation.failed'));
        });
        return;
      }
      if (target.locator.tabType === 'sequence') {
        const sequenceLocator = target.locator;
        void (async () => {
          const sequencePath =
            target.source === 'legacy_index' && resolvedWorkspaceRoot
              ? await resolveMigrationSequenceDestinationPath({
                  fs: platform().fs,
                  indexedPath: sequenceLocator.absolutePath,
                  workspaceRoot: resolvedWorkspaceRoot,
                })
              : sequenceLocator.absolutePath;
          await openSequenceFile({
            filePath: sequencePath,
            label: target.title,
            strategy: { kind: 'focused' },
          });
        })().catch((navigationError: unknown) => {
          setDestinationNavigationMessage(
            toUserMessage(navigationError, 'document.referenceUnavailable')
          );
        });
        return;
      }
      if (target.locator.tabType === 'page' || target.locator.tabType === 'design') {
        void openWorkspaceArtifactDestination({
          path: target.locator.absolutePath,
          requestedTabType: target.locator.tabType,
          title: target.title,
          workspaceRoot: resolvedWorkspaceRoot,
          openInFocusedPanel,
          upsertDesignFromArtifact,
          upsertPageFromArtifact,
        }).catch((navigationError: unknown) => {
          setDestinationNavigationMessage(
            toUserMessage(navigationError, 'document.referenceUnavailable')
          );
        });
        return;
      }
      openInFocusedPanel(target.locator.tabType, target.locator.absolutePath, target.title);
    },
    [
      openInFocusedPanel,
      upsertDesignFromArtifact,
      upsertPageFromArtifact,
      resolvedWorkspaceRoot,
      workspaceUnlocked,
    ]
  );

  const prepared = useMemo(() => {
    if (!document) return { document: null, text: null, error: null };
    try {
      let next = document;
      if (titleDraft !== next.title) next = renameScientificDocument(next, titleDraft);
      if (next.kind === 'protocol') {
        if (protocolOverviewDraft !== next.overview.text) {
          next = updateProtocolOverview(next, protocolOverviewDraft);
        }
        for (const step of next.steps) {
          const draft = protocolStepDrafts[step.id];
          if (!draft) continue;
          if (draft.title !== step.title || draft.contentText !== step.content.text) {
            next = updateProtocolStep(next, step.id, {
              ...(draft.title !== step.title ? { title: draft.title } : {}),
              ...(draft.contentText !== step.content.text
                ? { contentText: draft.contentText }
                : {}),
            });
          }
        }
      }
      if (next.kind === 'protein' && proteinDraft !== next.aminoAcids) {
        next = updateProteinSequence(next, proteinDraft);
      }
      return { document: next, text: serializeScientificDocument(next), error: null };
    } catch (prepareError) {
      return {
        document: null,
        text: null,
        error: toUserMessage(prepareError, 'failure.document-is-invalid'),
      };
    }
  }, [document, proteinDraft, protocolOverviewDraft, protocolStepDrafts, titleDraft]);

  saveOwner.observeDraft(
    JSON.stringify({
      titleDraft,
      proteinDraft,
      protocolOverviewDraft,
      protocolStepDrafts,
      preparedText: prepared.text,
    })
  );

  const reviewDocument =
    prepared.document?.kind === 'protocol'
      ? prepared.document
      : document?.kind === 'protocol'
        ? document
        : null;
  const reviewRegistration = useMemo(
    () =>
      reviewDocument && reviewDocument.pdfSources.length > 0
        ? registrationFromProtocol(filePath, reviewDocument, (workspacePath) =>
            resolveProtocolSourcePath(workspaceFolders, filePath, workspacePath)
          )
        : null,
    [filePath, reviewDocument, workspaceFolders]
  );

  useEffect(() => {
    const reviewStore = usePaperProtocolReviewStore.getState();
    if (reviewRegistration) {
      reviewStore.registerProtocol(reviewRegistration);
    } else {
      reviewStore.unregisterProtocol(filePath);
    }
  }, [filePath, reviewRegistration]);

  useEffect(
    () => () => usePaperProtocolReviewStore.getState().unregisterProtocol(filePath),
    [filePath]
  );

  useEffect(() => {
    if (selectedReviewStep?.protocolPath !== filePath) return;
    const target = [
      ...(reviewRootRef.current?.querySelectorAll<HTMLElement>('[data-protocol-step-id]') ?? []),
    ].find((element) => element.dataset.protocolStepId === selectedReviewStep.stepId);
    if (typeof target?.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [filePath, selectedReviewStep]);

  const dirty = Boolean(
    document?.mutable &&
    originalCanonicalText !== null &&
    (prepared.error !== null || prepared.text !== originalCanonicalText)
  );

  const reloadDocumentFromDisk = useCallback(async () => {
    const operation = saveOwner.beginReload();
    try {
      const workspaceRoot = resolvedWorkspaceRoot ?? migrationWorkspaceRoot ?? mountedWorkspaceRoot;
      if (!workspaceRoot) {
        throw new Error('The project containing this scientific document is unavailable.');
      }
      const result = await readDesktopScientificDocument({ filePath, workspaceRoot });
      if (!result.ok) throw new Error(result.error.message);
      const disposition = saveOwner.reloadDisposition(operation);
      if (disposition === 'stale') return false;
      if (disposition === 'preserve-draft') {
        const text = result.document.content;
        const parsed = parseScientificDocument(filePath, text);
        setOriginalText(text);
        setOriginalCanonicalText(serializeScientificDocument(parsed));
        return false;
      }
      adoptDocumentText(result.document.content);
      setError(null);
      return true;
    } catch (reloadError) {
      if (!saveOwner.canAdoptReload(operation)) return false;
      setError(
        toUserMessage(reloadError, 'failure.failed-to-reload-the-externally-changed-document')
      );
      return false;
    }
  }, [
    saveOwner,
    adoptDocumentText,
    filePath,
    migrationWorkspaceRoot,
    mountedWorkspaceRoot,
    resolvedWorkspaceRoot,
  ]);

  const { acceptExternalChange, dismissExternalChange, externalChangePending, suppressNextChange } =
    useScientificDocumentFileWatcher({
      filePath,
      isDirty: dirty,
      onReload: (discardChanges) =>
        documentLifecycle.reload({ kind: 'file', filePath }, canvasTabId, discardChanges),
    });

  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!workspaceUnlocked) {
      setError(userMessage('failure.unlock-the-migrated-project-before-editing-this-document'));
      return false;
    }
    if (!prepared.document || !prepared.text || !originalText) {
      setError(
        prepared.error != null
          ? toUserMessage(prepared.error, 'failure.document-is-invalid')
          : userMessage('failure.document-is-invalid')
      );
      return false;
    }
    if (saveInFlight.current?.owner === saveOwner) return saveInFlight.current.promise;
    const operation = saveOwner.begin();
    if (!operation) return false;

    const run = (async () => {
      setSaving(true);
      setError(null);
      try {
        suppressNextChange();
        if (
          resolvedWorkspaceRoot &&
          scientificPackageKindForMetaPath(filePath) &&
          (prepared.document.kind === 'protocol' || prepared.document.kind === 'protocol_run')
        ) {
          await saveNativeScientificPackage({
            workspaceRoot: resolvedWorkspaceRoot,
            metaPath: filePath,
            document: prepared.document,
            expectedText: originalText,
          });
        } else if (resolvedWorkspaceRoot) {
          await platform().fs.writeWorkspaceTextFileAtomic({
            workspaceRoot: resolvedWorkspaceRoot,
            path: filePath,
            content: prepared.text,
            mode: 'replace',
            expectedContentHash: await sha256Hex(originalText),
          });
        } else {
          await platform().fs.writeTextFile(filePath, prepared.text);
        }
        const outcome = saveOwner.finish(operation);
        if (outcome === 'retired') return false;
        setOriginalText(prepared.text);
        setOriginalCanonicalText(prepared.text);
        dismissExternalChange();
        if (outcome === 'saved') {
          setDocument(prepared.document);
          setTitleDraft(prepared.document.title);
          if (prepared.document.kind === 'protein') {
            setProteinDraft(prepared.document.aminoAcids);
          }
          if (prepared.document.kind === 'protocol') {
            setProtocolOverviewDraft(prepared.document.overview.text);
            setProtocolStepDrafts(stepDraftsForProtocol(prepared.document));
          }
        }
        setSaved(outcome === 'saved');
        if (outcome === 'saved')
          window.setTimeout(() => {
            if (saveOwner.isCurrent(operation)) setSaved(false);
          }, 1_500);
        return outcome === 'saved';
      } catch (saveError) {
        reportSaveFailure(
          '[ScientificDocumentTab] Save failed:',
          { filePath, tabId: canvasTabId },
          saveError
        );
        if (saveOwner.finish(operation) === 'retired') return false;
        setError(toUserMessage(saveError, 'failure.failed-to-save-document'));
        return false;
      } finally {
        if (saveOwner.isCurrent(operation)) setSaving(false);
      }
    })();
    saveInFlight.current = { owner: saveOwner, promise: run };
    try {
      return await run;
    } finally {
      if (saveInFlight.current?.promise === run) saveInFlight.current = null;
    }
  }, [
    canvasTabId,
    saveOwner,
    dismissExternalChange,
    dirty,
    filePath,
    originalText,
    prepared,
    resolvedWorkspaceRoot,
    suppressNextChange,
    workspaceUnlocked,
  ]);

  useDocumentLifecycle({
    target: { kind: 'file', filePath },
    tabId: canvasTabId,
    isDirty: () => dirty,
    save,
    reload: reloadDocumentFromDisk,
    discard: () => {
      saveOwner.retire();
      if (originalText !== null) adoptDocumentText(originalText);
    },
  });

  const addAmendment = useCallback(async () => {
    if (!document || document.kind !== 'protocol_run') return;
    setError(null);
    try {
      const next = await appendProtocolRunTextAmendment(document, amendment);
      setDocument(next);
      setAmendment(EMPTY_AMENDMENT);
    } catch (amendmentError) {
      setError(toUserMessage(amendmentError, 'failure.failed-to-add-amendment'));
    }
  }, [amendment, document]);

  const applyProtocolDocument = useCallback((next: ScientificProtocolDocument) => {
    setDocument(next);
    setProtocolOverviewDraft(next.overview.text);
    setProtocolStepDrafts(stepDraftsForProtocol(next));
  }, []);

  const handleAddProtocolStep = useCallback(async () => {
    const current = prepared.document;
    if (!current || current.kind !== 'protocol') return;
    setError(null);
    try {
      applyProtocolDocument(
        await addProtocolStep(current, {
          title: `New step ${current.steps.length + 1}`,
          contentText: '',
        })
      );
    } catch (stepError) {
      setError(toUserMessage(stepError, 'failure.failed-to-add-protocol-step'));
    }
  }, [applyProtocolDocument, prepared.document]);

  const handleDeleteProtocolStep = useCallback(
    (stepId: string) => {
      const current = prepared.document;
      if (!current || current.kind !== 'protocol') return;
      setError(null);
      try {
        applyProtocolDocument(deleteProtocolStep(current, stepId));
      } catch (stepError) {
        setError(toUserMessage(stepError, 'failure.failed-to-delete-protocol-step'));
      }
    },
    [applyProtocolDocument, prepared.document]
  );

  const handleMoveProtocolStep = useCallback(
    (stepId: string, direction: 'up' | 'down') => {
      const current = prepared.document;
      if (!current || current.kind !== 'protocol') return;
      applyProtocolDocument(moveProtocolStep(current, stepId, direction));
    },
    [applyProtocolDocument, prepared.document]
  );

  if (loading) return <CenteredMessage>Loading scientific document…</CenteredMessage>;
  if (!document)
    return (
      <CenteredMessage tone="error">
        {error != null
          ? toUserMessage(error, 'failure.document-unavailable')
          : userMessage('failure.document-unavailable')}
      </CenteredMessage>
    );

  const canEdit = workspaceUnlocked && document.mutable;
  const protocolDocument =
    document.kind === 'protocol'
      ? prepared.document?.kind === 'protocol'
        ? prepared.document
        : document
      : null;
  const protocolBody = protocolDocument ? (
    <ProtocolBody
      canEdit={canEdit}
      canNavigate={workspaceUnlocked}
      document={protocolDocument}
      overviewDraft={protocolOverviewDraft}
      stepDrafts={protocolStepDrafts}
      onAddStep={handleAddProtocolStep}
      onDeleteStep={handleDeleteProtocolStep}
      onMoveStep={handleMoveProtocolStep}
      onOverviewChange={setProtocolOverviewDraft}
      onOpenDestination={openDestination}
      onStepDraftChange={(stepId, draft) =>
        setProtocolStepDrafts((current) => ({ ...current, [stepId]: draft }))
      }
      resolveDestination={resolveDestination}
      hoveredStepId={hoveredReviewStep?.protocolPath === filePath ? hoveredReviewStep.stepId : null}
      selectedStepId={
        selectedReviewStep?.protocolPath === filePath ? selectedReviewStep.stepId : null
      }
      onHoverStep={(stepId) =>
        reviewRegistration
          ? hoverReviewStep(stepId ? { protocolPath: filePath, stepId } : null)
          : undefined
      }
      onSelectStep={(stepId) => {
        if (reviewRegistration) selectReviewStep({ protocolPath: filePath, stepId });
      }}
    />
  ) : null;
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg"
      data-testid="scientific-document-tab"
      ref={reviewRootRef}
    >
      <header className="flex min-h-12 items-center gap-3 border-b border-border px-4 py-2">
        <KindBadge document={document} />
        <input
          aria-label="Document title"
          className="min-w-0 flex-1 border-0 border-b border-transparent bg-transparent px-0 py-1 text-base font-semibold text-fg outline-none enabled:hover:border-border enabled:focus:border-accent disabled:opacity-100"
          disabled={!canEdit || document.kind === 'protocol_run'}
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
        />
        {dirty ? <span className="text-xs font-medium text-warning">Unsaved</span> : null}
        {saved && !dirty ? <span className="text-xs font-medium text-success">Saved</span> : null}
        {canEdit ? (
          <button
            type="button"
            className="border border-accent bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            disabled={!dirty || saving || Boolean(prepared.error)}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </header>

      {!workspaceUnlocked ? (
        <Notice>Read-only migration staging. Validate and unlock the project to edit.</Notice>
      ) : document.kind === 'protocol_run' && !document.mutable ? (
        <Notice>Completed imported run · immutable</Notice>
      ) : document.kind === 'legacy_collection' ? (
        <Notice>Legacy migration folder · read-only compatibility view</Notice>
      ) : null}
      {prepared.error ? (
        <Notice tone="error">{toUserMessage(prepared.error, 'operation.failed')}</Notice>
      ) : null}
      {error ? <Notice tone="error">{toUserMessage(error, 'operation.failed')}</Notice> : null}
      {destinationNavigationMessage ? <Notice>{destinationNavigationMessage}</Notice> : null}
      {externalChangePending ? (
        <div
          className="flex items-center gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-fg"
          data-testid="scientific-document-external-change"
        >
          <span>This protocol changed on disk while you have unsaved edits.</span>
          <button
            className="border-b border-warning px-1 py-0.5 hover:bg-warning/20"
            onClick={acceptExternalChange}
            type="button"
          >
            Reload
          </button>
          <button
            className="border-b border-transparent px-1 py-0.5 text-fg-muted hover:border-border"
            onClick={dismissExternalChange}
            type="button"
          >
            Keep my edits
          </button>
        </div>
      ) : null}

      <main className="min-h-0 flex-1 overflow-auto p-5">
        {protocolBody}
        {document.kind === 'protocol_run' ? (
          <ProtocolRunBody
            amendment={amendment}
            canAmend={canEdit}
            document={document}
            onAddAmendment={addAmendment}
            onAmendmentChange={setAmendment}
          />
        ) : null}
        {document.kind === 'legacy_collection' ? (
          <LegacyFolderBody
            canNavigate={workspaceUnlocked}
            document={document}
            onOpenDestination={openDestination}
            resolveDestination={resolveDestination}
          />
        ) : null}
        {document.kind === 'protein' ? (
          <ProteinBody
            canEdit={canEdit}
            document={document}
            sequence={proteinDraft}
            onSequenceChange={setProteinDraft}
          />
        ) : null}
      </main>
    </div>
  );
}

function KindBadge({ document }: { document: ScientificDocument }) {
  const label =
    document.kind === 'protocol_run'
      ? 'Protocol run'
      : document.kind === 'legacy_collection'
        ? 'Legacy folder'
        : document.kind[0].toUpperCase() + document.kind.slice(1);
  return (
    <span className="shrink-0 border-r border-border pr-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
      {label}
    </span>
  );
}

function ProtocolBody({
  canEdit,
  canNavigate,
  document,
  overviewDraft,
  stepDrafts,
  onAddStep,
  onDeleteStep,
  onMoveStep,
  onOverviewChange,
  onOpenDestination,
  onStepDraftChange,
  resolveDestination,
  hoveredStepId,
  selectedStepId,
  onHoverStep,
  onSelectStep,
}: {
  canEdit: boolean;
  canNavigate: boolean;
  document: ScientificProtocolDocument;
  overviewDraft: string;
  stepDrafts: Record<string, ProtocolStepDraft>;
  onAddStep: () => Promise<void>;
  onDeleteStep: (stepId: string) => void;
  onMoveStep: (stepId: string, direction: 'up' | 'down') => void;
  onOverviewChange: (value: string) => void;
  onOpenDestination: (target: NativeCatalogDestination) => void;
  onStepDraftChange: (stepId: string, value: ProtocolStepDraft) => void;
  resolveDestination: (targetId: string) => NativeCatalogDestination | null;
  hoveredStepId: string | null;
  selectedStepId: string | null;
  onHoverStep: (stepId: string | null) => void;
  onSelectStep: (stepId: string) => void;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-7">
      <MetadataRow label="Pinned source version" value={document.versionLabel} />
      <Section title="Overview">
        <RichTextView
          canNavigate={canNavigate}
          content={document.overview}
          empty="No overview provided."
          onOpenDestination={onOpenDestination}
          resolveDestination={resolveDestination}
        />
        {canEdit ? (
          <textarea
            aria-label="Protocol overview"
            className="mt-3 min-h-28 w-full border border-border bg-bg px-3 py-2 text-sm leading-6 text-fg outline-none focus:border-accent"
            value={overviewDraft}
            onChange={(event) => onOverviewChange(event.target.value)}
          />
        ) : null}
      </Section>
      <Section title="Ordered steps">
        <ol className="space-y-3">
          {document.steps.map((step, index) => {
            const draft = stepDrafts[step.id] ?? {
              title: step.title,
              contentText: step.content.text,
            };
            return (
              <li
                className={`border-l-2 border-t border-l-transparent border-t-border px-3 py-5 first:border-t-0 ${
                  selectedStepId === step.id
                    ? 'border-l-accent bg-accent/5'
                    : hoveredStepId === step.id
                      ? 'bg-bg-hover'
                      : ''
                }`}
                data-protocol-step-id={step.id}
                data-review-selected={selectedStepId === step.id ? 'true' : 'false'}
                key={step.id}
                onClick={() => onSelectStep(step.id)}
                onMouseEnter={() => onHoverStep(step.id)}
                onMouseLeave={() => onHoverStep(null)}
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                      Step {step.ordinal}
                    </span>
                    {step.sourceStatus ? <SourceStatusBadge status={step.sourceStatus} /> : null}
                    {step.pdfAnchors.length > 0 ? (
                      <button
                        className="border-b border-accent/50 text-[11px] font-medium text-accent hover:border-accent"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectStep(step.id);
                        }}
                        type="button"
                      >
                        {pageLabel(step.pdfAnchors.map((anchor) => anchor.page))}
                      </button>
                    ) : null}
                  </span>
                  {canEdit ? (
                    <span className="flex gap-1">
                      <StepAction
                        disabled={index === 0}
                        label={`Move step ${step.ordinal} up`}
                        onClick={() => onMoveStep(step.id, 'up')}
                      >
                        ↑
                      </StepAction>
                      <StepAction
                        disabled={index === document.steps.length - 1}
                        label={`Move step ${step.ordinal} down`}
                        onClick={() => onMoveStep(step.id, 'down')}
                      >
                        ↓
                      </StepAction>
                      <StepAction
                        disabled={document.steps.length === 1}
                        label={`Delete step ${step.ordinal}`}
                        onClick={() => onDeleteStep(step.id)}
                      >
                        Delete
                      </StepAction>
                    </span>
                  ) : null}
                </div>
                {canEdit ? (
                  <input
                    aria-label={`Step ${step.ordinal} title`}
                    className="w-full border-0 border-b border-border bg-transparent px-0 py-1.5 font-medium text-fg outline-none focus:border-accent"
                    value={draft.title}
                    onChange={(event) =>
                      onStepDraftChange(step.id, { ...draft, title: event.target.value })
                    }
                  />
                ) : (
                  <h3 className="font-medium text-fg">{step.title}</h3>
                )}
                <div className="mt-2">
                  <RichTextView
                    canNavigate={canNavigate}
                    content={step.content}
                    empty="Preserved empty step."
                    onOpenDestination={onOpenDestination}
                    resolveDestination={resolveDestination}
                  />
                </div>
                {canEdit ? (
                  <textarea
                    aria-label={`Step ${step.ordinal} content`}
                    className="mt-3 min-h-24 w-full border border-border bg-bg px-3 py-2 text-sm leading-6 text-fg outline-none focus:border-accent"
                    value={draft.contentText}
                    onChange={(event) =>
                      onStepDraftChange(step.id, {
                        ...draft,
                        contentText: event.target.value,
                      })
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
        {canEdit ? (
          <button
            type="button"
            className="mt-4 border border-border bg-bg px-3 py-1.5 text-xs font-medium text-fg hover:border-fg-muted hover:bg-bg-subtle"
            onClick={() => void onAddStep()}
          >
            Add step
          </button>
        ) : null}
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <SlotDeclarations title="Inputs" values={document.inputs} />
        <SlotDeclarations title="Outputs" values={document.outputs} />
      </div>
      <SourceLink url={document.sourceUrl} />
    </div>
  );
}

function SourceStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'hole'
      ? 'border-warning text-warning'
      : status === 'edited'
        ? 'border-border text-fg-muted'
        : status === 'resolved'
          ? 'border-success text-success'
          : 'border-accent text-accent';
  return (
    <span
      className={`border-l-2 pl-1.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}
      data-source-status={status}
    >
      {status}
    </span>
  );
}

function pageLabel(pages: number[]): string {
  const uniquePages = [...new Set(pages)].sort((left, right) => left - right);
  return `${uniquePages.length === 1 ? 'Page' : 'Pages'} ${uniquePages.join(', ')}`;
}

function ProtocolRunBody({
  amendment,
  canAmend,
  document,
  onAddAmendment,
  onAmendmentChange,
}: {
  amendment: AmendmentDraft;
  canAmend: boolean;
  document: ScientificProtocolRunDocument;
  onAddAmendment: () => Promise<void>;
  onAmendmentChange: (value: AmendmentDraft) => void;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetadataRow label="Status" value={document.status.replace('_', ' ')} />
        <MetadataRow label="Pinned protocol" value={document.protocolName} />
        <MetadataRow label="Protocol version" value={document.protocolVersion} />
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <RunValues title="Inputs" values={document.inputs} />
        <RunValues title="Outputs" values={document.outputs} />
        <RunValues title="Measurements" values={document.measurements} />
      </div>
      {document.tables.map((table) => (
        <Section key={table.id} title={table.name}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <tbody>
                {table.cells.map((row, rowIndex) => (
                  <tr key={`${table.id}-${rowIndex}`}>
                    {row.map((cell, columnIndex) => (
                      <td
                        className="border border-border px-3 py-2 text-fg"
                        key={`${table.id}-${rowIndex}-${columnIndex}`}
                      >
                        {cell.value}
                        {cell.savedResult && (
                          <span
                            role="img"
                            aria-label={savedFormulaResultExplanation(cell.savedResult)}
                            title={savedFormulaResultExplanation(cell.savedResult)}
                            tabIndex={0}
                            className={`mt-1 block max-w-full whitespace-normal break-words text-[10px] leading-3 focus-visible:outline focus-visible:outline-1 ${cell.savedResult.stale ? 'text-warning' : 'text-fg-muted'}`}
                          >
                            {cell.savedResult.stale ? 'May be outdated' : 'Saved'}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
      {document.amendments.length > 0 ? (
        <Section title="Local amendments">
          <ol className="space-y-2 text-sm">
            {document.amendments.map((item) => (
              <li className="border-l-2 border-border py-2 pl-3" key={item.id}>
                <span className="font-medium text-fg">{item.reason}</span>
                <span className="ml-2 font-mono text-xs text-fg-muted">{item.path}</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}
      {canAmend ? (
        <Section title="Add amendment">
          <div className="grid gap-3">
            <input
              aria-label="Amendment path"
              className="border border-border bg-bg px-3 py-2 text-sm text-fg"
              value={amendment.path}
              onChange={(event) => onAmendmentChange({ ...amendment, path: event.target.value })}
            />
            <input
              aria-label="Amendment reason"
              className="border border-border bg-bg px-3 py-2 text-sm text-fg"
              placeholder="Reason"
              value={amendment.reason}
              onChange={(event) => onAmendmentChange({ ...amendment, reason: event.target.value })}
            />
            <textarea
              aria-label="Amendment value"
              className="min-h-20 border border-border bg-bg px-3 py-2 text-sm text-fg"
              placeholder="Preserved amendment value"
              value={amendment.value}
              onChange={(event) => onAmendmentChange({ ...amendment, value: event.target.value })}
            />
            <button
              type="button"
              className="w-fit border border-border px-3 py-1.5 text-xs font-medium text-fg hover:bg-bg-subtle"
              onClick={() => void onAddAmendment()}
            >
              Add amendment
            </button>
          </div>
        </Section>
      ) : null}
      <SourceLink url={document.sourceUrl} />
    </div>
  );
}

function LegacyFolderBody({
  canNavigate,
  document,
  onOpenDestination,
  resolveDestination,
}: {
  canNavigate: boolean;
  document: ScientificLegacyCollectionDocument;
  onOpenDestination: (target: NativeCatalogDestination) => void;
  resolveDestination: (targetId: string) => NativeCatalogDestination | null;
}) {
  const references = (ids: string[], empty: string) =>
    ids.length > 0 ? (
      <div className="flex flex-wrap gap-2">
        {ids.map((id) => {
          const target = resolveDestination(id);
          return canNavigate && target ? (
            <button
              type="button"
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-accent hover:bg-bg-subtle"
              key={id}
              onClick={() => onOpenDestination(target)}
            >
              {target.title}
            </button>
          ) : (
            <span
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-fg-muted"
              key={id}
            >
              {userEntityLabel(target?.title)}
            </span>
          );
        })}
      </div>
    ) : (
      <p className="text-sm text-fg-muted">{empty}</p>
    );

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <MetadataRow label="Legacy folder ID" value={document.id} />
      {document.parentCollectionId ? (
        <Section title="Parent folder">
          {references([document.parentCollectionId], 'No parent folder.')}
        </Section>
      ) : null}
      <Section title={`Child folders (${document.childCollectionIds.length})`}>
        {references(document.childCollectionIds, 'No included child folders.')}
      </Section>
      <Section title={`Members (${document.memberObjectIds.length})`}>
        {references(document.memberObjectIds, 'No included members.')}
      </Section>
      {document.excludedChildren.length > 0 ? (
        <Section title="Excluded by the original migration scope">
          <ul className="space-y-1 text-sm text-fg-muted">
            {document.excludedChildren.map((child) => (
              <li key={child.id}>{child.name}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <SourceLink url={document.sourceUrl} />
    </div>
  );
}

function ProteinBody({
  canEdit,
  document,
  sequence,
  onSequenceChange,
}: {
  canEdit: boolean;
  document: Extract<ScientificDocument, { kind: 'protein' }>;
  sequence: string;
  onSequenceChange: (value: string) => void;
}) {
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetadataRow label="Identifier" value={document.identifier} />
        <MetadataRow label="Residues" value={String(sequence.replace(/\s+/g, '').length)} />
      </div>
      <Section title="Amino-acid sequence">
        <textarea
          aria-label="Amino-acid sequence"
          className="min-h-64 w-full resize-y border border-border bg-bg px-4 py-3 font-mono text-sm leading-6 tracking-wide text-fg disabled:opacity-100"
          disabled={!canEdit}
          spellCheck={false}
          value={sequence}
          onChange={(event) => onSequenceChange(event.target.value)}
        />
      </Section>
      <p className="text-xs text-fg-muted">
        Protein FASTA is rendered as amino acids and never sent to the nucleotide sequence viewer.
      </p>
    </div>
  );
}

function RichTextView({
  canNavigate,
  content,
  empty,
  onOpenDestination,
  resolveDestination,
}: {
  canNavigate: boolean;
  content: ScientificRichText;
  empty: string;
  onOpenDestination: (target: NativeCatalogDestination) => void;
  resolveDestination: (targetId: string) => NativeCatalogDestination | null;
}) {
  if (content.segments.length === 0) {
    return <p className="text-sm leading-6 text-fg-muted">{empty}</p>;
  }
  return (
    <p className="whitespace-pre-wrap text-sm leading-6 text-fg">
      {content.segments.map((segment, index) => {
        if (!segment.link) return <span key={index}>{segment.text}</span>;
        if (segment.link.kind === 'external') {
          return (
            <a
              className="text-accent underline underline-offset-2"
              href={segment.link.href}
              key={index}
              rel="noopener noreferrer"
              target="_blank"
            >
              {segment.text}
            </a>
          );
        }
        const target = resolveDestination(segment.link.destinationTargetId);
        if (!canNavigate || !target) {
          return (
            <span
              className="text-fg-muted underline decoration-dotted underline-offset-2"
              data-migration-target={segment.link.destinationTargetId}
              key={index}
              title={
                canNavigate
                  ? 'Preserved reference unavailable in this migration snapshot'
                  : 'Preserved reference available after project unlock'
              }
            >
              {segment.text}
              <span className="ml-1 text-[10px] no-underline">
                (preserved reference unavailable)
              </span>
            </span>
          );
        }
        return (
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            data-migration-target={segment.link.destinationTargetId}
            key={index}
            onClick={() => onOpenDestination(target)}
          >
            {segment.text}
          </button>
        );
      })}
    </p>
  );
}

function StepAction({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="border-l border-border px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-subtle hover:text-fg disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SlotDeclarations({
  title,
  values,
}: {
  title: string;
  values: Array<{ key: string; label: string; required: boolean; type: string }>;
}) {
  return (
    <Section title={title}>
      <ul className="space-y-2">
        {values.map((slot) => (
          <li className="flex items-start justify-between gap-3 text-sm" key={slot.key}>
            <span className="text-fg">
              {slot.label}
              {slot.required ? <span className="ml-1 text-warning">required</span> : null}
            </span>
            <span className="border-l border-border pl-2 font-mono text-xs text-fg-muted">
              {slot.type}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RunValues({
  title,
  values,
}: {
  title: string;
  values: Array<{ key: string; label: string; value: string }>;
}) {
  return (
    <Section title={title}>
      <dl className="space-y-2">
        {values.map((slot) => (
          <div key={slot.key}>
            <dt className="text-xs text-fg-muted">{slot.label}</dt>
            <dd className="text-sm text-fg">{slot.value}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="border-t border-border pt-5">
      <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-border py-1 pl-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-fg-muted">
        {label}
      </div>
      <div className="mt-1 break-all text-sm font-medium text-fg">{value}</div>
    </div>
  );
}

function SourceLink({ url }: { url: string | null }) {
  if (!url) return null;
  const safeUrl = safeExternalHttpUrl(url);
  return safeUrl ? (
    <a
      className="text-xs text-accent hover:underline"
      href={safeUrl}
      rel="noopener noreferrer"
      target="_blank"
    >
      Open immutable Benchling source reference
    </a>
  ) : (
    <span className="text-xs text-fg-muted" data-testid="preserved-unsafe-source-reference">
      Immutable source reference preserved, but unsafe navigation is unavailable.
    </span>
  );
}

function Notice({
  children,
  tone = 'info',
}: {
  children: React.ReactNode;
  tone?: 'info' | 'error';
}) {
  return (
    <div
      className={`border-b px-4 py-2 text-xs ${
        tone === 'error'
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-border bg-bg-subtle text-fg-muted'
      }`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}

function CenteredMessage({
  children,
  tone = 'normal',
}: {
  children: React.ReactNode;
  tone?: 'normal' | 'error';
}) {
  return (
    <div
      className={`flex h-full items-center justify-center p-6 text-sm ${
        tone === 'error' ? 'text-danger' : 'text-fg-muted'
      }`}
      role={tone === 'error' ? 'alert' : undefined}
    >
      {children}
    </div>
  );
}

async function openWorkspaceArtifactDestination(input: {
  path: string;
  requestedTabType: 'page' | 'design';
  title: string;
  workspaceRoot: string | null;
  openInFocusedPanel: (type: 'page' | 'design', entityId: string, label: string) => string;
  upsertPageFromArtifact: ReturnType<typeof usePageStore.getState>['upsertPageFromArtifact'];
  upsertDesignFromArtifact: ReturnType<typeof useDesignStore.getState>['upsertDesignFromArtifact'];
}): Promise<void> {
  try {
    await withWorkspaceArtifactOpen({
      path: input.path,
      workspaceRoot: input.workspaceRoot,
      consume: async (resolved, mutationToken) => {
        if (input.requestedTabType === 'page' && resolved.artifact.kind === 'notebook') {
          await input.upsertPageFromArtifact({
            id: resolved.entity.id,
            title: resolved.artifact.title,
            content: resolved.artifact.content as JSONContent,
            workspaceRoot: input.workspaceRoot,
            mutationToken,
          });
          input.openInFocusedPanel(
            'page',
            resolved.entity.id,
            resolved.artifact.title || input.title
          );
          return;
        }
        if (input.requestedTabType === 'design' && resolved.artifact.kind === 'assembly-design') {
          if (resolved.artifact.design) input.upsertDesignFromArtifact(resolved.artifact.design);
          input.openInFocusedPanel(
            'design',
            resolved.entity.id,
            useDesignStore.getState().designs[resolved.entity.id]?.name ||
              resolved.artifact.name ||
              input.title
          );
          return;
        }
        throw new Error(
          `Indexed ${input.requestedTabType} locator does not match its artifact type.`
        );
      },
    });
  } catch (error) {
    if (isWorkspaceMutationBusyError(error)) throw error;
    const entity = await getCatalogEntityForFilePath(input.path);
    if (input.requestedTabType === 'page' && entity?.type === 'notebook') {
      input.openInFocusedPanel('page', entity.id, entity.name || input.title);
      return;
    }
    if (input.requestedTabType === 'design' && entity?.type === 'design') {
      input.openInFocusedPanel('design', entity.id, entity.name || input.title);
      return;
    }
    throw error;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function collectNativeDestinationIds(document: ScientificDocument): string[] {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'destinationTargetId' && typeof child === 'string' && child.trim()) {
        ids.add(child.trim());
      } else {
        visit(child);
      }
    }
  };
  if (document.kind === 'legacy_collection') {
    [
      ...(document.parentCollectionId ? [document.parentCollectionId] : []),
      ...document.childCollectionIds,
      ...document.memberObjectIds,
    ].forEach((id) => ids.add(id));
  } else if (document.kind !== 'protein') {
    visit(document.raw);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function stepDraftsForProtocol(
  document: ScientificProtocolDocument
): Record<string, ProtocolStepDraft> {
  return Object.fromEntries(
    document.steps.map((step) => [step.id, { title: step.title, contentText: step.content.text }])
  );
}
