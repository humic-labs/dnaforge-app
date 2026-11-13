import { create } from 'zustand';
import type { ChromatogramLaneOptions } from './chromatogram-lane';

export interface AttachedRead {
  id: string;
  label: string;
  laneOptions: ChromatogramLaneOptions;
  identity: number;
  coverageStart: number;
  coverageEnd: number;
}

interface AttachedReadsState {
  attachedBySequenceId: Record<string, AttachedRead[]>;
  attach: (sequenceId: string, read: AttachedRead) => void;
  detach: (sequenceId: string, readId: string) => void;
  clear: (sequenceId?: string) => void;
}

export const useAttachedReadsStore = create<AttachedReadsState>((set) => ({
  attachedBySequenceId: {},
  attach: (sequenceId, read) =>
    set((state) => {
      const existing = state.attachedBySequenceId[sequenceId] ?? [];
      const filtered = existing.filter((r) => r.id !== read.id);
      return {
        attachedBySequenceId: {
          ...state.attachedBySequenceId,
          [sequenceId]: [...filtered, read],
        },
      };
    }),
  detach: (sequenceId, readId) =>
    set((state) => {
      const existing = state.attachedBySequenceId[sequenceId];
      if (!existing) return state;
      const filtered = existing.filter((r) => r.id !== readId);
      if (filtered.length === existing.length) return state;
      return {
        attachedBySequenceId: {
          ...state.attachedBySequenceId,
          [sequenceId]: filtered,
        },
      };
    }),
  clear: (sequenceId) =>
    set((state) => {
      if (!sequenceId) return { attachedBySequenceId: {} };
      if (!(sequenceId in state.attachedBySequenceId)) return state;
      const { [sequenceId]: _removed, ...rest } = state.attachedBySequenceId;
      return { attachedBySequenceId: rest };
    }),
}));
