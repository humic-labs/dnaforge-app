export const FRAME_TAB_NAME_PREFIX = 'dnaforge-tab-frame:';

export interface FrameTabNavigationRequest {
  frameName: string;
  direction: 1 | -1;
}
