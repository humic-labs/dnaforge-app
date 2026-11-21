import { defineGroup, invoke } from './contract';
import type { WindowZoomResult } from '../window-zoom';

export type WindowDisplayColorSpace = 'srgb' | 'display-p3';

export const windowContract = defineGroup('window', {
  setZoomLevel: invoke<[level: number], WindowZoomResult>(),
  showMenu: invoke<
    [
      menuId: import('../window-menu').WindowsMenuId,
      position: import('../window-menu').WindowMenuPosition,
    ],
    void
  >(),
  setTitleBarTheme: invoke<[dark: boolean], void>(),
  minimize: invoke<[], void>(),
  maximize: invoke<[], void>(),
  unmaximize: invoke<[], void>(),
  close: invoke<[], void>(),
  isMaximized: invoke<[], boolean>(),
  setSize: invoke<[width: number, height: number], void>(),
  setPosition: invoke<[x: number, y: number], void>(),
  getSize: invoke<[], { width: number; height: number }>(),
  getPosition: invoke<[], { x: number; y: number }>(),
  getDisplayColorSpace: invoke<[], WindowDisplayColorSpace | null>(),
});
