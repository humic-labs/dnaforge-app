import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import type { TerminalPort } from '../../shared/terminal-port';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { useCommandRegistry } from '../../commands';
import { confirmDialog } from '../../components/confirm-dialog-store';
import { createTerminalFileLinkProvider } from './terminal-links';
import { quoteTerminalPath, splitTerminalInput } from './terminal-input';
import { platform } from '../../platform';
import type {
  TerminalEvent,
  TerminalFixedDimensions,
  TerminalCommand,
} from '../../shared/terminal-ipc';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { syncTerminalTheme, terminalTheme } from './terminal-theme';
import { TerminalColorScheme } from '../../shared/terminal-color-scheme';
import type { TerminalPreferences } from './terminal-preferences';
import {
  terminalClipboardAction,
  terminalFindShortcut,
  terminalHistoryShortcut,
  terminalLinkShortcut,
  terminalHostPlatform,
  terminalNavigateGroupDirection,
  terminalSplitShortcut,
  terminalResizeDirection,
  type TerminalResizeDirection,
} from './terminal-keyboard';
import { terminalBufferText } from './terminal-buffer';
import { queueTerminalPaste } from './terminal-paste-queue';
import { TERMINAL_DRAG_TYPE } from './terminal-layout';
import { TerminalSearch, type TerminalSearchContext } from './TerminalSearch';
import { longestTerminalViewportLine } from './upstream/terminal-geometry';
import { TerminalLinks, type TerminalLinksProps } from './TerminalLinks';
import { collectTerminalLinks } from './terminal-detected-links';
import { TerminalCommandDecorations } from './terminal-command-decorations';
import { TerminalCommandActions } from './TerminalCommandActions';
import { TerminalOutputView } from './TerminalOutputView';
import { TerminalFileSearch, type TerminalFileSearchProps } from './TerminalFileSearch';
import { openTerminalFile, terminalFileQueryCandidates } from './terminal-open-file';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { TerminalStickyScroll } from './terminal-sticky-scroll';
import { TerminalCompletions, type TerminalCompletionsProps } from './TerminalCompletions';
import { TerminalPromptResize } from '../../shared/terminal-prompt-resize';
import { TerminalRendering } from './terminal-rendering';

export type TerminalAppearance = TerminalPreferences;

export interface TerminalPaneHandle {
  terminal: Terminal;
  search: SearchAddon;
  fit(): void;
  paste(): Promise<void>;
  insert(text: string): Promise<void>;
  execute(text: string): Promise<void>;
  copy(): Promise<void>;
  output(): string;
  find(): void;
  openLinks(): void;
  complete(): void;
  revealCommand(commandId: string): Promise<void>;
  toggleContentWidth(): Promise<void>;
}

type DataEvent = Extract<TerminalEvent, { kind: 'data' | 'clear' }>;

