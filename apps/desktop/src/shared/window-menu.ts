export const WINDOWS_MENU_IDS = ['File', 'Edit', 'View', 'Help', 'Options'] as const;

export type WindowsMenuId = (typeof WINDOWS_MENU_IDS)[number];

export interface WindowMenuPosition {
  x: number;
  y: number;
}
