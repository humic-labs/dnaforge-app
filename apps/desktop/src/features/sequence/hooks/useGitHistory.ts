import { userMessage } from '@waypoint/user-messages';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useToastStore } from '../../../stores/toast-store';
import {
  gitFileLog,
  gitShowCommit,
  gitRevertFile,
  gitCommitFile,
  gitRepoRoot,
  type GitLogEntry,
} from '../../workspace/public/git';
import { parseGenBankFull } from '@waypoint/sequence-utils';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

interface UseGitHistoryOptions {
  filePath: string | null;
  readOnly?: boolean;
  onRevert?: () => void;
  onCommit?: () => void;
}

interface UseGitHistoryResult {
  log: GitLogEntry[];
  isLoading: boolean;
  isGitRepo: boolean;
  selectedCommitHash: string | null;
  selectedCommitSequence: AnnotatedSequence | null;
  notification: string | null;
  dismissNotification: () => void;
  selectCommit: (hash: string) => void;
  clearSelection: () => void;
  commitFile: (message: string) => Promise<void>;
  revertFile: () => Promise<void>;
  refreshLog: () => void;
}

type HistoryScope = { filePath: string | null; root: string | null; autoCommitted: boolean };
type HistoryState =
  | { phase: 'idle'; scope: HistoryScope }
  | { phase: 'loading'; scope: HistoryScope; log: GitLogEntry[]; isGitRepo: boolean }
  | { phase: 'ready' | 'error'; scope: HistoryScope; log: GitLogEntry[]; isGitRepo: boolean };
type SelectionState =
  | { phase: 'none' }
  | { phase: 'loading'; scope: HistoryScope; hash: string }
  | { phase: 'ready'; scope: HistoryScope; hash: string; sequence: AnnotatedSequence | null }
  | { phase: 'error'; scope: HistoryScope; hash: string };

