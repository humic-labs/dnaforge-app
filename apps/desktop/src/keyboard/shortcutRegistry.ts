import { COMMAND_IDS, type CommandBinding, type CommandId } from '../commands/types';
import {
  matchesShortcut,
  type ShortcutDefinition,
  type ShortcutEventLike,
} from '@waypoint/ui-components/keyboard';

export type ShortcutAvailability = 'active' | 'suggested';

export type ShortcutAreaId =
  | 'application'
  | 'files'
  | 'tabs'
  | 'sequence'
  | 'pdf'
  | 'pages'
  | 'chat'
  | 'genome'
  | 'developer';

export type ShortcutScope =
  | 'global'
  | 'file-tree'
  | 'sequence'
  | 'pdf'
  | 'find-bar'
  | 'page'
  | 'document'
  | 'terminal'
  | 'chat'
  | 'genome'
  | 'development';

export interface ShortcutCommandLink {
  command: CommandId;
  allowInInput?: boolean;

  chordIndex?: number;
}

export type ShortcutKeysLabel = string | { readonly apple: string; readonly standard: string };

export interface AppShortcut {
  id: string;
  area: ShortcutAreaId;
  label: string;
  scope: ShortcutScope;
  availability: ShortcutAvailability;
  chords: readonly ShortcutDefinition[];

  keysLabel?: ShortcutKeysLabel;
  when?: string;
  note?: string;

  inAppMenu?: boolean;
  commandIds?: readonly CommandId[];

  commandBindings?: readonly ShortcutCommandLink[];

  sharesChordWith?: readonly string[];
}

export interface ShortcutArea {
  id: ShortcutAreaId;
  title: string;
  description: string;
}

export const SHORTCUT_AREAS: readonly ShortcutArea[] = [
  {
    id: 'application',
    title: 'Window',
    description: 'Keys that work no matter which part of the app you are in.',
  },
  {
    id: 'files',
    title: 'Explorer',
    description: 'The file list on the left, plus opening and saving a document.',
  },
  {
    id: 'tabs',
    title: 'Tabs',
    description: 'The tabs across the top. Closing a tab does not quit the app.',
  },
  {
    id: 'sequence',
    title: 'Sequence viewer',
    description:
      'A sequence. While you are editing, A, C, G, T, and N insert bases, so commands use a modifier.',
  },
  {
    id: 'pdf',
    title: 'PDF viewer',
    description: 'Zoom the PDF in the focused panel.',
  },
  {
    id: 'pages',
    title: 'Page',
    description: 'Formatting while a page is open.',
  },
  {
    id: 'chat',
    title: 'Ask AI',
    description: 'The chat box. Opening Ask AI and starting a new chat are listed under Window.',
  },
  {
    id: 'genome',
    title: 'Genome view',
    description: 'A genome or an alignment, while that view is open.',
  },
];

const MODIFIERS = ['ctrl', 'alt', 'shift', 'cmd'] as const;

function resolveChord(definition: ShortcutDefinition, apple: boolean): readonly string[] {
  if ('apple' in definition) return apple ? definition.apple : definition.standard;
  return definition;
}

export function chordKey(definition: ShortcutDefinition, apple: boolean): string {
  const tokens = resolveChord(definition, apple);
  const modifiers = MODIFIERS.filter((modifier) => tokens.includes(modifier));
  const keys = tokens
    .filter((token) => !(MODIFIERS as readonly string[]).includes(token))
    .map((token) => token.toLowerCase());
  return [...modifiers, ...keys].join('+');
}

