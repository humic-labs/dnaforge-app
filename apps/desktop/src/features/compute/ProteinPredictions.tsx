import {
  toUserMessage,
  userEntityLabel,
  userToolLabel,
  renderUserMessage,
  type UserMessage,
} from '@waypoint/user-messages';
import { useComputeJobsStore } from './jobs-store';
import { discoverProteinPredictions } from './prediction-discovery';
import { COMPUTE_JOB_STATE_LABEL } from './ComputeJobsPanel';
import { useEffect, useState } from 'react';
import { loadProteinPrediction, type ProteinPredictionSummary } from './prediction-library';

export function ProteinPredictions({
  sequence,
  onUse,
  selectedId,
  selectedChain,
}: {
  sequence: string;
  onUse: (prediction: ProteinPredictionSummary) => Promise<unknown>;
  selectedId?: string;
  selectedChain?: string;
}) {
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof discoverProteinPredictions>>['runs']>(
    []
  );
  const [notices, setNotices] = useState<UserMessage[]>([]);
  const [rows, setRows] = useState<ProteinPredictionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    const refresh = () => {
      setLoading(true);
      void discoverProteinPredictions(sequence)
        .then((value) => {
          if (current) {
            setRows(value.predictions);
            setRuns(value.runs);
            setNotices(
              value.notices.map((notice) => toUserMessage(notice, 'structure.predictionNotice'))
            );
            setError(null);
          }
        })
        .catch((cause) => {
          if (current) setError(toUserMessage(cause, 'structure.failed'));
        })
        .finally(() => {
          if (current) setLoading(false);
        });
    };
    setRows([]);
    setRuns([]);
    setNotices([]);
    setSettings({});
    setError(null);
    refresh();
    window.addEventListener('waypoint:predictions-changed', refresh);
    const unsubscribeJobs = useComputeJobsStore.subscribe((next, prior) => {
      if (next.observedAtMs !== prior.observedAtMs) refresh();
    });
    return () => {
      current = false;
      unsubscribeJobs();
      window.removeEventListener('waypoint:predictions-changed', refresh);
    };
  }, [sequence]);
  const act = async (row: ProteinPredictionSummary, details = false) => {
    setBusy(`${row.id}:${row.chainId}`);
    setError(null);
    try {
      if (details) {
        const result = await loadProteinPrediction(row.id, sequence, row.chainId);
        setSettings((prior) => ({ ...prior, [row.id]: result.run.settings }));
      } else await onUse(row);
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <details
      data-testid="protein-predictions"
      className="shrink-0 border-b border-border px-3 py-2 text-xs"
    >
      <summary className="cursor-pointer">
        Previous predictions {loading ? '…' : `(${rows.length})`}
      </summary>
      <p className="my-2 text-fg-muted">
        Exact protein matches saved on this computer, across workspaces. Reuse a result or run
        another prediction; models and settings can differ.
      </p>
      {error && <p role="alert">{toUserMessage(error, 'structure.failed')}</p>}
      {notices.map((notice, i) => (
        <p key={i} role="status">
          {renderUserMessage(notice)}
        </p>
      ))}
      {!loading && !error && !rows.length && <p>No saved prediction matches this protein.</p>}
      <div className="max-h-64 space-y-2 overflow-auto">
        {runs
          .filter((run) => !rows.some((row) => row.run.jobRecordId === run.id))
          .map((run) => (
            <p key={run.id} data-testid="protein-prediction-run">
              {userEntityLabel(run.label)} · {run.provider} · {COMPUTE_JOB_STATE_LABEL[run.state]}.
              Manage this run in Jobs.
            </p>
          ))}
        {rows.map((row) => (
          <div
            key={`${row.id}:${row.chainId}`}
            data-testid="protein-prediction-result"
            data-result-id={row.id}
            data-chain-id={row.chainId}
            className="rounded border border-border p-2"
          >
            <p className="font-medium">{userEntityLabel(row.run.label)}</p>
            <p>
              {userToolLabel(row.run.toolId)} · {row.run.provider} · Chain {row.chainId} ·{' '}
              {new Date(row.run.createdAt).toLocaleString()}
            </p>
            <p className="break-all text-fg-muted">
              From {row.origin.workspaceRoot} · Run {row.run.remoteId}
            </p>
            {row.chainCount > 1 && (
              <p>
                Contains {row.chainCount} protein chains. Reuse keeps the full model; mapping
                targets chain {row.chainId}.
              </p>
            )}
            {row.provenance.fixture && <p>Fixture: {row.provenance.fixture}</p>}
            {row.provenance.recovered_from && <p>{row.provenance.recovered_from}</p>}
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                className="rounded border border-border px-2 py-1"
                disabled={!!busy || (selectedId === row.id && selectedChain === row.chainId)}
                onClick={() => void act(row)}
              >
                {selectedId === row.id && selectedChain === row.chainId
                  ? 'Using this prediction'
                  : 'Use prediction'}
              </button>
              <button
                type="button"
                className="rounded border border-border px-2 py-1"
                disabled={!!busy}
                onClick={() => void act(row, true)}
              >
                Run details
              </button>
            </div>
            {settings[row.id] && (
              <div className="mt-2">
                <p>Settings</p>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(settings[row.id], null, 2)}
                </pre>
                <p>Reported metrics</p>
                <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(row.metrics, null, 2)}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
