import { userMessage } from '@waypoint/user-messages';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from './test-db';

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
  showItemInFolder: vi.fn(),
  getDb: vi.fn(),
  getDirtyState: vi.fn(),
  listScientificRecoveryCheckpoints: vi.fn(),
  createScientificLegacyRecovery: vi.fn(),
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: mocks.showMessageBox,
    showOpenDialog: mocks.showOpenDialog,
  },
  shell: { showItemInFolder: mocks.showItemInFolder },
}));
vi.mock('../ipc/database', () => ({ getDb: mocks.getDb }));
vi.mock('../dirty-state-cache', () => ({ getDirtyState: mocks.getDirtyState }));
vi.mock('../scientific-migration-recovery', () => ({
  listScientificRecoveryCheckpoints: mocks.listScientificRecoveryCheckpoints,
  createScientificLegacyRecovery: mocks.createScientificLegacyRecovery,
}));

import { showScientificStorageRecovery } from '../scientific-recovery-ui';

describe('native scientific storage recovery entry', () => {
  let db: Database.Database;
  const window = {} as BrowserWindow;
  const baseline = { id: 'before-enrollment', kind: 'pre-enrollment', createdAt: 1791800000000 };
  const recovered = {
    directory: '/recovery/isolated',
    projectPath: '/recovery/isolated/legacy/project',
    profilePath: '/recovery/isolated/legacy/profile',
    sourceCheckpointId: baseline.id,
    preservedCurrentCheckpointId: 'preserved-current',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    db = createTestDb();
    db.exec(`CREATE TABLE workspaces (
      id INTEGER PRIMARY KEY, name TEXT, path TEXT,
      archived_at INTEGER, trashed_at INTEGER
    );
    INSERT INTO workspaces VALUES (7, 'Active project', '/projects/active', NULL, NULL);
    INSERT INTO workspaces VALUES (8, 'Unenrolled project', '/projects/legacy', NULL, NULL);
    INSERT INTO workspaces VALUES (9, 'Archived project', '/projects/archived', 1, NULL);`);
    mocks.getDb.mockReturnValue(db);
    mocks.getDirtyState.mockReturnValue({ hasDirtyWork: false, details: '' });
    mocks.listScientificRecoveryCheckpoints.mockImplementation(
      async (_db: Database.Database, workspaceId: number) => (workspaceId === 7 ? [baseline] : [])
    );
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/projects/active'] });
    mocks.createScientificLegacyRecovery.mockResolvedValue(recovered);
  });

  afterEach(() => db.close());

  it('lists eligible projects and resolves the selected native root through the current database', async () => {
    await showScientificStorageRecovery(window);
    expect(mocks.getDb).toHaveBeenCalledWith({ interactive: false });
    const scope = mocks.showMessageBox.mock.calls[0]![1];
    expect(scope.detail).toContain('Active project');
    expect(scope.detail).toContain('/projects/active');
    expect(scope.detail).not.toContain('Unenrolled project');
    expect(scope.detail).not.toContain('Archived project');
    expect(mocks.listScientificRecoveryCheckpoints).not.toHaveBeenCalledWith(db, 9);
    expect(mocks.createScientificLegacyRecovery).toHaveBeenCalledWith({
      db,
      workspaceId: 7,
      checkpointId: baseline.id,
      beforeSnapshot: expect.any(Function),
    });
    const summary = mocks.showMessageBox.mock.calls.at(-1)![1];
    expect(summary.detail).toContain(recovered.projectPath);
    expect(summary.detail).toContain(recovered.profilePath);
    expect(summary.detail).toContain('original project');
    expect(summary.buttons).toContain('Reveal Recovery Copy');
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(recovered.directory);
    expect(db.prepare('SELECT count(*) AS count FROM workspaces').get()).toEqual({ count: 3 });
  });

  it('refuses unsaved work without offering to discard it', async () => {
    mocks.getDirtyState.mockReturnValue({
      hasDirtyWork: true,
      details: 'a sequence and a notebook',
    });
    await showScientificStorageRecovery(window);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: 'Save your changes before creating a recovery copy.',
        detail: expect.stringContaining('a sequence and a notebook'),
        buttons: ['Close'],
      })
    );
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
  });

  it('rechecks unsaved work after the user confirms recovery', async () => {
    mocks.showMessageBox.mockImplementation(async (_window, options) => {
      if (options.buttons?.includes('Create Recovery Copy')) {
        mocks.getDirtyState.mockReturnValue({ hasDirtyWork: true, details: 'a new primer' });
      }
      return { response: 0 };
    });
    await showScientificStorageRecovery(window);
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ detail: expect.stringContaining('a new primer') })
    );
  });

  it('supplies the saved-state guard to the fenced core snapshot', async () => {
    mocks.createScientificLegacyRecovery.mockImplementationOnce(async (input) => {
      mocks.getDirtyState.mockReturnValue({
        hasDirtyWork: true,
        details: 'an edit while recovery was waiting',
      });
      input.beforeSnapshot();
      return recovered;
    });
    await showScientificStorageRecovery(window);
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({
        message: 'Recovery copy was not created.',
        detail: expect.stringContaining('an edit while recovery was waiting'),
      })
    );
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it.each(['scope', 'directory', 'confirmation'])(
    'cancels at %s without creating a copy',
    async (stage) => {
      if (stage === 'scope') mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
      if (stage === 'directory')
        mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
      if (stage === 'confirmation') {
        mocks.showMessageBox
          .mockResolvedValueOnce({ response: 0 })
          .mockResolvedValueOnce({ response: 1 });
      }
      await showScientificStorageRecovery(window);
      expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
      expect(mocks.showMessageBox.mock.calls[0]![1].message).toBe(
        'Create a separate copy from before scientific storage was enabled.'
      );
      expect(mocks.showMessageBox).toHaveBeenCalledTimes(stage === 'confirmation' ? 2 : 1);
      expect(mocks.showOpenDialog).toHaveBeenCalledTimes(stage === 'scope' ? 0 : 1);
    }
  );

  it.each(['/projects/unowned', '/projects/legacy', '/projects/archived'])(
    'refuses a selected directory without an active checkpoint owner: %s',
    async (root) => {
      mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [root] });
      await showScientificStorageRecovery(window);
      expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
      expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
        window,
        expect.objectContaining({ type: 'error', message: 'Recovery copy was not created.' })
      );
      expect(mocks.showMessageBox.mock.calls.at(-1)![1].detail).toBe(
        'Choose an active project folder from the list of projects with recovery checkpoints.'
      );
    }
  );

  it('refuses ambiguous ownership of a selected project root', async () => {
    db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, NULL, NULL)').run(
      10,
      'Alias',
      '/projects/active'
    );
    await showScientificStorageRecovery(window);
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ detail: userMessage('recovery.ambiguousProject') })
    );
  });

  it('does not substitute a later preservation checkpoint for the enrollment baseline', async () => {
    mocks.listScientificRecoveryCheckpoints.mockResolvedValue([
      { id: 'after-enrollment', kind: 'pre-recovery', createdAt: baseline.createdAt + 1 },
    ]);
    await showScientificStorageRecovery(window);
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenCalledWith(
      window,
      expect.objectContaining({
        message: 'No scientific storage recovery checkpoint is available.',
      })
    );
  });

  it('refuses a changed database owner while the dialogs are open', async () => {
    mocks.showOpenDialog.mockImplementationOnce(async () => {
      mocks.getDb.mockReturnValue({});
      return { canceled: false, filePaths: ['/projects/active'] };
    });
    await showScientificStorageRecovery(window);
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ detail: userMessage('recovery.dataChanged') })
    );
  });

  it('shows a failed recovery and allows another attempt without revealing a nonexistent copy', async () => {
    mocks.createScientificLegacyRecovery.mockRejectedValueOnce(
      new Error('Checkpoint digest does not match.')
    );
    await showScientificStorageRecovery(window);
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({ type: 'error', detail: userMessage('recovery.failed') })
    );
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
    await showScientificStorageRecovery(window);
    expect(mocks.createScientificLegacyRecovery).toHaveBeenCalledTimes(2);
  });

  it('does not start a second recovery while the first native dialog is open', async () => {
    let finishDialog!: (value: { response: number }) => void;
    mocks.showMessageBox.mockImplementationOnce(
      () =>
        new Promise<{ response: number }>((resolve) => {
          finishDialog = resolve;
        })
    );
    const first = showScientificStorageRecovery(window);
    await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
    expect(mocks.showMessageBox.mock.calls[0]![1].message).toBe(
      'Create a separate copy from before scientific storage was enabled.'
    );
    await showScientificStorageRecovery(window);
    finishDialog({ response: 1 });
    await first;
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.createScientificLegacyRecovery).not.toHaveBeenCalled();
  });

  it('reports a completed copy accurately if revealing it fails', async () => {
    mocks.showItemInFolder.mockImplementationOnce(() => {
      throw new Error('Finder unavailable.');
    });
    await showScientificStorageRecovery(window);
    expect(mocks.showMessageBox).toHaveBeenLastCalledWith(
      window,
      expect.objectContaining({
        message: 'The recovery copy was created, but could not be shown.',
        detail: expect.stringContaining(recovered.directory),
      })
    );
    expect(mocks.createScientificLegacyRecovery).toHaveBeenCalledTimes(1);
  });
});
