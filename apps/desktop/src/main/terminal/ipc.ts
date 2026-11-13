import {
  app,
  clipboard,
  safeStorage,
  webContents,
  type IpcMainInvokeEvent,
  type WebPreferences,
} from 'electron';
import { join } from 'node:path';
import { handleGroup, mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { parseTerminalRuntimePolicy } from '../../shared/terminal-runtime-policy';
import { assertTerminalSender } from './trusted-sender';
import { getDb } from '../ipc/database';
import { TerminalService } from './terminal-service';
import { TerminalHistory } from './history';
import { TerminalSessionCheckpoint } from './session-storage';
import { TerminalWindows } from './terminal-windows';
import { TerminalKeyboardFocus } from './keyboard-focus';
import { TerminalClipboard } from './clipboard';
import { TerminalFileSearch } from './file-search';
import { assertSafePath } from '../ipc/path-allowlist';
import type {
  TerminalFileSearchRequest,
  TerminalFileSearchResult,
} from '../../shared/terminal-ipc';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { terminalContract } from '../../shared/ipc/terminal.contract';

export interface TerminalWorkspaceAccess {
  roots(): readonly string[];
  capture(root: string): () => void;
}

let service: TerminalService | null = null;
let shutdown: (() => Promise<void>) | null = null;

export function registerTerminalIpc(
  trustedRendererUrl: () => string | null,
  isPrimaryOwner: (id: number) => boolean,
  preload: () => Pick<WebPreferences, 'preload' | 'additionalArguments'>,
  workspaceAccess?: TerminalWorkspaceAccess
): void {
  const watched = new Set<number>();
  const restored = new Map<number, Promise<void>>();
  const projectRoot = (path: string): string => {
    const root = workspaceAccess
      ?.roots()
      .filter((root) => isPathInsideBoundary(path, root))
      .sort((a, b) => b.length - a.length)[0];
    if (!root) throw new Error('Terminal filename search requires an open project folder.');
    return root;
  };
  const fileSearch = new TerminalFileSearch({
    admitRoot: async (path) => {
      const canonical = await assertSafePath(path, { requireAbsolute: true });
      projectRoot(canonical);
      return canonical;
    },
    captureRoot: (path) => {
      if (!workspaceAccess)
        throw new Error('Terminal filename search requires an open project folder.');
      return workspaceAccess.capture(projectRoot(path));
    },
  });
  const statePath = join(app.getPath('userData'), 'terminal-sessions.v1.json');
  const readSetting = (key: string): string | undefined =>
    (
      getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  const writeSetting = (key: string, value: string): void => {
    getDb()
      .prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
      )
      .run(key, value, Date.now());
  };
  let runtimePolicy = parseTerminalRuntimePolicy({});
  try {
    const savedPolicy = readSetting('terminal.runtime.v1');
    if (savedPolicy) runtimePolicy = parseTerminalRuntimePolicy(JSON.parse(savedPolicy));
  } catch {
    console.warn('[terminal] Saved terminal policy could not be loaded; defaults apply.');
  }
  const encryption = {
    isEncryptionAvailable: async () =>
      (await safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: (text: string) => safeStorage.encryptStringAsync(text),
    decryptString: async (bytes: Buffer) => (await safeStorage.decryptStringAsync(bytes)).result,
  };
  const savedCheckpoint = new TerminalSessionCheckpoint(statePath, encryption);
  const clearCheckpoint = () => savedCheckpoint.discard();
  if (!runtimePolicy.persistSessions) clearCheckpoint();
  let persistentOwner: number | null = null;
  let stopping = false;
  let checkpoint: ReturnType<typeof setTimeout> | null = null;
  let saveQueue = Promise.resolve();
  const save = (id: number) => {
    saveQueue = saveQueue
      .then(async () => {
        if (!runtimePolicy.persistSessions) {
          clearCheckpoint();
          return;
        }
        const owners = [id, ...terminalWindows.owners(id)];
        const entries = (
          await Promise.all(
            owners.map(async (owner) => {
              const entries = await terminals.captureSessions(owner);
              const windowGroup = terminalWindows.group(owner);
              return entries.map((entry) => ({
                ...entry,
                ...(windowGroup ? { windowGroup } : {}),
              }));
            })
          )
        ).flat();

        if (runtimePolicy.persistSessions) await savedCheckpoint.write(entries);
        else clearCheckpoint();
      })
      .catch((error: unknown) => console.error('[terminal] Session checkpoint failed', error));
    return saveQueue;
  };
  const schedule = (id: number) => {
    if (
      stopping ||
      !runtimePolicy.persistSessions ||
      checkpoint ||
      terminalWindows.root(id) !== persistentOwner ||
      webContents.fromId(id)?.isDestroyed() !== false
    )
      return;
    checkpoint = setTimeout(() => {
      checkpoint = null;
      if (persistentOwner !== null) void save(persistentOwner);
    }, 2000);
    checkpoint.unref();
  };
  const history = new TerminalHistory(
    {
      read: () => {
        const row = getDb()
          .prepare('SELECT value FROM settings WHERE key=?')
          .get('terminal.history.v1') as { value: string } | undefined;
        return row?.value;
      },
      write: (value) => {
        getDb()
          .prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
          )
          .run('terminal.history.v1', value, Date.now());
      },
    },
    undefined,
    runtimePolicy.historyLimit
  );
  history.setLimit(runtimePolicy.historyLimit);
  const terminals = new TerminalService({
    history,
    runtimePolicy,
    integrationRoot: app.isPackaged
      ? join(process.resourcesPath, 'terminal-shell-integration')
      : join(__dirname, '../../resources/terminal-shell-integration'),
    emit: (owner, event) => {
      if (event.kind === 'removed') for (const id of event.ids) fileSearch.release(owner, id);
      if (event.kind === 'removed') for (const id of event.ids) terminalClipboard.clear(owner, id);
      if (event.kind === 'removed') for (const id of event.ids) keyboardFocus.clear(owner, id);
      if (event.kind === 'changed' && event.session.status === 'exited')
        keyboardFocus.clear(owner, event.session.id);
      const target = webContents.fromId(owner);
      if (target && !target.isDestroyed()) sendRendererIpc(target, 'terminal:event', event);
    },
    onChanged: schedule,
  });
  const keyboardFocus = new TerminalKeyboardFocus(
    (id) => webContents.fromId(id),
    (owner, id) => terminals.list(owner).some((session) => session.id === id)
  );
  const terminalWindows = new TerminalWindows({
    terminals,
    trustedRendererUrl,
    primaryOwner: () => persistentOwner,
    preload,
    stopping: () => stopping,
    changed: schedule,
  });
  service = terminals;
  try {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key=?')
      .get('terminal.profiles.v1') as { value: string } | undefined;
    if (row) terminals.configureProfiles(JSON.parse(row.value));
  } catch {
    console.warn(
      '[terminal] Saved profiles could not be loaded; detected shells remain available.'
    );
  }
  const owner = (event: IpcMainInvokeEvent): number => {
    assertTerminalSender(event, trustedRendererUrl());
    const sender = event.sender;
    if (!watched.has(sender.id)) {
      watched.add(sender.id);
      sender.once('destroyed', () => {
        fileSearch.release(sender.id);
        terminalClipboard.clear(sender.id);
        keyboardFocus.clear(sender.id);
        terminalWindows.release(sender.id);
        if (persistentOwner === sender.id && !stopping) {
          if (terminalWindows.owners(sender.id).length === 0) persistentOwner = null;
          if (checkpoint) clearTimeout(checkpoint);
          checkpoint = null;
          void save(sender.id).finally(() => terminals.closeOwner(sender.id));
        } else terminals.closeOwner(sender.id);
        restored.delete(sender.id);
        watched.delete(sender.id);
      });
      const detach = () => {
        fileSearch.release(sender.id);
        terminalClipboard.clear(sender.id);
        keyboardFocus.clear(sender.id);
        terminals.detachOwner(sender.id);
      };
      sender.on('did-start-loading', detach);
      sender.on('render-process-gone', detach);
    }
    return sender.id;
  };
  const terminalClipboard = new TerminalClipboard(terminals, () => clipboard.readText());
  const ready = async (event: IpcMainInvokeEvent) => {
    const id = owner(event);
    if (isPrimaryOwner(id) && !restored.has(id)) {
      persistentOwner = id;
      const restoration = Promise.resolve().then(async () => {
        try {
          await savedCheckpoint.restore(async (saved) => {
            await terminals.restoreSessions(id, saved);
            const windows = new Map<string, string[]>();
            for (const entry of saved)
              if (entry.windowGroup) {
                const ids = windows.get(entry.windowGroup) ?? [];
                ids.push(entry.session.id);
                windows.set(entry.windowGroup, ids);
              }
            for (const [groupId, ids] of windows) await terminalWindows.move(id, ids, groupId);
          });
        } catch (error) {
          console.error('[terminal] Saved sessions could not be loaded', error);
        }
      });
      restored.set(id, restoration);
    }
    await restored.get(id);
    return id;
  };
  shutdown = async () => {
    if (stopping) return;
    stopping = true;
    for (const id of watched) fileSearch.release(id);
    if (checkpoint) clearTimeout(checkpoint);
    checkpoint = null;
    if (persistentOwner !== null) {
      await restored.get(persistentOwner);
      await save(persistentOwner);
    } else await saveQueue;
    await terminals.dispose();
  };
  mainIpc.handle('terminal:focus', (event, id) => keyboardFocus.focus(owner(event), id));
  mainIpc.handle(
    'terminal:paste',
    async (event, id: string, warnMultiline: boolean): Promise<string> => {
      const ownerId = owner(event);
      const frame = event.senderFrame;

      const active: unknown = await event.sender.executeJavaScriptInIsolatedWorld(
        999,
        [{ code: 'navigator.userActivation.isActive' }],
        false
      );
      if (active !== true || event.senderFrame !== frame)
        throw new Error('Terminal paste requires a user gesture.');
      owner(event);
      return terminalClipboard.request(ownerId, id, warnMultiline);
    }
  );
  let policyQueue = Promise.resolve();
  handleGroup(terminalContract, {
    complete: (event, id, requestId) => terminals.complete(owner(event), id, requestId),
    cancelCompletions: (event, requestId) => terminals.cancelCompletions(owner(event), requestId),
    commitCompletion: (event, id, token) => terminals.commitCompletion(owner(event), id, token),
    preparePortRelease: (event, id, commandId, port) =>
      terminals.preparePortRelease(owner(event), id, commandId, port),
    releasePort: (event, id, token) => terminals.releasePort(owner(event), id, token),
    closeStatus: (event, id) => terminals.closeStatus(owner(event), id),
    runtimePolicy: (event) => {
      owner(event);
      return { ...runtimePolicy };
    },
    configureRuntimePolicy: (event, input) => {
      owner(event);
      const next = parseTerminalRuntimePolicy(input);
      const update = policyQueue.then(async () => {
        writeSetting('terminal.runtime.v1', JSON.stringify(next));
        runtimePolicy = next;
        terminals.configureRuntimePolicy(next);
        history.setLimit(next.historyLimit);
        if (!next.persistSessions) {
          if (checkpoint) clearTimeout(checkpoint);
          checkpoint = null;
          await saveQueue;
          clearCheckpoint();
        } else if (persistentOwner !== null) schedule(persistentOwner);
        return { ...runtimePolicy };
      });
      policyQueue = update.then(
        () => undefined,
        () => undefined
      );
      return update;
    },
    profiles: (event) => {
      owner(event);
      return terminals.getProfiles();
    },
    profileConfiguration: (event) => {
      owner(event);
      return terminals.getProfileConfiguration();
    },
    configureProfiles: (event, configuration) => {
      owner(event);
      const previous = terminals.getProfileConfiguration();
      terminals.configureProfiles(configuration);
      try {
        getDb()
          .prepare(
            'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
          )
          .run(
            'terminal.profiles.v1',
            JSON.stringify(terminals.getProfileConfiguration()),
            Date.now()
          );
      } catch (error) {
        terminals.configureProfiles(previous);
        throw error;
      }
    },
    list: async (event) => terminals.list(await ready(event)),
    history: (event, id) => terminals.history(owner(event), id),
    commandOutput: (event, id, commandId) => terminals.commandOutput(owner(event), id, commandId),
    create: async (event, request) => terminals.create(await ready(event), request),
    relaunch: (event, id) => terminals.relaunch(owner(event), id),
    clear: (event, id) => terminals.clear(owner(event), id),
    setFixedDimensions: (event, id, dimensions) =>
      terminals.setFixedDimensions(owner(event), id, dimensions),
    moveToWindow: async (event, ids, groupId) =>
      terminalWindows.move(await ready(event), ids, groupId),
    returnToMainWindow: (event) => terminalWindows.returnToMain(owner(event)),
    attach: (event, id) => terminals.attach(owner(event), id),
    detach: (event, id, attachmentId) => terminals.detach(owner(event), id, attachmentId),
    write: (event, id, data, mode) => terminals.write(owner(event), id, data, mode),
    commitPaste: (event, id: string, token: string): Promise<boolean> =>
      terminalClipboard.commit(owner(event), id, token),
    findFiles: (
      event,
      id: string,
      request: TerminalFileSearchRequest
    ): Promise<TerminalFileSearchResult> => {
      const ownerId = owner(event);
      terminals.assertOwner(ownerId, id);
      return fileSearch.find(ownerId, id, request);
    },
    cancelFileSearch: (event, requestId: string): void =>
      fileSearch.cancel(owner(event), requestId),
    confirmPaste: (event, id: string, token: string, accept: boolean): void =>
      terminalClipboard.confirm(owner(event), id, token, accept),
    resize: (event, id, cols, rows) => terminals.resize(owner(event), id, cols, rows),
    acknowledge: (event, id, attachmentId, sequence) =>
      terminals.acknowledge(owner(event), id, attachmentId, sequence),
    rename: (event, id, title) => terminals.rename(owner(event), id, title),
    close: async (event, id) => {
      const ownerId = owner(event);
      terminals.close(ownerId, id);
      if (ownerId === persistentOwner) await save(ownerId);
    },
  });
}

export async function shutdownTerminalSessions(): Promise<void> {
  await shutdown?.();
}

export function stopTerminalSessions(): void {
  void service?.dispose().catch((error: unknown) => {
    console.error('[terminal] final shutdown failed', error);
  });
}
