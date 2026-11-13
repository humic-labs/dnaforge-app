import type { TerminalPreferences } from './terminal-preferences';

type FieldBase = { key: keyof TerminalPreferences; label: string; description?: string };
type TerminalSettingsField = FieldBase &
  (
    | { kind: 'toggle' }
    | { kind: 'text' | 'lines' }
    | { kind: 'number'; min: number; max: number; step?: number }
    | { kind: 'select'; options: readonly { value: string; label: string }[]; numeric?: boolean }
  );

export const TERMINAL_SETTINGS_GROUPS: readonly {
  title: string;
  fields: readonly TerminalSettingsField[];
}[] = [
  {
    title: 'Appearance',
    fields: [
      {
        key: 'gpuAcceleration',
        kind: 'select',
        label: 'Graphics acceleration',
        description:
          'Use graphics hardware when available. The terminal falls back automatically if graphics become unavailable.',
        options: [
          { value: 'auto', label: 'Automatic' },
          { value: 'off', label: 'Off' },
        ],
      },
      {
        key: 'fontLigatures',
        kind: 'toggle',
        label: 'Join programming symbols',
        description:
          'Draw sequences such as != and => as joined symbols when the font supports it. Commands and copied text keep their original characters.',
      },
      {
        key: 'colorScheme',
        kind: 'select',
        label: 'Color theme',
        options: [
          { value: 'system', label: 'Match DNAForge' },
          { value: 'mocha', label: 'Catppuccin Mocha · Dark' },
          { value: 'latte', label: 'Catppuccin Latte · Light' },
        ],
      },
      { key: 'fontFamily', kind: 'text', label: 'Font family' },
      { key: 'fontSize', kind: 'number', label: 'Font size', min: 8, max: 48 },
      { key: 'lineHeight', kind: 'number', label: 'Line height', min: 1, max: 3, step: 0.05 },
      {
        key: 'letterSpacing',
        kind: 'number',
        label: 'Letter spacing',
        min: -2,
        max: 10,
        step: 0.1,
      },
      {
        key: 'fontWeight',
        kind: 'select',
        label: 'Normal text weight',
        numeric: true,
        options: [100, 200, 300, 400, 500, 600, 700, 800, 900].map((value) => ({
          value: String(value),
          label: String(value),
        })),
      },
      {
        key: 'fontWeightBold',
        kind: 'select',
        label: 'Bold text weight',
        numeric: true,
        options: [100, 200, 300, 400, 500, 600, 700, 800, 900].map((value) => ({
          value: String(value),
          label: String(value),
        })),
      },
      {
        key: 'minimumContrastRatio',
        kind: 'number',
        label: 'Minimum text contrast',
        min: 1,
        max: 21,
        step: 0.5,
      },
    ],
  },
  {
    title: 'Cursor',
    fields: [
      {
        key: 'cursorStyle',
        kind: 'select',
        label: 'Cursor shape',
        options: [
          { value: 'block', label: 'Block' },
          { value: 'bar', label: 'Bar' },
          { value: 'underline', label: 'Underline' },
        ],
      },
      { key: 'cursorBlink', kind: 'toggle', label: 'Blink cursor' },
      {
        key: 'cursorInactiveStyle',
        kind: 'select',
        label: 'Inactive cursor',
        options: [
          { value: 'outline', label: 'Outline' },
          { value: 'block', label: 'Block' },
          { value: 'bar', label: 'Bar' },
          { value: 'underline', label: 'Underline' },
          { value: 'none', label: 'Hidden' },
        ],
      },
      { key: 'cursorWidth', kind: 'number', label: 'Bar cursor width', min: 1, max: 10 },
    ],
  },
  {
    title: 'Scrolling and commands',
    fields: [
      { key: 'scrollback', kind: 'number', label: 'Scrollback lines', min: 100, max: 10000 },
      { key: 'smoothScrolling', kind: 'toggle', label: 'Animate scrolling' },
      { key: 'stickyScrollEnabled', kind: 'toggle', label: 'Keep command visible while scrolling' },
      {
        key: 'stickyScrollMaxLineCount',
        kind: 'number',
        label: 'Pinned command lines',
        min: 1,
        max: 10,
      },
      {
        key: 'stickyScrollIgnoredCommands',
        kind: 'lines',
        label: 'Commands without sticky scroll',
        description: 'Enter one command per line.',
      },
      {
        key: 'commandDecorations',
        kind: 'select',
        label: 'Command markers',
        options: [
          { value: 'both', label: 'Gutter and scrollbar' },
          { value: 'gutter', label: 'Gutter' },
          { value: 'overviewRuler', label: 'Scrollbar' },
          { value: 'never', label: 'Hidden' },
        ],
      },
    ],
  },
  {
    title: 'Selection and input',
    fields: [
      { key: 'copyOnSelection', kind: 'toggle', label: 'Copy on selection' },
      { key: 'multilinePasteWarning', kind: 'toggle', label: 'Warn before pasting multiple lines' },
      {
        key: 'rightClickBehavior',
        kind: 'select',
        label: 'Right click',
        options: [
          { value: 'platform', label: 'Platform default' },
          { value: 'default', label: 'Context menu' },
          { value: 'copyPaste', label: 'Copy selection or paste' },
          { value: 'paste', label: 'Paste' },
          { value: 'selectWord', label: 'Select word and menu' },
          { value: 'nothing', label: 'Pass to program' },
        ],
      },
      {
        key: 'macOptionIsMeta',
        kind: 'toggle',
        label: 'Use Option as Meta',
        description: 'Send Option shortcuts to terminal programs as Meta shortcuts.',
      },
      {
        key: 'macOptionClickForcesSelection',
        kind: 'toggle',
        label: 'Use Option to force text selection',
      },
      {
        key: 'altClickMovesCursor',
        kind: 'toggle',
        label: 'Move the cursor with Alt/Option-click',
      },
      {
        key: 'wordSeparators',
        kind: 'text',
        label: 'Word separators',
        description: 'Characters that separate words when you double-click to select.',
      },
      { key: 'enableFileLinks', kind: 'toggle', label: 'Detect file and folder links' },
    ],
  },
  {
    title: 'Accessibility and alerts',
    fields: [
      { key: 'screenReaderMode', kind: 'toggle', label: 'Screen reader mode' },
      { key: 'enableVisualBell', kind: 'toggle', label: 'Show visual bell' },
      {
        key: 'bellDuration',
        kind: 'number',
        label: 'Bell duration (ms)',
        min: 100,
        max: 10000,
        step: 100,
      },
    ],
  },
];

export type TerminalSettingsTargetId = `terminal-${keyof TerminalPreferences}`;
export const TERMINAL_SETTINGS_TARGETS = Object.fromEntries(
  TERMINAL_SETTINGS_GROUPS.flatMap((group) =>
    group.fields.map((field) => [
      `terminal-${field.key}`,
      {
        section: 'terminal' as const,
        title: field.label,
        description: field.description,
        aliases: `terminal ${group.title} ${field.key}`,
        desktopOnly: true,
      },
    ])
  )
) as Record<
  TerminalSettingsTargetId,
  {
    section: 'terminal';
    title: string;
    description?: string;
    aliases: string;
    desktopOnly: true;
  }
>;
