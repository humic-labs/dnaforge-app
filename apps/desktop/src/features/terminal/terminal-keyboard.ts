export type TerminalHostPlatform = 'darwin' | 'win32' | 'linux';
type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;
type PhysicalKey = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

export function terminalFindShortcut(platform: TerminalHostPlatform, event: PhysicalKey): boolean {
  return (
    event.code === 'KeyF' &&
    !event.altKey &&
    (platform === 'darwin'
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && event.shiftKey && !event.metaKey)
  );
}

export function terminalHistoryShortcut(
  platform: TerminalHostPlatform,
  event: PhysicalKey
): 'command' | 'directory' | null {
  if (event.shiftKey) return null;
  if (event.code === 'KeyR' && event.ctrlKey && event.altKey && !event.metaKey) return 'command';
  if (
    event.code === 'KeyG' &&
    (platform === 'darwin'
      ? event.metaKey && !event.ctrlKey && !event.altKey
      : event.ctrlKey && event.altKey && !event.metaKey)
  )
    return 'directory';
  return null;
}

export function terminalLinkShortcut(platform: TerminalHostPlatform, event: PhysicalKey): boolean {
  return (
    event.code === 'KeyO' &&
    event.altKey &&
    !event.shiftKey &&
    (platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

export type TerminalResizeDirection = 'left' | 'right' | 'up' | 'down';
export function terminalResizeDirection(
  platform: TerminalHostPlatform,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): TerminalResizeDirection | null {
  if (event.altKey) return null;
  const directions: Record<string, TerminalResizeDirection | undefined> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
  };
  const direction = directions[event.code];
  if (!direction) return null;
  if (platform === 'darwin' && event.ctrlKey && event.metaKey && !event.shiftKey) return direction;
  if (
    platform === 'linux' &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    (direction === 'left' || direction === 'right')
  )
    return direction;
  return null;
}

export function terminalSplitShortcut(
  platform: TerminalHostPlatform,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): boolean {
  if (event.altKey) return false;
  if (platform === 'darwin' && event.metaKey && !event.ctrlKey && !event.shiftKey)
    return event.code === 'Backslash';
  return event.ctrlKey && !event.metaKey && event.shiftKey && event.code === 'Digit5';
}

export function terminalHostPlatform(): TerminalHostPlatform {
  return navigator.platform.startsWith('Mac')
    ? 'darwin'
    : navigator.platform.startsWith('Win')
      ? 'win32'
      : 'linux';
}

export function terminalClipboardAction(
  platform: TerminalHostPlatform,
  event: Key,
  selected: boolean
): 'copy' | 'paste' | null {
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  const modifier =
    platform === 'darwin'
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && (platform === 'win32' || event.shiftKey);
  if (modifier && key === 'c' && selected) return 'copy';
  if (modifier && key === 'v') return 'paste';
  if (platform !== 'darwin' && !event.ctrlKey && event.shiftKey && key === 'insert') return 'paste';
  return null;
}
