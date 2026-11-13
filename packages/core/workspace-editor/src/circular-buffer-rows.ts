import type { WorkspaceEditorConfig } from './types';

const MIN_CIRCULAR_VIRTUAL_ROWS = 30;
const CIRCULAR_BUFFER_VIEWPORT_MULTIPLIER = 3;

export const MIN_CIRCULAR_BUFFER_ROW_PITCH_PX = 60;

export function estimateCircularBufferRowPitch(config: WorkspaceEditorConfig): number {
  const nucleotidePairHeight = Math.max(0, config.rowHeight) * 2;
  return Math.max(MIN_CIRCULAR_BUFFER_ROW_PITCH_PX, nucleotidePairHeight);
}

export function computeCircularVirtualRowCount(
  config: WorkspaceEditorConfig,
  viewportHeight: number
): number {
  if (config.overviewLod || config.lodLevel === 'density') return 0;

  const rowPitch = estimateCircularBufferRowPitch(config);
  const viewportRows = viewportHeight > 0 ? Math.ceil(viewportHeight / rowPitch) : 10;
  return Math.max(MIN_CIRCULAR_VIRTUAL_ROWS, viewportRows * CIRCULAR_BUFFER_VIEWPORT_MULTIPLIER);
}
