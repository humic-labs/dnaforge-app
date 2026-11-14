import { and, eq, isNull } from 'drizzle-orm';
import { db, settings, workspaces } from '../../db';
import { platform } from '../../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../../utils/environment';
import { MOCK_WORKSPACE_PATH } from '../../utils/browser-mocks';
import { normalizePathForBoundary } from '../../shared/path-boundary';
import { soleWritableProjectRoot } from '../../shared/project-root-selection';

export const WORKSPACE_PATH_KEY = 'current_workspace_path';
export interface WorkspaceSelectionState {
  phase: 'uninitialized' | 'restoring' | 'activating' | 'clearing' | 'ready' | 'failed';
  path: string | null;
  error: string | null;
}
export interface WorkspaceActivationOptions {
  addToRecents?: boolean;
  isCurrent?: () => boolean;
}
interface Root {
  path: string;
  pinned?: boolean;
}
interface SelectionPorts {
  readState(): WorkspaceSelectionState;
  publish(state: WorkspaceSelectionState): void;
  roots(): readonly Root[];
  mount(path: string): void;
}
type SelectionOperation = { kind: 'restore' | 'activate' | 'clear'; path: string | null };

export class DesktopWorkspaceSelection {
  private operation: SelectionOperation | null = null;
  private mountRestore: object | null = null;
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly ports: SelectionPorts) {}

  beginMountRestore(): () => boolean {
    const request = {};
    this.mountRestore = request;
    return () => this.mountRestore === request;
  }

  invalidateMountRestore(): void {
    this.mountRestore = null;
  }

  private begin(kind: SelectionOperation['kind'], path: string | null): SelectionOperation {
    const operation = { kind, path };
    this.operation = operation;
    return operation;
  }

  private publish(
    phase: WorkspaceSelectionState['phase'],
    path: string | null,
    error: string | null = null
  ): void {
    this.ports.publish({ phase, path, error });
  }

  private persist(operation: SelectionOperation): Promise<void> {
    const write = this.persistence.then(async () => {
      if (this.operation !== operation) return;
      if (operation.path === null) {
        await db.delete(settings).where(eq(settings.key, WORKSPACE_PATH_KEY));
      } else {
        const updatedAt = new Date();
        await db
          .insert(settings)
          .values({ key: WORKSPACE_PATH_KEY, value: operation.path, updatedAt })
          .onConflictDoUpdate({ target: settings.key, set: { value: operation.path, updatedAt } });
      }
    });
    this.persistence = write.catch(() => {});
    return write;
  }

  async restore(force = false): Promise<void> {
    if (!force && this.ports.readState().phase !== 'uninitialized') return;
    const operation = this.begin('restore', null);
    this.publish('restoring', this.ports.readState().path);
    try {
      let path: string | null = null;
      if (isHostedBrowserRuntime()) {
        this.publish('ready', null);
        return;
      }
      if (isBrowserOnly()) path = MOCK_WORKSPACE_PATH;
      else {
        const rows = await db.select().from(settings).where(eq(settings.key, WORKSPACE_PATH_KEY));
        if (this.operation !== operation) return;
        const persisted = rows[0]?.value;
        if (persisted) {
          const owners = await db
            .select({ path: workspaces.path })
            .from(workspaces)
            .where(
              and(
                eq(workspaces.path, persisted),
                isNull(workspaces.archivedAt),
                isNull(workspaces.trashedAt)
              )
            );
          if (this.operation !== operation) return;
          path = owners.length === 1 ? owners[0].path : null;
          if (!path) await this.persist(operation);
        }
      }
      if (this.operation !== operation) return;
      if (path) this.ports.mount(path);
      this.publish('ready', path);
    } catch (error) {
      this.fail(operation, error);
    }
  }

  async activate(path: string, options: WorkspaceActivationOptions = {}): Promise<void> {
    if (options.isCurrent && !options.isCurrent()) return;
    const operation = this.begin('activate', path);
    this.publish('activating', this.ports.readState().path);
    try {
      if (options.addToRecents !== false)
        await platform().db.ensureWorkspaceOwner(path, undefined, { recordOpen: true });
      if (this.operation !== operation) return;
      if (options.isCurrent && !options.isCurrent()) {
        this.operation = null;
        this.publish('ready', this.ports.readState().path);
        return;
      }
      this.ports.mount(path);
      this.publish('activating', path);
      await this.persist(operation);
      if (this.operation === operation) this.publish('ready', path);
    } catch (error) {
      this.fail(operation, error);
      if (options.isCurrent) throw error;
    }
  }

  async clear(): Promise<void> {
    const operation = this.begin('clear', null);
    this.publish('clearing', null);
    try {
      await this.persist(operation);
      if (this.operation === operation) this.publish('ready', null);
    } catch (error) {
      this.fail(operation, error);
    }
  }

  async selectDirectory(): Promise<string | null> {
    const opening = this.operation;
    try {
      const selected = isBrowserOnly()
        ? MOCK_WORKSPACE_PATH
        : await platform().dialog.open({
            directory: true,
            multiple: false,
            title: 'Select your lab data folder',
          });
      if (opening !== this.operation || typeof selected !== 'string') return null;
      await this.activate(selected);
      const state = this.ports.readState();
      return state.phase === 'ready' && state.path === selected ? selected : null;
    } catch (error) {
      if (opening === this.operation)
        this.publish(
          'failed',
          this.ports.readState().path,
          error instanceof Error ? error.message : 'Failed to select project'
        );
      return null;
    }
  }

  async acceptMounts(preferredPath?: string): Promise<void> {
    const current = this.ports.readState().path;
    const roots = this.ports.roots();
    const contains = (path: string) => roots.some((root) => sameRoot(root.path, path));
    if (preferredPath && contains(preferredPath))
      return this.activate(preferredPath, { addToRecents: false });
    const pendingRemoved =
      this.operation?.kind === 'activate' &&
      this.operation.path !== null &&
      !contains(this.operation.path);
    if (current && contains(current)) {
      if (pendingRemoved) return this.activate(current, { addToRecents: false });
      return;
    }
    const fallback = soleWritableProjectRoot(roots)?.path;
    if (fallback) return this.activate(fallback, { addToRecents: false });
    if (current || pendingRemoved) return this.clear();
  }

  removed(path: string): void {
    const current = this.ports.readState().path;
    if (!sameRoot(current, path) && !sameRoot(this.operation?.path, path)) return;
    const roots = this.ports.roots().filter((root) => !root.pinned);
    const retained = current && roots.find((root) => sameRoot(root.path, current));
    const fallback = retained ? retained.path : roots[0]?.path;
    if (fallback) void this.activate(fallback, { addToRecents: false });
    else void this.clear();
  }

  private fail(operation: SelectionOperation, error: unknown): void {
    if (this.operation !== operation) return;
    const message = error instanceof Error ? error.message : 'Failed to update the active project';
    this.publish('failed', this.ports.readState().path, message);
    console.error('[WorkspaceSession]', error);
  }
}

function sameRoot(a: string | null | undefined, b: string): boolean {
  return Boolean(a && normalizePathForBoundary(a) === normalizePathForBoundary(b));
}
