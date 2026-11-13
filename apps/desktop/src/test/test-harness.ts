import { useSequenceStore } from '../features/sequence/store';
import { getMockFileContent } from './platform-mocks';

export interface TestHarnessAPI {
  getSequence(documentId: string): {
    sequence: string;
    length: number;
    annotations: Array<{
      name: string;
      type: string;
      start: number;
      end: number;
      direction?: number;
      qualifiers?: Record<string, string[]>;
    }>;
    circular?: boolean;
  } | null;

  getSequenceVersion(documentId: string): number;
  isDirty(documentId: string): boolean;
  getFileContent(filePath: string): string | null;
  getOpenSequenceDocumentIds(): string[];
}

export function createTestHarness(): TestHarnessAPI {
  return {
    getSequence(documentId: string) {
      const state = useSequenceStore.getState();
      const seq = state.sequences[documentId];
      if (!seq) return null;
      return {
        sequence: seq.sequence,
        length: seq.length,
        annotations: (seq.annotations ?? []).map((a) => ({
          name: a.name,
          type: a.type,
          start: a.start,
          end: a.end,
          direction: a.direction,
          qualifiers: a.qualifiers,
        })),
        circular: seq.circular,
      };
    },

    getSequenceVersion(documentId: string) {
      return useSequenceStore.getState().sequenceVersions[documentId] ?? 0;
    },

    isDirty(documentId: string) {
      return useSequenceStore.getState().dirtyPaths[documentId] === true;
    },

    getFileContent(filePath: string) {
      return getMockFileContent(filePath);
    },

    getOpenSequenceDocumentIds() {
      return Object.keys(useSequenceStore.getState().sequences);
    },
  };
}