export function useGitHistory({
  filePath,
  readOnly = false,
  onRevert,
  onCommit,
}: UseGitHistoryOptions): UseGitHistoryResult {
  const scopeRef = useRef<HistoryScope | null>(null);
  const logRequestRef = useRef<object | null>(null);
  const selectionRef = useRef<SelectionState>({ phase: 'none' });
  const [selection, setSelection] = useState<SelectionState>(selectionRef.current);
  const [history, setHistory] = useState<HistoryState | null>(null);
  const [notification, setNotification] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);
  const clearSelection = useCallback(() => {
    selectionRef.current = { phase: 'none' };
    setSelection(selectionRef.current);
  }, []);

  useEffect(() => {
    const scope: HistoryScope = { filePath, root: null, autoCommitted: false };
    scopeRef.current = scope;
    setHistory({ phase: 'idle', scope });
    clearSelection();
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      logRequestRef.current = null;
      selectionRef.current = { phase: 'none' };
    };
  }, [filePath, clearSelection]);

  const fetchLog = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || !filePath || scope.filePath !== filePath) return;
    const request = {};
    logRequestRef.current = request;
    const ownsRequest = () => scopeRef.current === scope && logRequestRef.current === request;
    let entries: GitLogEntry[] = [];
    setHistory((previous) => ({
      phase: 'loading',
      scope,
      log: previous?.scope === scope && previous.phase !== 'idle' ? previous.log : [],
      isGitRepo: Boolean(scope.root),
    }));
    try {
      const root = scope.root ?? (await gitRepoRoot(filePath));
      if (!ownsRequest()) return;
      scope.root = root;
      if (!root) {
        setHistory({ phase: 'ready', scope, log: [], isGitRepo: false });
        return;
      }
      entries = await gitFileLog(filePath, root);
      if (!ownsRequest()) return;
      if (!readOnly && entries.length === 0 && !scope.autoCommitted) {
        scope.autoCommitted = true;
        try {
          await gitCommitFile(filePath, 'Initial version', root);
          if (!ownsRequest()) return;
          entries = await gitFileLog(filePath, root);
          if (!ownsRequest()) return;
          addToast(userMessage('notice.created-initial-version-for-git-tracking'), {
            definition: 'use-git-history-created-initial-version-for-git-tracking',
          });
          onCommit?.();
        } catch {
          scope.autoCommitted = false;
        }
      }
      if (ownsRequest()) setHistory({ phase: 'ready', scope, log: entries, isGitRepo: true });
    } catch {
      if (ownsRequest())
        setHistory((previous) => ({
          phase: 'error',
          scope,
          log: previous?.scope === scope && previous.phase !== 'idle' ? previous.log : entries,
          isGitRepo: Boolean(scope.root),
        }));
    }
  }, [filePath, addToast, onCommit, readOnly]);

  useEffect(() => {
    void fetchLog();
    return () => {
      logRequestRef.current = null;
    };
  }, [fetchLog]);

  const selectCommit = useCallback(
    async (hash: string) => {
      const scope = scopeRef.current;
      if (!scope || !filePath || scope.filePath !== filePath || !scope.root) return;
      const previous = selectionRef.current;
      if (previous.phase !== 'none' && previous.scope === scope && previous.hash === hash) {
        clearSelection();
        return;
      }
      const request: SelectionState = { phase: 'loading', scope, hash };
      selectionRef.current = request;
      setSelection(request);
      const ownsRequest = () => scopeRef.current === scope && selectionRef.current === request;
      try {
        const pathAtCommit =
          history?.scope === scope && history.phase !== 'idle'
            ? history.log.find((entry) => entry.hash === hash)?.pathAtCommit
            : undefined;
        const content = await gitShowCommit(
          pathAtCommit ? { pathAtCommit } : filePath,
          hash,
          scope.root
        );
        if (!ownsRequest()) return;
        const next: SelectionState = {
          phase: 'ready',
          scope,
          hash,
          sequence: content ? parseGenBankFull(content) : null,
        };
        selectionRef.current = next;
        setSelection(next);
      } catch {
        if (!ownsRequest()) return;
        const next: SelectionState = { phase: 'error', scope, hash };
        selectionRef.current = next;
        setSelection(next);
      }
    },
    [filePath, clearSelection, history]
  );

  const commitFile = useCallback(
    async (message: string) => {
      const scope = scopeRef.current;
      if (!scope || !filePath || scope.filePath !== filePath || readOnly) return;
      const root = scope.root ?? (await gitRepoRoot(filePath));
      if (scopeRef.current !== scope || !root) return;
      scope.root = root;
      await gitCommitFile(filePath, message, root);
      if (scopeRef.current !== scope) return;
      await fetchLog();
      if (scopeRef.current === scope) onCommit?.();
    },
    [filePath, fetchLog, onCommit, readOnly]
  );

  const revertFile = useCallback(async () => {
    const scope = scopeRef.current;
    if (!scope || !filePath || scope.filePath !== filePath || readOnly || !scope.root) return;
    await gitRevertFile(filePath, scope.root);
    if (scopeRef.current !== scope) return;
    onRevert?.();
    await fetchLog();
  }, [filePath, fetchLog, onRevert, readOnly]);

  const currentHistory =
    history?.scope.filePath === filePath && history.scope === scopeRef.current ? history : null;
  const currentSelection =
    selection.phase !== 'none' &&
    selection.scope.filePath === filePath &&
    selection.scope === scopeRef.current
      ? selection
      : null;
  return {
    log: currentHistory && currentHistory.phase !== 'idle' ? currentHistory.log : [],
    isLoading: currentHistory?.phase === 'loading',
    isGitRepo: currentHistory && currentHistory.phase !== 'idle' ? currentHistory.isGitRepo : false,
    selectedCommitHash: currentSelection?.hash ?? null,
    selectedCommitSequence: currentSelection?.phase === 'ready' ? currentSelection.sequence : null,
    notification,
    dismissNotification: useCallback(() => setNotification(null), []),
    selectCommit,
    clearSelection,
    commitFile,
    revertFile,
    refreshLog: fetchLog,
  };
}
