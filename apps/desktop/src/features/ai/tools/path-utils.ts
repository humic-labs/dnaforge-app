
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { WorkspaceFolder } from '../../../stores/workspaceStore';
import {
  findContainingPathBoundary,
  isAbsolutePathLike,
  pathRelativeToBoundary,
} from '../../../shared/path-boundary';
import { useCanvasStore } from '../../canvas/public/store';
import { useSequenceStore } from '../../sequence/public/store';
import {
  resolveSequenceDocument,
  resolveCanonicalSequenceDocumentById,
} from '../../sequence/public/sequence-document-repository';
import { looksLikeWorkspacePath } from '../../../shared/resolve-entity-path';
import {
  getUserFolders,
  normalizeAbsolutePath,
  type ResolvedMultiRootPath,
} from '../../workspace/public/path-resolve';
import {
  annotationsToBiologyFeatures,
  parseBiologyFile,
  type BiologyFormat,
  type ParsedBiologyFile,
} from './parse-biology-file';

export {
  getUserFolders,
  hasNoUserWorkspace,
  NO_WORKSPACE_TOOL_MESSAGE,
  normalizeAbsolutePath,
  normalizePath,
  resolveMultiRootPath,
  resolveWorkspacePath,
  type ResolvedMultiRootPath,
} from '../../workspace/public/path-resolve';

export interface ResolvedOpenTabWorkspaceBasename extends ResolvedMultiRootPath {
  documentId: string | null;
}

export async function resolveOpenTabAbsolutePath(path: string): Promise<string | null> {
  if (!isAbsolutePathLike(path)) return null;
  const canvas = useCanvasStore.getState();
  if (canvas.findTab('file', path)) return path;
  for (const tab of Object.values(canvas.panels).flatMap((panel) => panel.tabs)) {
    if (tab.type !== 'sequence' || !tab.sequenceDocument) continue;
    try {
      const resolved = await resolveSequenceDocument(tab.sequenceDocument);
      if (normalizeAbsolutePath(resolved.sourcePath) === normalizeAbsolutePath(path)) return path;
    } catch {
    }
  }
  return null;
}

export async function resolveUniqueOpenTabWorkspaceBasename(
  folders: WorkspaceFolder[],
  inputPath: string
): Promise<ResolvedOpenTabWorkspaceBasename | null> {
  if (
    !inputPath ||
    inputPath === '.' ||
    inputPath === '..' ||
    isAbsolutePathLike(inputPath) ||
    /[\\/]/u.test(inputPath)
  ) {
    return null;
  }

  const userFolders = getUserFolders(folders);
  if (userFolders.length === 0) return null;

  const matches = new Map<string, ResolvedOpenTabWorkspaceBasename>();
  const conflictingDocumentPaths = new Set<string>();
  for (const panel of Object.values(useCanvasStore.getState().panels)) {
    for (const tab of panel.tabs) {
      let absolutePath: string;
      let documentId: string | null = null;
      if (tab.type === 'sequence') {
        if (!tab.sequenceDocument) continue;
        try {
          const resolved = await resolveSequenceDocument(tab.sequenceDocument);
          absolutePath = normalizeAbsolutePath(resolved.sourcePath);
          documentId = resolved.documentId;
        } catch {
          continue;
        }
      } else if (tab.type === 'file' && isAbsolutePathLike(tab.entityId)) {
        absolutePath = normalizeAbsolutePath(tab.entityId);
      } else {
        continue;
      }

      if (absolutePath.slice(absolutePath.lastIndexOf('/') + 1) !== inputPath) continue;

      const folder = findContainingPathBoundary(userFolders, absolutePath);
      if (!folder) continue;
      const relativePath = pathRelativeToBoundary(absolutePath, folder.path);
      if (!relativePath) continue;

      const existing = matches.get(absolutePath);
      if (existing?.documentId && documentId && existing.documentId !== documentId) {
        conflictingDocumentPaths.add(absolutePath);
        continue;
      }
      if (!existing || (!existing.documentId && documentId)) {
        matches.set(absolutePath, { folder, absolutePath, relativePath, documentId });
      }
    }
  }

  if (conflictingDocumentPaths.size > 0) return null;
  return matches.size === 1 ? ([...matches.values()][0] ?? null) : null;
}

function inferResidentBiologyFormat(absPath: string, seq: AnnotatedSequence): BiologyFormat {
  const ext = absPath.split('.').pop()?.toLowerCase();
  if (ext === 'fasta' || ext === 'fa' || ext === 'fna' || ext === 'faa') return 'fasta';
  if (ext === 'gb' || ext === 'gbk' || ext === 'genbank') return 'genbank';
  return seq.annotations.length > 0 ? 'genbank' : 'fasta';
}

export interface LoadedSequenceDocument {
  documentId: string;
  name?: string;
  sourcePath: string;
  biology: Omit<ParsedBiologyFile, 'content'>;
}

export function normalizeSequenceDocumentId(input: string): string {
  let documentId = input;
  if (input.startsWith('waypoint://')) {
    try {
      const parsed = new URL(input);
      if (parsed.protocol === 'waypoint:' && parsed.hostname === 'sequence') {
        documentId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
      }
    } catch {
      throw new Error('Invalid sequence resource URI.');
    }
  }
  if (!documentId.trim()) throw new Error('A sequence document ID is required.');
  if (looksLikeWorkspacePath(documentId)) {
    throw new Error('Physical sequence paths are deprecated; use the stable document ID.');
  }
  return documentId;
}

export async function loadSequenceDocumentBiologyFile(
  input: string,
  folders: WorkspaceFolder[]
): Promise<LoadedSequenceDocument> {
  const documentId = normalizeSequenceDocumentId(input);
  const resolved = await resolveCanonicalSequenceDocumentById(
    documentId,
    folders.map((folder) => folder.path)
  );
  const resident = useSequenceStore.getState().getSequence(documentId);
  if (resident) {
    return {
      documentId,
      ...(resolved.name ? { name: resolved.name } : {}),
      sourcePath: resolved.sourcePath,
      biology: {
        format: inferResidentBiologyFormat(resolved.sourcePath, resident),
        sequence: resident,
        features: annotationsToBiologyFeatures(resident.annotations),
      },
    };
  }
  const parsed = await parseBiologyFile(resolved.sourcePath);
  return {
    documentId,
    ...(resolved.name ? { name: resolved.name } : {}),
    sourcePath: resolved.sourcePath,
    biology: {
      format: parsed.format,
      sequence: parsed.sequence,
      features: parsed.features,
    },
  };
}
