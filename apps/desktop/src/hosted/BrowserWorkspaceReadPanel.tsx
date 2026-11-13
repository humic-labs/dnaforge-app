import { toUserMessage, userToolLabel } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { sequencePackagePaths } from '../db/sequence-package';
import {
  loadHostedBrowserWorkspaceRead,
  type HostedBrowserWorkspaceReadProjection,
} from './browser-workspace-read';
import {
  createHostedBrowserProposal,
  decideHostedBrowserProposal,
  executeHostedBrowserProposal,
  loadHostedBrowserProposal,
  HostedBrowserProposalError,
  type HostedBrowserProposalSnapshot,
} from './browser-proposal';
import {
  askHostedBrowserQuestion,
  type HostedBrowserQuestionObservation,
} from './browser-question';

interface WorkspaceReadTarget {
  readonly workspaceId: string;
  readonly displayName: string;
}

type PreviewScope = { workspaceId: string | null; versionId: string | null };
type PreviewReadState =
  | { phase: 'idle' }
  | { phase: 'loading'; scope: PreviewScope }
  | { phase: 'ready'; scope: PreviewScope; projection: HostedBrowserWorkspaceReadProjection }
  | { phase: 'error'; scope: PreviewScope; error: string };

export function BrowserWorkspaceReadPanel({
  target,
  versionId,
  onClose,
}: {
  readonly target: WorkspaceReadTarget | null;
  readonly versionId: string | null;
  readonly onClose: () => void;
}) {
  const scopeRef = useRef<PreviewScope | null>(null);
  const readRequestRef = useRef<object | null>(null);
  const [readState, setReadState] = useState<PreviewReadState>({ phase: 'idle' });
  const currentRead =
    readState.phase !== 'idle' &&
    readState.scope.workspaceId === (target?.workspaceId ?? null) &&
    readState.scope.versionId === versionId
      ? readState
      : null;
  const phase = currentRead?.phase ?? 'idle';
  const projection = currentRead?.phase === 'ready' ? currentRead.projection : null;
  const error = currentRead?.phase === 'error' ? currentRead.error : null;
  const [proposal, setProposal] = useState<HostedBrowserProposalSnapshot | null>(null);
  const [proposalPhase, setProposalPhase] = useState<'idle' | 'creating' | 'deciding' | 'error'>(
    'idle'
  );
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [questionObservation, setQuestionObservation] =
    useState<HostedBrowserQuestionObservation | null>(null);
  const [questionPhase, setQuestionPhase] = useState<'idle' | 'asking' | 'error'>('idle');
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [mutationProposal, setMutationProposal] = useState<HostedBrowserProposalSnapshot | null>(
    null
  );
  const [mutationPhase, setMutationPhase] = useState<
    'idle' | 'creating' | 'deciding' | 'executing' | 'error'
  >('idle');
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    const scope: PreviewScope = { workspaceId: target?.workspaceId ?? null, versionId };
    scopeRef.current = scope;
    readRequestRef.current = null;
    setReadState({ phase: 'idle' });
    setProposal(null);
    setProposalPhase('idle');
    setProposalError(null);
    setQuestionObservation(null);
    setQuestionPhase('idle');
    setQuestionError(null);
    setMutationProposal(null);
    setMutationPhase('idle');
    setMutationError(null);
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
      readRequestRef.current = null;
    };
  }, [target?.workspaceId, versionId]);

  const targetWorkspaceId = target?.workspaceId;

  useEffect(() => {
    if (!targetWorkspaceId || !versionId) return;
    let cancelled = false;
    void restoreStoredMutationProposal(targetWorkspaceId, versionId)
      .then((next) => {
        if (cancelled) return;
        if (next) setMutationProposal(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [targetWorkspaceId, versionId]);

  const inspect = async () => {
    const scope = scopeRef.current;
    if (!target || !scope) return;
    const request = {};
    readRequestRef.current = request;
    const ownsRequest = () => scopeRef.current === scope && readRequestRef.current === request;
    setReadState({ phase: 'loading', scope });
    try {
      const next = await loadHostedBrowserWorkspaceRead({
        workspaceId: target.workspaceId,
        versionId,
      });
      if (!ownsRequest()) return;
      setReadState({ phase: 'ready', scope, projection: next });
    } catch (cause) {
      if (!ownsRequest()) return;
      setReadState({
        phase: 'error',
        scope,
        error: toUserMessage(cause, 'failure.the-browser-safe-workspace-read-is-unavailable'),
      });
    }
  };

  const createProposal = async () => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    if (!target || !projection?.version) return;
    setProposalPhase('creating');
    setProposalError(null);
    try {
      const next = await createHostedBrowserProposal({
        workspaceId: projection.workspace.id,
        versionId: projection.version.id,
        versionSha256: projection.version.content_sha256,
        argumentsPayload: {
          workspace_id: projection.workspace.id,
          version_id: projection.version.id,
          include: ['metadata'],
        },
        idempotencyKey: `browser-read-${crypto.randomUUID()}`,
      });
      if (!ownsScope()) return;
      setProposal(next);
      setProposalPhase('idle');
    } catch (cause) {
      if (!ownsScope()) return;
      setProposalPhase('error');
      setProposalError(toUserMessage(cause, 'failure.the-browser-proposal-service-is-unavailable'));
    }
  };

  const decideProposal = async (decision: 'approve' | 'deny') => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    if (!proposal) return;
    setProposalPhase('deciding');
    setProposalError(null);
    try {
      const next = await decideHostedBrowserProposal({
        proposalId: proposal.proposal_id,
        decision,
        idempotencyKey: `browser-decision-${crypto.randomUUID()}`,
      });
      if (!ownsScope()) return;
      setProposal(next);
      setProposalPhase('idle');
    } catch (cause) {
      if (!ownsScope()) return;
      setProposalPhase('error');
      setProposalError(
        toUserMessage(cause, 'failure.the-browser-proposal-decision-was-unavailable')
      );
    }
  };

  const askQuestion = async () => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    if (!target || !projection?.version) return;
    setQuestionPhase('asking');
    setQuestionError(null);
    try {
      const next = await askHostedBrowserQuestion({
        workspaceId: projection.workspace.id,
        versionId: projection.version.id,
        question: 'What files are in this workspace?',
        idempotencyKey: `browser-question-${crypto.randomUUID()}`,
      });
      if (!ownsScope()) return;
      setQuestionObservation(next);
      setQuestionPhase('idle');
    } catch (cause) {
      if (!ownsScope()) return;
      setQuestionPhase('error');
      setQuestionError(toUserMessage(cause, 'failure.the-browser-question-service-is-unavailable'));
    }
  };

  const createMutationProposal = async (path: string) => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    if (!projection?.version || !target) return;
    setMutationPhase('creating');
    setMutationError(null);
    try {
      const next = await createHostedBrowserProposal({
        workspaceId: projection.workspace.id,
        versionId: projection.version.id,
        versionSha256: projection.version.content_sha256,
        toolName: 'workspace.file_remove',
        argumentsPayload: { path },
        idempotencyKey: `browser-remove-${crypto.randomUUID()}`,
      });
      if (!ownsScope()) return;
      window.localStorage.setItem(
        hostedBrowserMutationProposalStorageKey(target.workspaceId, projection.version.id),
        next.proposal_id
      );
      if (!ownsScope()) return;
      setMutationProposal(next);
      setMutationPhase('idle');
    } catch (cause) {
      if (!ownsScope()) return;
      setMutationPhase('error');
      setMutationError(
        toUserMessage(cause, 'failure.the-browser-mutation-proposal-service-is-unavailable')
      );
    }
  };

  const executeMutationProposal = async (proposal: HostedBrowserProposalSnapshot) => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    setMutationPhase('executing');
    setMutationError(null);
    try {
      const next = await executeHostedBrowserProposal({
        proposalId: proposal.proposal_id,
        idempotencyKey: getMutationRequestKey(proposal.proposal_id, 'effect'),
      });
      if (!ownsScope()) return;
      setMutationProposal(next);
      persistTerminalMutationProposal(target?.workspaceId, next);
      setMutationPhase('idle');
    } catch (cause) {
      if (!ownsScope()) return;
      if (cause instanceof HostedBrowserProposalError && cause.code === 'idempotency_conflict') {
        try {
          const recovered = await loadHostedBrowserProposal(proposal.proposal_id);
          if (!ownsScope()) return;
          setMutationProposal(recovered);
          persistTerminalMutationProposal(target?.workspaceId, recovered);
          setMutationPhase('idle');
          setMutationError(null);
          return;
        } catch {}
      }
      if (!ownsScope()) return;
      setMutationPhase('error');
      setMutationError(
        toUserMessage(cause, 'failure.the-approved-browser-effect-could-not-be-executed')
      );
    }
  };

  const decideMutationProposal = async (decision: 'approve' | 'deny') => {
    const scope = scopeRef.current;
    if (!scope) return;
    const ownsScope = () => scopeRef.current === scope;
    if (!mutationProposal) return;
    setMutationPhase('deciding');
    setMutationError(null);
    try {
      const next = await decideHostedBrowserProposal({
        proposalId: mutationProposal.proposal_id,
        decision,
        idempotencyKey: getMutationRequestKey(mutationProposal.proposal_id, `decision-${decision}`),
      });
      if (!ownsScope()) return;
      setMutationProposal(next);
      if (decision === 'approve') {
        await executeMutationProposal(next);
      } else {
        setMutationPhase('idle');
      }
    } catch (cause) {
      if (!ownsScope()) return;
      setMutationPhase('error');
      setMutationError(
        toUserMessage(cause, 'failure.the-browser-mutation-decision-was-unavailable')
      );
    }
  };

  return (
    <aside className="hosted-browser-read" data-testid="hosted-browser-read-panel">
      <div className="hosted-browser-read-heading">
        <div>
          <strong>Browser workspace preview</strong>
          <span>Metadata read · one bounded effect with explicit approval</span>
        </div>
        <button type="button" aria-label="Close browser workspace read" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="hosted-browser-read-body">
        <p>
          The hosted agent is still unavailable for general AI turns. This preview checks the
          signed-in browser session, reads bounded workspace metadata, and exposes one explicit
          file-removal flow below.
        </p>
        {target ? (
          <>
            <div className="hosted-browser-read-target">
              <span>Project</span>
              <strong>{target.displayName}</strong>
            </div>
            <button
              type="button"
              className="hosted-primary-button"
              data-testid="hosted-browser-read-inspect"
              onClick={() => void inspect()}
              disabled={phase === 'loading'}
            >
              {phase === 'loading' ? 'Inspecting…' : 'Inspect current workspace'}
            </button>
          </>
        ) : (
          <p className="hosted-browser-read-empty">Open a project before inspecting it.</p>
        )}
        {phase === 'error' && error && (
          <p className="hosted-browser-read-error" role="alert">
            {toUserMessage(error, 'operation.failed')}
          </p>
        )}
        {phase === 'ready' && projection && (
          <>
            <ProjectionSummary projection={projection} />
            <QuestionRehearsal
              observation={questionObservation}
              phase={questionPhase}
              error={questionError}
              onAsk={() => void askQuestion()}
            />
            <ProposalRehearsal
              projection={projection}
              proposal={proposal}
              phase={proposalPhase}
              error={proposalError}
              onCreate={() => void createProposal()}
              onDecide={(decision) => void decideProposal(decision)}
            />
            <MutationProposalRehearsal
              projection={projection}
              proposal={mutationProposal}
              phase={mutationPhase}
              error={mutationError}
              onCreate={createMutationProposal}
              onDecide={(decision) => void decideMutationProposal(decision)}
              onExecute={(next) => void executeMutationProposal(next)}
            />
          </>
        )}
      </div>
    </aside>
  );
}

