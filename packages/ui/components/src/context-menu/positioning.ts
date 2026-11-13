export type FixedMenuPosition = {
  x: number;
  y: number;
};

export type FixedMenuClampInput = FixedMenuPosition & {
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
};

export function clampFixedMenuPosition({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  padding = 10,
}: FixedMenuClampInput): FixedMenuPosition {
  const safeViewportWidth = Math.max(0, viewportWidth);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const safeMenuWidth = Math.max(0, menuWidth);
  const safeMenuHeight = Math.max(0, menuHeight);
  const safePadding = Math.max(0, padding);
  const minX = Math.min(safePadding, Math.max(0, safeViewportWidth - safeMenuWidth));
  const minY = Math.min(safePadding, Math.max(0, safeViewportHeight - safeMenuHeight));
  const maxX = Math.max(minX, safeViewportWidth - safeMenuWidth - safePadding);
  const maxY = Math.max(minY, safeViewportHeight - safeMenuHeight - safePadding);

  return {
    x: Math.min(Math.max(x, minX), maxX),
    y: Math.min(Math.max(y, minY), maxY),
  };
}
