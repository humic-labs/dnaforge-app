import { userEntityLabel, userMessageWithValues } from '@waypoint/user-messages';
import { useCanvasStore } from '../features/canvas/public/store';
import { presentDocument } from '../features/canvas/public/present-document';
import type { Tab } from '../features/canvas/public/types';
import {
  presentedTabId,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../features/canvas/public/document-presentation';
import { REVEAL_OPEN_DOCUMENT_EVENT } from '../features/file-associations/handler-status-source';
import { openDocument } from '../features/document-opening/public/open-document';
import type { FileOpenSourceSurface } from '../features/sequence/public/file-open-telemetry';
import { platform } from '../platform';
import { externalFormatForPath } from '../shared/external-preview';
import type { ExternalPreviewReceipt } from '../shared/file-association-ipc';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { releasePresentedPreview } from './preview-tab-packages';

export type SourceViewerTab = NonNullable<Tab['sourceFileView']>;

export function sourceViewerTabId(view: SourceViewerTab): string {
  if (view.location === 'project' && view.projectPackageId)
    return (
      'source-view:project:' +
      JSON.stringify([view.workspaceRoot, view.path, view.projectPackageId])
    );
  return `source-view:${view.location}:${view.receipt?.packageId ?? view.path}`;
}

function openSourceViewer(view: SourceViewerTab, placement?: OpenStrategy): DocumentOpenResult {
  const label = view.sourceFileName ?? view.path.split(/[\\/]/u).pop() ?? view.path;
  return presentDocument(
    {
      type: 'file',
      entityId: sourceViewerTabId(view),
      label,
      readOnly: true,
      sourceFileView: view,
    },
    placement
  );
}

export function openProjectFastaCollection(
  path: string,
  placement?: OpenStrategy
): DocumentOpenResult {
  return openSourceViewer({ path, format: 'fasta', location: 'project' }, placement);
}

export async function openProjectSourcePackage(
  path: string,
  placement?: OpenStrategy,
  signal?: AbortSignal
): Promise<DocumentOpenResult> {
  const root =
    findWorkspaceRootForPath(useWorkspaceStore.getState().folders, path) ??
    findWorkspaceRootForPath((await platform().workspace.listRegisteredProjects?.()) ?? [], path);
  if (!root) throw new Error('Open the project containing this file in Files.');
  const doc = await platform().fileAssociations.describeProjectPreviewPackage({
    workspaceRoot: root,
    path,
  });
  if (signal?.aborted) return { status: 'cancelled', reason: 'aborted' };
  if (doc.presentation === 'sequence-package' || doc.presentation === 'molecular-document') {
    return openDocument({
      target: { kind: 'file', path: doc.entryPath },
      placement,
      signal,
      source: 'file_tree',
    });
  }
  if (doc.familyId !== 'fasta' && doc.familyId !== 'chromatogram')
    throw new Error('Unrecognized project source document.');
  return openSourceViewer(
    {
      path: doc.entryPath,
      format: doc.familyId,
      location: 'project',
      workspaceRoot: root,
      projectPackageId: doc.packageId,
      sourceFileName: doc.sourceFileName,
    },
    placement
  );
}

export function sourceViewForReceipt(receipt: ExternalPreviewReceipt): SourceViewerTab {
  if (receipt.familyId === 'genbank' || receipt.familyId === 'snapgene')
    throw new Error('A sequence package is required.');
  const { acquisitionId: _transient, ...durable } = receipt;
  return {
    path: receipt.sourceFileName,
    sourceFileName: receipt.sourceFileName,
    format: receipt.familyId,
    location: 'external',
    receipt: durable,
  };
}

export async function openExternalPreview(
  path: string,
  sourceSurface: FileOpenSourceSurface = 'menu'
): Promise<string | null> {
  const familyId = externalFormatForPath(path);
  const name = userEntityLabel(path.split(/[\\/]/u).pop());
  if (!familyId) {
    useToastStore
      .getState()
      .addToast(userMessageWithValues('document.externalPreviewUnsupported', { name }), {
        definition: 'file-open-failed',
      });
    return null;
  }
  try {
    const receipt = await platform().fileAssociations.openPreview({ sourcePath: path, familyId });
    try {
      const result = receipt.sequence
        ? await openDocument({
            target: { kind: 'sequence-package', path: receipt.sequence.packageRoot },
            label: receipt.sourceFileName,
            source: sourceSurface,
            sequenceOptions: { presentation: { kind: 'quick-look', receipt: receipt.sequence } },
          })
        : openSourceViewer(sourceViewForReceipt(receipt));
      if (result.status === 'presented' && receipt.sequence) {
        const { acquisitionId: _transient, ...durable } = receipt;
        useCanvasStore
          .getState()
          .updateTab(result.panelId, result.tabId, { previewReceipt: durable });
      }
      if (result.status === 'failed') throw new Error(result.message);
      const id = presentedTabId(result);
      if (id) window.dispatchEvent(new Event(REVEAL_OPEN_DOCUMENT_EVENT));
      return id;
    } finally {
      await releasePresentedPreview(receipt);
    }
  } catch (error) {
    console.error('[external preview]', error);
    useToastStore
      .getState()
      .addToast(userMessageWithValues('document.quickLookOpenFailed', { name }), {
        definition: 'file-open-failed',
      });
    return null;
  }
}

export async function openExternalFiles(paths: readonly string[], source: FileOpenSourceSurface) {
  for (const path of new Set(paths)) await openExternalPreview(path, source);
}
