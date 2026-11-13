export interface TerminalPreferences {
  colorScheme: 'mocha' | 'latte' | 'system';
  fontSize: number;
  fontFamily: string;
  gpuAcceleration: 'auto' | 'off';
  fontLigatures: boolean;
  fontWeight: number;
  fontWeightBold: number;
  minimumContrastRatio: number;
  lineHeight: number;
  letterSpacing: number;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  cursorInactiveStyle: 'outline' | 'block' | 'bar' | 'underline' | 'none';
  cursorWidth: number;
  scrollback: number;
  screenReaderMode: boolean;
  copyOnSelection: boolean;
  multilinePasteWarning: boolean;
  rightClickBehavior: 'platform' | 'default' | 'copyPaste' | 'paste' | 'selectWord' | 'nothing';
  macOptionIsMeta: boolean;
  macOptionClickForcesSelection: boolean;
  altClickMovesCursor: boolean;
  wordSeparators: string;
  smoothScrolling: boolean;
  enableFileLinks: boolean;
  enableVisualBell: boolean;
  bellDuration: number;
  commandDecorations: 'both' | 'gutter' | 'overviewRuler' | 'never';
  stickyScrollEnabled: boolean;
  stickyScrollMaxLineCount: number;
  stickyScrollIgnoredCommands: string[];
}

const DEFAULT_FONT = '"JetBrains Mono", Menlo, Consolas, monospace';

const DEFAULT_WORD_SEPARATORS = ' ()[]{}\',"`';
export function parseTerminalPreferences(value: unknown): TerminalPreferences {
  const input =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const number = (key: string, fallback: number, minimum: number, maximum: number) =>
    typeof input[key] === 'number' && Number.isFinite(input[key])
      ? Math.max(minimum, Math.min(maximum, input[key] as number))
      : fallback;
  const rightClick = [
    'platform',
    'default',
    'copyPaste',
    'paste',
    'selectWord',
    'nothing',
  ] as const;
  const cursor = input.cursorStyle;
  return {
    colorScheme:
      input.colorScheme === 'latte' || input.colorScheme === 'mocha' ? input.colorScheme : 'system',
    fontSize: number('fontSize', 14, 8, 48),
    gpuAcceleration: input.gpuAcceleration === 'off' ? 'off' : 'auto',
    fontLigatures: input.fontLigatures === true,
    fontWeight: Math.round(number('fontWeight', 400, 100, 900)),
    fontWeightBold: Math.round(number('fontWeightBold', 700, 100, 900)),
    minimumContrastRatio: number('minimumContrastRatio', 1, 1, 21),
    fontFamily:
      typeof input.fontFamily === 'string' &&
      input.fontFamily.trim() &&
      input.fontFamily.length <= 256 &&
      !/\p{Cc}/u.test(input.fontFamily)
        ? input.fontFamily
        : DEFAULT_FONT,
    lineHeight: number('lineHeight', 1.15, 1, 3),
    letterSpacing: number('letterSpacing', 0, -2, 10),
    cursorStyle: cursor === 'bar' || cursor === 'underline' ? cursor : 'block',
    cursorBlink: input.cursorBlink !== false,
    cursorInactiveStyle:
      input.cursorInactiveStyle === 'block' ||
      input.cursorInactiveStyle === 'bar' ||
      input.cursorInactiveStyle === 'underline' ||
      input.cursorInactiveStyle === 'none'
        ? input.cursorInactiveStyle
        : 'outline',
    cursorWidth: Math.round(number('cursorWidth', 1, 1, 10)),
    scrollback: number('scrollback', 10_000, 100, 10_000),
    screenReaderMode: input.screenReaderMode === true,
    copyOnSelection: input.copyOnSelection === true,
    multilinePasteWarning: input.multilinePasteWarning !== false,
    rightClickBehavior:
      rightClick.find((entry) => entry === input.rightClickBehavior) ?? 'platform',
    macOptionIsMeta: input.macOptionIsMeta === true,
    macOptionClickForcesSelection: input.macOptionClickForcesSelection === true,
    altClickMovesCursor: input.altClickMovesCursor !== false,
    wordSeparators:
      typeof input.wordSeparators === 'string' &&
      input.wordSeparators.length <= 256 &&
      !/\p{Cc}/u.test(input.wordSeparators)
        ? input.wordSeparators
        : DEFAULT_WORD_SEPARATORS,
    smoothScrolling: input.smoothScrolling === true,
    enableFileLinks: input.enableFileLinks !== false,
    enableVisualBell: input.enableVisualBell === true,
    bellDuration: number('bellDuration', 1000, 100, 10_000),
    commandDecorations:
      input.commandDecorations === 'gutter' ||
      input.commandDecorations === 'overviewRuler' ||
      input.commandDecorations === 'never'
        ? input.commandDecorations
        : 'both',
    stickyScrollEnabled: input.stickyScrollEnabled !== false,
    stickyScrollMaxLineCount: Math.round(number('stickyScrollMaxLineCount', 5, 1, 10)),
    stickyScrollIgnoredCommands: Array.isArray(input.stickyScrollIgnoredCommands)
      ? input.stickyScrollIgnoredCommands
          .filter((value): value is string => typeof value === 'string' && value.length <= 8192)
          .slice(0, 100)
      : ['clear', 'cls', 'clear-host', 'agent', 'agy', 'copilot', 'claude', 'codex', 'gemini'],
  };
}
