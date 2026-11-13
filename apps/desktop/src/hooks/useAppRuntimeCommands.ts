import { useDocumentSaveCommand } from '../shared/use-document-lifecycle';
import { userMessageWithValues, userMessageValue, userMessage } from '@waypoint/user-messages';
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { ActivityView } from '../components/ActivityBar';
import type { SettingsPanelFocusTarget } from '../components/SettingsPanel';
import type { OpenWorkspaceOptions, WorkspaceSource } from '../features/workspace-loader/types';
import { useCanvasStore } from '../features/canvas';
import { getTabTypeForFile } from '../utils/fileTypes';
import { useKeyboard } from '../shared/hooks/useKeyboard';
import {
  COMMAND_IDS,
  COMMAND_SCOPES,
  isEditableCommandTarget,
  useCommandHandler,
  useCommandRegistry,
} from '../commands';
import { platform } from '../platform';
import { isDesktopRuntime } from '../utils/environment';
import { openOrganizationsSettings } from '../features/auth/cloud-surface-store';
import { revealWorkspacePath } from '../features/workspace-loader/reveal-workspace-path';
import { listWorkspaceLibrary } from '../features/workspace-loader/workspace-library';
import { resolveSequencePackageRootForProductPath } from '../features/sequence/sequence-package-product';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { useToastStore } from '../stores/toast-store';
import { safeFocus } from '../shared/utils/safeFocus';

type AppRuntimeCommandsOptions = {
  readonly openAIChat: () => void;
  readonly openNewAIChat: () => void;
  readonly toggleSidebar: () => void;
  readonly handleOpenSettings: () => void;
  readonly setSettingsFocusTarget: Dispatch<SetStateAction<SettingsPanelFocusTarget | null>>;
  readonly handleViewChange: (view: ActivityView) => void;
  readonly handleFindInFolder: (folderPath: string) => void;
  readonly openWorkspaceSource: (
    source: WorkspaceSource,
    options?: OpenWorkspaceOptions
  ) => Promise<boolean>;
  readonly handleWebGLTraceToggle: () => void;
  readonly handleChatSnapshot: () => void;
  readonly captureSnapshot: () => void;
  readonly handleCpuProfileToggle: () => void;
  readonly setIsDevPanelOpen: Dispatch<SetStateAction<boolean>>;
  readonly devShortcutsEnabled: boolean;
};

const adjacencyGraphAvailable =
  Object.keys(import.meta.glob('../features/adjacency-graph/public/wizard.ts')).length > 0;