export const APP_SHORTCUTS: readonly AppShortcut[] = [
  {
    id: 'terminal.toggle',
    area: 'application',
    label: 'Toggle Terminal',
    scope: 'global',
    availability: 'active',
    chords: [['ctrl', '`']],
    commandIds: [COMMAND_IDS.terminalToggle],
    commandBindings: [{ command: COMMAND_IDS.terminalToggle, allowInInput: true }],
  },
  {
    id: 'terminal.new',
    area: 'application',
    label: 'New Terminal',
    scope: 'global',
    availability: 'active',
    chords: [['ctrl', 'shift', '`']],
    commandIds: [COMMAND_IDS.terminalNew],
    commandBindings: [{ command: COMMAND_IDS.terminalNew, allowInInput: true }],
  },
  {
    id: 'app.new-chat',
    area: 'application',
    label: 'New Chat',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'n']],
    inAppMenu: true,
    commandIds: [COMMAND_IDS.appNewChat],
    commandBindings: [{ command: COMMAND_IDS.appNewChat, allowInInput: true }],
  },
  {
    id: 'app.ai-chat',
    area: 'application',
    label: 'AI Chat',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', '/']],
    commandIds: [COMMAND_IDS.appFocusCommandInput],
    commandBindings: [{ command: COMMAND_IDS.appFocusCommandInput, allowInInput: true }],
  },
  {
    id: 'app.settings',
    area: 'application',
    label: 'Settings',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', ',']],
    inAppMenu: true,
    commandIds: [COMMAND_IDS.appOpenSettings],
    commandBindings: [{ command: COMMAND_IDS.appOpenSettings }],
  },
  {
    id: 'app.toggle-sidebar',
    area: 'application',
    label: 'Toggle Sidebar',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'b']],
    commandIds: [COMMAND_IDS.appToggleSidebar],
    commandBindings: [{ command: COMMAND_IDS.appToggleSidebar }],
  },
  {
    id: 'app.explorer',
    area: 'application',
    label: 'Explorer',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'e']],
    inAppMenu: true,
    commandIds: [COMMAND_IDS.appShowExplorer],
    commandBindings: [{ command: COMMAND_IDS.appShowExplorer }],
  },
  {
    id: 'app.search',
    area: 'application',
    label: 'Search',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'f']],
    when: 'The whole project',
    inAppMenu: true,
    commandIds: [COMMAND_IDS.workspaceSearch],
    commandBindings: [{ command: COMMAND_IDS.workspaceSearch }],
  },
  {
    id: 'app.dark-mode',
    area: 'application',
    label: 'Dark Mode',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'd']],
  },
  {
    id: 'app.undo',
    area: 'application',
    label: 'Undo',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'z']],
    inAppMenu: true,
    commandIds: [COMMAND_IDS.editUndo],
    commandBindings: [{ command: COMMAND_IDS.editUndo }],
  },
  {
    id: 'app.redo',
    area: 'application',
    label: 'Redo',
    scope: 'global',
    availability: 'active',
    chords: [
      ['cmd', 'shift', 'z'],
      ['ctrl', 'y'],
    ],
    inAppMenu: true,
    commandIds: [COMMAND_IDS.editRedo],
    commandBindings: [
      { command: COMMAND_IDS.editRedo, chordIndex: 0 },
      { command: COMMAND_IDS.editRedo, chordIndex: 1 },
    ],
  },
  {
    id: 'app.cut',
    area: 'application',
    label: 'Cut',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'x']],
    when: 'Text, and a sequence while editing',
  },
  {
    id: 'app.copy',
    area: 'application',
    label: 'Copy',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'c']],
    when: 'Text, and a sequence selection',
  },
  {
    id: 'app.paste',
    area: 'application',
    label: 'Paste',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'v']],
    when: 'Text, and a sequence while editing',
  },
  {
    id: 'app.select-all',
    area: 'application',
    label: 'Select All',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'a']],
    when: 'Text, the file list, and a sequence',
  },
  {
    id: 'app.go-to-file',
    area: 'application',
    label: 'Go to file',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'p']],
    commandIds: [COMMAND_IDS.appGoToFile],
    commandBindings: [{ command: COMMAND_IDS.appGoToFile, allowInInput: true }],
  },

  {
    id: 'files.new-folder',
    area: 'files',
    label: 'New Folder',
    scope: 'file-tree',
    availability: 'active',
    chords: [['cmd', 'shift', 'n']],
    when: 'Files',
    commandIds: [COMMAND_IDS.fileNewFolder],
    commandBindings: [{ command: COMMAND_IDS.fileNewFolder }],
  },
  {
    id: 'files.import-files',
    area: 'files',
    label: 'Import Files',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'o']],
    inAppMenu: true,
  },
  {
    id: 'files.import-folder',
    area: 'files',
    label: 'Import Folder',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'o']],
    inAppMenu: true,
  },
  {
    id: 'files.save',
    area: 'files',
    label: 'Save',
    scope: 'document',
    availability: 'active',
    chords: [['cmd', 's']],
    when: 'The editable document in the focused panel',
    commandIds: [COMMAND_IDS.fileSave],
    commandBindings: [{ command: COMMAND_IDS.fileSave, allowInInput: true }],
  },
  {
    id: 'files.move',
    area: 'files',
    label: 'Move in the list',
    scope: 'file-tree',
    availability: 'active',
    chords: [['arrowup'], ['arrowdown'], ['arrowleft'], ['arrowright']],
    keysLabel: '← → ↑ ↓',
    when: 'File list',
  },
  {
    id: 'files.jump-ends',
    area: 'files',
    label: 'Start or end of the list',
    scope: 'file-tree',
    availability: 'active',
    chords: [['home'], ['end']],
    when: 'File list',
  },
  {
    id: 'files.open',
    area: 'files',
    label: 'Open',
    scope: 'file-tree',
    availability: 'active',
    chords: [['enter']],
    when: 'File list. On a folder, expands or collapses it',
  },
  {
    id: 'files.toggle-selection',
    area: 'files',
    label: 'Add or remove from the selection',
    scope: 'file-tree',
    availability: 'active',
    chords: [['space']],
    when: 'File list',
  },
  {
    id: 'files.move-to-trash',
    area: 'files',
    label: 'Move to Trash',
    scope: 'file-tree',
    availability: 'active',
    chords: [{ apple: ['cmd', 'backspace'], standard: ['delete'] }],
    when: 'File list',
    note: 'On Windows and Linux this is the Delete key, which also deletes a base in a sequence.',
  },
  {
    id: 'files.rename',
    area: 'files',
    label: 'Rename',
    scope: 'file-tree',
    availability: 'active',
    chords: [['F2']],
    when: 'File list',
    commandIds: [COMMAND_IDS.fileRename],
  },
  {
    id: 'files.find-in-folder',
    area: 'files',
    label: 'Find in folder',
    scope: 'global',
    availability: 'active',
    chords: [['alt', 'cmd', 'f']],
    when: 'File list',
    commandIds: [COMMAND_IDS.workspaceFindInFolder],
  },
  {
    id: 'files.show-in-project',
    area: 'files',
    label: 'Show in project',
    scope: 'global',
    availability: 'active',
    chords: [['alt', 'cmd', 'e']],
    note: 'Shows the open tab in Explorer.',
    commandIds: [COMMAND_IDS.workspaceRevealActiveFile],
    commandBindings: [{ command: COMMAND_IDS.workspaceRevealActiveFile, allowInInput: true }],
  },
  {
    id: 'files.copy-path',
    area: 'files',
    label: 'Copy path',
    scope: 'file-tree',
    availability: 'active',
    chords: [['alt', 'cmd', 'c']],
    when: 'File list',
    note: 'A page uses this same key for a code block.',
  },
  {
    id: 'files.copy-relative-path',
    area: 'files',
    label: 'Copy relative path',
    scope: 'file-tree',
    availability: 'active',
    chords: [['shift', 'alt', 'cmd', 'c']],
    when: 'File list',
  },
  {
    id: 'files.reveal',
    area: 'files',
    label: 'Reveal in file manager',
    scope: 'file-tree',
    availability: 'active',
    chords: [['alt', 'cmd', 'r']],
    when: 'File list',
  },
  {
    id: 'files.open-in-new-panel',
    area: 'files',
    label: 'Open in new panel',
    scope: 'file-tree',
    availability: 'active',
    chords: [['cmd', 'enter']],
    when: 'File list',
  },

  {
    id: 'tabs.next',
    area: 'tabs',
    label: 'Next tab in the focused pane',
    scope: 'document',
    availability: 'active',
    chords: [['ctrl', 'tab']],
    commandIds: [COMMAND_IDS.canvasNextTab],
    when: 'Focused pane, outside editors and blocking dialogs or menus',
  },
  {
    id: 'tabs.previous',
    area: 'tabs',
    label: 'Previous tab in the focused pane',
    scope: 'document',
    availability: 'active',
    chords: [['ctrl', 'shift', 'tab']],
    commandIds: [COMMAND_IDS.canvasPreviousTab],
    when: 'Focused pane, outside editors and blocking dialogs or menus',
  },
  {
    id: 'terminal.next-tab',
    area: 'tabs',
    label: 'Next terminal subtab',
    scope: 'terminal',
    availability: 'active',
    chords: [{ apple: ['cmd', 'shift', ']'], standard: ['ctrl', 'PageDown'] }],
    when: 'Terminal input or terminal subtab list',
  },
  {
    id: 'terminal.previous-tab',
    area: 'tabs',
    label: 'Previous terminal subtab',
    scope: 'terminal',
    availability: 'active',
    chords: [{ apple: ['cmd', 'shift', '['], standard: ['ctrl', 'PageUp'] }],
    when: 'Terminal input or terminal subtab list',
  },
  {
    id: 'tabs.close',
    area: 'tabs',
    label: 'Close Tab',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'w']],
    note: 'Does not close the window. Close Window has no key.',
    inAppMenu: true,
  },
  {
    id: 'tabs.reopen',
    area: 'tabs',
    label: 'Reopen Closed Tab',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 't']],
    inAppMenu: true,
  },
  {
    id: 'tabs.reload',
    area: 'tabs',
    label: 'Reload',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'r']],
    note: 'Asks first when work is unsaved.',
    inAppMenu: true,
  },
  {
    id: 'tabs.force-reload',
    area: 'tabs',
    label: 'Force Reload',
    scope: 'global',
    availability: 'active',
    chords: [['cmd', 'shift', 'r']],
    note: 'Asks first, then reloads past the cache.',
    inAppMenu: true,
  },
  {
    id: 'tabs.go-to',
    commandIds: [COMMAND_IDS.canvasSelectTab],
    area: 'tabs',
    label: 'Go to tab',
    scope: 'global',
    availability: 'active',
    chords: [
      ['cmd', '1'],
      ['cmd', '2'],
      ['cmd', '3'],
      ['cmd', '4'],
      ['cmd', '5'],
      ['cmd', '6'],
      ['cmd', '7'],
      ['cmd', '8'],
      ['cmd', '9'],
      ['cmd', '0'],
    ],
    keysLabel: { apple: '⌘1–⌘9  ⌘0', standard: 'Ctrl+1–Ctrl+9  Ctrl+0' },
    note: '1 through 9 open that tab. 0 opens the last tab.',
    sharesChordWith: ['pdf.reset-zoom'],
  },
  {
    id: 'tabs.close-others',
    area: 'tabs',
    label: 'Close other tabs',
    scope: 'global',
    availability: 'active',
    chords: [['alt', 'cmd', 'w']],
    commandIds: [COMMAND_IDS.canvasCloseOtherTabs],
    commandBindings: [{ command: COMMAND_IDS.canvasCloseOtherTabs, allowInInput: true }],
  },

  {
    id: 'pdf.zoom-in',
    area: 'pdf',
    label: 'Zoom in',
    scope: 'pdf',
    availability: 'active',
    chords: [
      ['cmd', '='],
      ['cmd', 'shift', '+'],
      ['cmd', '+'],
      ['cmd', 'shift', '='],
    ],
    keysLabel: { apple: '⌘+ or ⌘=', standard: 'Ctrl++ or Ctrl+=' },
    when: 'Focused PDF',
    commandIds: [COMMAND_IDS.pdfZoomIn],
    commandBindings: [
      { command: COMMAND_IDS.pdfZoomIn },
      { command: COMMAND_IDS.pdfZoomIn, chordIndex: 1 },
      { command: COMMAND_IDS.pdfZoomIn, chordIndex: 2 },
      { command: COMMAND_IDS.pdfZoomIn, chordIndex: 3 },
    ],
  },
  {
    id: 'pdf.zoom-out',
    area: 'pdf',
    label: 'Zoom out',
    scope: 'pdf',
    availability: 'active',
    chords: [['cmd', '-']],
    when: 'Focused PDF',
    commandIds: [COMMAND_IDS.pdfZoomOut],
    commandBindings: [{ command: COMMAND_IDS.pdfZoomOut }],
  },
  {
    id: 'pdf.reset-zoom',
    area: 'pdf',
    label: 'Actual size (100%)',
    scope: 'pdf',
    availability: 'active',
    chords: [['cmd', '0']],
    when: 'Focused PDF',
    commandIds: [COMMAND_IDS.pdfResetZoom],
    commandBindings: [{ command: COMMAND_IDS.pdfResetZoom }],
    sharesChordWith: ['tabs.go-to'],
  },

  {
    id: 'sequence.find',
    area: 'sequence',
    label: 'Find',
    scope: 'sequence',
    availability: 'active',
    chords: [['cmd', 'f']],
    when: 'Sequence',
    note: 'Press again while the find bar is open to switch between DNA and amino acids.',
    commandIds: [COMMAND_IDS.sequenceFind, COMMAND_IDS.sequenceFindAminoAcid],
    commandBindings: [{ command: COMMAND_IDS.sequenceFind, allowInInput: true }],
  },
  {
    id: 'sequence.find-next',
    area: 'sequence',
    label: 'Next match',
    scope: 'find-bar',
    availability: 'active',
    chords: [['enter']],
    when: 'Find bar',
  },
  {
    id: 'sequence.find-previous',
    area: 'sequence',
    label: 'Previous match',
    scope: 'find-bar',
    availability: 'active',
    chords: [['shift', 'enter']],
    when: 'Find bar',
  },
  {
    id: 'sequence.find-move',
    area: 'sequence',
    label: 'Move through matches',
    scope: 'find-bar',
    availability: 'active',
    chords: [['arrowup'], ['arrowdown']],
    keysLabel: '↑ ↓',
    when: 'Find bar',
  },
  {
    id: 'sequence.find-close',
    area: 'sequence',
    label: 'Close find',
    scope: 'find-bar',
    availability: 'active',
    chords: [['escape']],
    when: 'Find bar',
  },
  {
    id: 'sequence.move',
    area: 'sequence',
    label: 'Move by base or line',
    scope: 'sequence',
    availability: 'active',
    chords: [['arrowleft'], ['arrowright'], ['arrowup'], ['arrowdown']],
    keysLabel: '← → ↑ ↓',
    when: 'Sequence',
  },
  {
    id: 'sequence.extend-selection',
    area: 'sequence',
    label: 'Extend the selection',
    scope: 'sequence',
    availability: 'active',
    chords: [
      ['shift', 'arrowleft'],
      ['shift', 'arrowright'],
      ['shift', 'arrowup'],
      ['shift', 'arrowdown'],
    ],
    when: 'Sequence',
  },
  {
    id: 'sequence.line-ends-modified',
    area: 'sequence',
    label: 'Jump to the line ends',
    scope: 'sequence',
    availability: 'active',
    chords: [
      ['cmd', 'arrowleft'],
      ['cmd', 'arrowright'],
    ],
    when: 'Linear sequence',
  },
  {
    id: 'sequence.line-ends',
    area: 'sequence',
    label: 'Start or end of the line',
    scope: 'sequence',
    availability: 'active',
    chords: [['home'], ['end']],
    when: 'Sequence',
  },
  {
    id: 'sequence.insert-base',
    area: 'sequence',
    label: 'Insert a base',
    scope: 'sequence',
    availability: 'active',
    chords: [['a'], ['c'], ['g'], ['t'], ['n']],
    keysLabel: 'A C G T N',
    when: 'Editing a sequence',
  },
  {
    id: 'sequence.delete-bases',
    area: 'sequence',
    label: 'Delete bases',
    scope: 'sequence',
    availability: 'active',
    chords: [['backspace'], ['delete']],
    when: 'Editing a sequence',
  },
  {
    id: 'sequence.commit',
    area: 'sequence',
    label: 'Commit edit',
    scope: 'sequence',
    availability: 'active',
    chords: [['enter']],
    when: 'Editing a sequence',
  },
  {
    id: 'sequence.invert',
    area: 'sequence',
    label: 'Invert selection',
    scope: 'sequence',
    availability: 'active',
    chords: [['cmd', 'shift', 'i']],
    when: 'Sequence',
    note: 'Circular sequences only.',
  },
  {
    id: 'sequence.clear',
    area: 'sequence',
    label: 'Clear selection',
    scope: 'sequence',
    availability: 'active',
    chords: [['escape']],
    when: 'Sequence',
  },
  {
    id: 'sequence.linear-circular',
    area: 'sequence',
    label: 'Switch linear and circular',
    scope: 'sequence',
    availability: 'active',
    chords: [['cmd', 'shift', 'l']],
    when: 'Sequence',
  },
  {
    id: 'sequence.add-annotation',
    area: 'sequence',
    label: 'Add annotation',
    scope: 'sequence',
    availability: 'active',
    chords: [['cmd', 'shift', 'a']],
    when: 'A range is selected',
  },
  {
    id: 'sequence.copy-translation',
    area: 'sequence',
    label: 'Copy translation',
    scope: 'sequence',
    availability: 'active',
    chords: [['cmd', 'shift', 'c']],
    when: 'A range is selected',
  },
  {
    id: 'sequence.reverse-complement',
    area: 'sequence',
    label: 'Copy reverse complement',
    scope: 'sequence',
    availability: 'active',
    chords: [['shift', 'alt', 'cmd', 'r']],
    when: 'A range is selected',
  },
  {
    id: 'sequence.next-feature',
    area: 'sequence',
    label: 'Next annotation',
    scope: 'sequence',
    availability: 'active',
    chords: [['alt', 'arrowdown']],
  },
  {
    id: 'sequence.previous-feature',
    area: 'sequence',
    label: 'Previous annotation',
    scope: 'sequence',
    availability: 'active',
    chords: [['alt', 'arrowup']],
  },
  {
    id: 'pages.bold',
    area: 'pages',
    label: 'Bold',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'b']],
    when: 'Page',
  },
  {
    id: 'pages.italic',
    area: 'pages',
    label: 'Italic',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'i']],
    when: 'Page',
  },
  {
    id: 'pages.underline',
    area: 'pages',
    label: 'Underline',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'u']],
    when: 'Page',
  },
  {
    id: 'pages.strike',
    area: 'pages',
    label: 'Strikethrough',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'x']],
    when: 'Page',
  },
  {
    id: 'pages.code',
    area: 'pages',
    label: 'Inline code',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'e']],
    when: 'Page',
  },
  {
    id: 'pages.highlight',
    area: 'pages',
    label: 'Highlight',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'h']],
    when: 'Page',
  },
  {
    id: 'pages.heading-1',
    area: 'pages',
    label: 'Heading 1',
    scope: 'page',
    availability: 'active',
    chords: [['alt', 'cmd', '1']],
    when: 'Page',
  },
  {
    id: 'pages.heading-2',
    area: 'pages',
    label: 'Heading 2',
    scope: 'page',
    availability: 'active',
    chords: [['alt', 'cmd', '2']],
    when: 'Page',
  },
  {
    id: 'pages.heading-3',
    area: 'pages',
    label: 'Heading 3',
    scope: 'page',
    availability: 'active',
    chords: [['alt', 'cmd', '3']],
    when: 'Page',
  },
  {
    id: 'pages.numbered-list',
    area: 'pages',
    label: 'Numbered list',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', '7']],
    when: 'Page',
  },
  {
    id: 'pages.bullet-list',
    area: 'pages',
    label: 'Bullet list',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', '8']],
    when: 'Page',
  },
  {
    id: 'pages.task-list',
    area: 'pages',
    label: 'Task list',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', '9']],
    when: 'Page',
  },
  {
    id: 'pages.quote',
    area: 'pages',
    label: 'Quote',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', '.']],
    when: 'Page',
  },
  {
    id: 'pages.code-block',
    area: 'pages',
    label: 'Code block',
    scope: 'page',
    availability: 'active',
    chords: [['alt', 'cmd', 'c']],
    when: 'Page',
  },
  {
    id: 'pages.clear-formatting',
    area: 'pages',
    label: 'Clear formatting',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', '\\']],
    when: 'Page',
  },
  {
    id: 'pages.subscript',
    area: 'pages',
    label: 'Subscript',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', ',']],
    when: 'Page',
  },
  {
    id: 'pages.superscript',
    area: 'pages',
    label: 'Superscript',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', '.']],
    when: 'Page',
  },
  {
    id: 'pages.move-up',
    area: 'pages',
    label: 'Move block up',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'arrowup']],
    when: 'Page',
  },
  {
    id: 'pages.move-down',
    area: 'pages',
    label: 'Move block down',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'arrowdown']],
    when: 'Page',
  },
  {
    id: 'pages.duplicate-block',
    area: 'pages',
    label: 'Duplicate block',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'd']],
    when: 'Page',
  },
  {
    id: 'pages.delete-block',
    area: 'pages',
    label: 'Delete block',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'backspace']],
    when: 'Page',
  },
  {
    id: 'pages.link',
    area: 'pages',
    label: 'Insert link',
    scope: 'page',
    availability: 'active',
    chords: [['cmd', 'shift', 'k']],
    note: 'AI Chat already uses the chord without Shift, including while you are typing.',
  },

  {
    id: 'chat.newline',
    area: 'chat',
    label: 'New line',
    scope: 'chat',
    availability: 'active',
    chords: [['shift', 'enter']],
    when: 'Composer',
  },
  {
    id: 'chat.stop',
    area: 'chat',
    label: 'Stop the reply',
    scope: 'chat',
    availability: 'active',
    chords: [['escape']],
    when: 'Composer, while a reply is running',
  },
  {
    id: 'chat.approval-focus',
    area: 'chat',
    label: 'Answer a waiting agent request',
    scope: 'chat',
    availability: 'active',
    chords: [['alt', 'cmd', 'a']],
    when: 'An agent is waiting for your answer',
  },
  {
    id: 'chat.previous',
    area: 'chat',
    label: 'Previous conversation',
    scope: 'chat',
    availability: 'active',
    chords: [['alt', 'cmd', '[']],
    commandIds: [COMMAND_IDS.chatPrevious],
    commandBindings: [{ command: COMMAND_IDS.chatPrevious, allowInInput: true }],
  },
  {
    id: 'chat.next',
    area: 'chat',
    label: 'Next conversation',
    scope: 'chat',
    availability: 'active',
    chords: [['alt', 'cmd', ']']],
    commandIds: [COMMAND_IDS.chatNext],
    commandBindings: [{ command: COMMAND_IDS.chatNext, allowInInput: true }],
  },

  {
    id: 'genome.dismiss-read',
    area: 'genome',
    label: 'Dismiss a pinned read',
    scope: 'genome',
    availability: 'active',
    chords: [['escape']],
    when: 'A read is pinned',
  },
];