export function TerminalPane({
  id,
  cwd,
  shellPath,
  userHome,
  port,
  active,
  appearance,
  onReady,
  onOpenDocument,
  onError,
  onFocus,
  onNavigate,
  onNavigateGroup,
  onSplit,
  onHistory,
  onResize,
  onMove,
  direction,
  onContextMenu,
  running,
  canSuggest,
  fixedDimensions,
  onBell,
  bell,
}: {
  id: string;
  cwd: string;
  shellPath: string;
  userHome?: string;
  port: TerminalPort;
  active: boolean;
  appearance: TerminalAppearance;
  onReady(id: string, handle: TerminalPaneHandle | null): void;
  onOpenDocument?(id: string): void;
  onError(message: string): void;
  onFocus(id: string): void;
  onNavigate(id: string, direction: number): void;
  onNavigateGroup(id: string, direction: number): void;
  onSplit(id: string): void;
  onHistory(id: string, kind: 'command' | 'directory'): void;
  onResize(id: string, direction: TerminalResizeDirection, pixels: number): void;
  onMove(source: string, target: string, side: 'before' | 'after'): void;
  direction: 'horizontal' | 'vertical';
  onContextMenu(id: string, x: number, y: number): void;
  running: boolean;
  canSuggest: boolean;
  fixedDimensions?: TerminalFixedDimensions;
  onBell(id: string): void;
  bell: boolean;
}) {
  const { dispatchCommand } = useCommandRegistry();
  const location = useRef({ cwd, shellPath, userHome });
  location.current = { cwd, shellPath, userHome };
  const container = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [searchContext, setSearchContext] = useState<TerminalSearchContext | null>(null);
  const [findRequest, setFindRequest] = useState(0);
  const [links, setLinks] = useState<TerminalLinksProps | null>(null);
  const [fileSearch, setFileSearch] = useState<TerminalFileSearchProps | null>(null);
  const handle = useRef<TerminalPaneHandle | null>(null);
  const rendering = useRef<TerminalRendering | null>(null);
  const decorations = useRef<TerminalCommandDecorations | null>(null);
  const stickyScroll = useRef<TerminalStickyScroll | null>(null);
  const [selectedCommand, setSelectedCommand] = useState<TerminalCommand | null>(null);
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<TerminalCompletionsProps | null>(null);
  const currentCanSuggest = useRef(canSuggest);
  currentCanSuggest.current = canSuggest;
  const cancelSuggestions = useRef<() => void>(() => undefined);
  const paneLifetime = useRef<AbortSignal>();
  const requestCommandOutput = useCallback(
    (commandId: string) => port.commandOutput(id, commandId),
    [port, id]
  );
  const callbacks = useRef({
    onReady,
    onOpenDocument,
    onError,
    onFocus,
    onNavigate,
    onNavigateGroup,
    onBell,
    onSplit,
    onHistory,
    onResize,
  });
  callbacks.current = {
    onReady,
    onOpenDocument,
    onError,
    onFocus,
    onNavigate,
    onNavigateGroup,
    onBell,
    onSplit,
    onHistory,
    onResize,
  };
  const inputFocused = useRef(false);
  const currentAppearance = useRef(appearance);
  currentAppearance.current = appearance;
  const currentDimensions = useRef(fixedDimensions);
  currentDimensions.current = fixedDimensions;
  const currentlyActive = useRef(active);
  currentlyActive.current = active;

  useEffect(() => {
    const element = container.current;
    const surfaceElement = surface.current;
    if (!element || !surfaceElement) return;
    let disposed = false;
    let retired = false;
    let linkDiscovery: AbortController | null = null;
    const lifetime = new AbortController();
    paneLifetime.current = lifetime.signal;
    let inputQueue: Promise<void> = Promise.resolve();
    let attachmentId: string | null = null;
    let sequence = 0;
    let ready = false;
    let resolveReady: () => void = () => undefined;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pending: DataEvent[] = [];
    const style = getComputedStyle(surfaceElement);
    const terminal = new Terminal({
      allowProposedApi: true,
      reflowCursorLine: false,
      cursorBlink: currentAppearance.current.cursorBlink,
      convertEol: false,
      fontFamily: currentAppearance.current.fontFamily,
      fontSize: currentAppearance.current.fontSize,
      fontWeight: currentAppearance.current.fontWeight,
      fontWeightBold: currentAppearance.current.fontWeightBold,
      minimumContrastRatio: currentAppearance.current.minimumContrastRatio,
      scrollback: currentAppearance.current.scrollback,
      screenReaderMode: currentAppearance.current.screenReaderMode,
      cursorStyle: currentAppearance.current.cursorStyle,
      cursorInactiveStyle: currentAppearance.current.cursorInactiveStyle,
      cursorWidth: currentAppearance.current.cursorWidth,
      lineHeight: currentAppearance.current.lineHeight,
      letterSpacing: currentAppearance.current.letterSpacing,
      macOptionIsMeta: currentAppearance.current.macOptionIsMeta,
      macOptionClickForcesSelection: currentAppearance.current.macOptionClickForcesSelection,
      altClickMovesCursor: currentAppearance.current.altClickMovesCursor,
      wordSeparator: currentAppearance.current.wordSeparators,
      smoothScrollDuration: currentAppearance.current.smoothScrolling ? 125 : 0,
      rightClickSelectsWord:
        currentAppearance.current.rightClickBehavior === 'selectWord' ||
        (currentAppearance.current.rightClickBehavior === 'platform' &&
          terminalHostPlatform() === 'darwin'),
      disableStdin: !running,
      theme: terminalTheme(style),
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.loadAddon(
      new WebLinksAddon((_event, url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      })
    );
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = '11';
    terminal.open(element);
    const renderer = new TerminalRendering(terminal);
    renderer.configure(currentAppearance.current);
    rendering.current = renderer;
    const promptResize = new TerminalPromptResize(terminal, location.current.shellPath);
    const commandMarks = new TerminalCommandDecorations(
      terminal,
      surfaceElement,
      setSelectedCommand
    );
    commandMarks.configure(currentAppearance.current);
    decorations.current = commandMarks;
    const sticky = new TerminalStickyScroll(
      terminal,
      surfaceElement,
      () => commandMarks.locations(),
      currentAppearance.current,
      setSelectedCommand
    );
    stickyScroll.current = sticky;
    setSearchContext({ terminal, search });
    if (import.meta.env.MODE === 'test') {
      let viewport = '';
      const rendered = terminal.onRender(() => {
        const buffer = terminal.buffer.active;
        viewport = Array.from(
          { length: terminal.rows },
          (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
        ).join('\n');
      });
      lifetime.signal.addEventListener('abort', () => rendered.dispose(), { once: true });
      Object.defineProperty(surfaceElement, '__terminalReadViewport', {
        configurable: true,
        value: () => viewport,
      });
      Object.defineProperty(surfaceElement, '__terminalReadSelection', {
        configurable: true,
        value: () => terminal.getSelection(),
      });
      Object.defineProperty(surfaceElement, '__terminalReadBuffer', {
        configurable: true,
        value: () => {
          return terminalBufferText(terminal.buffer.active);
        },
      });
    }
    terminal.textarea?.setAttribute('aria-label', 'Terminal input');
    const report = (error: unknown) => {
      if (!disposed && !retired)
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
    };
    let suggestionRequest: string | null = null;
    let suggestionModel: TerminalCompletionsProps | null = null;
    let inputRevision = 0;
    const closeSuggestions = (cancel = true) => {
      const requestId = suggestionRequest;
      suggestionRequest = null;
      suggestionModel = null;
      if (!disposed) setSuggestions(null);
      terminal.textarea?.removeAttribute('aria-controls');
      terminal.textarea?.removeAttribute('aria-activedescendant');
      if (cancel && requestId) void port.cancelCompletions(requestId).catch(report);
    };
    cancelSuggestions.current = () => closeSuggestions();
    const publishSuggestions = () => {
      if (disposed || !suggestionModel) return;
      setSuggestions({ ...suggestionModel });
      const item = suggestionModel.items[suggestionModel.selected];
      terminal.textarea?.setAttribute('aria-controls', `terminal-completions-${id}`);
      if (item)
        terminal.textarea?.setAttribute(
          'aria-activedescendant',
          `terminal-completion-${item.token}`
        );
    };
    const chooseSuggestion = (index: number) => {
      const item = suggestionModel?.items[index];
      const requestId = suggestionRequest;
      if (!item || !requestId) return;
      closeSuggestions(false);
      inputQueue = inputQueue
        .then(async () => {
          if (!disposed) await port.commitCompletion(id, item.token);
        })
        .catch(report)
        .finally(() => {
          void port.cancelCompletions(requestId).catch(report);
        });
      safeFocus(terminal.textarea, { preventScroll: true });
    };
    const suggest = () => {
      closeSuggestions();
      if (!currentCanSuggest.current || disposed) return;
      const requestId = crypto.randomUUID();
      const revision = inputRevision;
      suggestionRequest = requestId;
      suggestionModel = {
        id: `terminal-completions-${id}`,
        items: [],
        selected: 0,
        loading: true,
        onSelect: (index) => {
          if (suggestionModel) {
            suggestionModel.selected = index;
            publishSuggestions();
          }
        },
        onChoose: chooseSuggestion,
        onClose: () => {
          closeSuggestions();
          safeFocus(terminal.textarea, { preventScroll: true });
        },
      };
      publishSuggestions();
      safeFocus(terminal.textarea, { preventScroll: true });
      void inputQueue
        .then(async () => {
          if (disposed || suggestionRequest !== requestId || revision !== inputRevision) return;
          const result = await port.complete(id, requestId);
          if (
            disposed ||
            suggestionRequest !== requestId ||
            revision !== inputRevision ||
            !suggestionModel
          ) {
            await port.cancelCompletions(requestId);
            return;
          }
          suggestionModel.items = result.items;
          suggestionModel.loading = false;
          publishSuggestions();
        })
        .catch((error) => {
          closeSuggestions();
          report(error);
        });
    };
    let navigationId: string | null = null;
    let navigationViewport: number | null = null;
    let selectionAnchor: number | null = null;
    let navigationQueue: Promise<void> = Promise.resolve();
    const commandLocations = async () => {
      await readyPromise;
      const session = (await port.list()).find((session) => session.id === id);
      if (!session || disposed) throw new Error('The terminal is unavailable.');
      await new Promise<void>((resolve) => terminal.write('', resolve));
      if (disposed || terminal.buffer.active.type !== 'normal') return [];
      const offset = (session.bufferBaseY ?? 0) - terminal.buffer.normal.baseY;
      return session.commands.flatMap((command) => {
        const line = command.range ? command.range.startLine - offset : -1;
        return command.id &&
          command.command.trim() &&
          line >= 0 &&
          line < terminal.buffer.normal.length
          ? [{ id: command.id, line }]
          : [];
      });
    };
    const revealLine = (line: number) => {
      terminal.scrollToLine(Math.max(line - Math.floor(terminal.rows / 4), 0));
      navigationViewport = terminal.buffer.active.viewportY;
      safeFocus(terminal.textarea, { preventScroll: true });
    };
    const navigateCommand = async (direction: number, select: boolean) => {
      const commands = await commandLocations();
      const buffer = terminal.buffer.normal;
      if (navigationViewport !== buffer.viewportY) navigationId = null;
      const current = commands.findIndex((command) => command.id === navigationId);
      let index: number;
      if (navigationId === 'top') index = direction < 0 ? -1 : 0;
      else if (navigationId === 'bottom')
        index = direction < 0 ? commands.length - 1 : commands.length;
      else if (current >= 0) index = current + direction;
      else if (buffer.viewportY === buffer.baseY)
        index = direction < 0 ? commands.length - 1 : commands.length;
      else {
        const middle = buffer.viewportY + Math.floor(terminal.rows / 4);
        index =
          direction < 0
            ? commands.filter((command) => command.line < middle).length - 1
            : commands.findIndex((command) => command.line > middle);
        if (direction > 0 && index < 0) index = commands.length;
      }
      if (select && selectionAnchor === null)
        selectionAnchor = current >= 0 ? commands[current].line : buffer.baseY + buffer.cursorY;
      if (!select) selectionAnchor = null;
      let line: number;
      if (index < 0) {
        navigationId = 'top';
        line = 0;
        terminal.scrollToTop();
      } else if (index >= commands.length) {
        navigationId = 'bottom';
        line = buffer.baseY + buffer.cursorY;
        terminal.scrollToBottom();
      } else {
        navigationId = commands[index].id;
        line = commands[index].line;
        revealLine(line);
      }
      if (select && selectionAnchor !== null) {
        const start = Math.min(line, selectionAnchor);
        const end = Math.max(line, selectionAnchor) - 1;
        if (end >= start) terminal.selectLines(start, end);
        else terminal.clearSelection();
      }
      navigationViewport = terminal.buffer.active.viewportY;
    };
    const pane: TerminalPaneHandle = {
      terminal,
      search,
      fit: () => resize(),
      find: () => setFindRequest((request) => request + 1),
      openLinks: () => loadLinks(),
      complete: suggest,
      revealCommand: async (commandId) => {
        const command = (await commandLocations()).find((command) => command.id === commandId);
        if (!command) throw new Error('This command is no longer available in scrollback.');
        navigationId = commandId;
        revealLine(command.line);
      },
      toggleContentWidth: async () => {
        if (currentDimensions.current) await port.setFixedDimensions(id, {});
        else {
          const cols = Math.min(
            1000,
            Math.max(
              terminal.cols,
              longestTerminalViewportLine(terminal.buffer.active, terminal.cols)
            )
          );
          if (cols > terminal.cols) await port.setFixedDimensions(id, { cols });
        }
      },
      copy: async () => {
        if (terminal.hasSelection()) await platform().clipboard.writeText(terminal.getSelection());
      },
      output: () => terminalBufferText(terminal.buffer.active),
      paste: async () => {
        closeSuggestions();
        inputRevision++;
        if (disposed || !ready) throw new Error('The terminal is unavailable.');

        const requested = port.paste(id, currentAppearance.current.multilinePasteWarning);
        const completion = queueTerminalPaste(inputQueue, requested, async (token) => {
          if (!(await port.commitPaste(id, token))) {
            const accept = await confirmDialog({
              title: userMessage('dialog.paste-multiple-lines'),
              message: userMessage('dialog.this-program-may-run-each-pasted-line-immediately'),
              confirmLabel: userMessage('dialog.paste'),
              safeDefault: true,
              signal: lifetime.signal,
            });
            await port.confirmPaste(id, token, accept);
          }
          if (!disposed) safeFocus(terminal.textarea, { preventScroll: true });
        });
        inputQueue = completion.catch(report);
        await completion;
      },
      insert: async (text) => {
        await readyPromise;
        if (disposed || !ready) throw new Error('The terminal is unavailable.');
        if (
          currentAppearance.current.multilinePasteWarning &&
          /[\r\n]/.test(text) &&
          !terminal.modes.bracketedPasteMode &&
          !(await confirmDialog({
            title: userMessage('dialog.paste-multiple-lines'),
            message: userMessage('dialog.this-program-may-run-each-pasted-line-immediately'),
            confirmLabel: userMessage('dialog.paste'),
            safeDefault: true,
            signal: lifetime.signal,
          }))
        )
          return;
        if (!disposed) {
          await inputQueue;
          terminal.paste(text);
          await inputQueue;
          safeFocus(terminal.textarea, { preventScroll: true });
        }
      },
      execute: async (text) => {
        await readyPromise;
        if (disposed || !ready) throw new Error('The terminal is unavailable.');
        await inputQueue;
        terminal.paste(text.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
        await inputQueue;
        if (disposed) throw new Error('The terminal closed before execution.');
        send('\r');
        await inputQueue;
      },
    };
    handle.current = pane;
    callbacks.current.onReady(id, pane);
    const send = (data: string, mode: 'text' | 'binary' = 'text') => {
      inputRevision++;
      closeSuggestions();
      inputQueue = inputQueue
        .then(async () => {
          for (const chunk of splitTerminalInput(data)) {
            if (disposed) return;
            await port.write(id, chunk, mode);
          }
        })
        .catch(report);
    };
    const input = terminal.onData((data) => send(data));
    const colorScheme = new TerminalColorScheme(
      terminal.parser,
      () => terminal.options.theme ?? {},
      (data) => send(data)
    );
    const binary = terminal.onBinary((data) => send(data, 'binary'));
    const selection = terminal.onSelectionChange(() => {
      if (currentAppearance.current.copyOnSelection && terminal.hasSelection())
        void pane.copy().catch(report);
    });
    const bellListener = terminal.onBell(() => {
      if (ready && currentAppearance.current.enableVisualBell) callbacks.current.onBell(id);
    });
    const insertPath = (path: string) => {
      if (!disposed) {
        terminal.paste(quoteTerminalPath(path, location.current.shellPath) + ' ');
        safeFocus(terminal.textarea, { preventScroll: true });
      }
    };
    const dropped = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string }>).detail;
      if (detail && typeof detail.path === 'string') insertPath(detail.path);
    };
    surfaceElement.addEventListener('waypoint-file-drop', dropped);
    let fileLookupId: string | null = null;
    let fileLookupTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelFileLookup = () => {
      if (fileLookupTimer) clearTimeout(fileLookupTimer);
      fileLookupTimer = null;
      const requestId = fileLookupId;
      fileLookupId = null;
      if (requestId)
        void Promise.resolve()
          .then(() => port.cancelFileSearch(requestId))
          .catch(() => undefined);
    };
    const projectScope = () =>
      JSON.stringify(
        useWorkspaceStore
          .getState()
          .folders.map((folder) => folder.path)
          .sort()
      );
    const startFileLookup = (query: string, autoOpen: boolean): void => {
      cancelFileLookup();
      const requestId = crypto.randomUUID();
      fileLookupId = requestId;
      const roots = useWorkspaceStore.getState().folders.map((folder) => folder.path);
      const scope = projectScope();
      const candidates = terminalFileQueryCandidates(query);
      let position = candidates[0]!;
      const context: TerminalFileSearchProps = {
        query,
        loading: true,
        autoOpen,
        hasProjects: roots.length > 0,
        result: { requestId, paths: [], incomplete: false, cancelled: false },
        onQueryChange: (next) => startFileLookup(next, false),
        onClose: () => {
          cancelFileLookup();
          setFileSearch(null);
          safeFocus(terminal.textarea, { preventScroll: true });
        },
        onOpen: (path) => {
          cancelFileLookup();
          setFileSearch(null);
          void openTerminalFile(path, position, () => callbacks.current.onOpenDocument?.(id)).catch(
            report
          );
        },
      };
      setFileSearch(context);
      const lookup = async () => {
        fileLookupTimer = null;
        try {
          let result: TerminalFileSearchProps['result'] | undefined;
          for (const candidate of candidates) {
            if (disposed || fileLookupId !== requestId) return;
            position = candidate;
            result = await port.findFiles(id, { requestId, roots, query: candidate.query });

            if (result.paths.length || result.incomplete || result.cancelled) break;
          }
          if (!result || disposed || fileLookupId !== requestId) return;
          if (!currentAppearance.current.enableFileLinks) {
            cancelFileLookup();
            setFileSearch(null);
          } else if (projectScope() !== scope) {
            setFileSearch({
              ...context,
              loading: false,
              error: 'Open projects changed. Search again.',
            });
          } else if (result.requestId === requestId)
            setFileSearch({ ...context, result, loading: false });
        } catch (error) {
          if (!disposed && fileLookupId === requestId)
            setFileSearch({
              ...context,
              loading: false,
              error: toUserMessage(error, 'operation.failed'),
            });
        }
      };
      if (autoOpen) void lookup();
      else
        fileLookupTimer = setTimeout(() => {
          void lookup();
        }, 150);
    };
    const fileLinkProvider = createTerminalFileLinkProvider(
      terminal,
      () => location.current.cwd,
      dispatchCommand,
      report,
      () => location.current.userHome,
      () => callbacks.current.onOpenDocument?.(id),
      () => currentAppearance.current.enableFileLinks,
      (query) =>
        startFileLookup(
          `${query.query}${query.line ? `:${query.line}${query.column ? `:${query.column}` : ''}` : ''}`,
          true
        ),
      () => currentAppearance.current.wordSeparators
    );
    const fileLinks = terminal.registerLinkProvider(fileLinkProvider);
    const loadLinks = (all = false) => {
      linkDiscovery?.abort();
      const discovery = new AbortController();
      linkDiscovery = discovery;
      const context: TerminalLinksProps = {
        result: { links: [], atLimit: false },
        loading: true,
        all,
        onExpand: () => loadLinks(true),
        onClose: () => {
          discovery.abort();
          setLinks(null);
          safeFocus(terminal.textarea, { preventScroll: true });
        },
        onOpen: (link) => {
          discovery.abort();
          setLinks(null);
          safeFocus(terminal.textarea, { preventScroll: true });
          try {
            const isMac = navigator.platform.startsWith('Mac');
            link.activate(new MouseEvent('click', { metaKey: isMac, ctrlKey: !isMac }), link.text);
          } catch (error) {
            report(error);
          }
        },
      };
      setLinks(context);
      void collectTerminalLinks(terminal, fileLinkProvider, discovery.signal, all, (_event, uri) =>
        window.open(uri, '_blank', 'noopener,noreferrer')
      )
        .then((result) => {
          if (!disposed && !discovery.signal.aborted && linkDiscovery === discovery)
            setLinks({ ...context, result, loading: false });
        })
        .catch((error) => {
          if (!disposed && !discovery.signal.aborted) {
            report(error);
            setLinks({ ...context, loading: false });
          }
        });
    };
    const isMac = navigator.platform.startsWith('Mac');
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (event.defaultPrevented) return false;
      if (event.isComposing || event.getModifierState('AltGraph')) return true;
      if (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === 'Space' &&
        currentCanSuggest.current
      ) {
        event.preventDefault();
        suggest();
        return false;
      }
      if (suggestionModel) {
        const plain = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
        if (plain && event.key === 'Escape') {
          event.preventDefault();
          closeSuggestions();
          return false;
        }
        if (plain && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          const count = suggestionModel.items.length;
          if (count)
            suggestionModel.selected =
              (suggestionModel.selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
          publishSuggestions();
          return false;
        }
        if (plain && (event.key === 'Tab' || event.key === 'Enter')) {
          event.preventDefault();
          chooseSuggestion(suggestionModel.selected);
          return false;
        }
        if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) closeSuggestions();
      }
      const resizeDirection = terminalResizeDirection(terminalHostPlatform(), event);
      if (resizeDirection) {
        event.preventDefault();
        const screen = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
        if (screen) {
          const horizontal = resizeDirection === 'left' || resizeDirection === 'right';
          const pixels = horizontal
            ? (screen.width / terminal.cols) * 4
            : (screen.height / terminal.rows) * 4;
          callbacks.current.onResize(id, resizeDirection, pixels);
        }
        return false;
      }
      if (terminalLinkShortcut(terminalHostPlatform(), event)) {
        event.preventDefault();
        pane.openLinks();
        return false;
      }
      const history = terminalHistoryShortcut(terminalHostPlatform(), event);
      if (history) {
        event.preventDefault();
        callbacks.current.onHistory(id, history);
        return false;
      }
      if (event.code === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) return false;
      const direction = terminalNavigateGroupDirection(terminalHostPlatform(), event);
      if (direction !== null) {
        event.preventDefault();
        event.stopPropagation();
        callbacks.current.onNavigateGroup(id, direction);
        return false;
      }
      if (terminalSplitShortcut(terminalHostPlatform(), event)) {
        event.preventDefault();
        callbacks.current.onSplit(id);
        return false;
      }
      const key = event.key.toLowerCase();
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === 'KeyZ'
      ) {
        event.preventDefault();
        void pane.toggleContentWidth().catch(report);
        return false;
      }
      if (
        event.altKey &&
        (isMac ? event.metaKey : !event.ctrlKey) &&
        (key === 'arrowleft' || key === 'arrowright')
      ) {
        callbacks.current.onNavigate(id, key === 'arrowleft' ? -1 : 1);
        return false;
      }
      if (
        (isMac ? event.metaKey : event.ctrlKey) &&
        !event.altKey &&
        (key === 'arrowup' || key === 'arrowdown')
      ) {
        event.preventDefault();
        navigationQueue = navigationQueue
          .then(() => navigateCommand(key === 'arrowup' ? -1 : 1, event.shiftKey))
          .catch(report);
        return false;
      }
      const clipboardAction = terminalClipboardAction(
        terminalHostPlatform(),
        event,
        terminal.hasSelection()
      );
      if (clipboardAction === 'copy') {
        event.preventDefault();
        void pane.copy().catch(report);
        return false;
      }
      if (clipboardAction === 'paste') {
        event.preventDefault();
        void pane.paste().catch(report);
        return false;
      }
      if (terminalFindShortcut(terminalHostPlatform(), event)) {
        event.preventDefault();
        pane.find();
        return false;
      }
      if (
        isMac &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        key === 'a'
      ) {
        event.preventDefault();
        terminal.selectAll();
        return false;
      }
      if (
        isMac &&
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        key === 'k'
      ) {
        event.preventDefault();
        void port.clear(id).catch(report);
        return false;
      }
      return true;
    });
    const consume = (event: DataEvent) => {
      if (disposed || event.attachmentId !== attachmentId || event.sequence <= sequence) return;
      sequence = event.sequence;
      if (event.kind === 'clear') {
        terminal.write('', () => {
          if (disposed) return;
          commandMarks.clear();
          terminal.clear();
          sticky.refresh();
          void port.acknowledge(id, attachmentId!, event.sequence).catch(report);
        });
        return;
      }
      terminal.write(event.data, () => {
        if (!disposed && attachmentId === event.attachmentId) {
          promptResize.revealPrompt(location.current.shellPath);
          if (event.commandState) commandMarks.sync(event.commandState);
          sticky.refresh();
          void port.acknowledge(id, event.attachmentId, event.sequence).catch(report);
        }
      });
    };
    const unsubscribe = port.subscribe((event) => {
      if (event.kind === 'removed' && event.ids.includes(id)) {
        retired = true;
        return;
      }
      if ((event.kind !== 'data' && event.kind !== 'clear') || event.id !== id) return;
      if (!ready) pending.push(event);
      else consume(event);
    });
    const syncTheme = () => {
      if (disposed || !syncTerminalTheme(terminal, surfaceElement)) return;
      colorScheme.paletteChanged();
      commandMarks.refresh();
      sticky.configure(currentAppearance.current);
    };
    let resizeQueued = false;
    const resize = () => {
      if (disposed || retired || !ready || resizeQueued) return;
      resizeQueued = true;
      inputQueue = inputQueue
        .then(async () => {
          resizeQueued = false;
          syncTheme();
          if (disposed || retired || element.clientWidth < 10 || element.clientHeight < 10) return;
          const fixed = currentDimensions.current;
          if (terminal.element) {
            terminal.element.style.width = '';
            terminal.element.style.height = '';
          }
          const proposed = fit.proposeDimensions();
          const cols = fixed?.cols ?? Math.max(2, proposed?.cols ?? terminal.cols);
          const rows = fixed?.rows ?? Math.max(1, proposed?.rows ?? terminal.rows);
          if (cols !== terminal.cols || rows !== terminal.rows) {
            closeSuggestions();
            await promptResize.prepare(cols, location.current.shellPath);
            if (disposed || retired) return;
            terminal.resize(cols, rows);
            await port.resize(id, cols, rows);
          }
          const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
          if (terminal.element && screen) {
            terminal.element.style.width = fixed?.cols ? screen.style.width : '';
            terminal.element.style.height = fixed?.rows ? screen.style.height : '';
          }
        })
        .catch(report);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    void port
      .attach(id)
      .then((attached) => {
        if (disposed) {
          void port.detach(id, attached.attachmentId).catch(() => undefined);
          return;
        }
        attachmentId = attached.attachmentId;
        sequence = attached.sequence;
        colorScheme.restore(attached.session.colorSchemeReports === true);
        terminal.options.tabStopWidth = attached.session.emulation?.tabStopWidth ?? 8;
        terminal.unicode.activeVersion = attached.session.emulation?.unicodeVersion ?? '11';
        terminal.resize(attached.session.cols, attached.session.rows);
        terminal.write(attached.replay, () => {
          if (disposed) return;
          const prompt = attached.session.promptStart;
          promptResize.seed(
            prompt
              ? {
                  line:
                    prompt.line -
                    ((attached.session.bufferBaseY ?? 0) - terminal.buffer.normal.baseY),
                  column: prompt.column,
                }
              : undefined
          );
          commandMarks.sync(attached.session);
          sticky.refresh();
          ready = true;
          resolveReady();
          for (const event of pending.splice(0)) consume(event);
          colorScheme.resynchronize();
          resize();
          if (currentlyActive.current) safeFocus(terminal.textarea, { preventScroll: true });
        });
      })
      .catch((error: unknown) => {
        resolveReady();
        report(error);
      });
    return () => {
      disposed = true;
      closeSuggestions();
      cancelSuggestions.current = () => undefined;
      if (inputFocused.current) {
        inputFocused.current = false;
        void port.focus?.(null).catch(() => undefined);
      }
      linkDiscovery?.abort();
      resolveReady();
      cancelFileLookup();
      observer.disconnect();
      themeObserver.disconnect();
      lifetime.abort();
      surfaceElement.removeEventListener('waypoint-file-drop', dropped);
      fileLinks.dispose();
      unsubscribe();
      promptResize.dispose();
      input.dispose();
      colorScheme.dispose();
      binary.dispose();
      selection.dispose();
      bellListener.dispose();
      sticky.dispose();
      stickyScroll.current = null;
      commandMarks.dispose();
      decorations.current = null;
      callbacks.current.onReady(id, null);
      handle.current = null;
      if (attachmentId) void port.detach(id, attachmentId).catch(() => undefined);
      renderer.dispose();
      rendering.current = null;
      terminal.dispose();
      Reflect.deleteProperty(surfaceElement, '__terminalReadBuffer');
      Reflect.deleteProperty(surfaceElement, '__terminalReadViewport');
      Reflect.deleteProperty(surfaceElement, '__terminalReadSelection');
    };
  }, [id, port, dispatchCommand]);

  useEffect(() => {
    const terminal = handle.current?.terminal;
    if (!terminal) return;
    if (surface.current) syncTerminalTheme(terminal, surface.current);
    terminal.options.fontSize = appearance.fontSize;
    decorations.current?.configure(appearance);
    terminal.options.scrollback = appearance.scrollback;
    terminal.options.screenReaderMode = appearance.screenReaderMode;
    terminal.options.fontFamily = appearance.fontFamily;
    terminal.options.fontWeight = appearance.fontWeight;
    terminal.options.fontWeightBold = appearance.fontWeightBold;
    terminal.options.minimumContrastRatio = appearance.minimumContrastRatio;
    terminal.options.cursorInactiveStyle = appearance.cursorInactiveStyle;
    terminal.options.cursorWidth = appearance.cursorWidth;
    terminal.options.lineHeight = appearance.lineHeight;
    terminal.options.letterSpacing = appearance.letterSpacing;
    terminal.options.cursorStyle = appearance.cursorStyle;
    terminal.options.cursorBlink = appearance.cursorBlink;
    terminal.options.macOptionIsMeta = appearance.macOptionIsMeta;
    terminal.options.macOptionClickForcesSelection = appearance.macOptionClickForcesSelection;
    terminal.options.altClickMovesCursor = appearance.altClickMovesCursor;
    terminal.options.wordSeparator = appearance.wordSeparators;
    terminal.options.smoothScrollDuration = appearance.smoothScrolling ? 125 : 0;
    terminal.options.rightClickSelectsWord =
      appearance.rightClickBehavior === 'selectWord' ||
      (appearance.rightClickBehavior === 'platform' && terminalHostPlatform() === 'darwin');
    stickyScroll.current?.configure(appearance);
    rendering.current?.configure(appearance);
    const frame = requestAnimationFrame(() => handle.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [appearance]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => handle.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [fixedDimensions?.cols, fixedDimensions?.rows]);
  useEffect(() => {
    if (handle.current) handle.current.terminal.options.disableStdin = !running;
  }, [running]);

  useEffect(() => {
    if (active) safeFocus(handle.current?.terminal.textarea, { preventScroll: true });
  }, [active]);

  return (
    <div
      ref={surface}
      data-testid="terminal-pane"
      data-terminal-id={id}
      data-terminal-surface
      data-terminal-theme={appearance.colorScheme}
      data-fixed-dimensions={fixedDimensions ? 'true' : undefined}
      data-bell={bell ? 'true' : undefined}
      data-file-drop-zone
      className="dnaforge-terminal-pane"
      onContextMenuCapture={(event) => {
        const pane = handle.current;
        if (!pane) return;
        const behavior =
          appearance.rightClickBehavior === 'platform'
            ? terminalHostPlatform() === 'win32'
              ? 'copyPaste'
              : terminalHostPlatform() === 'darwin'
                ? 'selectWord'
                : 'default'
            : appearance.rightClickBehavior;
        if (behavior === 'nothing' || pane.terminal.modes.mouseTrackingMode !== 'none') return;
        event.preventDefault();
        if (behavior === 'copyPaste' && pane.terminal.hasSelection())
          void pane
            .copy()
            .then(() => pane.terminal.clearSelection())
            .catch((error: unknown) => onError(String(error)));
        else if (behavior === 'copyPaste' || behavior === 'paste')
          void pane.paste().catch((error: unknown) => onError(String(error)));
        else onContextMenu(id, event.clientX, event.clientY);
      }}
      onDragOver={(event) => {
        if (
          event.dataTransfer.files.length ||
          event.dataTransfer.types.includes('Files') ||
          event.dataTransfer.types.includes(TERMINAL_DRAG_TYPE)
        )
          event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const source = event.dataTransfer.getData(TERMINAL_DRAG_TYPE);
        if (source) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const before =
            direction === 'vertical'
              ? event.clientY < bounds.top + bounds.height / 2
              : event.clientX < bounds.left + bounds.width / 2;
          onMove(source, id, before ? 'before' : 'after');
          return;
        }
        const paths = Array.from(event.dataTransfer.files)
          .map((file) => platform().workspace.getPathForFile(file))
          .filter(Boolean);
        const text = paths.map((path) => quoteTerminalPath(path, shellPath)).join(' ');
        if (text) {
          handle.current?.terminal.paste(text + ' ');
          safeFocus(handle.current?.terminal.textarea, { preventScroll: true });
        }
      }}
      onBlurCapture={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          event.currentTarget.contains(event.relatedTarget)
        )
          return;
        cancelSuggestions.current();
        if (inputFocused.current) {
          inputFocused.current = false;
          void port.focus?.(null).catch((error) => onError(String(error)));
        }
      }}
      onFocusCapture={() => {
        inputFocused.current = running;
        void port.focus?.(running ? id : null).catch((error) => onError(String(error)));
        surface.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        onFocus(id);
      }}
      onMouseDown={() => onFocus(id)}
    >
      <div ref={container} className="dnaforge-terminal-emulator" />
      {suggestions && <TerminalCompletions {...suggestions} />}
      {links && <TerminalLinks {...links} />}
      {fileSearch && <TerminalFileSearch {...fileSearch} />}
      {selectedCommand && (
        <TerminalCommandActions
          command={selectedCommand}
          running={running}
          shellPath={shellPath}
          requestOutput={requestCommandOutput}
          onQuickFix={(fix) => {
            const selected = selectedCommand;
            const signal = paneLifetime.current;
            const perform = async () => {
              if (fix.kind === 'command') await handle.current?.execute(fix.command);
              else if (fix.kind === 'link') window.open(fix.url, '_blank', 'noopener,noreferrer');
              else if (selected.id) {
                const action = await port.preparePortRelease(id, selected.id, fix.port);
                if (signal?.aborted) return;
                if (
                  await confirmDialog({
                    title: userMessageWithValues('dialog.free-port-value', {
                      value0: userMessageValue(action.port),
                    }),
                    message: userMessageWithValues(
                      'dialog.send-ctrl-c-to-the-foreground-program-in-value',
                      { value0: userMessageValue(action.terminalTitle) }
                    ),
                    confirmLabel: userMessage('dialog.interrupt-program'),
                    safeDefault: true,
                    signal,
                  })
                )
                  await port.releasePort(id, action.token);
              }
            };
            void perform().catch((error) => onError(String(error)));
          }}
          onClose={() => {
            setSelectedCommand(null);
            safeFocus(handle.current?.terminal.textarea, { preventScroll: true });
          }}
          onAction={(action) => {
            const command = selectedCommand;
            const pane = handle.current;
            if (!pane) return;
            const perform = async () => {
              if (action === 'run') await pane.execute(command.command);
              else if (action === 'insert') await pane.insert(command.command);
              else if (action === 'copy') await platform().clipboard.writeText(command.command);
              else if (command.id) {
                const text = await port.commandOutput(id, command.id);
                if (text === undefined)
                  throw new Error('This command’s output is no longer available in scrollback.');
                setCommandOutput(text);
              }
            };
            void perform().catch((error) => onError(String(error)));
          }}
        />
      )}
      {commandOutput !== null && (
        <TerminalOutputView
          text={commandOutput}
          onClose={() => {
            setCommandOutput(null);
            safeFocus(handle.current?.terminal.textarea, { preventScroll: true });
          }}
          onCopy={() => {
            void platform()
              .clipboard.writeText(commandOutput)
              .catch((error) => onError(String(error)));
          }}
        />
      )}
      {searchContext && (
        <TerminalSearch
          request={findRequest}
          context={searchContext}
          onClose={() => setFindRequest(0)}
        />
      )}
    </div>
  );
}
