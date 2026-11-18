import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Button, Notice, TextField, TextArea } from '../../components/ui';
import { platform } from '../../platform';
import { resolveWorkspaceScope } from '../../db/workspace-catalog';
import { openProjectResourceReference } from '../../services/notebook-resource-navigation';
import type { NativeProtocolPackageSnapshot } from '../../shared/protocol-packages';
import { ProtocolOperationSession } from './protocol-operation-session';

type Launch = { workspaceRoot: string; parentPath: string } | null;
let launch: Launch = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
export function openCreateProtocol(input: NonNullable<Launch>) {
  launch = input;
  notify();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function ProtocolCreationHost() {
  const current = useSyncExternalStore(subscribe, () => launch);
  const [projectId, setProjectId] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setProjectId(null);
    setError(null);
    if (current)
      void resolveWorkspaceScope(current.workspaceRoot)
        .then((scope) => {
          if (!cancelled) {
            if (!scope) throw Error('The owning project identity is unavailable.');
            setProjectId(scope);
          }
        })
        .catch((cause) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : 'The project is unavailable.');
        });
    return () => {
      cancelled = true;
    };
  }, [current]);
  if (!current) return null;
  const close = () => {
    launch = null;
    notify();
  };
  if (!projectId)
    return (
      <div
        role="dialog"
        aria-label="Create protocol"
        className="fixed inset-0 z-[10050] grid place-items-center bg-black/40"
      >
        <section className="space-y-3 rounded border border-border bg-bg p-5">
          <p>{error ?? 'Reading the owning project…'}</p>
          <Button onClick={close}>Cancel</Button>
        </section>
      </div>
    );
  return (
    <ProtocolCreationDialog
      key={`${projectId}:${current.parentPath}`}
      projectId={projectId}
      parentPath={current.parentPath}
      onClose={close}
      onReady={async (saved) => {
        await openProjectResourceReference({
          kind: 'entity',
          projectId: saved.projectId,
          entityId: saved.entityId,
        });
        close();
      }}
    />
  );
}
export function ProtocolCreationDialog({
  projectId,
  parentPath,
  protocol,
  sourceReady = true,
  onReady,
  onClose,
}: {
  projectId: string;
  parentPath?: string;
  protocol?: NativeProtocolPackageSnapshot;
  sourceReady?: boolean;
  onReady(saved: NativeProtocolPackageSnapshot): Promise<void>;
  onClose(): void;
}) {
  const session = useMemo(
    () =>
      new ProtocolOperationSession(
        platform().protocols,
        typeof localStorage === 'undefined' ? null : localStorage,
        `dnaforge.protocol.creation.v1:${JSON.stringify([projectId, protocol?.entityId ?? 'new-protocol'])}`
      ),
    [projectId, protocol?.entityId]
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [title, setTitle] = useState(protocol ? `${protocol.title} run` : ''),
    [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const request = {
    project: projectId,
    requestId,
    title: title.trim(),
    ...(parentPath ? { parentPath } : {}),
    ...(protocol
      ? { protocolId: protocol.entityId, expectedSourceSha256: protocol.sourceSha256 }
      : {}),
  };
  const busy = snapshot.phase === 'sending';
  const complete = async (pending: ReturnType<typeof session.begin>) => {
    const result = await pending;
    if (result?.kind === 'ready') {
      try {
        await onReady(result.package);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : 'The created artifact could not be opened.'
        );
      }
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={protocol ? 'Start run' : 'Create protocol'}
      data-testid="scientific-creation-form"
      className="fixed inset-0 z-[10050] grid place-items-center bg-black/40 p-4"
    >
      <section className="w-full max-w-lg space-y-4 rounded border border-border bg-bg p-5">
        <h2 className="text-lg font-semibold">{protocol ? 'Start run' : 'Create protocol'}</h2>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!sourceReady || !title.trim()) return;
            void complete(
              session.begin(
                protocol
                  ? {
                      kind: 'start',
                      request: {
                        ...request,
                        protocolId: protocol.entityId,
                        expectedSourceSha256: protocol.sourceSha256,
                      },
                    }
                  : { kind: 'create', request }
              )
            );
          }}
        >
          <label className="block space-y-1 text-sm">
            <span>{protocol ? 'Run title' : 'Protocol title'}</span>
            <TextField
              aria-label={protocol ? 'Run title' : 'Protocol title'}
              value={
                'attempt' in snapshot
                  ? 'title' in snapshot.attempt.request
                    ? snapshot.attempt.request.title
                    : title
                  : title
              }
              disabled={snapshot.phase !== 'editing'}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {parentPath ? <p className="break-all text-xs">Folder: {parentPath}</p> : null}
          {protocol ? (
            <>
              <p>Use the saved definition of {protocol.title} for this run.</p>
              <p className="break-all text-xs">Saved source: {protocol.sourceSha256}</p>
              <Notice>Creating the run does not transfer stock or execute equipment.</Notice>
            </>
          ) : null}
          {!sourceReady ? <Notice>Save changes before starting a run.</Notice> : null}
          {snapshot.phase === 'failed' ? <Notice tone="error">{snapshot.message}</Notice> : null}
          {snapshot.phase === 'unknown' ? <Notice>{snapshot.message}</Notice> : null}
          {snapshot.phase === 'result' && snapshot.result.kind !== 'ready' ? (
            <Notice>
              {snapshot.result.kind === 'missing'
                ? 'The original operation has no native receipt yet. Retry the same request.'
                : snapshot.result.message}
            </Notice>
          ) : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <details>
            <summary>Prepared request details</summary>
            <TextArea
              readOnly
              aria-label="Prepared scientific creation request"
              value={JSON.stringify(
                'attempt' in snapshot ? snapshot.attempt.request : request,
                null,
                2
              )}
              rows={7}
            />
          </details>
          {'attempt' in snapshot && snapshot.phase !== 'sending' ? (
            <div className="flex gap-2">
              <Button onClick={() => void complete(session.inspect())}>
                Check original operation
              </Button>
              {snapshot.phase !== 'result' || snapshot.result.kind !== 'ready' ? (
                <Button onClick={() => void complete(session.retry())}>Retry same operation</Button>
              ) : (
                <Button onClick={() => void complete(Promise.resolve(snapshot.result))}>
                  Open created record
                </Button>
              )}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={snapshot.phase !== 'editing' || !sourceReady || !title.trim()}
            >
              {busy ? 'Saving…' : protocol ? 'Start run' : 'Create protocol'}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
