import { MenuNativeSelect, MenuRow } from '@waypoint/ui-components';
import {
  toUserMessage,
  userMessage,
  userMessageWithValues,
  userMessageValue,
} from '@waypoint/user-messages';
import { safeFocus } from '../../shared/utils/safeFocus';
import {
  createRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEventHandler,
  type MouseEventHandler,
} from 'react';
import {
  ExclamationCircleIcon,
  PlusIcon,
  SidebarIcon,
  SearchIcon,
  EllipsisIcon,
  CloseIcon,
  MoveToTabIcon,
  OpenExternalIcon,
} from '../../components/icons';
import {
  NavigationAction,
  NavigationList,
  NavigationRow,
  UI_NAVIGATION_EMPTY_CLASS,
  UI_NAVIGATION_GROUP_CLASS,
  UI_NAVIGATION_HEADER_CLASS,
  UI_NAVIGATION_METADATA_CLASS,
  UI_NAVIGATION_PANEL_CLASS,
} from '../../components/ui';
import { COMMAND_IDS, useCommandHandler, useCommandRegistry } from '../../commands';
import { PortalMenu } from '../../components/PortalMenu';
import { confirmDialog } from '../../components/confirm-dialog-store';
import { useToastStore } from '../../stores/toast-store';
import { TerminalContextMenu } from './TerminalContextMenu';
import { TerminalOutputView } from './TerminalOutputView';
import { TerminalCommandHistory } from './TerminalCommandHistory';
import { terminalHistoryPinKey } from './terminal-history-picker';
import { TerminalDimensions } from './TerminalDimensions';
import { useTerminalBells } from './terminal-bells';
import { terminalFileCommand, terminalDirectoryCommand } from './terminal-input';
import {
  useTerminalPreferences,
  subscribeTerminalProfilesChanged,
} from './terminal-settings-store';
import { TerminalGroupHost } from './TerminalGroupHost';
import { TerminalSplitGroup, type TerminalSplitGroupHandle } from './TerminalSplitGroup';
import { TerminalPaneTarget } from './TerminalPaneTarget';
import {
  TERMINAL_DRAG_TYPE,
  reorderTerminalGroups,
  moveTerminalPane,
  unsplitTerminalPane,
  splitTerminalPane,
  terminalGroupViewId,
  migrateTerminalGroupViews,
  moveTerminalGroupToView,
  TERMINAL_WORKSPACE_TAB_ID,
  type TerminalPresentation,
  type TerminalGroup,
} from './terminal-layout';
import { TERMINAL_EDITOR_ACTION_EVENT, useTerminalEditorTargets } from './terminal-placement';
import {
  terminalHostPlatform,
  terminalSplitShortcut,
  type TerminalResizeDirection,
} from './terminal-keyboard';
import { useCanvasStore } from '../canvas/public/store';
import {
  OPEN_INTEGRATED_TERMINAL_EVENT,
  RUN_INTEGRATED_TERMINAL_EVENT,
  type TerminalRunRequest,
} from './terminal-events';
import { platform } from '../../platform';
import type {
  TerminalHistoryData,
  TerminalProfile,
  TerminalSession,
} from '../../shared/terminal-ipc';
import { TerminalPane, type TerminalPaneHandle } from './TerminalPane';
import { registerTerminalViewOpener, TerminalOpeningError } from './terminal-opening';
import { useTerminalWorkspaceTarget } from './TerminalWorkspace';

const STORAGE_KEY = 'dnaforge.terminal.layout.v1';
const PANEL_VIEW_ID = 'terminal-panel';

