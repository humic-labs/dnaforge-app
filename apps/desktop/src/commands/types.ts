import type { ReactNode } from 'react';

export const COMMAND_IDS = {
  terminalToggle: 'terminal.toggle',
  terminalNew: 'terminal.new',
  terminalRunSelection: 'terminal.runSelection',
  terminalRunActiveFile: 'terminal.runActiveFile',
  appNewChat: 'app.newChat',
  appFocusCommandInput: 'app.focusCommandInput',
  appOpenSettings: 'app.openSettings',
  appToggleSidebar: 'app.toggleSidebar',
  appShowExplorer: 'app.showExplorer',
  appShowRegistry: 'app.showRegistry',
  workspaceRevealPath: 'workspace.revealPath',
  workspaceSearch: 'workspace.search',
  workspaceFindInFolder: 'workspace.findInFolder',
  fileRename: 'file.rename',
  fileSave: 'file.save',
  fileNewFolder: 'file.newFolder',
  fileNewText: 'file.newText',
  editUndo: 'edit.undo',
  editRedo: 'edit.redo',
  sequenceFind: 'sequence.find',
  sequenceFindAminoAcid: 'sequence.findAminoAcid',
  pdfZoomIn: 'pdf.zoomIn',
  pdfZoomOut: 'pdf.zoomOut',
  pdfResetZoom: 'pdf.resetZoom',
  canvasNextTab: 'canvas.nextTab',
  canvasPreviousTab: 'canvas.previousTab',
  canvasCloseOtherTabs: 'canvas.closeOtherTabs',
  canvasSelectTab: 'canvas.selectTab',
  workspaceRevealActiveFile: 'workspace.revealActiveFile',
  appGoToFile: 'app.goToFile',
  chatPrevious: 'chat.previous',
  chatNext: 'chat.next',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

export const COMMAND_SCOPES = {
  modal: 'modal',
  menuContext: 'menu.context',
  inputEditor: 'input.editor',
  embedGrid: 'embed.grid',
  sidebarFileTree: 'sidebar.fileTree',
  tabSequence: 'tab.sequence',
  tabPdf: 'tab.pdf',
  tabText: 'tab.text',
  canvasPanel: 'canvas.panel',
  appGlobal: 'app.global',
} as const;

export type CommandScope = (typeof COMMAND_SCOPES)[keyof typeof COMMAND_SCOPES];

export const COMMAND_SCOPE_PRIORITY: Record<CommandScope, number> = {
  [COMMAND_SCOPES.modal]: 900,
  [COMMAND_SCOPES.menuContext]: 800,
  [COMMAND_SCOPES.inputEditor]: 700,
  [COMMAND_SCOPES.embedGrid]: 600,
  [COMMAND_SCOPES.sidebarFileTree]: 500,
  [COMMAND_SCOPES.tabSequence]: 400,
  [COMMAND_SCOPES.tabPdf]: 375,
  [COMMAND_SCOPES.tabText]: 350,
  [COMMAND_SCOPES.canvasPanel]: 300,
  [COMMAND_SCOPES.appGlobal]: 0,
};

export const BLOCKING_COMMAND_SCOPES = new Set<CommandScope>([
  COMMAND_SCOPES.modal,
  COMMAND_SCOPES.menuContext,
  COMMAND_SCOPES.inputEditor,
]);

export const FOCUS_COMMAND_SCOPES = new Set<CommandScope>([
  COMMAND_SCOPES.embedGrid,
  COMMAND_SCOPES.sidebarFileTree,
  COMMAND_SCOPES.tabSequence,
  COMMAND_SCOPES.tabPdf,
  COMMAND_SCOPES.tabText,
  COMMAND_SCOPES.canvasPanel,
]);

export const DOCUMENT_COMMAND_SCOPES = new Set<CommandScope>([
  COMMAND_SCOPES.tabSequence,
  COMMAND_SCOPES.tabPdf,
  COMMAND_SCOPES.tabText,
]);

export interface CommandDefinition {
  id: CommandId;
  label: string;
  ownerScope: CommandScope;
  description?: string;
}

export interface CommandBinding {
  command: CommandId;
  key: string;
  cmd?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  allowInInput?: boolean;
  preventDefault?: boolean;
}

export interface CommandContext<Payload = unknown> {
  command: CommandId;
  source: 'keyboard' | 'electron-menu' | 'ui' | 'test' | 'agent';
  event?: KeyboardEvent;
  payload?: Payload;
  bypassBlockingScopes?: readonly CommandScope[];
}

export type CommandHandler<Payload = unknown> = (
  context: CommandContext<Payload>
) => boolean | void;

export interface CommandHandlerRegistration<Payload = unknown> {
  command: CommandId;
  scope: CommandScope;
  handler: CommandHandler<Payload>;
  enabled?: () => boolean;
  label?: string;
  surfaceId?: string;
}

export interface CommandDispatchResult {
  command: CommandId;
  handled: boolean;
  blocked: boolean;
  scope: CommandScope | null;
}

export interface CommandScopeHandle {
  claim: () => void;
  release: () => void;
  eventHandlers: {
    onFocusCapture: () => void;
    onMouseDownCapture: () => void;
  };
}

export interface CommandSystemDebugState {
  activeScopes: CommandScope[];
  lastCommand: CommandDispatchResult | null;
  keyboardListenerAttached?: boolean;
  keyboardEventCount?: number;
  lastKeyboardEvent?: {
    key: string;
    code: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    target: string | null;
    matchedCommand: CommandId | null;
  } | null;
}

export interface CommandRegistryContextValue {
  dispatchCommand: <Payload = unknown>(
    command: CommandId,
    context?: Partial<CommandContext<Payload>>
  ) => CommandDispatchResult;
  registerHandler: <Payload = unknown>(
    registration: CommandHandlerRegistration<Payload>
  ) => () => void;
  claimScope: (scope: CommandScope, ownerId: string, surfaceId?: string) => void;
  releaseScope: (scope: CommandScope, ownerId: string) => void;
  getDebugState: () => CommandSystemDebugState;
}

export interface CommandScopeProviderProps {
  children: ReactNode;
}
