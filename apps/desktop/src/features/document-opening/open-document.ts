import { getTabTypeForFile } from '../../utils/fileTypes';
import { isAdoptableMarkdownPath } from '../../shared/markdown-notebook';
import { platform } from '../../platform';
import { findWorkspaceRootForPath } from '../../db/workspace-catalog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { inferCatalogFileKind } from '../../shared/catalog-file-kind';
import { resolveNativeFastaSourceAuthority } from '../../services/native-catalog-destination';
import { isEntityArtifactPath } from '../lims/public/entity-artifact';
import { presentDocument } from '../canvas/public/present-document';
import { useCanvasStore } from '../canvas/public/store';
import {
  cancelledDocumentOpen,
  type DocumentOpenResult,
} from '../canvas/public/document-presentation';
import type { TabType } from '../canvas/public/types';
import type { OpenDocumentRequest, OpenFileDocumentRequest } from './types';
import { registerPendingReadableContent } from '../../lib/readable-content-telemetry';
import { beginPdfRead } from '../pdf/public/telemetry';
import { TRACK_VIEW_SUFFIX } from '../../shared/track-view';
import { isMolecularDocumentFile } from '../../shared/document-availability';
import { requestGenomeViewFileOpen } from '../sequence/public/genome-view-open-request';
import { beginImageOpenRequest, admitImageOpen } from './image-view-lifecycle';
import { resolveFilesystemDocumentTarget } from './filesystem-target';

type FileHandler = (request: OpenFileDocumentRequest) => Promise<DocumentOpenResult>;
type TrackViewOpenRequest = Pick<OpenDocumentRequest, 'signal' | 'placement' | 'label'>;
type FileDocumentKind =
  | 'legacy-fasta'
  | 'track-view'
  | 'molecular-document'
  | 'entity'
  | 'sequence'
  | 'structure'
  | 'page'
  | 'design'
  | 'primer'
  | 'protein'
  | 'text'
  | 'file'
  | 'pdf'
  | 'scientific-document'
  | 'image'
  | 'html'
  | 'table';

const openWorkspace: FileHandler = async (request) =>
  (await import('../page/public/open-workspace-document')).openWorkspaceDocument(request);

async function openLiteral(
  request: OpenFileDocumentRequest,
  admittedKind?: 'protein'
): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const type = admittedKind ?? resolveFileDocumentKind(request.target);
  if (
    type === null ||
    type === 'entity' ||
    type === 'track-view' ||
    type === 'molecular-document' ||
    type === 'legacy-fasta'
  )
    return { status: 'unsupported', message: 'Unsupported document view.' };
  const result = presentDocument(
    { type, entityId: request.target.path, label: request.label },
    request.placement
  );
  if (result.status === 'presented' && admittedKind === 'protein') {
    const tab = useCanvasStore
      .getState()
      .panels[result.panelId]?.tabs.find((candidate) => candidate.id === result.tabId);
    if (tab?.legacyFasta)
      useCanvasStore.getState().updateTab(result.panelId, result.tabId, { legacyFasta: undefined });
  }
  if (result.status === 'presented' && type !== 'image') {
    registerPendingReadableContent({ contentKey: request.target.path, tabId: result.tabId });
    if (type === 'pdf') {
      try {
        beginPdfRead(result.tabId);
      } catch {}
    }
  }
  return result;
}

async function openTrackViewTarget(
  id: string,
  request: TrackViewOpenRequest
): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const previousIds = new Set(
    Object.values(useCanvasStore.getState().panels).flatMap((panel) =>
      panel.tabs.map((tab) => tab.id)
    )
  );
  return awaitTrackViewPresentation(
    requestGenomeViewFileOpen(id, request.placement, request.signal, request.label),
    previousIds
  );
}

export async function awaitTrackViewPresentation(
  opening: Promise<string | null>,
  previousIds: ReadonlySet<string>
): Promise<DocumentOpenResult> {
  const tabId = await opening;
  if (!tabId) return cancelledDocumentOpen();
  const panel = Object.values(useCanvasStore.getState().panels).find((candidate) =>
    candidate.tabs.some((tab) => tab.id === tabId)
  );
  return panel
    ? {
        status: 'presented',
        tabId,
        panelId: panel.id,
        tabType: 'sequence',
        disposition: previousIds.has(tabId) ? 'reused' : 'created',
        content: 'loading',
      }
    : cancelledDocumentOpen();
}

const openSequence: FileHandler = async (request) =>
  (await import('../sequence/public/openSequenceFile')).openSequenceFileResult({
    ...request.sequenceOptions,
    filePath: request.target.path,
    label: request.label,
    strategy: request.placement,
    signal: request.signal,
    sourceSurface: request.source,
  });