function QuestionRehearsal({
  observation,
  phase,
  error,
  onAsk,
}: {
  readonly observation: HostedBrowserQuestionObservation | null;
  readonly phase: 'idle' | 'asking' | 'error';
  readonly error: string | null;
  readonly onAsk: () => void;
}) {
  return (
    <section className="hosted-browser-read-question" data-testid="hosted-browser-question">
      <div className="hosted-browser-read-target">
        <span>Read-question rehearsal</span>
        <strong>{observation ? 'Observation received' : 'Not asked'}</strong>
      </div>
      <p className="hosted-browser-read-note">
        This exercises the browser-safe catalog and metadata reader. It is not a model turn and
        cannot edit the project.
      </p>
      <button
        type="button"
        className="hosted-primary-button"
        data-testid="hosted-browser-question-ask"
        onClick={onAsk}
        disabled={phase === 'asking'}
      >
        {phase === 'asking' ? 'Asking…' : 'Ask: what files are here?'}
      </button>
      {observation && (
        <p className="hosted-browser-read-note" data-testid="hosted-browser-question-result">
          Answered by <strong>{userToolLabel(observation.tool_name)}</strong>:{' '}
          {observation.workspace.files.length}{' '}
          {observation.workspace.files.length === 1 ? 'file' : 'files'} found. No effect was
          executed.
        </p>
      )}
      {phase === 'error' && error && (
        <p className="hosted-browser-read-error" role="alert">
          {toUserMessage(error, 'operation.failed')}
        </p>
      )}
    </section>
  );
}

