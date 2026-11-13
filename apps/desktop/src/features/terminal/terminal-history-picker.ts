import { isPatternInWord } from './upstream/terminal-history-filter';

export function matchesTerminalHistory(text: string, query: string, fuzzy: boolean): boolean {
  const pattern = query.toLowerCase();
  const word = text.toLowerCase();
  return fuzzy
    ? isPatternInWord(pattern, 0, pattern.length, word, 0, word.length)
    : word.includes(pattern);
}

export function terminalHistoryPinKey(
  workspace: string,
  shell: string,
  kind: 'command' | 'directory'
): string {
  const name =
    shell
      .split(/[/\\]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? shell;
  return (
    'dnaforge.terminal.history.pins.v1:' +
    JSON.stringify([workspace, name === 'powershell' ? 'pwsh' : name, kind])
  );
}

export function parseTerminalHistoryPins(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter(
          (item): item is string =>
            typeof item === 'string' && item.length > 0 && item.length <= 8192
        )
      ),
    ].slice(-100);
  } catch {
    return [];
  }
}

export function historyEntriesWithPins<T extends { text: string }>(
  entries: T[],
  pins: string[],
  query: string
): Array<T & { pinned: boolean }> {
  return [
    ...(query
      ? []
      : pins.flatMap((text) => {
          const entry = entries.find((candidate) => candidate.text === text);
          return entry ? [{ ...entry, pinned: true }] : [];
        })),
    ...entries.map((entry) => ({ ...entry, pinned: false })),
  ];
}
