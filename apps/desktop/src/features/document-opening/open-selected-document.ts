import { isFastaSource } from '../../shared/preserved-fasta';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { isBrowserOnly, isHostedBrowserRuntime } from '../../utils/environment';
import { useToastStore } from '../../stores/toast-store';
import type { TabType } from '../canvas/public/types';
import { useCanvasStore } from '../canvas/public/store';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../canvas/public/document-presentation';
import {
  bindElectronWorkspaceSessionTab,
  closeElectronWorkspaceSessionFile,
  openElectronWorkspaceSessionFile,
} from '../workspace-session/public/electron-session';
import {
  awaitTrackViewPresentation,
  openDocument,
  resolveFileDocumentKindFromSource,
} from './open-document';
import { TRACK_VIEW_SUFFIX } from '../../shared/track-view';
import {
  admitGenomeViewFileOpen,
  finishGenomeViewFileOpen,
  pendingGenomeViewFileOpen,
  requestGenomeViewFileOpen,
} from '../sequence/public/genome-view-open-request';

export async function openSelectedDocument(
  path: string,
  tabType: TabType,
  label?: string,
  signal?: AbortSignal,
  placement: OpenStrategy = { kind: 'focused' }
): Promise<DocumentOpenResult> {
  if (signal?.aborted) return cancelledDocumentOpen();
  let sessionPath: string | null = null;
  let pendingTrackView: ReturnType<typeof pendingGenomeViewFileOpen> = null;
  let trackViewOpening: { promise: Promise<string | null>; previousIds: Set<string> } | null = null;
  let acceptedTabType: TabType = path.endsWith(TRACK_VIEW_SUFFIX) ? 'sequence' : tabType;
  let legacyFasta = false;
  const name = userMessageValue(label || path.split(/[\\/]/).at(-1) || 'This file');
  try {
    if (isFastaSource(path)) {
      const sourceKind = await resolveFileDocumentKindFromSource({ kind: 'file', path, tabType });
      if (sourceKind === 'protein' || sourceKind === 'sequence') acceptedTabType = sourceKind;
      if (sourceKind === 'fasta-collection') acceptedTabType = 'file';
      legacyFasta = sourceKind === 'legacy-fasta';
    }
    if (signal?.aborted) return cancelledDocumentOpen();
    if (acceptedTabType === 'sequence' && path.endsWith(TRACK_VIEW_SUFFIX)) {
      const previousIds = new Set(
        Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
          panel.tabs.map((tab) => tab.id)
        )
      );
      trackViewOpening = {
        promise: requestGenomeViewFileOpen(path, placement, signal, label, 'pending'),
        previousIds,
      };
      pendingTrackView = pendingGenomeViewFileOpen();
    }
    const shouldOpenWorkspaceSession =
      !legacyFasta &&
      !isBrowserOnly() &&
      (isHostedBrowserRuntime() || acceptedTabType === 'sequence');
    if (shouldOpenWorkspaceSession) sessionPath = await openElectronWorkspaceSessionFile(path);
  } catch (error) {
    if (pendingTrackView) finishGenomeViewFileOpen(null, pendingTrackView.id);
    if (signal?.aborted) return cancelledDocumentOpen();
    const message =
      error instanceof Error ? error.message : 'The project file could not be verified.';
    console.error('[openSelectedDocument] Project verification failed:', {
      path,
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    useToastStore
      .getState()
      .addToast(userMessageWithValues('document.verificationFailed', { name }), {
        definition: 'app-the-project-file-could-not-be-verified',
      });
    return { status: 'blocked', message };
  }
  if (signal?.aborted || (pendingTrackView && !admitGenomeViewFileOpen(pendingTrackView))) {
    if (sessionPath) closeElectronWorkspaceSessionFile(sessionPath);
    return cancelledDocumentOpen();
  }
  const result = trackViewOpening
    ? await awaitTrackViewPresentation(trackViewOpening.promise, trackViewOpening.previousIds)
    : await openDocument({
        signal,
        target: { kind: 'file', path, tabType: acceptedTabType },
        label,
        placement,
        source: 'file_tree',
      });
  if (pendingTrackView)
    finishGenomeViewFileOpen(
      result.status === 'presented' ? result.tabId : null,
      pendingTrackView.id
    );
  if (result.status === 'presented') {
    if (sessionPath) bindElectronWorkspaceSessionTab(result.tabId, sessionPath);
    return result;
  }
  if (sessionPath) closeElectronWorkspaceSessionFile(sessionPath);
  if ('message' in result) {
    console.error('[openSelectedDocument] Document opening failed:', {
      path,
      status: result.status,
      message: result.message,
    });
    const message = toUserMessage(result, 'operation.failed');
    useToastStore
      .getState()
      .addToast(
        message === userMessage('operation.failed')
          ? userMessageWithValues('document.namedOpenFailed', { name })
          : message,
        {
          definition: 'project-verification-failed',
        }
      );
  }
  return result;
}
