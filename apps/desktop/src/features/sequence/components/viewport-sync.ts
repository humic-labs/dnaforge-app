import type { ViewportChangeSource } from '@waypoint/workspace-editor';

export function shouldSyncViewportCenterToWebGL(input: {
  source: ViewportChangeSource;
  isWebglSyncLocked: boolean;
  isWebglDrivenEcho: boolean;
}): boolean {
  return (
    (input.source === 'scroll' || input.source === 'zoom') &&
    input.isWebglSyncLocked &&
    !input.isWebglDrivenEcho
  );
}

export function shouldSyncCanvasCenterFromWebGL(input: {
  reason: 'scroll' | 'zoom';
  isWebglSyncLocked: boolean;
}): boolean {
  return input.reason === 'scroll' && input.isWebglSyncLocked;
}
