import { isTabDirty } from '../canvas/public/artifact-document-lifecycle';
import { useCanvasStore } from '../canvas/public/store';
import { presentDocument } from '../canvas/public/present-document';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../canvas/public/document-presentation';
import {
  molecularViewAttrs,
  sameMolecularViewData,
} from '../page/public/embeds/structure3d/molecularView';
import { useStructure3dStore } from '../page/public/embeds/structure3d/store';
import type { MolecularView } from '../../shared/molecular-view';
import { samePresentationAppearance } from '../page/public/embeds/structure3d/molecularPresentation';
import { viewerCache } from '../page/public/embeds/structure3d/molstar/cache';
import { captureMolViewSpecView } from '../page/public/embeds/structure3d/molstar/molViewSpec';
import type { Structure3dAttrs } from '../page/public/embeds/structure3d/types';
import { readMolecularDocument } from './services';
import {
  molecularDocumentRevision,
  molecularDocumentRevisionDigest,
  molecularDocumentCatalogId,
  type MolecularDocumentReference,
} from '../../shared/molecular-document-reference';
import { molecularReferenceSnapshotIndex } from '../../shared/molecular-reference';
import { savedSelectionRefsForDocument } from '../../shared/molecular-document';

type PinnedAsset = NonNullable<Structure3dAttrs['molViewSpecAssets']>[number];

function sameAssets(baseline: MolecularView, current: readonly PinnedAsset[]): boolean {
  const expected = baseline.version === 2 ? baseline.pinnedAssets : [];
  const assets = new Map(current.map((asset) => [asset.name, asset]));
  return (
    expected.length === current.length &&
    assets.size === current.length &&
    expected.every((saved) => {
      const asset = assets.get(saved.name);
      return (
        asset &&
        saved.format === asset.format &&
        saved.text === asset.text &&
        saved.sha256 === asset.sha256 &&
        saved.label === asset.label &&
        saved.sourceReferenceId === asset.sourceReferenceId
      );
    })
  );
}

function hasWorkingChanges(
  entityId: string,
  attrs: Structure3dAttrs,
  baseline: MolecularView | null,
  tabIsDirty: boolean
): boolean {
  if (!baseline) return true;
  if (!sameMolecularViewData(baseline, attrs)) return true;
  let capturedNative = false;
  for (const entry of viewerCache.values()) {
    if (!entry.plugin || !entry.container.isConnected || entry.isLoading || entry.error) continue;
    if (
      entry.container
        .closest('[data-structure-agent-host]')
        ?.getAttribute('data-structure-agent-host') !== entityId
    )
      continue;
    try {
      const current = captureMolViewSpecView(entry.plugin, {
        preserveUnchangedOpeningCamera: true,
      });
      capturedNative = true;
      if (
        !samePresentationAppearance(baseline.scene, current.scene) ||
        baseline.coordinates.format !== current.coordinates.format ||
        baseline.coordinates.text !== current.coordinates.text ||
        !sameAssets(baseline, current.pinnedAssets)
      )
        return true;
    } catch {}
  }
  if (capturedNative) return false;
  const camera = attrs.view?.cameraSnapshot ?? attrs.cameraSnapshot;
  return (
    tabIsDirty ||
    !attrs.molViewSpec ||
    !samePresentationAppearance(baseline.scene, attrs.molViewSpec) ||
    attrs.source !== 'file' ||
    attrs.sourceId !== baseline.coordinates.text ||
    (attrs.coordinateSha256 !== undefined &&
      attrs.coordinateSha256 !== baseline.coordinates.sha256) ||
    !sameAssets(baseline, attrs.molViewSpecAssets ?? []) ||
    camera !== baseline.cameraSnapshot
  );
}

function currentTabs(entityId: string) {
  return Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
    panel.tabs
      .filter((tab) => tab.type === 'structure' && tab.entityId === entityId)
      .map((tab) => ({ panelId: panel.id, tab }))
  );
}

function updateOpenDocument(entityId: string, attrs: Structure3dAttrs, clean: boolean): void {
  const structureStore = useStructure3dStore.getState();
  if (structureStore.expandedStructures[entityId])
    structureStore.updateStructureData(entityId, attrs);
  for (const { panelId, tab } of currentTabs(entityId))
    useCanvasStore.getState().updateTab(panelId, tab.id, {
      initialStructureAttrs: attrs,
      ...(clean ? { isDirty: false } : {}),
    });
}

