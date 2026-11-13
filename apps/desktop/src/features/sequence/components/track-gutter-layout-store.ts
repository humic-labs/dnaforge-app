import { create } from 'zustand';

import { GUTTER_DEFAULT_WIDTH } from './TrackGutter';

const GUTTER_WIDTH_STORAGE_ID = 'dna708.gutterWidth.v2';
const CYTOBAND_VISIBLE_STORAGE_ID = 'dna2951.cytobandVisible';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function readStoredWidth(): number {
  const value = Number(read(GUTTER_WIDTH_STORAGE_ID));
  return Number.isFinite(value) && value >= GUTTER_DEFAULT_WIDTH ? value : GUTTER_DEFAULT_WIDTH;
}

interface TrackGutterLayoutState {
  width: number;
  collapsedByTabId: Readonly<Record<string, boolean>>;
  cytobandVisible: boolean;
  setWidth: (width: number) => void;
  toggleCollapsed: (tabId: string) => void;
  setCytobandVisible: (visible: boolean) => void;
}

export const useTrackGutterLayoutStore = create<TrackGutterLayoutState>((set) => ({
  width: readStoredWidth(),
  collapsedByTabId: {},
  cytobandVisible: read(CYTOBAND_VISIBLE_STORAGE_ID) !== '0',
  setWidth: (width) => {
    write(GUTTER_WIDTH_STORAGE_ID, String(Math.round(width)));
    set({ width });
  },
  toggleCollapsed: (tabId) =>
    set((state) => ({
      collapsedByTabId: {
        ...state.collapsedByTabId,
        [tabId]: !state.collapsedByTabId[tabId],
      },
    })),
  setCytobandVisible: (cytobandVisible) => {
    write(CYTOBAND_VISIBLE_STORAGE_ID, cytobandVisible ? '1' : '0');
    set({ cytobandVisible });
  },
}));
