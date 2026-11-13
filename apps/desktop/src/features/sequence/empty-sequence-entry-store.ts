import { create } from 'zustand';

export type EmptySequenceEntryCue = 'caret' | 'rows' | 'hint';

interface EmptySequenceEntryState {
  cue: EmptySequenceEntryCue;
  setCue: (cue: EmptySequenceEntryCue) => void;
  reset: () => void;
}

export const DEFAULT_EMPTY_SEQUENCE_ENTRY_CUE: EmptySequenceEntryCue = 'caret';

export const useEmptySequenceEntryStore = create<EmptySequenceEntryState>((set) => ({
  cue: DEFAULT_EMPTY_SEQUENCE_ENTRY_CUE,
  setCue: (cue) => set({ cue }),
  reset: () => set({ cue: DEFAULT_EMPTY_SEQUENCE_ENTRY_CUE }),
}));