export function TerminalDock({
  defaultCwd,
  floatingGroupId,
  workspaceActive,
  onOpenWorkspace,
  onCloseWorkspace,
}: {
  defaultCwd?: string;
  floatingGroupId?: string;
  workspaceActive?: boolean;
  onOpenWorkspace?(): void;
  onCloseWorkspace?(): void;
}) {
  const { dispatchCommand } = useCommandRegistry();
  const storageKey = floatingGroupId ? `${STORAGE_KEY}:${floatingGroupId}` : STORAGE_KEY;
  const [port] = useState(() => platform().terminal);
  const editorTargets = useTerminalEditorTargets((state) => state.targets);
  const canvasPanels = useCanvasStore((state) => state.panels);
  const [initialized, setInitialized] = useState(false);
  const workspaceTarget = useTerminalWorkspaceTarget((state) => state.target);
  const workspaceNavigation = useRef({ workspaceActive, onOpenWorkspace, onCloseWorkspace });
  workspaceNavigation.current = { workspaceActive, onOpenWorkspace, onCloseWorkspace };
  const [panelOpen, setPanelOpen] = useState(false);
  const open = floatingGroupId || !onOpenWorkspace ? panelOpen : Boolean(workspaceActive);
  const setOpen = useCallback(
    (value: boolean) => {
      setPanelOpen(value);
      if (floatingGroupId) return;
      const navigation = workspaceNavigation.current;
      if (value) navigation.onOpenWorkspace?.();
      else if (navigation.workspaceActive) navigation.onCloseWorkspace?.();
    },
    [floatingGroupId]
  );
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [profiles, setProfiles] = useState<TerminalProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [groups, setGroups] = useState<TerminalGroup[]>([]);
  const [paneTargets, setPaneTargets] = useState<Record<string, HTMLDivElement>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  useEffect(() => {
    setActiveId((current) =>
      current && sessions.some((session) => session.id === current)
        ? current
        : (sessions[sessions.length - 1]?.id ?? null)
    );
  }, [sessions]);
  const [busy, setBusy] = useState(false);
  const pendingCreate = useRef(false);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(300);
  const [maximized, setMaximized] = useState(false);
  const [activeByView, setActiveByView] = useState<Record<string, string>>({});
  const [uiViewId, setUiViewId] = useState(PANEL_VIEW_ID);
  const toolbarRefs = useRef(
    new Map<
      string,
      {
        menu: ReturnType<typeof createRef<HTMLButtonElement>>;
        surface: ReturnType<typeof createRef<HTMLDivElement>>;
      }
    >()
  );
  const lastFocusedView = useRef<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const presentedEditorGroups = useRef(new Set<string>());
  const [historyTarget, setHistoryTarget] = useState<{
    id: string;
    kind: 'command' | 'directory';
  } | null>(null);
  const [savedHistory, setSavedHistory] = useState<{
    id: string;
    data: TerminalHistoryData;
  } | null>(null);
  const historyId = historyTarget?.id;
  useEffect(() => {
    if (!port || !historyId) return;
    let cancelled = false;
    void port
      .history(historyId)
      .then((data) => {
        if (!cancelled) setSavedHistory({ id: historyId, data });
      })
      .catch(() => {
        if (!cancelled) setError(userMessage('failure.terminal-history-could-not-be-loaded'));
      });
    return () => {
      cancelled = true;
    };
  }, [port, historyId]);
  const closing = useRef(new Set<string>());
  const closeLifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const lifetime = new AbortController();
    closeLifetime.current = lifetime;
    return () => lifetime.abort();
  }, []);
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [outputView, setOutputView] = useState<{ id: string; text: string } | null>(null);
  const [dimensionsId, setDimensionsId] = useState<string | null>(null);
  const appearance = useTerminalPreferences();
  const { bells, ring, clear: clearBell } = useTerminalBells(appearance.bellDuration);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const handles = useRef(new Map<string, TerminalPaneHandle>());
  const splitHandles = useRef(new Map<string, TerminalSplitGroupHandle>());
  const dockRoot = useRef<HTMLElement>(null);
  const paneWaiters = useRef(
    new Map<
      string,
      {
        resolve(handle: TerminalPaneHandle): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    >()
  );
  const executionQueue = useRef<Promise<void>>(Promise.resolve());
  const resizeOrigin = useRef<{ y: number; height: number } | null>(null);
  const activeGroup = groups.find((group) => group.sessions.includes(activeId ?? ''))?.id;
  const editorViews = new Map<string, TerminalGroup[]>();
  for (const group of groups) {
    if (group.placement !== 'editor') continue;
    const viewId = terminalGroupViewId(group);
    editorViews.set(viewId, [...(editorViews.get(viewId) ?? []), group]);
  }
  const panelGroups = groups.filter((group) => group.placement !== 'editor');
  const focusedEditorView =
    [...editorViews.keys()].find((id) => editorTargets[id]?.active) ??
    [...editorViews.keys()].find((id) => editorTargets[id]?.visible);
  const primaryViewId =
    open || floatingGroupId ? PANEL_VIEW_ID : (focusedEditorView ?? PANEL_VIEW_ID);
  const surfaceOpen = open || Object.values(editorTargets).some((target) => target.visible);
  const selectedFor = (viewId: string, viewGroups: TerminalGroup[]) => {
    const ids = viewGroups.flatMap((group) => group.sessions);
    const saved = activeByView[viewId];
    return (
      (saved && ids.includes(saved)
        ? saved
        : activeId && ids.includes(activeId)
          ? activeId
          : ids[0]) ?? null
    );
  };
  useEffect(() => {
    if (!actionsOpen || !surfaceOpen) return;
    const frame = requestAnimationFrame(() =>
      safeFocus(
        toolbarRefs.current
          .get(uiViewId)
          ?.surface.current?.querySelector<HTMLElement>('select, button:not(:disabled)')
      )
    );
    return () => cancelAnimationFrame(frame);
  }, [actionsOpen, surfaceOpen, uiViewId]);
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const targetPane = useCallback((id: string, element: HTMLDivElement | null) => {
    setPaneTargets((current) => {
      if (current[id] === element || (!element && !current[id])) return current;
      const next = { ...current };
      if (element) next[id] = element;
      else delete next[id];
      return next;
    });
  }, []);
  const report = useCallback(
    (value: unknown) => setError(toUserMessage(value, 'operation.failed')),
    []
  );
  const ready = useCallback((id: string, handle: TerminalPaneHandle | null) => {
    if (handle) {
      handles.current.set(id, handle);
      const waiter = paneWaiters.current.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        paneWaiters.current.delete(id);
        waiter.resolve(handle);
      }
    } else handles.current.delete(id);
  }, []);
  const showContextMenu = useCallback(
    (id: string, x: number, y: number) => {
      setActiveId(id);
      const group = groups.find((group) => group.sessions.includes(id));
      if (group) {
        const viewId = group.placement === 'editor' ? terminalGroupViewId(group) : PANEL_VIEW_ID;
        setUiViewId(viewId);
        setActiveByView((current) => ({ ...current, [viewId]: id }));
      }
      setContextMenu({ id, x, y });
    },
    [groups]
  );
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    if (activeId)
      safeFocus(handles.current.get(activeId)?.terminal.textarea, { preventScroll: true });
  }, [activeId]);
  const showOutput = useCallback((id: string) => {
    const handle = handles.current.get(id);
    if (handle) setOutputView({ id, text: handle.output() });
  }, []);
  const closeOutput = useCallback(() => {
    setOutputView(null);
    if (activeId)
      safeFocus(handles.current.get(activeId)?.terminal.textarea, { preventScroll: true });
  }, [activeId]);
  const waitForPane = useCallback((id: string): Promise<TerminalPaneHandle> => {
    const existing = handles.current.get(id);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        paneWaiters.current.delete(id);
        reject(new Error('The terminal view did not become ready.'));
      }, 10_000);
      paneWaiters.current.set(id, { resolve, reject, timer });
    });
  }, []);
  useEffect(
    () => () => {
      for (const waiter of paneWaiters.current.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('The terminal window closed.'));
      }
      paneWaiters.current.clear();
    },
    []
  );
  const resizePanes = useCallback((groupId: string, sizes: Record<string, number>) => {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId && JSON.stringify(group.sizes) !== JSON.stringify(sizes)
          ? { ...group, sizes }
          : group
      )
    );
  }, []);
  const readySplitGroup = useCallback((id: string, handle: TerminalSplitGroupHandle | null) => {
    if (handle) splitHandles.current.set(id, handle);
    else splitHandles.current.delete(id);
  }, []);
  const resizeFocusedTerminal = useCallback(
    (id: string, direction: TerminalResizeDirection, pixels: number) => {
      const group = groups.find((group) => group.sessions.includes(id));
      if (!group || !Number.isFinite(pixels) || pixels <= 0) return;
      const horizontal = direction === 'left' || direction === 'right';
      try {
        if (horizontal === ((group.direction ?? 'horizontal') === 'horizontal')) {
          splitHandles.current
            .get(group.id)
            ?.resizePane(id, direction === 'left' || direction === 'up', pixels);
        } else if (!horizontal && group.placement !== 'editor' && !floatingGroupId && !maximized) {
          const maximum = dockRoot.current?.parentElement?.clientHeight ?? window.innerHeight;
          setHeight((value) =>
            Math.max(
              Math.min(150, maximum),
              Math.min(maximum, value + (direction === 'up' ? pixels : -pixels))
            )
          );
        }
      } catch (error) {
        report(error);
      }
    },
    [groups, floatingGroupId, maximized, report]
  );
  const navigatePane = useCallback(
    (id: string, direction: number) => {
      const group = groups.find((item) => item.sessions.includes(id));
      if (!group) return;
      const index = group.sessions.indexOf(id);
      setActiveId(
        group.sessions[(index + direction + group.sessions.length) % group.sessions.length]!
      );
    },
    [groups]
  );
  const activateSession = useCallback(
    (id: string) => {
      clearBell(id);
      setActiveId(id);
      const group = groups.find((item) => item.sessions.includes(id));
      if (!group) return;
      const viewId = group.placement === 'editor' ? terminalGroupViewId(group) : PANEL_VIEW_ID;
      setUiViewId(viewId);
      setActiveByView((current) => ({ ...current, [viewId]: id }));
      if (group.placement === 'editor' && !floatingGroupId) {
        setOpen(false);
        const canvas = useCanvasStore.getState();
        const tab = canvas.findTab('terminal', terminalGroupViewId(group));
        if (tab) {
          canvas.setActiveTab(tab.panelId, tab.tabId);
          canvas.focusPanel(tab.panelId);
        } else {
          presentedEditorGroups.current.delete(terminalGroupViewId(group));
          setGroups((current) =>
            current.map((item) =>
              terminalGroupViewId(item) === terminalGroupViewId(group)
                ? { ...item, placement: 'editor' }
                : item
            )
          );
        }
      } else setOpen(true);
      const pane = handles.current.get(id);
      if (pane?.terminal.element?.getClientRects().length)
        safeFocus(pane.terminal.textarea, { preventScroll: true });
      else
        requestAnimationFrame(() =>
          safeFocus(handles.current.get(id)?.terminal.textarea, { preventScroll: true })
        );
    },
    [groups, clearBell, floatingGroupId]
  );
  const navigateGroup = useCallback(
    (id: string, direction: number) => {
      const source = groups.find((group) => group.sessions.includes(id));
      if (!source) return;
      const siblings = groups.filter((group) =>
        source.placement === 'editor'
          ? group.placement === 'editor' &&
            terminalGroupViewId(group) === terminalGroupViewId(source)
          : group.placement !== 'editor'
      );
      const index = siblings.indexOf(source);
      const next = siblings[(index + direction + siblings.length) % siblings.length];
      if (next?.sessions[0]) activateSession(next.sessions[0]);
    },
    [groups, activateSession]
  );
  const movePane = useCallback(
    (source: string, target: string, side: 'before' | 'after') => {
      if (
        !groups.some((group) => group.sessions.includes(source)) ||
        !groups.some((group) => group.sessions.includes(target))
      )
        return;
      activateSession(target);
      setGroups((current) => moveTerminalPane(current, source, target, side));
      const group = groups.find((group) => group.sessions.includes(target));
      if (group)
        setActiveByView((current) => ({
          ...current,
          [group.placement === 'editor' ? terminalGroupViewId(group) : PANEL_VIEW_ID]: source,
        }));
      setActiveId(source);
    },
    [groups, activateSession]
  );

  useEffect(() => {
    if (!port) return;
    let cancelled = false;
    const unsubscribe = port.subscribe((event) => {
      if (event.kind === 'changed' && event.notifyExit) {
        useToastStore.getState().addRichToast({
          definition: 'terminal-shell-exited',
          key: `${event.session.id}:${event.session.pid}`,
          message: userMessageWithValues('notice.value-shell-exited-with-code-value', {
            value0: userMessageValue(event.session.title),
            value1: userMessageValue(event.session.exitCode),
          }),
        });
      }
      if (event.kind === 'changed')
        setSessions((current) =>
          current.map((session) => (session.id === event.session.id ? event.session : session))
        );
      if (event.kind === 'removed') {
        const removed = new Set(event.ids);
        setSessions((current) => current.filter((session) => !removed.has(session.id)));
        setGroups((current) =>
          current
            .map((group) => ({
              ...group,
              sessions: group.sessions.filter((id) => !removed.has(id)),
            }))
            .filter((group) => group.sessions.length)
        );
        setActiveId((current) => (current && removed.has(current) ? null : current));
      }
      if (event.kind === 'added') {
        const ids = event.sessions.map((session) => session.id);
        setSessions((current) => [
          ...current.filter((session) => !ids.includes(session.id)),
          ...event.sessions,
        ]);
        setGroups((current) => [
          ...current.filter((group) => group.id !== event.groupId),
          {
            id: event.groupId ?? ids[0]!,
            sessions: ids,
            viewId: event.groupId ?? ids[0]!,
            placement: floatingGroupId ? 'panel' : 'editor',
          },
        ]);
        setActiveId(ids[0] ?? null);
        setOpen(Boolean(floatingGroupId));
      }
    });
    void Promise.all([
      port.list(),
      port.profiles(),
      port.profileConfiguration(),
      port.runtimePolicy(),
    ])
      .then(([existing, available, configuration, policy]) => {
        if (cancelled) return;
        setSessions(existing);
        setProfiles(available);
        setProfileId(configuration.defaultProfileId ?? available[0]?.id ?? '');
        let layout: {
          groups?: TerminalGroup[];
          activeId?: string;
          open?: boolean;
          height?: number;
          maximized?: boolean;
          presentation?: TerminalPresentation | 'workspace';
          activeByView?: Record<string, string>;
        } = {};
        try {
          layout = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
        } catch {}
        const ids = new Set(existing.map((session) => session.id));
        const assigned = new Set<string>();
        const restored: TerminalGroup[] = [];
        if (Array.isArray(layout.groups))
          for (const group of layout.groups) {
            if (!group || typeof group.id !== 'string' || !Array.isArray(group.sessions)) continue;
            const valid = group.sessions.filter((id) => ids.has(id) && !assigned.has(id));
            valid.forEach((id) => assigned.add(id));
            if (valid.length)
              restored.push({
                id: group.id,
                sessions: valid,
                viewId:
                  typeof group.viewId === 'string' && group.viewId.length <= 256
                    ? group.viewId
                    : undefined,
                placement: floatingGroupId
                  ? 'panel'
                  : group.placement === 'panel' || group.placement === 'editor'
                    ? group.placement
                    : layout.presentation === 'panel'
                      ? 'panel'
                      : 'editor',
                direction: group.direction === 'vertical' ? 'vertical' : 'horizontal',
                sizes: group.sizes && typeof group.sizes === 'object' ? group.sizes : undefined,
              });
          }
        const remaining = [...ids].filter((id) => !assigned.has(id));
        if (floatingGroupId && remaining.length)
          restored.push({ id: floatingGroupId, sessions: remaining });
        else
          for (const id of remaining)
            restored.push({
              id,
              sessions: [id],
              placement: layout.presentation === 'panel' ? 'panel' : 'editor',
            });
        setGroups(
          migrateTerminalGroupViews(restored, layout.presentation, Boolean(floatingGroupId))
        );
        setActiveByView(
          layout.activeByView && typeof layout.activeByView === 'object'
            ? Object.fromEntries(
                Object.entries(layout.activeByView).filter(
                  ([, id]) => typeof id === 'string' && ids.has(id)
                )
              )
            : {}
        );
        setActiveId(
          layout.activeId && ids.has(layout.activeId) ? layout.activeId : (existing[0]?.id ?? null)
        );
        const showAtStartup = floatingGroupId
          ? Boolean(existing.length)
          : policy.startupVisibility === 'visible' ||
            (policy.startupVisibility === 'remember' &&
              Boolean(
                existing.length &&
                restored.some((group) => group.placement === 'panel') &&
                layout.open
              ));
        setPanelOpen(showAtStartup);
        if (!floatingGroupId && showAtStartup) workspaceNavigation.current.onOpenWorkspace?.();
        else if (
          !floatingGroupId &&
          policy.startupVisibility === 'hidden' &&
          workspaceNavigation.current.workspaceActive
        )
          workspaceNavigation.current.onCloseWorkspace?.();
        if (typeof layout.height === 'number' && Number.isFinite(layout.height)) {
          const maximum = dockRoot.current?.parentElement?.clientHeight || window.innerHeight;
          setHeight(Math.max(Math.min(150, maximum), Math.min(maximum, layout.height)));
        }
        setMaximized(layout.maximized === true);
        setInitialized(true);
      })
      .catch(report);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [port, report, storageKey, floatingGroupId]);

  useEffect(() => {
    if (initialized)
      localStorage.setItem(
        storageKey,
        JSON.stringify({ version: 2, groups, activeId, activeByView, open, height, maximized })
      );
  }, [initialized, groups, activeId, activeByView, open, height, maximized, storageKey]);
  useEffect(() => {
    if (!port) return;
    return subscribeTerminalProfilesChanged(() => {
      void Promise.all([port.profiles(), port.profileConfiguration()])
        .then(([available, configuration]) => {
          setProfiles(available);
          setProfileId(configuration.defaultProfileId ?? available[0]?.id ?? '');
        })
        .catch(report);
    });
  }, [port, report]);

  const create = useCallback(
    async (
      split = false,
      requestedCwd?: string,
      parentId = activeId,
      newAppTab = false,
      requestedViewId?: string
    ) => {
      if (!port || pendingCreate.current || !initialized) return;
      const parent = groups.find((group) => group.sessions.includes(parentId ?? ''));
      const placement =
        floatingGroupId || requestedViewId === PANEL_VIEW_ID
          ? 'panel'
          : newAppTab
            ? 'editor'
            : (parent?.placement ?? 'panel');
      const viewId = newAppTab
        ? (requestedViewId ?? crypto.randomUUID())
        : (requestedViewId ?? (parent ? terminalGroupViewId(parent) : TERMINAL_WORKSPACE_TAB_ID));
      if (placement === 'editor') dispatchCommand(COMMAND_IDS.appShowExplorer, { source: 'ui' });
      pendingCreate.current = true;
      setBusy(true);
      setError('');
      try {
        const parentSession = sessions.find((session) => session.id === parentId);
        const session = await port.create({
          cwd: requestedCwd ?? parentSession?.cwd ?? defaultCwd,
          profileId: profileId || undefined,
        });
        setSessions((current) => [...current, session]);
        setGroups((current) =>
          split && parent
            ? splitTerminalPane(current, parentId!, session.id)
            : [...current, { id: session.id, sessions: [session.id], viewId, placement }]
        );
        setActiveId(session.id);
        const selectedView = placement === 'editor' ? viewId : PANEL_VIEW_ID;
        setActiveByView((current) => ({ ...current, [selectedView]: session.id }));
        setUiViewId(selectedView);
        setOpen(placement === 'panel');
        if (placement === 'editor') {
          const canvas = useCanvasStore.getState();
          const tab = canvas.findTab('terminal', viewId);
          if (tab) {
            canvas.setActiveTab(tab.panelId, tab.tabId);
            canvas.focusPanel(tab.panelId);
          }
        }
        return session;
      } catch (failure) {
        report(failure);
      } finally {
        pendingCreate.current = false;
        setBusy(false);
      }
    },
    [
      port,
      initialized,
      sessions,
      groups,
      activeId,
      defaultCwd,
      profileId,
      report,
      floatingGroupId,
      dispatchCommand,
    ]
  );

  useEffect(
    () =>
      registerTerminalViewOpener(async (request) => {
        if (!port || floatingGroupId)
          throw new TerminalOpeningError(
            'TERMINAL_UNAVAILABLE',
            'Open terminals from the main desktop window.'
          );
        if (!initialized || busy || pendingCreate.current)
          throw new TerminalOpeningError(
            'TERMINAL_NOT_READY',
            'The terminal is busy or still loading.',
            { retriable: true }
          );
        const parentId = request.parentSessionId ?? activeId;
        const parent = groups.find((group) => group.sessions.includes(parentId ?? ''));
        if ((request.mode !== 'tab' || request.parentSessionId) && !parent)
          throw new TerminalOpeningError(
            'TERMINAL_PARENT_NOT_FOUND',
            'The parent terminal is not open in this window.'
          );
        const editor = request.mode === 'tab' || parent?.placement === 'editor';
        const viewId =
          request.mode === 'tab'
            ? crypto.randomUUID()
            : editor
              ? terminalGroupViewId(parent!)
              : PANEL_VIEW_ID;
        const session = await create(
          request.mode === 'split',
          request.cwd,
          parentId,
          request.mode === 'tab',
          viewId
        );
        if (!session)
          throw new TerminalOpeningError(
            'TERMINAL_OPEN_FAILED',
            'The native terminal could not be opened.',
            { stateChanged: 'unknown' }
          );
        try {
          const pane = await waitForPane(session.id);
          const deadline = Date.now() + 10_000;
          let activated = false;
          while (Date.now() < deadline) {
            const canvas = useCanvasStore.getState();
            const tab = editor ? canvas.findTab('terminal', viewId) : null;
            if (tab && !activated) {
              canvas.setActiveTab(tab.panelId, tab.tabId);
              canvas.focusPanel(tab.panelId);
              activated = true;
            }
            if ((!editor || tab) && pane.terminal.element?.getClientRects().length)
              return {
                sessionId: session.id,
                groupId: request.mode === 'split' ? parent!.id : session.id,
                viewId,
                tabId: tab?.tabId ?? null,
                title: session.title,
                cwd: session.cwd,
              };
            await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
          }
          throw new Error('The terminal view did not become visible.');
        } catch (error) {
          throw new TerminalOpeningError(
            'TERMINAL_VIEW_FAILED',
            error instanceof Error ? error.message : String(error),
            {
              stateChanged: true,
              sessionId: session.id,
            }
          );
        }
      }),
    [port, floatingGroupId, initialized, busy, activeId, groups, create, waitForPane]
  );

  useEffect(() => {
    const requested = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string }>).detail;
      if (detail && typeof detail.cwd === 'string') void create(false, detail.cwd);
    };
    window.addEventListener(OPEN_INTEGRATED_TERMINAL_EVENT, requested);
    return () => window.removeEventListener(OPEN_INTEGRATED_TERMINAL_EVENT, requested);
  }, [create]);

  useEffect(() => {
    const requested = (event: Event) => {
      const request = (event as CustomEvent<TerminalRunRequest>).detail;
      if (!request || typeof request !== 'object' || !port) return;
      const text =
        typeof request.text === 'string' && request.text.trim() ? request.text : undefined;
      const filePath =
        typeof request.filePath === 'string' && request.filePath.trim()
          ? request.filePath
          : undefined;
      if (!text && !filePath) return;
      executionQueue.current = executionQueue.current
        .then(async () => {
          const available = await port.list();
          const current = request.fresh
            ? undefined
            : available.find((session) => session.id === activeId && session.status === 'running');
          const session = current ?? (await create(false, defaultCwd ?? request.cwd));
          if (!session) throw new Error('The terminal is not ready to run code.');
          activateSession(session.id);
          await (
            await waitForPane(session.id)
          ).execute(filePath ? terminalFileCommand(filePath, session.shellPath) : text!);
        })
        .catch(report);
    };
    window.addEventListener(RUN_INTEGRATED_TERMINAL_EVENT, requested);
    return () => window.removeEventListener(RUN_INTEGRATED_TERMINAL_EVENT, requested);
  }, [port, activeId, create, defaultCwd, groups, waitForPane, report, activateSession]);

  const toggle = useCallback(() => {
    if (!initialized) return;
    if (onOpenWorkspace && !floatingGroupId) {
      if (open) {
        setOpen(false);
        return;
      }
      const savedId = activeByView[PANEL_VIEW_ID];
      const panelGroup =
        groups.find(
          (group) => group.placement !== 'editor' && group.sessions.includes(savedId ?? '')
        ) ?? groups.find((group) => group.placement !== 'editor');
      if (panelGroup)
        activateSession(
          savedId && panelGroup.sessions.includes(savedId) ? savedId : panelGroup.sessions[0]!
        );
      else if (!sessions.length) void create(false, undefined, null, false, PANEL_VIEW_ID);
      else setOpen(true);
      return;
    }
    const group = groups.find((group) => group.sessions.includes(activeId ?? '')) ?? groups[0];
    if (!group) {
      void create();
      return;
    }
    if (group.placement === 'editor' && !floatingGroupId) {
      dispatchCommand(COMMAND_IDS.appShowExplorer, { source: 'ui' });
      activateSession(group.sessions.includes(activeId ?? '') ? activeId! : group.sessions[0]!);
    } else if (!open)
      activateSession(group.sessions.includes(activeId ?? '') ? activeId! : group.sessions[0]!);
    else setOpen(false);
  }, [
    initialized,
    open,
    create,
    groups,
    activeId,
    floatingGroupId,
    dispatchCommand,
    activateSession,
    onOpenWorkspace,
    activeByView,
    sessions.length,
    setOpen,
  ]);
  useCommandHandler(COMMAND_IDS.terminalToggle, toggle);
  useCommandHandler(COMMAND_IDS.terminalNew, () => {
    void create(false, undefined, activeId, false, PANEL_VIEW_ID);
  });

  const close = async (id: string) => {
    if (!port || closing.current.has(id)) return;
    closing.current.add(id);
    try {
      const status = await port.closeStatus(id);
      if (
        status.requiresConfirmation &&
        !(await confirmDialog({
          title: userMessage('dialog.close-busy-terminal'),
          message: userMessage(
            'dialog.a-program-may-still-be-running-in-this-terminal-closing-it-will-stop-i'
          ),
          confirmLabel: userMessage('dialog.close-terminal'),
          tone: 'danger',
          safeDefault: true,
          signal: closeLifetime.current?.signal,
        }))
      )
        return;
      if (closeLifetime.current?.signal.aborted) return;
      await port.close(id);
      setSessions((current) => current.filter((session) => session.id !== id));
      setGroups((current) =>
        current
          .map((group) => ({ ...group, sessions: group.sessions.filter((item) => item !== id) }))
          .filter((group) => group.sessions.length > 0)
      );
      setActiveId((current) => (current === id ? null : current));
    } catch (failure) {
      report(failure);
    } finally {
      closing.current.delete(id);
    }
  };
  const unsplit = (id: string) => {
    const source = groups.find((group) => group.sessions.includes(id));
    if (!source || source.sessions.length < 2) return;
    setGroups((current) => unsplitTerminalPane(current, id, crypto.randomUUID()));
    activateSession(id);
  };
  const relaunch = async (id = activeId) => {
    if (!port || !id || busy) return;
    setBusy(true);
    setError('');
    try {
      const replacement = await port.relaunch(id);
      setSessions((current) =>
        current.map((session) => (session.id === id ? replacement : session))
      );
      setGroups((current) =>
        current.map((group) => ({
          ...group,
          sessions: group.sessions.map((entry) => (entry === id ? replacement.id : entry)),
          sizes: group.sizes
            ? Object.fromEntries(
                Object.entries(group.sizes).map(([entry, size]) => [
                  entry === id ? replacement.id : entry,
                  size,
                ])
              )
            : undefined,
        }))
      );
      setActiveId(replacement.id);
      setActiveByView((current) =>
        Object.fromEntries(
          Object.entries(current).map(([viewId, selected]) => [
            viewId,
            selected === id ? replacement.id : selected,
          ])
        )
      );
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  };
  const moveToNewTab = (id: string) => {
    const viewId = crypto.randomUUID();
    setGroups((current) => moveTerminalGroupToView(current, id, viewId));
    setActiveByView((current) => ({ ...current, [viewId]: id }));
    setActiveId(id);
    setUiViewId(viewId);
    setOpen(false);
    dispatchCommand(COMMAND_IDS.appShowExplorer, { source: 'ui' });
  };
  const moveToEditor = (id = activeId) => {
    const group = groups.find((group) => group.sessions.includes(id ?? ''));
    if (!group || !id) return;
    if (onOpenWorkspace && group.placement !== 'editor') {
      moveToNewTab(id);
      return;
    }
    const viewId = terminalGroupViewId(group);
    presentedEditorGroups.current.delete(viewId);
    setGroups((current) =>
      current.map((item) =>
        terminalGroupViewId(item) === viewId ? { ...item, placement: 'editor' } : item
      )
    );
    setActiveByView((current) => ({ ...current, [viewId]: id }));
    setActiveId(id);
    setUiViewId(viewId);
    setMaximized(false);
    setOpen(false);
    dispatchCommand(COMMAND_IDS.appShowExplorer, { source: 'ui' });
  };
  const moveToWindow = async (groupId = activeGroup) => {
    const group = groups.find((item) => item.id === groupId);
    if (!port || !group || busy) return;
    setBusy(true);
    try {
      await port.moveToWindow(group.sessions, group.id);
    } catch (failure) {
      report(failure);
    } finally {
      setBusy(false);
    }
  };
  const moveToPanel = useCallback(
    (groupId: string) => {
      const group = groups.find((item) => item.id === groupId);
      if (!group) return;
      const viewId = terminalGroupViewId(group);
      const canvas = useCanvasStore.getState();
      const tab = canvas.findTab('terminal', viewId);
      if (tab) canvas.closeTab(tab.panelId, tab.tabId);
      setGroups((current) =>
        current.map((item) =>
          terminalGroupViewId(item) === viewId ? { ...item, placement: 'panel' } : item
        )
      );
      const id = group.sessions.includes(activeId ?? '') ? activeId! : group.sessions[0]!;
      setActiveId(id);
      setActiveByView((current) => ({ ...current, [PANEL_VIEW_ID]: id }));
      setUiViewId(PANEL_VIEW_ID);
      setOpen(true);
    },
    [groups, activeId]
  );
  useEffect(() => {
    if (!initialized || floatingGroupId) return;
    const canvas = useCanvasStore.getState();
    const hidden = new Set<string>();
    const reopened = new Set<string>();
    const views = new Map<string, TerminalGroup[]>();
    for (const group of groups) {
      const viewId = terminalGroupViewId(group);
      views.set(viewId, [...(views.get(viewId) ?? []), group]);
    }
    for (const viewId of presentedEditorGroups.current)
      if (!views.has(viewId)) presentedEditorGroups.current.delete(viewId);
    for (const [viewId, viewGroups] of views) {
      const tab = canvas.findTab('terminal', viewId);
      if (viewGroups.every((group) => group.placement !== 'editor')) {
        if (tab) for (const group of viewGroups) reopened.add(group.id);
        continue;
      }
      const first = sessions.find((session) => session.id === viewGroups[0]?.sessions[0]);
      const label =
        viewId === TERMINAL_WORKSPACE_TAB_ID ? 'Terminal' : `Terminal: ${first?.title ?? 'Shell'}`;
      if (tab) {
        presentedEditorGroups.current.add(viewId);
        for (const group of viewGroups) if (group.placement !== 'editor') reopened.add(group.id);
        const current = canvas.panels[tab.panelId]?.tabs.find((item) => item.id === tab.tabId);
        if (current && current.label !== label) canvas.updateTab(tab.panelId, tab.tabId, { label });
      } else if (!presentedEditorGroups.current.has(viewId)) {
        presentedEditorGroups.current.add(viewId);
        canvas.openInFocusedPanel('terminal', viewId, label);
      } else for (const group of viewGroups) hidden.add(group.id);
    }
    if (hidden.size || reopened.size)
      setGroups((current) =>
        current.map((group) =>
          reopened.has(group.id)
            ? { ...group, placement: 'editor' }
            : hidden.has(group.id)
              ? { ...group, placement: 'panel' }
              : group
        )
      );

    for (const panel of Object.values(canvasPanels))
      for (const tab of panel.tabs)
        if (tab.type === 'terminal' && !views.has(tab.entityId)) canvas.closeTab(panel.id, tab.id);
  }, [initialized, canvasPanels, groups, floatingGroupId, sessions]);
  useEffect(() => {
    const action = (event: Event) => {
      const detail = (event as CustomEvent<{ groupId: string; action: string }>).detail;
      const group = detail && groups.find((item) => item.id === detail.groupId);
      if (!group) return;
      const id = group.sessions.includes(activeId ?? '') ? activeId! : group.sessions[0]!;
      if (detail.action === 'panel') moveToPanel(detail.groupId);
      else if (detail.action === 'split') void create(true, undefined, id);
      else if (detail.action === 'relaunch') void relaunch(id);
      else if (detail.action === 'find') {
        activateSession(id);
        handles.current.get(id)?.find();
      }
    };
    window.addEventListener(TERMINAL_EDITOR_ACTION_EVENT, action);
    return () => window.removeEventListener(TERMINAL_EDITOR_ACTION_EVENT, action);
  });

  useEffect(() => {
    if (workspaceActive) return;
    const entry = Object.entries(editorTargets).find(([, target]) => target.active);
    if (!entry) return;
    const [viewId] = entry;
    if (open && lastFocusedView.current === viewId) return;
    lastFocusedView.current = viewId;
    const viewGroups = groups.filter(
      (group) => group.placement === 'editor' && terminalGroupViewId(group) === viewId
    );
    const ids = viewGroups.flatMap((group) => group.sessions);
    const saved = activeByView[viewId];
    const id =
      saved && ids.includes(saved) ? saved : activeId && ids.includes(activeId) ? activeId : ids[0];
    if (id) {
      setActiveId(id);
      setUiViewId(viewId);
      setOpen(false);
    }
  }, [editorTargets, groups, activeByView, activeId, open, workspaceActive]);

  if (!port) return null;
  const terminalPort = port;
  const createSession = create;
  const relaunchSession = relaunch;
  const moveGroupToEditor = moveToEditor;
  const moveGroupToWindow = moveToWindow;
  const panelVisible = open;
  const currentContextMenu = contextMenu;
  const currentRenaming = renaming;
  const currentHistory = historyTarget;
  const currentOutput = outputView;
  const currentDimensions = dimensionsId;
  const currentActionsOpen = actionsOpen;
  const renderWorkspace = (
    viewId: string,
    groups: TerminalGroup[],
    editorTarget?: (typeof editorTargets)[string]
  ) => {
    const ids = new Set(groups.flatMap((group) => group.sessions));
    const activeId = selectedFor(viewId, groups);
    const active = sessionMap.get(activeId ?? '');
    const activeGroup = groups.find((group) => group.sessions.includes(activeId ?? ''))?.id;
    const workspace = !floatingGroupId && viewId === PANEL_VIEW_ID ? workspaceTarget : null;
    const SessionList = workspace ? NavigationList : 'div';
    const surfaceTarget = editorTarget ?? workspace;
    const editorChrome = editorTarget?.chrome;
    const open = !editorTarget && panelVisible;
    const surfaceOpen = open || Boolean(editorTarget?.visible);
    const sessionTabsVisible = true;
    const presentation: TerminalPresentation = editorTarget ? 'sessions' : 'panel';
    const port = terminalPort;
    const orderedSessions = groups.flatMap((group) =>
      group.sessions.flatMap((id) => {
        const session = sessionMap.get(id);
        return session ? [session] : [];
      })
    );
    let controls = toolbarRefs.current.get(viewId);
    if (!controls) {
      controls = { menu: createRef<HTMLButtonElement>(), surface: createRef<HTMLDivElement>() };
      toolbarRefs.current.set(viewId, controls);
    }
    const actionsMenu = controls.menu;
    const actionsSurface = controls.surface;
    const actionsOpen = currentActionsOpen && uiViewId === viewId;
    const contextMenu =
      currentContextMenu && ids.has(currentContextMenu.id) ? currentContextMenu : null;
    const renaming = currentRenaming && ids.has(currentRenaming) ? currentRenaming : null;
    const historyTarget = currentHistory && ids.has(currentHistory.id) ? currentHistory : null;
    const outputView = currentOutput && ids.has(currentOutput.id) ? currentOutput : null;
    const dimensionsId = currentDimensions && ids.has(currentDimensions) ? currentDimensions : null;
    const create = (split = false, cwd?: string, parentId = activeId) =>
      createSession(split, cwd, parentId, false, workspace ? PANEL_VIEW_ID : undefined);
    const relaunch = (id = activeId) => relaunchSession(id);
    const moveToEditor = (id = activeId) => moveGroupToEditor(id);
    const moveToWindow = () => moveGroupToWindow(activeGroup);
    const find = () => {
      if (activeId) handles.current.get(activeId)?.find();
    };
    return (
      <TerminalGroupHost
        key={viewId}
        chrome
        target={surfaceTarget?.chrome}
        visible={Boolean(editorChrome) || open || Boolean(floatingGroupId)}
      >
        <section
          ref={surfaceTarget?.chrome ? undefined : dockRoot}
          data-terminal-view-id={viewId}
          onPointerDownCapture={() => {
            setUiViewId(viewId);
            if (activeId) setActiveId(activeId);
          }}
          data-testid={viewId === primaryViewId ? 'terminal-dock' : undefined}
          data-open={surfaceOpen}
          data-session-layout="sessions"
          data-presentation={editorChrome ? 'editor' : floatingGroupId ? 'window' : presentation}
          data-terminal-theme={appearance.colorScheme}
          data-maximized={open && maximized ? 'true' : undefined}
          aria-label="Integrated terminal"
          className={`dnaforge-terminal-dock${workspace ? ' dnaforge-terminal-workspace-chrome' : ''}`}
          style={
            open && !workspace
              ? {
                  height: maximized || floatingGroupId ? '100%' : height,
                  flex: maximized || floatingGroupId ? '1 1 100%' : '0 0 auto',
                }
              : undefined
          }
        >
          {open && !editorChrome && !floatingGroupId && !workspace && presentation === 'panel' && (
            <div
              role="separator"
              aria-label="Resize terminal panel"
              aria-orientation="horizontal"
              tabIndex={0}
              className="dnaforge-terminal-resizer"
              onKeyDown={(event) => {
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  setHeight((value) => Math.max(150, value + (event.key === 'ArrowUp' ? 20 : -20)));
                }
              }}
              onPointerDown={(event) => {
                resizeOrigin.current = { y: event.clientY, height };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (resizeOrigin.current)
                  setHeight(
                    Math.max(
                      150,
                      Math.min(
                        window.innerHeight - 100,
                        resizeOrigin.current.height + resizeOrigin.current.y - event.clientY
                      )
                    )
                  );
              }}
              onPointerUp={() => {
                resizeOrigin.current = null;
              }}
            />
          )}
          <div className="dnaforge-terminal-toolbar dnaforge-terminal-header">
            <button
              data-testid="terminal-surface-title"
              disabled={!initialized || busy}
              onClick={toggle}
              title="Toggle Terminal (Ctrl+`)"
              aria-expanded={open}
              className="wp-interactive dnaforge-terminal-title"
            >
              <span className="dnaforge-terminal-prompt-icon" aria-hidden="true">
                ›_
              </span>
              Terminal
            </button>
            {surfaceOpen && (
              <>
                <span className="dnaforge-terminal-location" title={active?.cwd}>
                  {active?.cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || 'Workspace'}
                </span>
                <div className="dnaforge-terminal-primary-actions">
                  <button
                    className="wp-interactive"
                    aria-label="Split terminal"
                    title="Split session"
                    disabled={!active || busy}
                    onClick={() => void create(true)}
                  >
                    <SidebarIcon />
                  </button>
                  <button
                    className="wp-interactive"
                    aria-label="Find in terminal"
                    title="Find in terminal"
                    onClick={find}
                  >
                    <SearchIcon />
                  </button>
                  {!floatingGroupId && (
                    <button
                      aria-label="New terminal app tab"
                      title="New terminal app tab"
                      className="wp-interactive dnaforge-terminal-new-app-tab"
                      disabled={busy}
                      onClick={() => void createSession(false, undefined, activeId, true)}
                    >
                      <PlusIcon />
                      <span>New tab</span>
                    </button>
                  )}
                  <div
                    className="dnaforge-terminal-actions"
                    onBlur={(event) => {
                      const next = event.relatedTarget;
                      if (
                        next instanceof Node &&
                        (actionsMenu.current?.contains(next) ||
                          actionsSurface.current?.contains(next))
                      )
                        return;
                      setActionsOpen(false);
                    }}
                  >
                    <button
                      className="wp-interactive"
                      ref={actionsMenu}
                      aria-label="Terminal actions"
                      title="More terminal actions"
                      aria-haspopup="dialog"
                      aria-expanded={actionsOpen}
                      onClick={() => setActionsOpen((value) => !value)}
                    >
                      <EllipsisIcon />
                    </button>
                    <PortalMenu
                      open={actionsOpen && surfaceOpen}
                      anchorRef={actionsMenu}
                      surfaceRef={actionsSurface}
                      onRequestClose={() => setActionsOpen(false)}
                      role="dialog"
                      aria-label="Terminal options"
                      preferredSide="bottom"
                      layout={{ width: 256 }}
                      density="compact"
                      selection={false}
                    >
                      <div
                        className="dnaforge-terminal-action-menu"
                        data-terminal-surface
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            event.stopPropagation();
                            setActionsOpen(false);
                            safeFocus(actionsMenu.current);
                          }
                        }}
                        onClick={(event) => {
                          if ((event.target as HTMLElement).closest('button')) {
                            setActionsOpen(false);
                          }
                        }}
                      >
                        <MenuNativeSelect
                          aria-label="Terminal shell profile"
                          value={profileId}
                          onChange={(event) => setProfileId(event.target.value)}
                        >
                          {profiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                              {profile.name}
                            </option>
                          ))}
                        </MenuNativeSelect>
                        <label>
                          Session
                          <MenuNativeSelect
                            aria-label="Terminal session"
                            value={activeId ?? ''}
                            onChange={(event) => activateSession(event.target.value)}
                          >
                            {orderedSessions.map((session) => (
                              <option key={session.id} value={session.id}>
                                {session.title}
                              </option>
                            ))}
                          </MenuNativeSelect>
                        </label>
                        <MenuRow
                          aria-label="End terminal session"
                          disabled={!activeId}
                          onClick={() => activeId && void close(activeId)}
                        >
                          End session
                        </MenuRow>
                        <MenuRow
                          aria-label="Relaunch terminal"
                          disabled={!active || busy}
                          onClick={() => void relaunch()}
                        >
                          Relaunch
                        </MenuRow>
                        <MenuRow
                          aria-label={
                            editorChrome ? 'Move terminal to panel' : 'Move terminal to editor'
                          }
                          disabled={!active || Boolean(floatingGroupId)}
                          onClick={() =>
                            editorChrome && activeGroup ? moveToPanel(activeGroup) : moveToEditor()
                          }
                        >
                          {editorChrome ? 'Move to terminal column' : 'Move to tab'}
                        </MenuRow>
                        <MenuRow
                          aria-label="Move terminal to new window"
                          disabled={!active || busy}
                          onClick={() => void moveToWindow()}
                        >
                          New window
                        </MenuRow>
                        {floatingGroupId && (
                          <MenuRow
                            aria-label="Return terminal to main window"
                            onClick={() => void port.returnToMainWindow().catch(report)}
                          >
                            Return to main window
                          </MenuRow>
                        )}
                        {groups.find((group) => group.id === activeGroup)?.sessions.length && (
                          <>
                            <MenuRow
                              aria-label="Previous terminal pane"
                              onClick={() => activeId && navigatePane(activeId, -1)}
                            >
                              ←
                            </MenuRow>
                            <MenuRow
                              aria-label="Next terminal pane"
                              onClick={() => activeId && navigatePane(activeId, 1)}
                            >
                              →
                            </MenuRow>
                            <MenuNativeSelect
                              aria-label="Terminal split arrangement"
                              value={
                                groups.find((group) => group.id === activeGroup)?.direction ??
                                'horizontal'
                              }
                              onChange={(event) =>
                                setGroups((current) =>
                                  current.map((group) =>
                                    group.id === activeGroup
                                      ? {
                                          ...group,
                                          direction:
                                            event.target.value === 'vertical'
                                              ? 'vertical'
                                              : 'horizontal',
                                        }
                                      : group
                                  )
                                )
                              }
                            >
                              <option value="horizontal">Side by side</option>
                              <option value="vertical">Stacked</option>
                            </MenuNativeSelect>
                          </>
                        )}
                        {groups.find((group) => group.id === activeGroup)?.sessions.length !== 1 &&
                          activeId && (
                            <MenuRow
                              aria-label="Unsplit terminal"
                              onClick={() => unsplit(activeId)}
                            >
                              Unsplit
                            </MenuRow>
                          )}
                        <MenuRow
                          aria-label="View terminal output"
                          disabled={!activeId}
                          onClick={() => activeId && showOutput(activeId)}
                        >
                          Output
                        </MenuRow>
                        <MenuRow
                          aria-label="Paste into terminal"
                          disabled={!activeId}
                          onClick={() => {
                            if (activeId) void handles.current.get(activeId)?.paste().catch(report);
                          }}
                        >
                          Paste
                        </MenuRow>
                        <MenuRow
                          aria-label="Terminal command history"
                          disabled={!activeId}
                          onClick={() =>
                            activeId && setHistoryTarget({ id: activeId, kind: 'command' })
                          }
                        >
                          History
                        </MenuRow>
                        {!floatingGroupId && (
                          <>
                            <MenuRow
                              aria-label="Manage terminal profiles"
                              onClick={() => {
                                setMaximized(false);
                                dispatchCommand(COMMAND_IDS.appOpenSettings, {
                                  source: 'ui',
                                  payload: { focus: 'terminal-profiles' },
                                });
                              }}
                            >
                              Profiles
                            </MenuRow>
                            <MenuRow
                              aria-label="Terminal settings"
                              onClick={() => {
                                setMaximized(false);
                                dispatchCommand(COMMAND_IDS.appOpenSettings, {
                                  source: 'ui',
                                  payload: { focus: 'terminal' },
                                });
                              }}
                            >
                              Settings
                            </MenuRow>
                          </>
                        )}
                      </div>
                    </PortalMenu>
                  </div>
                  <button
                    className="wp-interactive"
                    hidden={Boolean(editorChrome) || Boolean(workspace)}
                    aria-label={maximized ? 'Restore terminal panel' : 'Maximize terminal panel'}
                    title={maximized ? 'Restore workspace' : 'Fill workspace'}
                    onClick={() => setMaximized((value) => !value)}
                  >
                    <OpenExternalIcon />
                  </button>
                  <button
                    className="wp-interactive"
                    hidden={Boolean(editorChrome)}
                    aria-label="Hide terminal"
                    title="Return to document · Ctrl+`"
                    onClick={() => setOpen(false)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              </>
            )}
            {!open && sessions.length > 0 && (
              <span className="dnaforge-terminal-session-count">{sessions.length}</span>
            )}
          </div>
          {error && (
            <div role="alert" className="dnaforge-terminal-error">
              {toUserMessage(error, 'operation.failed')}
              <button aria-label="Dismiss terminal error" onClick={() => setError('')}>
                ×
              </button>
            </div>
          )}
          {active?.revivalError && surfaceOpen && (
            <div role="alert" className="dnaforge-terminal-error">
              {active.revivalError}
            </div>
          )}
          {historyTarget && (
            <TerminalCommandHistory
              key={`${historyTarget.id}:${historyTarget.kind}`}
              pinStorageKey={terminalHistoryPinKey(
                defaultCwd ?? '',
                sessionMap.get(historyTarget.id)?.shellPath ?? '',
                historyTarget.kind
              )}
              commands={sessionMap.get(historyTarget.id)?.commands ?? []}
              history={savedHistory?.id === historyTarget.id ? savedHistory.data : undefined}
              directory={
                historyTarget.kind === 'directory'
                  ? sessionMap.get(historyTarget.id)?.cwd
                  : undefined
              }
              running={sessionMap.get(historyTarget.id)?.status === 'running'}
              onViewOutput={(commandId) => {
                const id = historyTarget.id;
                setHistoryTarget(null);
                void port
                  .commandOutput(id, commandId)
                  .then((text) => {
                    if (text === undefined)
                      throw new Error(
                        'This command’s output is no longer available in scrollback.'
                      );
                    setOutputView({ id, text });
                  })
                  .catch(report);
              }}
              onReveal={(commandId) => {
                const id = historyTarget.id;
                setHistoryTarget(null);
                activateSession(id);
                void handles.current.get(id)?.revealCommand(commandId).catch(report);
              }}
              onKindChange={() =>
                setHistoryTarget({
                  ...historyTarget,
                  kind: historyTarget.kind === 'command' ? 'directory' : 'command',
                })
              }
              onClose={() => {
                setHistoryTarget(null);
                if (handles.current.has(historyTarget.id)) {
                  activateSession(historyTarget.id);
                  safeFocus(handles.current.get(historyTarget.id)?.terminal.textarea, {
                    preventScroll: true,
                  });
                }
              }}
              onPick={(text, execute) => {
                const pane = handles.current.get(historyTarget.id);
                const session = sessionMap.get(historyTarget.id);
                setHistoryTarget(null);
                if (!pane || !session) return;
                activateSession(historyTarget.id);
                const input =
                  historyTarget.kind === 'directory'
                    ? terminalDirectoryCommand(text, session.shellPath)
                    : text;
                void (execute ? pane.execute(input) : pane.insert(input)).catch(report);
              }}
            />
          )}
          <div
            className="dnaforge-terminal-content"
            style={{
              display: sessionTabsVisible ? 'flex' : 'none',
            }}
          >
            <div className="dnaforge-terminal-groups">
              {groups.map((group) => (
                <TerminalGroupHost
                  key={group.id}
                  target={surfaceTarget?.element}
                  visible={group.id === activeGroup && (editorTarget ? editorTarget.visible : open)}
                >
                  <TerminalSplitGroup
                    id={group.id}
                    sessions={group.sessions}
                    direction={group.direction}
                    sizes={group.sizes}
                    onResize={resizePanes}
                    onReady={readySplitGroup}
                  >
                    {(id) => <TerminalPaneTarget key={id} id={id} onTarget={targetPane} />}
                  </TerminalSplitGroup>
                </TerminalGroupHost>
              ))}
              {open && !groups.length && (
                <TerminalGroupHost target={surfaceTarget?.element} visible>
                  <div className="dnaforge-terminal-workspace-empty">
                    <p>Select a terminal or start a new session.</p>
                    <button onClick={() => void create()} disabled={busy}>
                      Create terminal
                    </button>
                  </div>
                </TerminalGroupHost>
              )}
            </div>
            <TerminalGroupHost chrome target={workspace?.sidebar} visible={surfaceOpen}>
              <div
                data-terminal-surface
                className={workspace ? UI_NAVIGATION_PANEL_CLASS : 'dnaforge-terminal-tabs'}
              >
                {workspace && (
                  <div className={UI_NAVIGATION_HEADER_CLASS}>
                    <h2>Terminals</h2>
                    <NavigationAction
                      id="new-terminal"
                      label="New terminal"
                      disabled={busy || !initialized}
                      onInvoke={() => void create()}
                      icon={<PlusIcon className="w-4 h-4" />}
                    />
                  </div>
                )}
                <SessionList
                  role="tablist"
                  aria-label="Terminal sessions"
                  aria-orientation={workspace ? 'vertical' : 'horizontal'}
                  {...(!workspace ? { className: 'dnaforge-terminal-tab-items' } : {})}
                >
                  {groups.map((group) => (
                    <div
                      key={group.id}
                      className={
                        workspace ? UI_NAVIGATION_GROUP_CLASS : 'dnaforge-terminal-tab-group'
                      }
                      data-terminal-tab-group-id={group.id}
                      data-split={group.sessions.length > 1}
                      data-direction={group.direction ?? 'horizontal'}
                      data-active={group.sessions.includes(activeId ?? '')}
                      role={group.sessions.length > 1 ? 'group' : undefined}
                      aria-label={
                        group.sessions.length > 1
                          ? group.direction === 'vertical'
                            ? 'Stacked terminals'
                            : 'Side by side terminals'
                          : undefined
                      }
                    >
                      {group.sessions.length > 1 && (
                        <span
                          className={
                            workspace
                              ? UI_NAVIGATION_METADATA_CLASS
                              : 'dnaforge-terminal-split-indicator'
                          }
                          role="img"
                          aria-label={
                            group.direction === 'vertical' ? 'Stacked split' : 'Side by side split'
                          }
                          title={
                            group.direction === 'vertical'
                              ? 'Stacked terminals'
                              : 'Side by side terminals'
                          }
                        >
                          <svg
                            viewBox="0 0 16 16"
                            width="14"
                            height="14"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            aria-hidden="true"
                          >
                            <rect x="1.5" y="1.5" width="13" height="13" rx="2" />
                            {group.direction === 'vertical' ? (
                              <path d="M2 8h12" />
                            ) : (
                              <path d="M8 2v12" />
                            )}
                          </svg>
                        </span>
                      )}
                      {group.sessions.map((id) => {
                        const session = sessionMap.get(id);
                        if (!session) return null;
                        const rowProps: HTMLAttributes<HTMLDivElement> & {
                          'data-terminal-tab-id': string;
                          'data-terminal-group-id': string;
                        } = {
                          'data-terminal-tab-id': session.id,
                          'data-terminal-group-id': group.id,
                          onContextMenu: (event) => {
                            event.preventDefault();
                            showContextMenu(session.id, event.clientX, event.clientY);
                          },
                          draggable: true,
                          onDragStart: (event) => {
                            event.dataTransfer.setData(TERMINAL_DRAG_TYPE, session.id);
                            event.dataTransfer.effectAllowed = 'move';
                          },
                          onDragOver: (event) => {
                            if (event.dataTransfer.types.includes(TERMINAL_DRAG_TYPE))
                              event.preventDefault();
                          },
                          onDrop: (event) => {
                            const source = event.dataTransfer.getData(TERMINAL_DRAG_TYPE);
                            if (
                              !sessions.some((item) => item.id === source) ||
                              source === session.id
                            )
                              return;
                            event.preventDefault();
                            const bounds = event.currentTarget.getBoundingClientRect();
                            const side = workspace
                              ? event.clientY < bounds.top + bounds.height / 2
                                ? 'before'
                                : 'after'
                              : event.clientX < bounds.left + bounds.width / 2
                                ? 'before'
                                : 'after';
                            setGroups((current) =>
                              reorderTerminalGroups(
                                current.map((item) =>
                                  item.sessions.includes(source)
                                    ? {
                                        ...item,
                                        viewId: terminalGroupViewId(group),
                                        placement: group.placement,
                                      }
                                    : item
                                ),
                                source,
                                session.id,
                                side
                              )
                            );
                            setActiveId(source);
                            setActiveByView((current) => ({ ...current, [viewId]: source }));
                          },
                        };
                        const activate: MouseEventHandler<HTMLButtonElement> = (event) => {
                          activateSession(session.id);
                          if (event.altKey) void create(true, session.cwd, session.id);
                        };
                        const navigate: KeyboardEventHandler<HTMLButtonElement> = (event) => {
                          if (
                            event.code === 'Tab' &&
                            event.ctrlKey &&
                            !event.metaKey &&
                            !event.altKey
                          ) {
                            event.preventDefault();
                            navigateGroup(session.id, event.shiftKey ? -1 : 1);
                          } else if (terminalSplitShortcut(terminalHostPlatform(), event)) {
                            event.preventDefault();
                            void create(true, undefined, session.id);
                          } else if (event.key === 'Delete') {
                            event.preventDefault();
                            void close(session.id);
                          } else if (
                            [
                              'ArrowRight',
                              'ArrowLeft',
                              'ArrowDown',
                              'ArrowUp',
                              'Home',
                              'End',
                            ].includes(event.key)
                          ) {
                            event.preventDefault();
                            const index = orderedSessions.findIndex(
                              (item) => item.id === session.id
                            );
                            const next =
                              event.key === 'Home'
                                ? orderedSessions[0]
                                : event.key === 'End'
                                  ? orderedSessions[orderedSessions.length - 1]
                                  : orderedSessions[
                                      (index +
                                        (event.key === 'ArrowDown' || event.key === 'ArrowRight'
                                          ? 1
                                          : -1) +
                                        orderedSessions.length) %
                                        orderedSessions.length
                                    ];
                            if (next) {
                              activateSession(next.id);
                              const list = event.currentTarget.closest('[role="tablist"]');
                              requestAnimationFrame(() =>
                                safeFocus(
                                  list?.querySelector<HTMLButtonElement>(
                                    `[data-terminal-tab-id="${next.id}"] [role="tab"]`
                                  )
                                )
                              );
                            }
                          }
                        };
                        const rename = () => {
                          setRenaming(session.id);
                          setName(session.title);
                        };
                        const title =
                          session.status === 'exited'
                            ? `${session.exitCode === null ? 'Stopped' : `(${session.exitCode})`} ${session.title}`
                            : session.title;
                        if (workspace) {
                          return (
                            <NavigationRow
                              key={session.id}
                              {...rowProps}
                              title={title}
                              detail={session.cwd}
                              status={{
                                label:
                                  session.status === 'exited'
                                    ? 'Exited'
                                    : session.shellState === 'command'
                                      ? 'Running'
                                      : 'Ready',
                                tone: session.status === 'exited' ? 'neutral' : 'success',
                              }}
                              leadingIcon={
                                bells[session.id] ? (
                                  <ExclamationCircleIcon className="w-3.5 h-3.5" />
                                ) : undefined
                              }
                              selection={{
                                kind: 'tab',
                                selected: session.id === activeId,
                                tabIndex: session.id === activeId ? 0 : -1,
                              }}
                              primaryTitle={`${session.cwd}\nPID ${session.pid}${session.shellState === 'command' ? `\n${session.commands.at(-1)?.command ?? 'Running'}` : ''}${bells[session.id] ? '\nTerminal bell' : ''}`}
                              onActivate={activate}
                              onPrimaryKeyDown={navigate}
                              onPrimaryDoubleClick={rename}
                              actions={[
                                {
                                  id: 'move-to-tab',
                                  label: 'Move terminal to tab',
                                  icon: <MoveToTabIcon className="w-3.5 h-3.5" />,
                                  onInvoke: () => moveToNewTab(session.id),
                                },
                                {
                                  id: 'close',
                                  label: `Close terminal ${session.title}`,
                                  icon: <CloseIcon className="w-3.5 h-3.5" />,
                                  onInvoke: () => void close(session.id),
                                },
                              ]}
                            />
                          );
                        }
                        return (
                          <div
                            key={session.id}
                            {...rowProps}
                            className="dnaforge-terminal-tab-row wp-interactive"
                            data-interaction-group="true"
                            onClick={(event) => {
                              if (event.target === event.currentTarget) activateSession(session.id);
                            }}
                          >
                            <button
                              className="wp-interactive"
                              role="tab"
                              tabIndex={session.id === activeId ? 0 : -1}
                              aria-selected={session.id === activeId}
                              title={`${session.cwd}\nPID ${session.pid}`}
                              onClick={activate}
                              onKeyDown={navigate}
                              onDoubleClick={rename}
                            >
                              <span
                                className="dnaforge-terminal-session-dot"
                                data-status={session.status}
                                aria-hidden="true"
                              />
                              {session.status === 'exited'
                                ? session.exitCode === null
                                  ? 'Stopped '
                                  : `(${session.exitCode}) `
                                : ''}
                              <span className="dnaforge-terminal-session-label">
                                <span>{session.title}</span>
                              </span>
                            </button>
                            {bells[session.id] && (
                              <span
                                role="img"
                                aria-label="Terminal bell"
                                title="Terminal bell"
                                className="dnaforge-terminal-tab-bell"
                              >
                                <ExclamationCircleIcon className="w-3.5 h-3.5" />
                              </span>
                            )}
                            <button
                              className="wp-interactive"
                              aria-label={`Close terminal ${session.title}`}
                              onClick={() => void close(session.id)}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </SessionList>
                {!workspace && (
                  <button
                    aria-label="New terminal"
                    title="New session"
                    className="wp-interactive dnaforge-terminal-new-tab"
                    disabled={busy}
                    onClick={() => void create()}
                  >
                    <PlusIcon />
                  </button>
                )}
                {workspace && !groups.length && (
                  <p className={UI_NAVIGATION_EMPTY_CLASS}>
                    No terminals here. Use + to start a session.
                  </p>
                )}
              </div>
            </TerminalGroupHost>
          </div>
          {renaming && surfaceOpen && (
            <form
              className="dnaforge-terminal-toolbar"
              onSubmit={(event) => {
                event.preventDefault();
                void port
                  .rename(renaming, name.trim() || null)
                  .then(() => setRenaming(null))
                  .catch(report);
              }}
            >
              <input
                aria-label="Terminal name"
                placeholder="Automatic name"
                title="Leave blank to use automatic name"
                value={name}
                maxLength={128}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              <button className="wp-interactive" type="submit">
                Rename
              </button>
              <button className="wp-interactive" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          )}
          {surfaceOpen && active && (
            <div className="dnaforge-terminal-status">
              <span title={active.cwd}>{active.cwd}</span>
              <span>{active.integration ? 'Shell integration' : active.status}</span>
              <span>
                {active.cols} × {active.rows}
              </span>
            </div>
          )}
          {contextMenu && (
            <TerminalContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={closeContextMenu}
              actions={[
                {
                  id: 'rename',
                  label: 'Rename terminal',
                  run: () => {
                    setRenaming(contextMenu.id);
                    setName(sessionMap.get(contextMenu.id)?.title ?? '');
                  },
                },
                {
                  id: 'automatic-name',
                  label: 'Use automatic name',
                  run: () => {
                    void port.rename(contextMenu.id, null).catch(report);
                  },
                },
                {
                  id: 'copy',
                  label: 'Copy terminal selection',
                  disabled: !handles.current.get(contextMenu.id)?.terminal.hasSelection(),
                  run: () => {
                    void handles.current.get(contextMenu.id)?.copy().catch(report);
                  },
                },
                {
                  id: 'paste',
                  label: 'Paste into terminal',
                  disabled:
                    sessions.find((session) => session.id === contextMenu.id)?.status !== 'running',
                  run: () => {
                    void handles.current.get(contextMenu.id)?.paste().catch(report);
                  },
                },
                {
                  id: 'complete',
                  label: 'Suggest completion',
                  disabled: sessionMap.get(contextMenu.id)?.shellState !== 'prompt',
                  run: () => handles.current.get(contextMenu.id)?.complete(),
                },
                {
                  id: 'select-all',
                  label: 'Select all terminal text',
                  run: () => handles.current.get(contextMenu.id)?.terminal.selectAll(),
                },
                {
                  id: 'clear',
                  label: 'Clear terminal buffer',
                  run: () => {
                    void port.clear(contextMenu.id).catch(report);
                  },
                },
                {
                  id: 'output',
                  label: 'View terminal output',
                  run: () => showOutput(contextMenu.id),
                },
                {
                  id: 'dimensions',
                  label: 'Set fixed terminal dimensions',
                  run: () => setDimensionsId(contextMenu.id),
                },
                {
                  id: 'open-link',
                  label: 'Open detected link',
                  run: () => handles.current.get(contextMenu.id)?.openLinks(),
                },
                {
                  id: 'content-width',
                  label: 'Toggle size to content width',
                  run: () => {
                    void handles.current.get(contextMenu.id)?.toggleContentWidth().catch(report);
                  },
                },
                {
                  id: 'split',
                  label: 'Split terminal',
                  run: () => {
                    void create(true, undefined, contextMenu.id);
                  },
                },
                {
                  id: 'unsplit',
                  label: 'Unsplit terminal',
                  disabled:
                    (groups.find((group) => group.sessions.includes(contextMenu.id))?.sessions
                      .length ?? 0) < 2,
                  run: () => unsplit(contextMenu.id),
                },
                ...groups
                  .filter((group) => !group.sessions.includes(contextMenu.id))
                  .map((group, index) => ({
                    id: `move-group:${group.id}`,
                    label: `Move terminal to group ${index + 1}: ${sessionMap.get(group.sessions[0]!)?.title ?? 'Terminal'}`,
                    run: () =>
                      movePane(contextMenu.id, group.sessions[group.sessions.length - 1]!, 'after'),
                  })),
                {
                  id: 'relaunch',
                  label: 'Relaunch terminal',
                  run: () => {
                    void relaunch(contextMenu.id);
                  },
                },
                {
                  id: 'move-tab',
                  label: 'Move to new terminal tab',
                  disabled: Boolean(floatingGroupId),
                  run: () => moveToNewTab(contextMenu.id),
                },
                {
                  id: 'move-editor',
                  label: 'Move terminal to editor',
                  disabled: Boolean(floatingGroupId),
                  run: () => moveToEditor(contextMenu.id),
                },
                {
                  id: 'move-window',
                  label: 'Move terminal to new window',
                  run: () => {
                    void moveToWindow();
                  },
                },
                {
                  id: 'close',
                  label: 'Close terminal',
                  run: () => {
                    void close(contextMenu.id);
                  },
                },
              ]}
            />
          )}
          {outputView && (
            <TerminalOutputView
              text={outputView.text}
              onClose={closeOutput}
              onCopy={() => {
                void platform().clipboard.writeText(outputView.text).catch(report);
              }}
            />
          )}
          {dimensionsId && (
            <TerminalDimensions
              key={dimensionsId}
              value={sessionMap.get(dimensionsId)?.fixedDimensions}
              onApply={(dimensions) => port.setFixedDimensions(dimensionsId, dimensions)}
              onClose={() => {
                setDimensionsId(null);
                safeFocus(handles.current.get(dimensionsId)?.terminal.textarea, {
                  preventScroll: true,
                });
              }}
            />
          )}
        </section>
      </TerminalGroupHost>
    );
  };
  return (
    <>
      {renderWorkspace(PANEL_VIEW_ID, panelGroups)}
      {[...editorViews].map(([viewId, groups]) =>
        renderWorkspace(viewId, groups, editorTargets[viewId])
      )}
      <div hidden>
        {sessions.map((session) => {
          const group = groups.find((item) => item.sessions.includes(session.id));
          return (
            <TerminalGroupHost
              key={session.id}
              target={paneTargets[session.id]}
              visible={Boolean(paneTargets[session.id])}
            >
              <TerminalPane
                id={session.id}
                cwd={session.cwd}
                shellPath={session.shellPath}
                userHome={session.userHome}
                port={port}
                appearance={appearance}
                active={
                  session.id === activeId &&
                  (group?.placement === 'editor'
                    ? Boolean(editorTargets[terminalGroupViewId(group)]?.active)
                    : open)
                }
                onReady={ready}
                onError={report}
                onOpenDocument={() => {
                  if (workspaceNavigation.current.workspaceActive) setOpen(false);
                }}
                onFocus={(id) => {
                  clearBell(id);
                  setActiveId(id);
                  if (group) {
                    const viewId =
                      group.placement === 'editor' ? terminalGroupViewId(group) : PANEL_VIEW_ID;
                    setActiveByView((current) => ({ ...current, [viewId]: id }));
                    setUiViewId(viewId);
                  }
                  if (group?.placement === 'editor') {
                    setOpen(false);
                    editorTargets[terminalGroupViewId(group)]?.focus();
                  }
                }}
                onNavigate={navigatePane}
                onNavigateGroup={navigateGroup}
                onSplit={(id) => void create(true, undefined, id)}
                onHistory={(id, kind) => setHistoryTarget({ id, kind })}
                onResize={resizeFocusedTerminal}
                onMove={movePane}
                direction={group?.direction ?? 'horizontal'}
                onContextMenu={showContextMenu}
                running={session.status === 'running'}
                canSuggest={
                  session.status === 'running' &&
                  session.integration &&
                  session.shellState === 'prompt'
                }
                fixedDimensions={session.fixedDimensions}
                onBell={ring}
                bell={Boolean(bells[session.id])}
              />
            </TerminalGroupHost>
          );
        })}
      </div>
    </>
  );
}
