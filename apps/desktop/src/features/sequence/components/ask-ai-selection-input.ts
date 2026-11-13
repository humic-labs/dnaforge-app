import type { AskAiSelectionInput } from '../../ai/public/ask-ai-about-selection';
import type { ActiveOverlaySnapshot } from '../../ai/public/selection-descriptor/active-overlays';

export interface AskAiViewerPayload {
  range: { start: number; end: number };
  wraps?: boolean;
  overlays?: ActiveOverlaySnapshot;
  inferredWindow?: boolean;
  seedText?: string;
  anchor?: { x: number; y: number };
}

export interface AskAiViewerContext {
  documentId: string;
  workspaceRootPath?: string | null;
  sequenceBasename: string;
}

export function buildAskAiSelectionInput(
  payload: AskAiViewerPayload,
  ctx: AskAiViewerContext
): AskAiSelectionInput {
  const { range } = payload;
  const displayLabel = payload.inferredWindow
    ? `${ctx.sequenceBasename} ~${range.start}–${range.end} (inferred window)`
    : `${ctx.sequenceBasename} ${range.start}–${range.end}`;
  return {
    entityType: 'sequence_region',
    displayLabel,
    locator: ctx.documentId,
    workspaceRootPath: ctx.workspaceRootPath,
    deepLinkParams: { start: range.start, end: range.end, wraps: payload.wraps },
    seedText: payload.seedText,
    activeOverlays: payload.overlays,
    anchor: payload.anchor,
  };
}