export function useAppRuntimeCommands({
  openAIChat,
  openNewAIChat,
  toggleSidebar,
  handleOpenSettings,
  setSettingsFocusTarget,
  handleViewChange,
  handleFindInFolder,
  openWorkspaceSource,
  handleWebGLTraceToggle,
  handleChatSnapshot,
  captureSnapshot,
  handleCpuProfileToggle,
  setIsDevPanelOpen,
  devShortcutsEnabled,
}: AppRuntimeCommandsOptions): void {
  const { dispatchCommand } = useCommandRegistry();
  useDocumentSaveCommand();

  useEffect(() => {
    if (!isDesktopRuntime() || !platform().administration) return;
    return platform().administration.onChanged((event) => {
      if (event.kind !== 'handoff') return;
      const focus: SettingsPanelFocusTarget =
        event.target.purpose === 'provider-setup'
          ? `compute-provider:${event.target.providerId}`
          : event.target.purpose === 'agent-access'
            ? 'agent-access'
            : 'account';
      setSettingsFocusTarget(focus);
      handleOpenSettings();
    });
  }, [handleOpenSettings, setSettingsFocusTarget]);

  useCommandHandler(COMMAND_IDS.appFocusCommandInput, () => {
    openAIChat();
    return true;
  });
  useCommandHandler(COMMAND_IDS.appNewChat, () => {
    openNewAIChat();
    return true;
  });
  useCommandHandler(COMMAND_IDS.appToggleSidebar, () => {
    toggleSidebar();
    return true;
  });
  useCommandHandler<{ focus?: SettingsPanelFocusTarget }>(
    COMMAND_IDS.appOpenSettings,
    ({ payload }) => {
      if (payload?.focus) setSettingsFocusTarget(payload.focus);
      handleOpenSettings();
      return true;
    }
  );
  useCommandHandler(COMMAND_IDS.appShowExplorer, () => {
    handleViewChange('files');
    return true;
  });
  useCommandHandler(COMMAND_IDS.appShowRegistry, () => {
    handleViewChange('lims');
    return true;
  });
  useCommandHandler<{ path: string; openOutsideFolder?: boolean }>(
    COMMAND_IDS.workspaceRevealPath,
    ({ payload }) => {
      if (!payload?.path) return false;
      void revealWorkspacePath(
        payload.path,
        {
          getMountedFolders: () => useWorkspaceStore.getState().folders,
          listWorkspaceLibrary,
          openWorkspaceSource,
          resolveOutsideFolder: async (targetPath) => {
            const stat = await platform().fs.stat(targetPath);
            return stat?.isDirectory ? stat.canonicalPath : null;
          },
          resolveVisibleTreePath: (targetPath) => {
            if (getTabTypeForFile(targetPath) !== 'sequence') return targetPath;
            return resolveSequencePackageRootForProductPath(targetPath).then(
              (packageRoot) => packageRoot ?? targetPath,
              () => targetPath
            );
          },
          revealPath: (targetPath) => useWorkspaceStore.getState().revealPath(targetPath),
          showExplorer: () => handleViewChange('files'),
          reportUnavailable: (targetPath) => {
            const label = targetPath.split(/[\\/]/).filter(Boolean).pop() ?? 'this item';
            useToastStore
              .getState()
              .addToast(
                userMessageWithValues(
                  'notice.couldn-t-show-value-because-its-project-is-unavailable',
                  { value0: userMessageValue(label) }
                ),
                {
                  definition: 'app-couldn-t-show-example-because-its-project-is-unavailable',
                }
              );
          },
        },
        { openOutsideFolder: payload.openOutsideFolder === true }
      ).catch((error) => {
        console.warn('[App] Failed to show path in workspace:', error);
        useToastStore
          .getState()
          .addToast(userMessage('notice.could-not-show-that-item-in-its-project'), {
            definition: 'app-could-not-show-that-item-in-its-project',
          });
      });
      return true;
    }
  );
  useCommandHandler(COMMAND_IDS.workspaceSearch, () => {
    handleViewChange('search');
    return true;
  });
  useCommandHandler<{ folderPath?: string }>(COMMAND_IDS.workspaceFindInFolder, ({ payload }) => {
    handleFindInFolder(payload?.folderPath ?? '');
    return true;
  });

  useKeyboard([
    { key: '7', cmd: true, shift: true, handler: handleWebGLTraceToggle, allowInInput: true },
    { key: '8', cmd: true, shift: true, handler: handleChatSnapshot, allowInInput: true },
    { key: '9', cmd: true, shift: true, handler: captureSnapshot, allowInInput: true },
    {
      key: '0',
      cmd: true,
      shift: true,
      handler: handleCpuProfileToggle,
      allowInInput: true,
    },
    { key: 'r', cmd: true, handler: () => window.location.reload(), allowInInput: true },
    ...(adjacencyGraphAvailable
      ? [
          {
            key: 'g',
            cmd: true,
            shift: true,
            handler: () => {
              useCanvasStore
                .getState()
                .openInFocusedPanel('adjacency-graph', 'adjacency-graph', 'Adjacency Graph');
            },
          },
        ]
      : []),
    ...(devShortcutsEnabled
      ? [{ key: '.', cmd: true, shift: true, handler: () => setIsDevPanelOpen((prev) => !prev) }]
      : []),
  ]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    const p = platform();
    const unsub0 = p.on('menu:new-chat', () => {
      dispatchCommand(COMMAND_IDS.appNewChat, {
        source: 'electron-menu',
        bypassBlockingScopes: [COMMAND_SCOPES.inputEditor],
      });
    });
    const unsub1 = p.on('menu:settings', handleOpenSettings);
    const unsubOrganizations = p.on('menu:organizations', openOrganizationsSettings);
    const unsub2 = p.on('menu:explorer', () => handleViewChange('files'));
    const unsub3 = p.on('menu:search', () => {
      dispatchCommand(COMMAND_IDS.workspaceSearch, { source: 'electron-menu' });
    });
    const unsub4 = p.on('menu:check-for-updates', () => platform().update.checkManual());
    const unsub5 = p.on('menu:close-tab', () => {
      window.dispatchEvent(new CustomEvent('waypoint:close-active-tab'));
    });
    const unsub6 = p.on('menu:reopen-closed-tab', () => {
      useCanvasStore.getState().reopenLastClosedTab();
    });
    const dispatchEditCommand = (
      command: typeof COMMAND_IDS.editUndo | typeof COMMAND_IDS.editRedo
    ) => {
      const nativeAction = command === COMMAND_IDS.editUndo ? 'undo' : 'redo';
      if (isEditableCommandTarget(document.activeElement)) {
        document.execCommand?.(nativeAction);
        return;
      }
      const result = dispatchCommand(command, { source: 'electron-menu' });
      if (!result.handled && !result.blocked) document.execCommand?.(nativeAction);
    };
    const unsubUndo = p.on('menu:undo', () => dispatchEditCommand(COMMAND_IDS.editUndo));
    const unsubRedo = p.on('menu:redo', () => dispatchEditCommand(COMMAND_IDS.editRedo));

    return () => {
      unsub0();
      unsub1();
      unsubOrganizations();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
      unsub6();
      unsubUndo();
      unsubRedo();
    };
  }, [dispatchCommand, handleOpenSettings, handleViewChange]);

  useEffect(() => {
    const handleWindowFocus = () => {
      const activeEl = document.activeElement as HTMLElement | null;
      const isInputFocused =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.tagName === 'TEXTAREA' ||
        activeEl?.isContentEditable;
      if (!isInputFocused) safeFocus(document.body);
    };
    window.addEventListener('focus', handleWindowFocus);
    return () => window.removeEventListener('focus', handleWindowFocus);
  }, []);
}
