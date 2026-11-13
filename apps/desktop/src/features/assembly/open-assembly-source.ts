import {
  computeChecksum,
  decodeSequenceDocument,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import type { DesignRegion } from '../design/public/types';
import type { AcceptedAssemblySourceProvenanceSnapshot } from './accepted-types';
import { useCanvasStore } from '../canvas/public/store';
import { useSequenceStore } from '../sequence/public/store';
import {
  resolveSequenceDocumentById,
  type ResolvedSequenceDocument,
} from '../sequence/public/sequence-document-repository';
import { openDocument } from '../document-opening/public/open-document';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { platform } from '../../platform';
import { isBinarySequencePath } from '../../shared/parse-sequence-file';
import { fromPackageRelative, parseSequencePackageDocument } from '../../db/sequence-package';
import {
  findEnclosingSequencePackageRoot,
  locateSequencePackageMetaPath,
} from '../../db/sequence-package-io';

type AssemblySourceRegion = Pick<
  DesignRegion,
  'sourceSequenceId' | 'sourceSequenceName' | 'sourceStart' | 'sourceEnd' | 'sequence'
> &
  Partial<
    Pick<
      DesignRegion,
      | 'sourceSequence'
      | 'sourceAnnotations'
      | 'sourceLength'
      | 'sourceIsCircular'
      | 'sourceType'
      | 'rdOverhangs'
    >
  > & { rdSourceEnzyme?: string; rdSourceEnzymeName?: string };

export function isOpenableAssemblySourceId(sourceId: string): boolean {
  return sourceId.trim().length > 0 && sourceId !== 'external' && sourceId !== 'placeholder';
}

export async function openAssemblySourceRegion(
  region: AssemblySourceRegion,
  options: { provenance?: AcceptedAssemblySourceProvenanceSnapshot } = {}
): Promise<void> {
  const provenance = options.provenance;
  let sourceId = provenance?.sourceConstructId || region.sourceSequenceId;
  if (!isOpenableAssemblySourceId(sourceId))
    throw new Error('This fragment has no saved source sequence.');
  const pinnedChecksum =
    provenance?.sourceSequenceChecksum ??
    (provenance?.sourceSequenceVersionId?.startsWith('sha256:')
      ? provenance.sourceSequenceVersionId
      : undefined);
  const pinnedPath = sourceFileLocator(provenance?.sourceLocator) ?? sourceFileLocator(sourceId);
  const sourcePackageId = pinnedPath ? await packageIdForSavedSourceProduct(pinnedPath) : null;
  const currentSource: ResolvedSequenceDocument | null = sourcePackageId
    ? await resolveSequenceDocumentById(
        sourcePackageId,
        useWorkspaceStore.getState().folders.map((folder) => folder.path)
      )
    : null;
  if (currentSource) sourceId = currentSource.documentId;
  if (pinnedChecksum) {
    const sourcePath =
      currentSource?.sourcePath ??
      pinnedPath ??
      (
        await resolveSequenceDocumentById(
          sourceId,
          useWorkspaceStore.getState().folders.map((folder) => folder.path)
        )
      ).sourcePath;
    let current: AnnotatedSequence;
    try {
      const bytes = await platform().fs.readFile(sourcePath);
      current = decodeSequenceDocument(
        isBinarySequencePath(sourcePath)
          ? bytes
          : new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        { path: sourcePath }
      ).sequence;
    } catch {
      throw new Error('The saved source version is unavailable at its recorded location.');
    }
    if ((await computeChecksum(current.sequence)) !== pinnedChecksum) {
      throw new Error(
        'The source has changed since this assembly was saved. Its historical version is unavailable.'
      );
    }
    const loaded = sourceFileLocator(sourceId)
      ? null
      : useSequenceStore.getState().getSequence(sourceId);
    if (loaded && (await computeChecksum(loaded.sequence)) !== pinnedChecksum) {
      throw new Error(
        'The open source tab contains a different version. The saved source version is unavailable.'
      );
    }
  }
  const inlineSource = annotatedSourceSequenceForRegion(region);
  if (inlineSource && !currentSource && !pinnedChecksum && !sourceFileLocator(sourceId)) {
    useSequenceStore.getState().setSequence(sourceId, inlineSource);
  }
  let tab = useCanvasStore.getState().findTab('sequence', sourceId);
  let openedNewSourceTab = false;
  if (!tab) {
    const filePath = pinnedPath;
    const label = region.sourceSequenceName || 'Sequence';
    const request = currentSource
      ? {
          target: { kind: 'sequence-document' as const, document: currentSource.ref },
          label,
        }
      : filePath
        ? { target: { kind: 'file' as const, path: filePath }, label }
        : {
            target: {
              kind: 'sequence-document' as const,
              document: (
                await resolveSequenceDocumentById(
                  sourceId,
                  useWorkspaceStore.getState().folders.map((folder) => folder.path)
                )
              ).ref,
            },
            label,
          };
    const result = await openDocument(request);
    if (result.status !== 'presented') {
      throw new Error(
        'message' in result ? result.message : 'Source sequence could not be opened.'
      );
    }
    tab = { panelId: result.panelId, tabId: result.tabId };
    sourceId =
      useCanvasStore
        .getState()
        .panels[result.panelId]?.tabs.find((candidate) => candidate.id === result.tabId)
        ?.entityId ?? sourceId;
    openedNewSourceTab = result.disposition !== 'reused';
  }
  if (pinnedChecksum) {
    const loaded = useSequenceStore.getState().getSequence(sourceId);
    if (loaded && (await computeChecksum(loaded.sequence)) !== pinnedChecksum) {
      throw new Error(
        'The source tab opened a different version. The saved source version is unavailable.'
      );
    }
  }
  const loadedSourceLength = useSequenceStore.getState().getSequence(sourceId)?.length;
  const highlightRange = provenanceHighlightRangeForRegion(
    region,
    loadedSourceLength ?? provenance?.sourceLength
  );
  const digestEnzymes =
    region.sourceType === 'rd' || (!region.sourceType && region.rdOverhangs)
      ? [
          ...new Set(
            (region.rdSourceEnzymeName || region.rdSourceEnzyme || '')
              .split('+')
              .map((name) => name.trim())
              .filter(Boolean)
          ),
        ]
      : [];
  const canvas = useCanvasStore.getState();
  canvas.setActiveTab(tab.panelId, tab.tabId);
  canvas.setTabViewState(tab.panelId, tab.tabId, {
    ...(openedNewSourceTab ? { sequenceRendererVisibility: 'map' as const } : {}),
    ...(digestEnzymes.length
      ? { cutSiteDisplayRequest: { id: crypto.randomUUID(), enzymeNames: digestEnzymes } }
      : {}),
    highlightRange,
    scrollPosition: highlightRange.start + 1,
  });
}

async function packageIdForSavedSourceProduct(sourcePath: string): Promise<string | null> {
  const fs = platform().fs;
  const packageRoot = await findEnclosingSequencePackageRoot(sourcePath, fs);
  if (!packageRoot) return null;
  const markerPath = await locateSequencePackageMetaPath(packageRoot, fs.exists);
  if (!markerPath) return null;
  const document = parseSequencePackageDocument(await fs.readTextFile(markerPath));
  return fromPackageRelative(document.product.file, packageRoot) === sourcePath
    ? document.id
    : null;
}

function sourceFileLocator(locator: string | undefined): string | null {
  if (!locator) return null;
  if (locator.startsWith('file://')) return decodeURIComponent(new URL(locator).pathname);
  return locator.startsWith('/') || /^[A-Za-z]:[\\/]/.test(locator) ? locator : null;
}

function annotatedSourceSequenceForRegion(region: AssemblySourceRegion): AnnotatedSequence | null {
  if (!region.sourceSequenceId || typeof region.sourceSequence !== 'string') return null;
  return {
    id: region.sourceSequenceId,
    name: region.sourceSequenceName || region.sourceSequenceId,
    sequence: region.sourceSequence,
    length: region.sourceSequence.length,
    annotations: (region.sourceAnnotations ?? []).map(sourceCacheAnnotation),
    circular: Boolean(region.sourceIsCircular),
  };
}

function sourceCacheAnnotation(
  annotation: NonNullable<DesignRegion['sourceAnnotations']>[number]
): Annotation {
  const direction = (annotation as { direction?: unknown }).direction;
  return {
    name: annotation.name,
    type: annotation.type,
    start: annotation.start,
    end: annotation.end,
    direction:
      direction === -1 || direction === 0 || direction === 1
        ? direction
        : annotation.strand === 'reverse'
          ? -1
          : annotation.strand === 'forward'
            ? 1
            : 0,
    color: annotation.color,
    qualifiers: annotation.qualifiers
      ? Object.fromEntries(
          Object.entries(annotation.qualifiers).map(([key, value]) => [key, [value]])
        )
      : undefined,
  };
}

export function provenanceHighlightRangeForRegion(
  region: AssemblySourceRegion,
  sourceLength?: number
): { start: number; end: number; wraps?: boolean } {
  const length =
    sourceLength ??
    (region.sourceLength && region.sourceLength > 0 ? region.sourceLength : undefined) ??
    (region.sourceSequence ? region.sourceSequence.length : undefined);
  const start = Math.max(0, Math.floor(region.sourceStart ?? 0));
  let rawEnd = Math.floor(region.sourceEnd ?? start + region.sequence.length);
  if (length && length > 0 && rawEnd > length) rawEnd -= length;
  if (rawEnd < start) {
    const end = rawEnd - 1;
    if (end < 0) return { start, end: Math.max(start, (length ?? start + 1) - 1) };
    return { start, end, wraps: true };
  }
  return { start, end: Math.max(start, rawEnd - 1) };
}
