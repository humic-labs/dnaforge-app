import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { z } from 'zod';
import { tableEditorCommandSchema } from '../../../../shared/table-editor-command';
export {
  tableEditorCommandSchema,
  tableValueCommandSchema,
} from '../../../../shared/table-editor-command';
import { executeTableModelCommand } from './table-model-commands';
import type { useTableData } from './hooks/useTableData';
import type { TableData } from './types';
import { useCanvasStore } from '../../../canvas/public/store';

type Commands = ReturnType<typeof useTableData>;
interface Control {
  pageId: string;
  tableId: string;
  view: 'embed' | 'panel';
  current(): { commands: Commands; data: TableData };
}
const controls = new Set<Control>();

export function useTableEditorControl(input: {
  pageId?: string;
  tableId: string;
  view: 'embed' | 'panel';
  commands: Commands;
  data: TableData;
}) {
  const latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    if (!input.pageId) return;
    const control: Control = {
      pageId: input.pageId,
      tableId: input.tableId,
      view: input.view,
      current: () => latest.current,
    };
    controls.add(control);
    return () => {
      controls.delete(control);
    };
  }, [input.pageId, input.tableId, input.view]);
}

export function getTableEditorControl(pageId: string, tableId: string) {
  const matches = [...controls].filter(
    (control) => control.pageId === pageId && control.tableId === tableId
  );
  const canvas = useCanvasStore.getState();
  const panel = canvas.focusedPanelId ? canvas.panels[canvas.focusedPanelId] : undefined;
  const expandedActive = panel?.tabs.some(
    (tab) => tab.id === panel.activeTabId && tab.type === 'table' && tab.entityId === tableId
  );
  const preferred = matches.filter(
    (control) => control.view === (expandedActive ? 'panel' : 'embed')
  );
  const candidates = preferred.length ? preferred : matches;
  if (candidates.length > 1)
    throw new Error('This table has multiple editing views. Close the extra view first.');
  return candidates[0] ?? null;
}

export function executeTableEditorCommand(
  control: Control,
  command: z.infer<typeof tableEditorCommandSchema>
) {
  return executeTableModelCommand(control.current().commands, command, flushSync);
}