const fileHandlers = {
  'legacy-fasta': async (request) => {
    const authority = await resolveNativeFastaSourceAuthority(request.target.path);
    if (!authority || authority.status === 'declared')
      throw new Error('The FASTA kind changed while opening. Open its current source again.');
    if (request.signal?.aborted) return cancelledDocumentOpen();
    if (authority.legacyReadView === 'sequence') {
      const result = await openSequence({
        ...request,
        sequenceOptions: { ...request.sequenceOptions, readOnly: true },
      });
      if (result.status === 'presented' && !request.signal?.aborted)
        useCanvasStore
          .getState()
          .updateTab(result.panelId, result.tabId, { readOnly: true, legacyFasta: authority });
      return result;
    }
    const result = presentDocument(
      {
        type: authority.legacyReadView,
        entityId: request.target.path,
        label: request.label,
        readOnly: true,
        legacyFasta: authority,
      },
      request.placement
    );
    if (result.status === 'presented') {
      useCanvasStore
        .getState()
        .updateTab(result.panelId, result.tabId, { readOnly: true, legacyFasta: authority });
      registerPendingReadableContent({ contentKey: request.target.path, tabId: result.tabId });
    }
    return result;
  },
  'molecular-document': async (request) =>
    (await import('../molecular-documents/public/open')).openMolecularDocument(
      request.target.path,
      request
    ),
  'track-view': async (request) => openTrackViewTarget(request.target.path, request),
  entity: async (request) =>
    (await import('../lims/public/open-entity-artifact')).openEntityArtifact(request),
  sequence: openSequence,
  structure: async (request) =>
    (await import('../structure-files/public/openStructureFile')).openStructureFileResult({
      ...request.structureOptions,
      filePath: request.target.path,
      label: request.label,
      strategy: request.placement,
      signal: request.signal,
    }),
  page: openWorkspace,
  design: openWorkspace,
  primer: async (request) =>
    (await import('../primers/public/open-primer-document')).openPrimerDocument(request),
  protein: (request) => openLiteral(request, 'protein'),
  text: openLiteral,
  file: openLiteral,
  pdf: openLiteral,
  'scientific-document': openLiteral,
  image: openLiteral,
  html: openLiteral,
  table: openLiteral,
} satisfies Record<FileDocumentKind, FileHandler>;

export function resolveFileDocumentKind(
  target: OpenFileDocumentRequest['target']
): FileDocumentKind | null {
  if (isMolecularDocumentFile(target.path)) return 'molecular-document';
  if (target.tabType === 'page') return 'page';
  if (target.path.endsWith(TRACK_VIEW_SUFFIX)) return 'track-view';
  if (isEntityArtifactPath(target.path)) return 'entity';
  const recognized = getTabTypeForFile(target.path);

  const type = recognized === 'text' ? (target.tabType ?? recognized) : recognized;
  return Object.prototype.hasOwnProperty.call(fileHandlers, type)
    ? (type as FileDocumentKind)
    : null;
}

export async function resolveFileDocumentKindFromSource(
  target: OpenFileDocumentRequest['target']
): Promise<FileDocumentKind | null> {
  const kind = resolveFileDocumentKind(target);
  if ((kind !== 'sequence' && kind !== 'protein') || inferCatalogFileKind(target.path) !== 'fasta')
    return kind;
  const authority = await resolveNativeFastaSourceAuthority(target.path);
  if (!authority) return kind;
  return authority.status === 'declared' ? authority.kind : 'legacy-fasta';
}

let navigationRequestId = 0;