function ProposalRehearsal({
  projection,
  proposal,
  phase,
  error,
  onCreate,
  onDecide,
}: {
  readonly projection: HostedBrowserWorkspaceReadProjection;
  readonly proposal: HostedBrowserProposalSnapshot | null;
  readonly phase: 'idle' | 'creating' | 'deciding' | 'error';
  readonly error: string | null;
  readonly onCreate: () => void;
  readonly onDecide: (decision: 'approve' | 'deny') => void;
}) {
  return (
    <section className="hosted-browser-read-proposal" data-testid="hosted-browser-proposal">
      <div className="hosted-browser-read-target">
        <span>Server-owned proposal rehearsal</span>
        <strong>
          {proposal ? `Proposal ${proposal.proposal_id.slice(0, 8)}…` : 'Not created'}
        </strong>
      </div>
      <p className="hosted-browser-read-note">
        This records an explicit decision for the inspected revision. It starts no AI turn and
        grants no mutation authority.
      </p>
      {!proposal && projection.version ? (
        <button
          type="button"
          className="hosted-primary-button"
          data-testid="hosted-browser-proposal-create"
          onClick={onCreate}
          disabled={phase === 'creating'}
        >
          {phase === 'creating' ? 'Recording proposal…' : 'Record read proposal'}
        </button>
      ) : proposal?.status === 'pending' ? (
        <div className="hosted-browser-read-actions">
          <button
            type="button"
            className="hosted-primary-button"
            data-testid="hosted-browser-proposal-deny"
            onClick={() => onDecide('deny')}
            disabled={phase === 'deciding'}
          >
            Deny decision
          </button>
          <button
            type="button"
            className="hosted-primary-button"
            data-testid="hosted-browser-proposal-approve"
            onClick={() => onDecide('approve')}
            disabled={phase === 'deciding'}
          >
            Approve decision
          </button>
        </div>
      ) : proposal ? (
        <p className="hosted-browser-read-note" data-testid="hosted-browser-proposal-terminal">
          Durable decision: <strong>{proposal.status}</strong>. No effect was executed.
        </p>
      ) : (
        <p className="hosted-browser-read-empty">A revision is required to record a proposal.</p>
      )}
      {phase === 'error' && error && (
        <p className="hosted-browser-read-error" role="alert">
          {toUserMessage(error, 'operation.failed')}
        </p>
      )}
    </section>
  );
}