const SHORTCUTS_BY_ID = new Map(APP_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function appShortcut(id: string): AppShortcut {
  const shortcut = SHORTCUTS_BY_ID.get(id);
  if (!shortcut) throw new Error(`Unknown shortcut: ${id}`);
  return shortcut;
}

export function shortcutChord(id: string, chordIndex = 0): ShortcutDefinition {
  const chord = appShortcut(id).chords[chordIndex];
  if (!chord) throw new Error(`Shortcut ${id} has no chord ${chordIndex}`);
  return chord;
}

export function matchesAppShortcut(event: ShortcutEventLike, id: string): boolean {
  return appShortcut(id).chords.some((chord) => matchesShortcut(event, chord));
}

const ELECTRON_KEY_NAMES: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  backspace: 'Backspace',
  delete: 'Delete',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  ' ': 'Space',
};

export function electronAccelerator(id: string): string {
  const tokens = resolveChord(shortcutChord(id), false);
  const key = tokens.find((token) => !(MODIFIERS as readonly string[]).includes(token));
  if (!key) throw new Error(`Shortcut ${id} has no key`);
  const parts: string[] = [];
  if (tokens.includes('cmd')) parts.push('CmdOrCtrl');
  else if (tokens.includes('ctrl')) parts.push('Ctrl');
  if (tokens.includes('alt')) parts.push('Alt');
  if (tokens.includes('shift')) parts.push('Shift');
  const named = ELECTRON_KEY_NAMES[key.toLowerCase()];
  parts.push(named ?? (key.length === 1 ? key.toUpperCase() : key));
  return parts.join('+');
}

function bindingFromChord(link: ShortcutCommandLink, chord: ShortcutDefinition): CommandBinding {
  const tokens = resolveChord(chord, false);
  const key = tokens.find((token) => !(MODIFIERS as readonly string[]).includes(token));
  if (!key) throw new Error(`Command ${link.command} has no key`);
  return {
    command: link.command,
    key,
    cmd: tokens.includes('cmd') || undefined,
    ctrl: tokens.includes('ctrl') || undefined,
    shift: tokens.includes('shift') || undefined,
    alt: tokens.includes('alt') || undefined,
    allowInInput: link.allowInInput,
  };
}

export function commandBindingsFromRegistry(): readonly CommandBinding[] {
  return APP_SHORTCUTS.flatMap((shortcut) =>
    (shortcut.commandBindings ?? []).map((link) =>
      bindingFromChord(link, shortcutChord(shortcut.id, link.chordIndex ?? 0))
    )
  );
}
