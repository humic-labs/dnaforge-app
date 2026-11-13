import { useWorkspaceStore } from '../../../stores/workspaceStore';
import {
  highlightRangeInCanvas,
  highlightRangeSchema,
  type HighlightRangeInput,
} from '../tools/highlight-range';
import { openTabInCanvas, openTabSchema, type OpenTabInput } from '../tools/open-tab';
import { toolHistoryPolicy } from '../../../shared/tool-history-policy';
import { isRecordedToolResultSuccessful, type StoredToolResult } from './stored-tool-result';

export type { StoredToolResult } from './stored-tool-result';

export type ToolHistoryReactivationResult = { ok: true } | { ok: false; error: string };

interface ToolHistoryHandlers {
  openTab(input: OpenTabInput): Promise<{ tabId: string; error?: string }>;
  highlightRange(input: HighlightRangeInput): Promise<{ ok: boolean; error?: string }>;
}

export function createToolResultReactivator(handlers: ToolHistoryHandlers) {
  return async (
    toolName: string,
    result: StoredToolResult
  ): Promise<ToolHistoryReactivationResult> => {
    if (!isRecordedToolResultSuccessful(result)) {
      return { ok: false, error: 'Failed tool calls cannot be shown again.' };
    }

    const policy = toolHistoryPolicy(toolName);
    if (policy.mode !== 'reactivate') {
      return { ok: false, error: 'This tool result is inspect-only.' };
    }

    switch (policy.handler) {
      case 'open-tab': {
        const parsed = openTabSchema.safeParse(result.input);
        if (!parsed.success) return { ok: false, error: 'The saved tab target is invalid.' };
        const opened = await handlers.openTab(parsed.data);
        return opened.tabId
          ? { ok: true }
          : { ok: false, error: opened.error ?? 'The saved tab could not be opened.' };
      }
      case 'highlight-range': {
        const parsed = highlightRangeSchema.safeParse(result.input);
        if (!parsed.success) return { ok: false, error: 'The saved sequence range is invalid.' };
        const highlighted = await handlers.highlightRange(parsed.data);
        return highlighted.ok
          ? { ok: true }
          : {
              ok: false,
              error: highlighted.error ?? 'The saved sequence range could not be shown.',
            };
      }
    }
  };
}

export const reactivateToolResult = createToolResultReactivator({
  openTab: async (input) => openTabInCanvas(input, useWorkspaceStore.getState().folders),
  highlightRange: async (input) =>
    highlightRangeInCanvas(input, useWorkspaceStore.getState().folders),
});