function ProjectionSummary({
  projection,
}: {
  readonly projection: HostedBrowserWorkspaceReadProjection;
}) {
  return (
    <div className="hosted-browser-read-result" data-testid="hosted-browser-read-result">
      <div className="hosted-browser-read-target">
        <span>Accepted revision</span>
        <strong>
          {projection.version
            ? `Revision ${projection.version.version_number}`
            : 'No accepted revision'}
        </strong>
        {projection.version && (
          <small>
            {projection.version.file_count} {projection.version.file_count === 1 ? 'file' : 'files'}{' '}
            · {projection.version.content_sha256.slice(0, 12)}…
          </small>
        )}
      </div>
      {projection.files.length === 0 ? (
        <p className="hosted-browser-read-empty">
          This project has no files in the accepted revision.
        </p>
      ) : (
        <ul className="hosted-browser-read-files">
          {projection.files.map((file) => (
            <li key={file.resource_id}>
              <strong>{file.path}</strong>
              <span>
                {file.content_type} · {formatBytes(file.size_bytes)} ·{' '}
                {file.content_sha256.slice(0, 12)}…
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="hosted-browser-read-note">
        Object bytes were not returned; any change must use the explicit approved effect below.
      </p>
    </div>
  );
}

function MutationProposalRehearsal({
  projection,
  proposal,
  phase,
  error,
  onCreate,
  onDecide,
  onExecute,
}: {
  readonly projection: HostedBrowserWorkspaceReadProjection;
  readonly proposal: HostedBrowserProposalSnapshot | null;
  readonly phase: 'idle' | 'creating' | 'deciding' | 'executing' | 'error';
  readonly error: string | null;
  readonly onCreate: (path: string) => void;
  readonly onDecide: (decision: 'approve' | 'deny') => void;
  readonly onExecute: (proposal: HostedBrowserProposalSnapshot) => void;
}) {
  const proposedPath =
    proposal?.tool_name === 'workspace.file_remove' && typeof proposal.arguments.path === 'string'
      ? proposal.arguments.path
      : null;
  const receipt = proposal?.execution?.status === 'completed' ? proposal.execution : null;
  const terminalOutcome =
    proposal?.execution?.status === 'failed' || proposal?.execution?.status === 'unavailable'
      ? proposal.execution
      : null;
  const completeProjection = projection.version?.file_count === projection.files.length;
  const proposalRevisionInspected =
    completeProjection && projection.version?.id === proposal?.version_id;
  const packageScope =
    proposedPath && proposalRevisionInspected
      ? sequenceRemovalScope(projection.files, proposedPath)
      : null;
  const removedPackageRoot = receipt?.result?.removed_package_root;
  const removedPaths = receipt?.result?.removed_paths;
  return (
    <section className="hosted-browser-read-proposal" data-testid="hosted-browser-mutation">
      <div className="hosted-browser-read-target">
        <span>Approved workspace effect</span>
        <strong>
          {proposal ? `Proposal ${proposal.proposal_id.slice(0, 8)}…` : 'Not proposed'}
        </strong>
      </div>
      <p className="hosted-browser-read-note">
        Removal requires explicit approval. A sequence is removed as its entire package, including
        its metadata, product, and attachments. Other files are removed individually. The result is
        written to workspace history with a durable receipt.
      </p>
      {!proposal && !completeProjection ? (
        <p className="hosted-browser-read-empty">
          Removal is unavailable because the inspected file list is incomplete.
        </p>
      ) : !proposal && projection.files.length > 0 ? (
        <div className="hosted-browser-read-actions">
          {projection.files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="hosted-primary-button"
              data-testid="hosted-browser-remove-propose"
              data-path={file.path}
              onClick={() => onCreate(file.path)}
              disabled={phase === 'creating'}
            >
              {phase === 'creating' ? 'Recording…' : `Propose remove ${file.path}`}
              {phase !== 'creating' && sequenceRemovalScope(projection.files, file.path) && (
                <> · entire sequence package</>
              )}
            </button>
          ))}
        </div>
      ) : proposal?.status === 'pending' && proposedPath ? (
        <>
          <p className="hosted-browser-read-note">
            Proposed operation: <strong>remove {proposedPath}</strong>
          </p>
          {packageScope && (
            <p className="hosted-browser-read-note" data-testid="hosted-browser-removal-scope">
              This removes the entire sequence package <strong>{packageScope.root}</strong> (
              {packageScope.fileCount} files), including its metadata, product, and attachments.
            </p>
          )}
          {!proposalRevisionInspected && (
            <p className="hosted-browser-read-note">
              Inspect the complete proposed revision before approving removal.
            </p>
          )}
          <div className="hosted-browser-read-actions">
            <button
              type="button"
              className="hosted-primary-button"
              data-testid="hosted-browser-remove-deny"
              onClick={() => onDecide('deny')}
              disabled={phase === 'deciding' || phase === 'executing'}
            >
              Deny removal
            </button>
            <button
              type="button"
              className="hosted-primary-button"
              data-testid="hosted-browser-remove-approve"
              onClick={() => onDecide('approve')}
              disabled={phase === 'deciding' || phase === 'executing' || !proposalRevisionInspected}
            >
              {phase === 'deciding' || phase === 'executing' ? 'Applying…' : 'Approve removal'}
            </button>
          </div>
        </>
      ) : receipt && proposedPath ? (
        <p className="hosted-browser-read-note" data-testid="hosted-browser-mutation-receipt">
          Durable receipt <strong>{receipt.receipt_id?.slice(0, 8)}…</strong>: removed{' '}
          <strong>{proposedPath}</strong>; publish status{' '}
          <strong>{String(receipt.result?.publish_status ?? 'recorded')}</strong>. This receipt is
          reloadable.
          {typeof removedPackageRoot === 'string' && Array.isArray(removedPaths) && (
            <>
              {' '}
              Entire sequence package <strong>{removedPackageRoot}</strong> removed (
              {removedPaths.length} files).
            </>
          )}
        </p>
      ) : terminalOutcome && proposedPath ? (
        <p className="hosted-browser-read-note" data-testid="hosted-browser-mutation-outcome">
          Durable execution outcome <strong>{terminalOutcome.status}</strong> (
          <strong>{terminalOutcome.error_code}</strong>): no workspace effect was applied to{' '}
          <strong>{proposedPath}</strong>. Create a new proposal after inspecting the current
          revision.
        </p>
      ) : proposal?.status === 'approved' &&
        (!proposal.execution || proposal.execution.status === 'claimed') ? (
        <button
          type="button"
          className="hosted-primary-button"
          data-testid="hosted-browser-remove-execute"
          onClick={() => onExecute(proposal)}
          disabled={phase === 'executing'}
        >
          {phase === 'executing'
            ? 'Applying…'
            : proposal.execution?.status === 'claimed'
              ? 'Recover approved removal'
              : phase === 'error'
                ? 'Retry approved removal'
                : 'Execute approved removal'}
        </button>
      ) : proposal ? (
        <p className="hosted-browser-read-note" data-testid="hosted-browser-mutation-terminal">
          Durable decision: <strong>{proposal.status}</strong>. No workspace effect was executed.
        </p>
      ) : (
        <p className="hosted-browser-read-empty">No files are available to remove.</p>
      )}
      {phase === 'error' && error && (
        <p className="hosted-browser-read-error" role="alert">
          {toUserMessage(error, 'operation.failed')}
        </p>
      )}
    </section>
  );
}

function sequenceRemovalScope(
  files: readonly { readonly path: string }[],
  selectedPath: string
): { readonly root: string; readonly fileCount: number } | null {
  const markerSuffix = sequencePackagePaths('package').metaPath.slice('package'.length);
  const root = files
    .filter((file) => file.path.toLowerCase().endsWith(markerSuffix))
    .map((file) => file.path.slice(0, -markerSuffix.length))
    .filter((candidate) => selectedPath.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  return root
    ? { root, fileCount: files.filter((file) => file.path.startsWith(`${root}/`)).length }
    : null;
}

function hostedBrowserMutationProposalStorageKey(workspaceId: string, versionId: string): string {
  return `dnaforge.hosted.browser.mutation-proposal.${workspaceId}.${versionId}`;
}

function hostedBrowserMutationTerminalStorageKey(workspaceId: string): string {
  return `dnaforge.hosted.browser.mutation-terminal.${workspaceId}`;
}

function isTerminalMutationProposal(proposal: HostedBrowserProposalSnapshot): boolean {
  return (
    proposal.tool_name === 'workspace.file_remove' &&
    (proposal.execution?.status === 'completed' ||
      proposal.execution?.status === 'failed' ||
      proposal.execution?.status === 'unavailable')
  );
}

function persistTerminalMutationProposal(
  workspaceId: string | undefined,
  proposal: HostedBrowserProposalSnapshot
): void {
  if (
    !workspaceId ||
    proposal.workspace_id !== workspaceId ||
    !isTerminalMutationProposal(proposal)
  ) {
    return;
  }
  window.localStorage.setItem(
    hostedBrowserMutationTerminalStorageKey(workspaceId),
    proposal.proposal_id
  );
}

async function restoreStoredMutationProposal(
  workspaceId: string,
  versionId: string
): Promise<HostedBrowserProposalSnapshot | null> {
  const currentKey = hostedBrowserMutationProposalStorageKey(workspaceId, versionId);
  const terminalKey = hostedBrowserMutationTerminalStorageKey(workspaceId);
  const candidates = [
    { key: currentKey, requiresCurrentVersion: true },
    { key: terminalKey, requiresCurrentVersion: false },
  ];

  for (const candidate of candidates) {
    const proposalId = window.localStorage.getItem(candidate.key);
    if (!proposalId) continue;
    try {
      const proposal = await loadHostedBrowserProposal(proposalId);
      const workspaceMatches = proposal.workspace_id === workspaceId;
      const versionMatches = !candidate.requiresCurrentVersion || proposal.version_id === versionId;
      const terminal = isTerminalMutationProposal(proposal);
      if (workspaceMatches && versionMatches && (candidate.requiresCurrentVersion || terminal)) {
        return proposal;
      }
    } catch {}
    window.localStorage.removeItem(candidate.key);
  }
  return null;
}

function getMutationRequestKey(
  proposalId: string,
  operation: 'effect' | 'decision-approve' | 'decision-deny'
): string {
  const storageKey = `dnaforge.hosted.browser.mutation-request.${proposalId}.${operation}`;
  const existing = window.localStorage.getItem(storageKey);
  if (existing) return existing;
  const next = `browser-${operation}-${crypto.randomUUID()}`;
  window.localStorage.setItem(storageKey, next);
  return next;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}
