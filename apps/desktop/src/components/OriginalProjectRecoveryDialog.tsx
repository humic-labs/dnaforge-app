import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import { toUserMessage, renderUserMessage, type UserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { platform } from '../platform';
import { needsOriginalProjectIdentification } from '../shared/first-project';
import { isBundledSampleWorkspaceOriginPath } from '../shared/sample-workspace-ipc';
import { useOriginalProjectRecoveryStore } from '../stores/original-project-recovery-store';
import { reconcileWorkspaceRoot } from '../services/workspace-reconcile';
import {
  reportPrimerRecoveryInventory,
  reportPrimerReconcileFailures,
} from '../services/workspace-reconcile-report';
import { refreshPrimerRecoveryInventory } from '../features/primers/public/primer-recovery-report';

interface ProjectChoice {
  id: number;
  repo_uuid: string;
  name: string;
  path: string;
  origin_path: string | null;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
}

export function OriginalProjectRecoveryDialog() {
  const open = useOriginalProjectRecoveryStore((state) => state.open);
  const close = useOriginalProjectRecoveryStore((state) => state.close);
  return open ? <OriginalProjectChoice onClose={close} /> : null;
}

function OriginalProjectChoice({ onClose }: { onClose(): void }) {
  const presentationOverlay = usePresentationOverlay('modal');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const [projects, setProjects] = useState<ProjectChoice[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      platform().workspace.getOriginalDefaultProject(),
      platform().db.select<ProjectChoice[]>(
        'SELECT id, repo_uuid, name, path, origin_path, access_mode, archived_at, trashed_at FROM workspaces WHERE repo_uuid IS NOT NULL ORDER BY name, path'
      ),
    ])
      .then(([resolution, rows]) => {
        if (cancelled) return;
        if (!needsOriginalProjectIdentification(resolution)) {
          setError(
            toUserMessage(resolution, 'failure.the-original-my-project-is-already-identified')
          );
          return;
        }
        setProjects(rows.filter((row) => !isBundledSampleWorkspaceOriginPath(row.origin_path)));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(toUserMessage(cause, 'operation.failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    presentationEvents.add(document, 'keydown', onKey);
    return () => presentationEvents.remove(document, 'keydown', onKey);
  }, [busy, onClose, presentationEvents]);

  const identify = async () => {
    const project = projects.find((candidate) => String(candidate.id) === selected);
    if (!project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolution = await platform().workspace.identifyOriginalDefaultProject({
        workspaceId: project.id,
        repoUuid: project.repo_uuid,
      });
      if (resolution.status !== 'ready') throw new Error(resolution.message);
      const result = await reconcileWorkspaceRoot(resolution.project.rootPath);
      reportPrimerReconcileFailures(resolution.project.rootPath, result);
      reportPrimerRecoveryInventory(await refreshPrimerRecoveryInventory());
      onClose();
    } catch (cause) {
      setError(toUserMessage(cause, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      ref={presentationOverlay.bindRef(undefined, '0')}
      className="fixed inset-0 z-[10060] flex items-center justify-center bg-black/40"
    >
      <PresentationScopeContext.Provider value={presentationOverlay.scope}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="original-project-recovery-title"
          data-testid="original-project-recovery-dialog"
          className="mx-4 w-full max-w-xl rounded-lg border border-border bg-bg p-5 text-fg shadow-xl"
        >
          <h2 id="original-project-recovery-title" className="text-sm font-semibold">
            Identify the original My Project
          </h2>
          <p className="mt-2 text-sm text-fg-muted">
            Choose the existing project DNAForge first created as My Project, even if you renamed
            it. Records without a project will be recovered there.
          </p>
          <label className="mt-4 block text-sm">
            Original project
            <select
              aria-label="Original project"
              value={selected}
              disabled={loading || busy}
              onChange={(event) => setSelected(event.target.value)}
              className="mt-2 w-full rounded border border-border bg-bg px-2 py-2 text-sm"
            >
              <option value="">
                {loading ? 'Loading projects…' : 'Choose the original project…'}
              </option>
              {projects.map((project) => {
                const state =
                  project.trashed_at != null
                    ? 'In Trash'
                    : project.archived_at != null
                      ? 'Archived'
                      : project.access_mode !== 'writable'
                        ? 'Read only'
                        : '';
                return (
                  <option key={project.repo_uuid} value={project.id} disabled={Boolean(state)}>
                    {project.name} — {project.path}
                    {state ? ` (${state})` : ''}
                  </option>
                );
              })}
            </select>
          </label>
          <p className="mt-2 text-xs text-fg-muted">
            Restore an archived or trashed original from Projects before choosing it here.
          </p>
          {!loading && projects.length === 0 && !error ? (
            <p role="alert" className="mt-3 text-sm text-error">
              No existing project is available. Restore the original project before recovery.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-error">
              {renderUserMessage(error)}
            </p>
          ) : null}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="rounded border border-border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selected || loading || busy}
              onClick={() => void identify()}
              className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Recovering…' : 'Identify and recover'}
            </button>
          </div>
        </section>
      </PresentationScopeContext.Provider>
    </div>
  );
}
