import { userEntityLabel, userMessageWithValues } from '@waypoint/user-messages';
import { presentDocument } from '../features/canvas/public/present-document';
import {
  presentedTabId,
  type DocumentOpenResult,
  type OpenStrategy,
} from '../features/canvas/public/document-presentation';
import { REVEAL_OPEN_DOCUMENT_EVENT } from '../features/file-associations/handler-status-source';
import type { FileOpenSourceSurface } from '../features/sequence/public/file-open-telemetry';
import { externalFormatForPath, type SourceFileView } from '../shared/external-preview';
import { useToastStore } from '../stores/toast-store';
import { openQuickLookSource } from './open-quick-look-source';

function openSourceViewer(view: SourceFileView, placement?: OpenStrategy): DocumentOpenResult {
  const label = view.path.split(/[\\/]/u).pop() || view.path;
  return presentDocument(
    {
      type: 'file',
      entityId: `source-view:${view.location}:${view.path}`,
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

export async function openExternalPreview(
  path: string,
  sourceSurface: FileOpenSourceSurface = 'menu'
): Promise<string | null> {
  const familyId = externalFormatForPath(path);
  if (!familyId) {
    useToastStore.getState().addToast(
      userMessageWithValues('document.externalPreviewUnsupported', {
        name: userEntityLabel(path.split(/[\\/]/u).pop()),
      }),
      { definition: 'file-open-failed' }
    );
    return null;
  }
  const id =
    familyId === 'genbank' || familyId === 'snapgene'
      ? await openQuickLookSource({ sourcePath: path, familyId, sourceSurface })
      : presentedTabId(openSourceViewer({ path, format: familyId, location: 'external' }));
  if (id) window.dispatchEvent(new Event(REVEAL_OPEN_DOCUMENT_EVENT));
  return id;
}

export async function openExternalFiles(paths: readonly string[], source: FileOpenSourceSurface) {
  for (const path of new Set(paths)) await openExternalPreview(path, source);
}
