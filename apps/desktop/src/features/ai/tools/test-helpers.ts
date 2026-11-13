import { vi } from 'vitest';
import { useCanvasStore } from '../../canvas/public/store';
import type { SequenceDocumentRef } from '../../../shared/managed-sequence-document';

let _uuidSeq = 0;

export function mockUUID() {
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `mock-0000-0000-0000-${String(++_uuidSeq).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`
  );
}

export function resetCanvasStore() {
  _uuidSeq = 0;
  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs: [], activeTabId: null },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
}

type TestCanvasTab = {
  id: string;
  type: 'sequence' | 'file';
  entityId: string;
  label: string;
  sequenceDocument?: SequenceDocumentRef;
};

export function setCanvasTabs(
  tabs: TestCanvasTab[],
  activeTabId: string | null = tabs[0]?.id ?? null
): void {
  useCanvasStore.setState({
    panels: {
      main: { id: 'main', tabs, activeTabId },
    },
    layout: { type: 'panel', panelId: 'main' },
    focusedPanelId: 'main',
  });
}

export { execOpts, execTool } from '../../../test/ai/exec-tool';