export async function openMolecularDocument(
  path: string,
  request: {
    signal?: AbortSignal;
    placement?: OpenStrategy;
    workspaceRoot?: string;
    revisionId?: string;
    viewId?: string;
    snapshotIndex?: number;
    reference?: MolecularDocumentReference;
  }
): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const saved = await readMolecularDocument(path, request.workspaceRoot);
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const revisionId = request.revisionId ?? saved.document.currentReferenceId;
  const snapshot = molecularDocumentRevision(saved.document, revisionId);
  if (
    request.reference &&
    (saved.catalogEntityId !== molecularDocumentCatalogId(request.reference) ||
      revisionId !== request.reference.revisionId ||
      (await molecularDocumentRevisionDigest(snapshot)) !== request.reference.revisionSha256)
  )
    throw Error('The molecular document identity or pinned revision changed while opening.');
  const snapshotIndex = request.viewId
    ? molecularReferenceSnapshotIndex(snapshot, { viewId: request.viewId })
    : request.snapshotIndex;
  const historical = revisionId !== saved.document.currentReferenceId;
  const entityId = `molecular-document:${saved.catalogEntityId}${historical ? `@${revisionId}` : ''}`;
  if (historical) {
    return presentDocument(
      {
        type: 'structure',
        entityId,
        label: `${snapshot.title} (historical version)`,
        initialStructureAttrs: {
          ...molecularViewAttrs(entityId, snapshot, snapshotIndex, revisionId),
          molecularDocumentId: saved.document.id,
          molecularDocumentReference: request.reference ?? {
            ...saved.documentReference,
            revisionId,
            revisionSha256: await molecularDocumentRevisionDigest(snapshot),
          },
          molecularDocumentProjectId: saved.documentReference.projectId,
          molecularDocumentPath: saved.path,
          molecularDocumentRevision: saved.revision,
          molecularDocumentSavedReferenceId: saved.document.currentReferenceId,
          molecularDocumentHistoricalRevisionId: revisionId,
        },
      },
      request.placement
    );
  }
  let tabs = currentTabs(entityId);
  let existing = tabs.length
    ? useStructure3dStore.getState().expandedStructures[entityId]?.data
    : undefined;
  existing ??= tabs.find(({ tab }) => tab.initialStructureAttrs?.molViewSpec)?.tab
    .initialStructureAttrs;
  const binding = {
    molecularDocumentId: saved.document.id,
    molecularDocumentReference: request.reference ?? saved.documentReference,
    molecularDocumentProjectId: saved.documentReference.projectId,
    molecularDocumentPath: saved.path,
    molecularDocumentRevision: saved.revision,
    molecularDocumentSavedReferenceId: saved.document.currentReferenceId,
  };
  const savedSelectionRefs = savedSelectionRefsForDocument(saved);
  let attrs: Structure3dAttrs = {
    ...molecularViewAttrs(entityId, snapshot, snapshotIndex, saved.document.currentReferenceId),
    label: saved.document.name,
    ...binding,
    molecularDocumentHistoricalRevisionId: undefined,
    ...(savedSelectionRefs.length ? { savedSelectionRefs } : {}),
  };
  if (request.reference && existing) {
    if (
      hasWorkingChanges(
        entityId,
        existing,
        snapshot,
        tabs.some(({ tab }) => isTabDirty(tab))
      )
    )
      return {
        status: 'blocked',
        message:
          'This molecular document has unsaved edits. Save or discard them before opening the exact referenced revision.',
      };
    if (
      existing.molecularDocumentRevision === saved.revision &&
      existing.molecularDocumentSavedReferenceId === saved.document.currentReferenceId
    )
      attrs = {
        ...existing,
        ...binding,
        molViewSpec: snapshot.scene,
        molViewSpecSavedReferenceId: saved.document.currentReferenceId,
        molViewSpecSnapshotIndex: attrs.molViewSpecSnapshotIndex,
        highlightGroups: [],
      };
    updateOpenDocument(entityId, attrs, true);
  } else if (existing?.molecularDocumentRevision === saved.revision) {
    attrs = { ...existing, ...binding };
    updateOpenDocument(entityId, attrs, false);
  } else if (existing?.molViewSpec) {
    const baselineId =
      existing.molecularDocumentSavedReferenceId ?? existing.molViewSpecSavedReferenceId;
    const baseline =
      saved.document.history.find((entry) => entry.referenceId === baselineId)?.snapshot ?? null;
    if (request.signal?.aborted) return cancelledDocumentOpen();
    tabs = currentTabs(entityId);
    const current = useStructure3dStore.getState().expandedStructures[entityId]?.data ?? existing;
    if (current.molecularDocumentRevision !== existing.molecularDocumentRevision)
      return {
        status: 'blocked',
        message:
          'The molecular document changed while it was opening. Your working view is preserved. Reopen the file again.',
      };
    if (
      tabs.length &&
      hasWorkingChanges(
        entityId,
        current,
        baseline,
        tabs.some(({ tab }) => isTabDirty(tab))
      )
    ) {
      if (current.molecularDocumentPath !== saved.path)
        updateOpenDocument(entityId, { ...current, molecularDocumentPath: saved.path }, false);
      return {
        status: 'blocked',
        message:
          'The molecular document changed on disk while this tab has unsaved edits. Your working view is preserved. Close this tab and discard its edits before reopening the current file.',
      };
    }
    updateOpenDocument(entityId, attrs, true);
  } else {
    updateOpenDocument(entityId, attrs, true);
  }
  return presentDocument(
    {
      type: 'structure',
      entityId,
      label: saved.document.name,
      initialStructureAttrs: attrs,
    },
    request.placement
  );
}
