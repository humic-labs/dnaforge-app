import type {
  WorkspaceSessionAdapter,
  WorkspaceSessionFile,
  WorkspaceSessionFileWrite,
  WorkspaceSessionPublicationCondition,
  WorkspaceSessionPrincipal,
  WorkspaceSessionRevision,
  WorkspaceSessionSnapshot,
  WorkspaceSessionWorkspace,
} from './workspace-sessions';

export type WorkspaceSessionControllerPhase =
  | 'idle'
  | 'loading-index'
  | 'loading-workspace'
  | 'opening-file'
  | 'loading-history'
  | 'committing'
  | 'restoring'
  | 'error';

export interface WorkspaceSessionOpenedFile {
  readonly file: WorkspaceSessionFile;
  readonly bytes: Uint8Array;
}

export interface WorkspaceSessionControllerState {
  readonly phase: WorkspaceSessionControllerPhase;
  readonly principal: WorkspaceSessionPrincipal | null;
  readonly workspaces: readonly WorkspaceSessionWorkspace[];
  readonly activeWorkspaceId: string | null;
  readonly snapshot: WorkspaceSessionSnapshot | null;
  readonly openFiles: readonly WorkspaceSessionOpenedFile[];
  readonly activeFilePath: string | null;
  readonly history: readonly WorkspaceSessionRevision[];
  readonly error: unknown | null;
  readonly refreshError: unknown | null;
}

const EMPTY_STATE: WorkspaceSessionControllerState = {
  phase: 'idle',
  principal: null,
  workspaces: [],
  activeWorkspaceId: null,
  snapshot: null,
  openFiles: [],
  activeFilePath: null,
  history: [],
  error: null,
  refreshError: null,
};

const MAX_CREATE_WORKSPACE_LOAD_ATTEMPTS = 3;

type FileSelectionOwner =
  | { phase: 'none' }
  | { phase: 'opening' | 'selected' | 'failed'; path: string };

