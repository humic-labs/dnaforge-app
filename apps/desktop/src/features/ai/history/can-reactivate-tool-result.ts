import { toolHistoryPolicy } from '../../../shared/tool-history-policy';
import { highlightRangeSchema } from '../tools/highlight-range-schema';
import { openTabSchema } from '../tools/open-tab-schema';
import { isRecordedToolResultSuccessful, type StoredToolResult } from './stored-tool-result';

export function canReactivateToolResult(toolName: string, result: StoredToolResult): boolean {
  if (!isRecordedToolResultSuccessful(result)) return false;
  const policy = toolHistoryPolicy(toolName);
  if (policy.mode !== 'reactivate') return false;
  switch (policy.handler) {
    case 'open-tab':
      return openTabSchema.safeParse(result.input).success;
    case 'highlight-range': {
      const parsed = highlightRangeSchema.safeParse(result.input);
      if (!parsed.success) return false;
      const hasContiguousRange =
        typeof parsed.data.start === 'number' && typeof parsed.data.end === 'number';
      const hasRegions = Boolean(parsed.data.regions?.length);
      return hasContiguousRange || hasRegions;
    }
  }
}
