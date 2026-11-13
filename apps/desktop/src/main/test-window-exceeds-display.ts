type WindowSize = { width: number; height: number };

export function testWindowExceedsDisplay(
  env: { NODE_ENV?: string },
  platform: string,
  display: WindowSize,
  requested: WindowSize
): boolean {
  return (
    env.NODE_ENV === 'test' &&
    platform === 'linux' &&
    (display.width < requested.width || display.height < requested.height)
  );
}
