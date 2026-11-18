import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Button, Notice, TextArea } from '../../components/ui';
import { platform } from '../../platform';
import { withRendererWorkspaceMutation } from '../../services/workspace-mutation-transaction';
import {
  sharedScientificDesignSetupSession,
  type ScientificDesignSetupScope,
} from './scientific-design-setup-session';
export function ScientificDesignSetup({
  scope,
  canWrite,
}: {
  scope: ScientificDesignSetupScope;
  canWrite: boolean;
}) {
  const client = platform().scientificObjects,
    session = useMemo(
      () =>
        sharedScientificDesignSetupSession(
          client,
          scope,
          localStorage,
          withRendererWorkspaceMutation
        ),
      [client, scope.workspace, scope.workspaceRoot]
    ),
    snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    session.activate();
    void session.refresh();
    const refresh = () => void session.refresh();
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      session.detach();
    };
  }, [session]);
  const busy = snapshot.phase === 'sending',
    accepted =
      snapshot.result?.receipt.outcome === 'changed'
        ? snapshot.result.receipt.version
        : snapshot.result?.receipt.outcome === 'no-op'
          ? snapshot.result.receipt.head
          : null;
  return (
    <section
      className="space-y-3 rounded border border-border p-4"
      data-testid="scientific-design-setup"
      data-setup-phase={snapshot.phase}
      data-project-id={scope.projectId}
    >
      <h3 className="font-semibold">Versioned designs</h3>
      <p>
        Save DNA designs with exact revisions. Setting this up leaves existing files and inventory
        unchanged.
      </p>
      {snapshot.phase === 'inspecting' ? (
        <p role="status">Checking design history…</p>
      ) : snapshot.phase === 'needs-setup' ? (
        <p>This project has no versioned design history yet.</p>
      ) : snapshot.phase === 'ready' ? (
        <Notice>Versioned designs are available.</Notice>
      ) : snapshot.phase === 'accepted-unconfirmed' ? (
        <Notice>
          Accepted design history exists. Finish setup to confirm its publication is available.
        </Notice>
      ) : snapshot.phase === 'unknown' ? (
        <Notice tone="warning">
          The original setup needs confirmation. Retry the same request; do not start another setup.
        </Notice>
      ) : snapshot.phase === 'accepted-pending' ? (
        <Notice tone="warning">
          Design history was accepted. Its publication still needs to finish.
        </Notice>
      ) : snapshot.phase === 'refused' ? (
        <Notice tone="warning">
          The original setup was refused. Check current design availability; another change may
          already have set it up.
        </Notice>
      ) : snapshot.phase === 'sending' ? (
        <p role="status">Finishing the original design setup…</p>
      ) : null}
      {snapshot.message ? <Notice tone="warning">{snapshot.message}</Notice> : null}
      {!canWrite ? <p>This project is read only or has unfinished Run changes.</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void session.refresh()}>
          Check design availability
        </Button>
        {snapshot.phase === 'needs-setup' ? (
          <Button disabled={!canWrite || busy} onClick={() => void session.setup()}>
            Set up versioned designs
          </Button>
        ) : null}
        {snapshot.attempt ? (
          <Button disabled={!canWrite || busy} onClick={() => void session.retrySameSetup()}>
            Retry same setup
          </Button>
        ) : null}
        {snapshot.catalog?.head ? (
          <Button disabled={!canWrite || busy} onClick={() => void session.reconcile()}>
            Finish setup
          </Button>
        ) : null}
      </div>
      {snapshot.phase === 'ready' ? (
        <p>
          In Files, choose New… → DNA sequences → Create. Add bases in the sequence editor and Save.
          An empty sequence is not a production design.
        </p>
      ) : null}
      <details>
        <summary>Setup request and saved history identities</summary>
        {snapshot.attempt || snapshot.phase === 'needs-setup' ? (
          <TextArea
            readOnly
            aria-label="Original design setup request"
            rows={8}
            value={JSON.stringify(snapshot.attempt ?? session.proposedRequest(), null, 2)}
          />
        ) : null}
        <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
          {JSON.stringify(
            {
              originalAcceptedVersion: accepted,
              currentAcceptedHead: snapshot.catalog?.head ?? null,
              result: snapshot.result,
            },
            null,
            2
          )}
        </pre>
      </details>
    </section>
  );
}
