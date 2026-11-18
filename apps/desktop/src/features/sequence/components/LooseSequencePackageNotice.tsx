import { userMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import { useCallback, useEffect, useState } from 'react';
import type { NucleicAcid } from '@waypoint/sequence-utils';
import { MANAGED_DNA_FILE_EXTENSIONS } from '@waypoint/sequence-utils/sequence-file-types';
import { platform } from '../../../platform';
import { findWorkspaceRootForPath } from '../../../db/workspace-catalog';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { isManagedRepo } from '../../../services/workspace-reconcile';
import { reconcileWorkspaceAfterFilesChanged } from '../../../services/workspace-operations';
import { useCanvasStore } from '../../canvas/public/store';
import { openDocument } from '../../document-opening/public/open-document';
import { useToastStore } from '../../../stores/toast-store';
import { resolveContainingPathBoundary } from '../../../shared/path-boundary';
import { useProjectEditFolders } from '../../workspace-loader/public/use-project-edit-folders';
import { projectPathIsReadOnly } from '../../workspace-loader/public/project-edit-folders';

type LooseSequencePackageNoticeProps = {
  tabId: string;
  filePath: string;
  label: string;
};

type NoticeState =
  | { status: 'hidden' }
  | {
      status: 'refused';
      workspaceRoot: string;
      reason: string;
      confirmDnaSha256?: string;
      canConvertToRna?: boolean;
      recovery?: { sourceSha256: string; replacementCount: number; recordCount: number };
    }
  | { status: 'convertible'; workspaceRoot: string }
  | { status: 'converting' };

export function isLooseManagedDnaPath(filePath: string): boolean {
  const name = filePath.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && MANAGED_DNA_FILE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function LegacyFastaSequencePackageNotice(props: LooseSequencePackageNoticeProps) {
  const folders = useProjectEditFolders();
  const owner = resolveContainingPathBoundary(folders, props.filePath);
  if (
    owner.status === 'none' ||
    owner.status === 'ambiguous' ||
    projectPathIsReadOnly(props.filePath, folders)
  )
    return null;
  return <LooseSequencePackageNotice {...props} />;
}

export function LooseSequencePackageNotice({
  tabId,
  filePath,
  label,
}: LooseSequencePackageNoticeProps) {
  const [state, setState] = useState<NoticeState>({ status: 'hidden' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'hidden' });
    void (async () => {
      const looseSequenceFiles = platform().looseSequenceFiles;
      if (!isLooseManagedDnaPath(filePath) || !looseSequenceFiles) return;
      const workspaceRoot = findWorkspaceRootForPath(
        useWorkspaceStore.getState().folders,
        filePath
      );
      if (!workspaceRoot || !(await isManagedRepo(workspaceRoot))) return;
      const inspection = await looseSequenceFiles.inspect({ workspaceRoot, sourcePath: filePath });
      if (cancelled) return;
      if (inspection.state === 'convertible') {
        setState({ status: 'convertible', workspaceRoot });
      } else if (inspection.state === 'needs-dna-confirmation') {
        setState({
          status: 'refused',
          workspaceRoot,
          reason: inspection.reason,
          confirmDnaSha256: inspection.sourceSha256,
          canConvertToRna: inspection.canConvertToRna,
        });
      } else if (inspection.state === 'refused') {
        setState({ status: 'refused', workspaceRoot, reason: inspection.reason });
      } else if (inspection.state === 'recoverable') {
        setState({
          status: 'refused',
          workspaceRoot,
          reason: inspection.reason,
          recovery: inspection,
        });
      }
    })().catch((error: unknown) => {
      console.warn('[LooseSequencePackageNotice] inspection failed:', error);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const convert = useCallback(
    async (confirmedNucleicAcid: NucleicAcid = 'dna') => {
      if (state.status !== 'refused' && state.status !== 'convertible') return;
      const { workspaceRoot } = state;
      const confirmedDnaSourceSha256 =
        state.status === 'refused' ? state.confirmDnaSha256 : undefined;
      const recovery = state.status === 'refused' ? state.recovery : undefined;
      setState({ status: 'converting' });
      let packageRoots: readonly string[];
      try {
        const result = await platform().looseSequenceFiles!.convert({
          workspaceRoot,
          sourcePath: filePath,
          ...(confirmedDnaSourceSha256 ? { confirmedDnaSourceSha256, confirmedNucleicAcid } : {}),
          ...(recovery ? { confirmedRecoverySourceSha256: recovery.sourceSha256 } : {}),
        });
        if (result.packageRoots.length === 0) {
          setState({
            status: 'refused',
            workspaceRoot,
            reason: result.reason ?? 'The file could not be converted.',
          });
          return;
        }
        packageRoots = result.packageRoots;
      } catch (error) {
        setState({
          status: 'refused',
          workspaceRoot,
          reason: `Conversion failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      try {
        await reconcileWorkspaceAfterFilesChanged({
          workspaceRoot,
          revealPath: packageRoots[0],
          strict: true,
        });
      } catch (error) {
        console.warn('[LooseSequencePackageNotice] refresh after conversion failed:', error);
        useToastStore
          .getState()
          .addToast(
            userMessage('notice.converted-the-file-but-the-project-view-could-not-refresh'),
            {
              definition: 'loose-sequence-package-notice-refresh-after-convert-failed',
            }
          );
      }
      closeTabById(tabId);
      let unopened = 0;
      for (const packageRoot of packageRoots) {
        try {
          await openDocument({ target: { kind: 'sequence-package', path: packageRoot }, label });
        } catch (error) {
          unopened++;
          console.warn('[LooseSequencePackageNotice] could not open converted package:', error);
        }
      }
      if (unopened > 0) {
        useToastStore
          .getState()
          .addToast(
            userMessageWithValues(
              'notice.converted-the-file-but-value-of-its-value-sequences-could-not-be-opene',
              { value0: userMessageValue(unopened), value1: userMessageValue(packageRoots.length) }
            ),
            { definition: 'loose-sequence-package-notice-open-after-convert-failed' }
          );
      }
    },
    [filePath, label, state, tabId]
  );

  if (state.status === 'hidden') return null;
  const canConvert =
    state.status === 'convertible' || (state.status === 'refused' && !!state.confirmDnaSha256);
  return (
    <div
      role="status"
      data-testid="loose-sequence-package-notice"
      className="flex items-start gap-3 border-b border-border bg-surface-raised px-4 py-2 text-xs text-fg"
    >
      <div className="flex-1">
        <div className="font-medium">This file is not stored as a DNAForge sequence yet.</div>
        {state.status === 'refused' && (
          <div className="mt-0.5 text-fg-muted" data-testid="loose-sequence-package-reason">
            {state.reason}
            {!state.confirmDnaSha256 &&
              !state.recovery &&
              ' Fix the file and DNAForge converts it the next time the project is indexed.'}
            {state.recovery && (
              <div className="mt-1">
                Recover a separate copy: replace {state.recovery.replacementCount} unreadable
                symbol(s) with N (unknown base) across {state.recovery.recordCount} sequence(s). No
                bases will be guessed or deleted. The original file stays unchanged and is also kept
                inside each recovered sequence. Sequence length may be uncertain; every replacement
                is marked.
              </div>
            )}
          </div>
        )}
        {state.status === 'convertible' && (
          <div className="mt-0.5 text-fg-muted">It is ready to convert.</div>
        )}
      </div>
      {state.status === 'refused' && state.recovery && (
        <button
          type="button"
          data-testid="loose-sequence-package-recover"
          onClick={() => void convert()}
          className="shrink-0 rounded border border-border px-2 py-1 font-medium wp-interactive"
        >
          Recover copy with N
        </button>
      )}
      {(canConvert || state.status === 'converting') && (
        <button
          type="button"
          data-testid="loose-sequence-package-convert"
          disabled={state.status === 'converting'}
          onClick={() => void convert()}
          className="shrink-0 rounded border border-border px-2 py-1 font-medium wp-interactive disabled:opacity-50"
        >
          {state.status === 'converting'
            ? 'Converting…'
            : state.status === 'refused'
              ? state.canConvertToRna
                ? 'Import as cDNA'
                : 'This is DNA — convert'
              : 'Convert'}
        </button>
      )}
      {state.status === 'refused' && state.canConvertToRna && state.confirmDnaSha256 && (
        <button
          type="button"
          data-testid="loose-sequence-package-convert-rna"
          onClick={() => void convert('rna')}
          className="shrink-0 rounded border border-border px-2 py-1 font-medium wp-interactive"
        >
          Convert to RNA
        </button>
      )}
    </div>
  );
}

function closeTabById(tabId: string): void {
  const store = useCanvasStore.getState();
  for (const [panelId, panel] of Object.entries(store.panels)) {
    if (panel.tabs.some((tab) => tab.id === tabId)) {
      store.closeTab(panelId, tabId);
      return;
    }
  }
}