export async function openDocument(request: OpenDocumentRequest): Promise<DocumentOpenResult> {
  if (request.signal?.aborted) return cancelledDocumentOpen();
  const imageRequest =
    (request.target.kind === 'file' && resolveFileDocumentKind(request.target) === 'image') ||
    (request.target.kind === 'record' && request.target.tabType === 'image')
      ? beginImageOpenRequest(
          {
            filePath:
              request.target.kind === 'file'
                ? request.target.path
                : request.target.kind === 'record'
                  ? request.target.entityId
                  : '',
          },
          request.signal
        )
      : null;
  try {
    let resolvedRequest = request;
    if (request.target.kind === 'file') {
      const resolution = await resolveFilesystemDocumentTarget(
        request.target,
        platform().fs,
        request.signal
      );
      if (request.signal?.aborted || resolution.status === 'cancelled') {
        const result = cancelledDocumentOpen();
        admitImageOpen(imageRequest, result);
        return result;
      }
      if (resolution.status === 'unsupported') {
        admitImageOpen(imageRequest, resolution);
        return resolution;
      }
      resolvedRequest = { ...request, target: resolution.target };
    }
    const result = await dispatchDocument(resolvedRequest);
    admitImageOpen(imageRequest, result);
    if (result.status === 'presented' && request.navigation && !request.signal?.aborted) {
      useCanvasStore.getState().setTabViewState(result.panelId, result.tabId, {
        ...request.navigation,
        sequenceNavigationRequestId: ++navigationRequestId,
      });
    }
    return result;
  } catch (error) {
    const result: DocumentOpenResult = request.signal?.aborted
      ? cancelledDocumentOpen()
      : { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    admitImageOpen(imageRequest, result);
    return result;
  }
}

async function dispatchDocument(request: OpenDocumentRequest): Promise<DocumentOpenResult> {
  const { target } = request;
  if (target.kind === 'legacy-migration-file') {
    const { resolveLegacyMigrationFastaRead } =
      await import('../../services/legacy-migration-fasta-read');
    const read = await resolveLegacyMigrationFastaRead(target);
    if (request.signal?.aborted) return cancelledDocumentOpen();
    const result = presentDocument(
      {
        type: 'file',
        entityId: read.destinationId,
        label: read.title,
        readOnly: true,
        legacyMigrationRead: read,
        loadStatus: 'loaded',
      },
      request.placement
    );
    if (result.status === 'presented') {
      useCanvasStore
        .getState()
        .updateTab(result.panelId, result.tabId, { readOnly: true, legacyMigrationRead: read });
      registerPendingReadableContent({ contentKey: read.destinationId, tabId: result.tabId });
    }
    return result;
  }
  if (target.kind === 'file') {
    if (/\.(md|markdown)$/i.test(target.path) && platform().notebook.adoptMarkdown) {
      const root = findWorkspaceRootForPath(useWorkspaceStore.getState().folders, target.path);
      if (root && isAdoptableMarkdownPath(target.path.slice(root.length + 1))) {
        const adopted = await platform().notebook.adoptMarkdown!({
          workspaceRoot: root,
          path: target.path,
        });
        if (adopted) {
          useWorkspaceStore.getState().bumpFileTreeRefresh();
          return openWorkspace({
            ...request,
            target: { kind: 'file', path: adopted.path, tabType: 'page' },
            label: adopted.title,
          });
        }
      }
    }
    const inferredKind = resolveFileDocumentKind(target);
    const kind =
      (inferredKind === 'sequence' || inferredKind === 'protein') &&
      inferCatalogFileKind(target.path) === 'fasta'
        ? await resolveFileDocumentKindFromSource(target)
        : inferredKind;
    if (!kind)
      return { status: 'unsupported', message: `Unsupported document view: ${target.tabType}` };
    return fileHandlers[kind]({
      ...request,
      target,
      label: request.label?.trim() || target.path.split(/[\\/]/).pop() || 'Untitled',
    });
  }
  if (target.kind === 'sequence-document' || target.kind === 'sequence-package') {
    const opener = await import('../sequence/public/openSequenceFile');
    if (request.signal?.aborted) return cancelledDocumentOpen();
    const options = {
      ...request.sequenceOptions,
      label: request.label || 'Sequence',
      strategy: request.placement,
      signal: request.signal,
      sourceSurface: request.source,
    };
    return target.kind === 'sequence-document'
      ? opener.openSequenceDocumentResult(target.document, options)
      : opener.openSequencePackageResult(target.path, options);
  }
  if (target.kind === 'track-view') {
    return openTrackViewTarget(target.id, request);
  }
  if (target.kind === 'record') {
    if (
      target.tabType === 'structure' &&
      /^(?:saved-view:|molecular-document:)/.test(target.entityId)
    )
      return {
        status: 'failed',
        message:
          'Molecular results must open through their verified document reference or document file.',
      };
    if (target.tabType === 'record') {
      return (await import('../lims/public/open-entity-artifact')).openSavedEntityRecord(
        target.entityId,
        request
      );
    }
    if (!recordKinds.has(target.tabType))
      return { status: 'unsupported', message: `Unsupported record view: ${target.tabType}` };
    return presentDocument(
      {
        type: target.tabType,
        entityId: target.entityId,
        label: request.label || target.entityId,
        ...request.view,
      },
      request.placement
    );
  }
  return { status: 'unsupported', message: 'Unsupported document target.' };
}

const recordKinds = new Set<TabType>([
  'page',
  'design',
  'protein',
  'structure',
  'file',
  'text',
  'pdf',
  'scientific-document',
  'image',
  'html',
  'table',
]);
