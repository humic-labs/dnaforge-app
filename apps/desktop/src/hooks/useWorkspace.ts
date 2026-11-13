import { useState, useEffect, useCallback, useRef } from 'react';
import { db, settings, workspaces } from '../db';
import { and, eq, isNull } from 'drizzle-orm';
import { platform } from '../platform';
import { isBrowserOnly, isHostedBrowserRuntime } from '../utils/environment';
import { MOCK_WORKSPACE_PATH } from '../utils/browser-mocks';

export const WORKSPACE_PATH_KEY = 'current_workspace_path';

export interface WorkspaceState {
  path: string | null;
  loading: boolean;
  error: string | null;
}

export interface UseWorkspaceReturn extends WorkspaceState {
  selectWorkspace: () => Promise<string | null>;
  setWorkspacePath: (
    path: string,
    options?: { addToRecents?: boolean; isCurrent?: () => boolean }
  ) => Promise<void>;
  clearWorkspace: () => Promise<void>;
  refresh: () => Promise<void>;
}

type WorkspaceRequest = {
  phase: 'loading' | 'activating' | 'clearing' | 'ready' | 'error' | 'retired';
};

export function useWorkspace(): UseWorkspaceReturn {
  const requestRef = useRef<WorkspaceRequest | null>(null);
  const beginRequest = useCallback((phase: 'loading' | 'activating' | 'clearing') => {
    if (requestRef.current) requestRef.current.phase = 'retired';
    const request: WorkspaceRequest = { phase };
    requestRef.current = request;
    return request;
  }, []);
  const [state, setState] = useState<WorkspaceState>({
    path: null,
    loading: true,
    error: null,
  });

  const loadWorkspace = useCallback(async () => {
    const request = beginRequest('loading');
    const ownsRequest = () => requestRef.current === request;
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      if (isHostedBrowserRuntime()) {
        request.phase = 'ready';
        setState({ path: null, loading: false, error: null });
        return;
      }
      if (isBrowserOnly()) {
        request.phase = 'ready';
        setState({ path: MOCK_WORKSPACE_PATH, loading: false, error: null });
        return;
      }

      const result = await db.select().from(settings).where(eq(settings.key, WORKSPACE_PATH_KEY));

      if (!ownsRequest()) return;
      const persistedPath = result.length > 0 ? result[0].value : null;
      let path: string | null = null;
      if (persistedPath) {
        const activeProject = await db
          .select({ path: workspaces.path })
          .from(workspaces)
          .where(
            and(
              eq(workspaces.path, persistedPath),
              isNull(workspaces.archivedAt),
              isNull(workspaces.trashedAt)
            )
          );
        if (!ownsRequest()) return;
        path = activeProject.length === 1 ? activeProject[0].path : null;

        if (!path) {
          await db.delete(settings).where(eq(settings.key, WORKSPACE_PATH_KEY));
        }
      }

      if (!ownsRequest()) return;
      request.phase = 'ready';
      setState({
        path,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (!ownsRequest()) return;
      request.phase = 'error';
      console.error('Failed to load workspace:', error);
      if (isBrowserOnly()) {
        setState({ path: MOCK_WORKSPACE_PATH, loading: false, error: null });
        return;
      }
      setState({
        path: null,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load project',
      });
    }
  }, [beginRequest]);

  const selectWorkspace = useCallback(async (): Promise<string | null> => {
    let request = requestRef.current;
    try {
      let selected: string | null = null;

      if (isBrowserOnly()) {
        selected = MOCK_WORKSPACE_PATH;
        console.log('[Workspace] Browser mode - using mock path:', selected);
      } else {
        const result = await platform().dialog.open({
          directory: true,
          multiple: false,
          title: 'Select your lab data folder',
        });
        selected = typeof result === 'string' ? result : null;
      }

      if (requestRef.current !== request) return null;
      if (selected && typeof selected === 'string') {
        request = beginRequest('activating');
        const now = Date.now();
        await db
          .insert(settings)
          .values({
            key: WORKSPACE_PATH_KEY,
            value: selected,
            updatedAt: new Date(now),
          })
          .onConflictDoUpdate({
            target: settings.key,
            set: {
              value: selected,
              updatedAt: new Date(now),
            },
          });

        if (requestRef.current !== request) return null;
        await platform().db.ensureWorkspaceOwner(selected, undefined, { recordOpen: true });
        if (requestRef.current !== request) return null;
        request.phase = 'ready';
        setState({
          path: selected,
          loading: false,
          error: null,
        });

        return selected;
      }

      return null;
    } catch (error) {
      if (requestRef.current !== request) return null;
      if (request) request.phase = 'error';
      console.error('Failed to select workspace:', error);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to select project',
      }));
      return null;
    }
  }, [beginRequest]);

  const setWorkspacePath = useCallback(
    async (
      path: string,
      options?: { addToRecents?: boolean; isCurrent?: () => boolean }
    ): Promise<void> => {
      if (options?.isCurrent && !options.isCurrent()) return;
      const request = beginRequest('activating');
      const ownsRequest = () =>
        requestRef.current === request && (!options?.isCurrent || options.isCurrent());
      try {
        const now = Date.now();
        await db
          .insert(settings)
          .values({
            key: WORKSPACE_PATH_KEY,
            value: path,
            updatedAt: new Date(now),
          })
          .onConflictDoUpdate({
            target: settings.key,
            set: {
              value: path,
              updatedAt: new Date(now),
            },
          });

        if (!ownsRequest()) return;
        if (options?.addToRecents !== false) {
          await platform().db.ensureWorkspaceOwner(path, undefined, { recordOpen: true });
        }

        if (!ownsRequest()) return;
        request.phase = 'ready';
        setState({
          path,
          loading: false,
          error: null,
        });

        console.log('[Workspace] Set path directly:', path);
      } catch (error) {
        if (!ownsRequest()) return;
        request.phase = 'error';
        console.error('Failed to set workspace path:', error);
        setState((prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error.message : 'Failed to set project',
        }));
        if (options?.isCurrent) throw error;
      }
    },
    [beginRequest]
  );

  const clearWorkspace = useCallback(async () => {
    const request = beginRequest('clearing');
    setState({ path: null, loading: false, error: null });
    try {
      await db.delete(settings).where(eq(settings.key, WORKSPACE_PATH_KEY));
      if (requestRef.current === request) request.phase = 'ready';
    } catch (error) {
      if (requestRef.current !== request) return;
      request.phase = 'error';
      console.error('Failed to clear workspace:', error);
    }
  }, [beginRequest]);

  useEffect(() => {
    void loadWorkspace();
    return () => {
      if (requestRef.current) requestRef.current.phase = 'retired';
      requestRef.current = null;
    };
  }, [loadWorkspace]);

  return {
    ...state,
    selectWorkspace,
    setWorkspacePath,
    clearWorkspace,
    refresh: loadWorkspace,
  };
}
