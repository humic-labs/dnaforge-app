import {
  completeSequenceDocumentSave,
  saveSequenceDocumentWithCompletion,
} from './complete-sequence-document-save';
import { useSequenceStore } from './store';

type MountedSave = () => Promise<boolean>;

const mountedSaves = new Map<string, MountedSave>();
const knownSourcePaths = new Map<string, { sourcePath: string; readOnly: boolean }>();

export function registerSequenceSave(
  documentId: string,
  sourcePath: string,
  readOnly: boolean,
  save: MountedSave
): () => void {
  knownSourcePaths.set(documentId, { sourcePath, readOnly });
  mountedSaves.set(documentId, save);
  return () => {
    if (mountedSaves.get(documentId) === save) mountedSaves.delete(documentId);
  };
}

export interface SaveAllSequencesResult {
  saved: number;

  failed: string[];
}

export async function saveAllDirtySequences(
  options: { excludeDocumentIds?: ReadonlySet<string> } = {}
): Promise<SaveAllSequencesResult> {
  const dirty = Object.keys(useSequenceStore.getState().dirtyPaths).filter(
    (id) => !options.excludeDocumentIds?.has(id)
  );
  let saved = 0;
  const failed: string[] = [];
  for (const documentId of dirty) {
    try {
      const mounted = mountedSaves.get(documentId);
      if (mounted) {
        await mounted();
      } else {
        const known = knownSourcePaths.get(documentId);
        if (known && !known.readOnly) {
          await saveSequenceDocumentWithCompletion({
            kind: 'write',
            document: { documentId, sourcePath: known.sourcePath },
            complete: async (publication) => {
              const name = known.sourcePath.split(/[\\/]/).filter(Boolean).pop() ?? 'sequence';
              return completeSequenceDocumentSave(
                { documentId, sourcePath: known.sourcePath },
                `Save ${name}`,
                publication
              );
            },
          });
        }
      }
    } catch (error: unknown) {
      console.error('[saveAllDirtySequences] Save failed:', documentId, error);
    }
    if (useSequenceStore.getState().dirtyPaths[documentId] === true) failed.push(documentId);
    else saved += 1;
  }
  return { saved, failed };
}

export function resetSequenceSaveRegistryForTests(): void {
  mountedSaves.clear();
  knownSourcePaths.clear();
}