export class WorkspaceSessionController {
  private state: WorkspaceSessionControllerState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private workspaceEpoch = 0;
  private historyOwner: { phase: 'idle' | 'loading' | 'ready' | 'failed' } = { phase: 'idle' };
  private fileSelection: FileSelectionOwner = { phase: 'none' };
  private readonly fileReads = new Map<string, FileSelectionOwner>();
  private commitTail: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: WorkspaceSessionAdapter) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): WorkspaceSessionControllerState => this.state;

  async initialize(preferredWorkspaceId?: string | null): Promise<void> {
    this.workspaceEpoch += 1;
    this.historyOwner = { phase: 'idle' };
    this.fileSelection = { phase: 'none' };
    this.fileReads.clear();
    const generation = ++this.generation;
    this.publish({ ...this.state, phase: 'loading-index', error: null });
    try {
      const index = await this.adapter.listWorkspaces();
      if (generation !== this.generation) return;
      const activeWorkspaceId = selectWorkspaceId(
        index.workspaces,
        preferredWorkspaceId ?? this.state.activeWorkspaceId ?? index.preferredWorkspaceId
      );
      this.publish({
        phase: activeWorkspaceId ? 'loading-workspace' : 'idle',
        principal: index.principal ?? null,
        workspaces: [...index.workspaces],
        activeWorkspaceId,
        snapshot: null,
        openFiles: [],
        activeFilePath: null,
        history: [],
        error: null,
        refreshError: null,
      });
      if (!activeWorkspaceId) return;
      await this.loadWorkspace(activeWorkspaceId, generation);
    } catch (error) {
      this.fail(error, generation);
      throw error;
    }
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    this.workspaceEpoch += 1;
    this.historyOwner = { phase: 'idle' };
    this.fileSelection = { phase: 'none' };
    this.fileReads.clear();
    const generation = ++this.generation;
    this.publish({
      ...this.state,
      phase: 'loading-workspace',
      activeWorkspaceId: workspaceId,
      snapshot: null,
      openFiles: [],
      activeFilePath: null,
      history: [],
      error: null,
    });
    try {
      await this.loadWorkspace(workspaceId, generation);
    } catch (error) {
      this.fail(error, generation);
      throw error;
    }
  }

  async peekWorkspace(workspaceId: string): Promise<WorkspaceSessionSnapshot> {
    const { snapshot, workspaces } = this.state;
    if (snapshot?.workspaceId === workspaceId) return snapshot;
    const workspace = workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    return this.adapter.loadWorkspace(workspace);
  }

  peekFile(snapshot: WorkspaceSessionSnapshot, file: WorkspaceSessionFile): Promise<Uint8Array> {
    return this.adapter.readFile({ snapshot, file });
  }

  async createWorkspace(displayName: string): Promise<WorkspaceSessionWorkspace> {
    const created = await this.adapter.createWorkspace(displayName, this.state.principal?.id);
    for (let attempt = 0; attempt < MAX_CREATE_WORKSPACE_LOAD_ATTEMPTS; attempt += 1) {
      await this.initialize(created.workspaceId);
      const state = this.state;
      if (
        state.activeWorkspaceId === created.workspaceId &&
        state.snapshot?.workspaceId === created.workspaceId &&
        state.phase === 'idle'
      ) {
        return created;
      }
    }
    throw new Error('Created workspace could not be loaded into an accepted session snapshot.');
  }

  async openFile(path: string): Promise<WorkspaceSessionOpenedFile> {
    const snapshot = this.state.snapshot;
    if (!snapshot) throw new Error('No workspace snapshot is loaded.');
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`Workspace file is unavailable: ${path}.`);
    const cached = this.state.openFiles.find(
      (candidate) =>
        candidate.file.path === path &&
        candidate.file.contentRevision === file.contentRevision &&
        candidate.file.resourceId === file.resourceId
    );
    if (cached) {
      this.fileSelection = { phase: 'selected', path };
      this.publish({
        ...this.state,
        phase: this.state.phase === 'opening-file' ? 'idle' : this.state.phase,
        activeFilePath: path,
        error: null,
      });
      return { file, bytes: cached.bytes };
    }
    const generation = this.generation;
    const owner: FileSelectionOwner = { phase: 'opening', path };
    this.fileSelection = owner;
    this.fileReads.set(path, owner);
    this.publish({ ...this.state, phase: 'opening-file', error: null });
    try {
      const opened = { file, bytes: await this.adapter.readFile({ snapshot, file }) };
      if (
        generation === this.generation &&
        this.fileReads.get(path) === owner &&
        this.state.snapshot?.revisionId === snapshot.revisionId &&
        this.state.snapshot.localRevisionId === snapshot.localRevisionId &&
        this.state.snapshot.workspaceId === snapshot.workspaceId &&
        this.state.snapshot.files.some(
          (current) =>
            current.path === path &&
            current.contentRevision === file.contentRevision &&
            current.resourceId === file.resourceId
        )
      ) {
        const activate = this.fileSelection === owner;
        if (activate) this.fileSelection = { phase: 'selected', path };
        this.publish({
          ...this.state,
          phase:
            this.state.phase === 'opening-file' && this.fileSelection.phase !== 'opening'
              ? 'idle'
              : this.state.phase,
          openFiles: [
            ...this.state.openFiles.filter((candidate) => candidate.file.path !== path),
            opened,
          ],
          activeFilePath: activate ? path : this.state.activeFilePath,
          error: activate ? null : this.state.error,
        });
      }
      return opened;
    } catch (error) {
      if (this.fileReads.get(path) === owner && this.fileSelection === owner) {
        this.fileSelection = { phase: 'failed', path };
        this.fail(error, generation);
      }
      throw error;
    } finally {
      if (this.fileReads.get(path) === owner) this.fileReads.delete(path);
    }
  }

  activateFile(path: string): void {
    if (!this.state.openFiles.some((candidate) => candidate.file.path === path)) {
      throw new Error(`Workspace file is not open: ${path}.`);
    }
    this.fileSelection = { phase: 'selected', path };
    this.publish({
      ...this.state,
      phase: this.state.phase === 'opening-file' ? 'idle' : this.state.phase,
      activeFilePath: path,
      error: null,
    });
  }

  deactivateFile(): void {
    this.fileSelection = { phase: 'none' };
    if (this.state.activeFilePath === null && this.state.phase !== 'opening-file') return;
    this.publish({
      ...this.state,
      phase: this.state.phase === 'opening-file' ? 'idle' : this.state.phase,
      activeFilePath: null,
      error: null,
    });
  }

  closeFile(path: string): void {
    this.fileReads.delete(path);
    if (this.fileSelection.phase !== 'none' && this.fileSelection.path === path) {
      this.fileSelection = { phase: 'none' };
    }
    const openFiles = this.state.openFiles.filter((candidate) => candidate.file.path !== path);
    const phase =
      this.state.phase === 'opening-file' && this.fileSelection.phase !== 'opening'
        ? 'idle'
        : this.state.phase;
    if (openFiles.length === this.state.openFiles.length && phase === this.state.phase) return;
    this.publish({
      ...this.state,
      phase,
      openFiles,
      activeFilePath:
        this.state.activeFilePath === path
          ? (openFiles[openFiles.length - 1]?.file.path ?? null)
          : this.state.activeFilePath,
      error: null,
    });
  }

  async refreshActiveWorkspace(): Promise<WorkspaceSessionSnapshot | null> {
    await this.commitTail;
    const workspaceId = this.state.activeWorkspaceId;
    if (!workspaceId) return null;
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    const generation = ++this.generation;
    this.publish({ ...this.state, phase: 'loading-workspace', error: null });
    try {
      const accepted = await this.adapter.loadWorkspace(workspace);
      if (generation !== this.generation) return accepted;
      await this.projectAcceptedSnapshot(accepted, generation, false);
      return accepted;
    } catch (error) {
      this.fail(error, generation);
      throw error;
    }
  }

  async commit(
    writes: readonly WorkspaceSessionFileWrite[],
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    removePaths?: readonly string[],
    publicationCondition?: WorkspaceSessionPublicationCondition,
    expectedSnapshot?: WorkspaceSessionSnapshot
  ): Promise<WorkspaceSessionSnapshot> {
    const workspaceId = this.state.snapshot?.workspaceId;
    if (!workspaceId) throw new Error('No workspace snapshot is loaded.');
    const workspaceEpoch = this.workspaceEpoch;
    const expectedAccountId = this.state.principal?.id;
    const pending = this.commitTail.then(() => {
      if (
        workspaceEpoch !== this.workspaceEpoch ||
        this.state.snapshot?.workspaceId !== workspaceId
      ) {
        throw new Error('Workspace changed before the queued commit could start.');
      }
      if (expectedSnapshot && this.state.snapshot !== expectedSnapshot) {
        throw new Error('Workspace changed before the prepared edit could start.');
      }
      return this.commitNow(
        writes,
        onProgress,
        removePaths,
        expectedAccountId,
        publicationCondition
      );
    });
    this.commitTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  commitWorkspaceFiles(input: {
    readonly workspaceId: string;
    readonly writes: readonly WorkspaceSessionFileWrite[];
    readonly expectedAccountId?: string;
  }): Promise<WorkspaceSessionSnapshot> {
    const expectedAccountId = input.expectedAccountId ?? this.state.principal?.id;
    const assertAccount = () => {
      if (this.state.principal?.id !== expectedAccountId) {
        throw new Error('The signed-in account changed before the project save.');
      }
    };
    const pending = this.commitTail.then(async () => {
      assertAccount();
      const snapshot = await this.peekWorkspace(input.workspaceId);
      assertAccount();
      return this.commitNow(
        input.writes,
        undefined,
        undefined,
        expectedAccountId,
        undefined,
        snapshot
      );
    });
    this.commitTail = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  private async commitNow(
    writes: readonly WorkspaceSessionFileWrite[],
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    removePaths?: readonly string[],
    expectedAccountId?: string,
    publicationCondition?: WorkspaceSessionPublicationCondition,
    workspaceSnapshot?: WorkspaceSessionSnapshot
  ): Promise<WorkspaceSessionSnapshot> {
    const snapshot = workspaceSnapshot ?? this.state.snapshot;
    if (!snapshot) throw new Error('No workspace snapshot is loaded.');
    const projectsIntoSelection =
      this.state.snapshot === snapshot && this.state.activeWorkspaceId === snapshot.workspaceId;
    const generation = projectsIntoSelection ? ++this.generation : this.generation;
    if (projectsIntoSelection) this.publish({ ...this.state, phase: 'committing', error: null });
    try {
      const accepted = await this.adapter.commit({
        snapshot,
        writes,
        onProgress,
        removePaths,
        expectedAccountId,
        ...(publicationCondition ? { publicationCondition } : {}),
      });
      if (!projectsIntoSelection || generation !== this.generation) return accepted;
      await this.projectAcceptedSnapshot(accepted, generation, true);
      return accepted;
    } catch (error) {
      if (projectsIntoSelection) this.fail(error, generation);
      throw error;
    }
  }

  async loadHistory(): Promise<readonly WorkspaceSessionRevision[]> {
    const workspaceId = this.state.activeWorkspaceId;
    if (!workspaceId) return [];
    if (!this.adapter.listHistory) throw new Error('Workspace history is unavailable.');
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    const generation = this.generation;
    const owner = { phase: 'loading' as const };
    this.historyOwner = owner;
    this.publish({ ...this.state, phase: 'loading-history', error: null });
    try {
      const history = [...(await this.adapter.listHistory(workspace))];
      if (
        generation === this.generation &&
        this.state.activeWorkspaceId === workspaceId &&
        this.historyOwner === owner
      ) {
        this.historyOwner = { phase: 'ready' };
        this.publish({
          ...this.state,
          phase: this.state.phase === 'loading-history' ? 'idle' : this.state.phase,
          history,
          error: null,
        });
      }
      return history;
    } catch (error) {
      if (this.historyOwner === owner) {
        this.historyOwner = { phase: 'failed' };
        if (this.state.phase === 'loading-history') this.fail(error, generation);
      }
      throw error;
    }
  }

  async restoreRevision(revisionId: string): Promise<WorkspaceSessionSnapshot> {
    const snapshot = this.state.snapshot;
    const workspaceId = this.state.activeWorkspaceId;
    if (!snapshot || !workspaceId) throw new Error('No workspace snapshot is loaded.');
    if (!this.adapter.restoreRevision) throw new Error('Workspace restore is unavailable.');
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    if (!this.state.history.some((revision) => revision.revisionId === revisionId)) {
      throw new Error(`Workspace revision is unavailable: ${revisionId}.`);
    }
    const generation = ++this.generation;
    this.publish({ ...this.state, phase: 'restoring', error: null });
    try {
      const accepted = await this.adapter.restoreRevision({
        workspace,
        snapshot,
        revisionId,
        expectedAccountId: this.state.principal?.id,
      });
      if (generation !== this.generation) return accepted;
      await this.projectAcceptedSnapshot(accepted, generation, true);
      return accepted;
    } catch (error) {
      this.fail(error, generation);
      throw error;
    }
  }

  reset(): void {
    this.workspaceEpoch += 1;
    this.historyOwner = { phase: 'idle' };
    this.fileSelection = { phase: 'none' };
    this.fileReads.clear();
    this.generation += 1;
    this.publish(EMPTY_STATE);
  }

  private async loadWorkspace(workspaceId: string, generation: number): Promise<void> {
    const workspace = this.state.workspaces.find(
      (candidate) => candidate.workspaceId === workspaceId
    );
    if (!workspace) throw new Error(`Workspace is unavailable: ${workspaceId}.`);
    const snapshot = await this.adapter.loadWorkspace(workspace);
    if (generation !== this.generation) return;
    this.publish({
      ...this.state,
      phase: 'idle',
      activeWorkspaceId: workspaceId,
      snapshot,
      openFiles: [],
      activeFilePath: null,
      history: [],
      error: null,
    });
  }

  private async projectAcceptedSnapshot(
    accepted: WorkspaceSessionSnapshot,
    generation: number,
    resetHistory: boolean
  ): Promise<void> {
    if (generation !== this.generation) return;
    const previousOpenFiles = this.state.openFiles;
    this.publish({ ...this.state, snapshot: accepted });
    const openFiles: WorkspaceSessionOpenedFile[] = [];
    let refreshError: unknown | null = null;
    for (const opened of previousOpenFiles) {
      const file = accepted.files.find((candidate) => candidate.path === opened.file.path);
      if (!file) continue;
      if (
        file.contentRevision === opened.file.contentRevision &&
        file.resourceId === opened.file.resourceId
      ) {
        openFiles.push({ file, bytes: opened.bytes });
        continue;
      }
      try {
        openFiles.push({ file, bytes: await this.adapter.readFile({ snapshot: accepted, file }) });
      } catch (error) {
        refreshError ??= error ?? new Error('The accepted project files could not be refreshed.');
        openFiles.push(opened);
      }
    }
    if (generation !== this.generation) return;
    this.publish({
      ...this.state,
      phase: 'idle',
      snapshot: accepted,
      ...this.reconcileOpenFiles(previousOpenFiles, openFiles),
      ...(resetHistory ? { history: [] } : {}),
      error: null,
      refreshError,
    });
  }

  private reconcileOpenFiles(
    previous: readonly WorkspaceSessionOpenedFile[],
    refreshed: readonly WorkspaceSessionOpenedFile[]
  ): Pick<WorkspaceSessionControllerState, 'openFiles' | 'activeFilePath'> {
    const openFiles = this.state.openFiles.flatMap((current) => {
      if (!previous.includes(current)) return [current];
      const updated = refreshed.find((candidate) => candidate.file.path === current.file.path);
      return updated ? [updated] : [];
    });
    const active = this.state.activeFilePath;
    const activeFilePath =
      active === null || openFiles.some((file) => file.file.path === active)
        ? active
        : (openFiles[0]?.file.path ?? null);
    return { openFiles, activeFilePath };
  }

  private fail(error: unknown, generation: number): void {
    if (generation !== this.generation) return;
    this.publish({ ...this.state, phase: 'error', error });
  }

  private publish(next: WorkspaceSessionControllerState): void {
    const stale = next.openFiles.some((opened) => {
      const accepted = next.snapshot?.files.find((file) => file.path === opened.file.path);
      return (
        accepted &&
        (accepted.contentRevision !== opened.file.contentRevision ||
          accepted.resourceId !== opened.file.resourceId)
      );
    });
    this.state = next.refreshError !== null && !stale ? { ...next, refreshError: null } : next;
    for (const listener of this.listeners) listener();
  }
}

function selectWorkspaceId(
  workspaces: readonly WorkspaceSessionWorkspace[],
  preferredWorkspaceId: string | null | undefined
): string | null {
  if (
    preferredWorkspaceId &&
    workspaces.some((workspace) => workspace.workspaceId === preferredWorkspaceId)
  ) {
    return preferredWorkspaceId;
  }
  return workspaces[0]?.workspaceId ?? null;
}
