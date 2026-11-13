import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  normalizeRichSequenceFragment,
  type RichSequenceFragment,
  type RichSequenceFragmentInput,
} from './rich-sequence-clipboard';

interface RichSequenceClipboardState {
  copiedRegion: RichSequenceFragment | null;
  setCopiedRegion: (fragment: RichSequenceFragmentInput) => RichSequenceFragment;
  clear: () => void;
}

export const useRichSequenceClipboardStore = create<RichSequenceClipboardState>()(
  persist(
    (set) => ({
      copiedRegion: null,
      setCopiedRegion: (fragment) => {
        const committed = normalizeRichSequenceFragment(fragment);
        set({ copiedRegion: committed });
        return committed;
      },
      clear: () => set({ copiedRegion: null }),
    }),
    {
      name: 'dnaforge-rich-sequence-clipboard',
      version: 2,
    }
  )
);
