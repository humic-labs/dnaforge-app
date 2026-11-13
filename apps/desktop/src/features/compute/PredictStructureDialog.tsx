import { ProteinPredictions } from './ProteinPredictions';
import { openProteinPrediction } from './prediction-result-view';
import { reuseInspectionPrediction } from '../structure-drawer/public/inspection-prediction';
import { useEffect, useMemo, useState } from 'react';
import { Button, UI_CARD_CLASS } from '../../components/ui';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useComputeStore } from './store';
import { usePredictStructureStore } from './predict-structure-store';
import {
  cleanProteinSequence,
  predictionOptions,
  runStructurePrediction,
} from './predict-structure';

export function PredictStructureDialog() {
  const target = usePredictStructureStore((s) => s.target);
  const close = usePredictStructureStore((s) => s.close);
  const providers = useComputeStore((s) => s.providers);
  const loading = useComputeStore((s) => s.loading);
  const refresh = useComputeStore((s) => s.refresh);
  const openConnectDialog = useComputeStore((s) => s.openConnectDialog);
  const folders = useWorkspaceStore((s) => s.folders);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (target) void refresh();
  }, [target, refresh]);

  const options = useMemo(() => predictionOptions(providers), [providers]);
  const firstReady = options.find((o) => o.ready)?.preset.provider ?? null;
  useEffect(() => {
    if (!target) return;
    setPicked((current) =>
      current && options.some((o) => o.ready && o.preset.provider === current)
        ? current
        : firstReady
    );
  }, [target, options, firstReady]);

  if (!target) return null;
  const residues = cleanProteinSequence(target.sequence).length;
  const chosen = options.find((o) => o.ready && o.preset.provider === picked) ?? null;

  const predict = () => {
    if (!chosen || residues === 0) return;
    close();
    void runStructurePrediction(target, chosen.preset, folders);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Predict structure"
      data-testid="predict-structure-dialog"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-xl border border-border bg-bg shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-fg">Predict structure</h2>
          <button
            type="button"
            onClick={close}
            className="text-fg-subtle hover:text-fg"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-sm text-fg" data-testid="predict-structure-target">
            {target.name} · {residues} residues
          </p>
          <ProteinPredictions
            key={target.sequence}
            sequence={target.sequence}
            onUse={async (row) => {
              if (target.inspectionTarget)
                await reuseInspectionPrediction(
                  target.inspectionTarget.document_id,
                  row.id,
                  row.chainId
                );
              else await openProteinPrediction(row.id, target.sequence, row.chainId);
              close();
            }}
          />
          <p className="text-xs text-fg-muted">
            Runs under your own account with the provider you choose. You see what is sent and the
            estimated cost before anything leaves the app.
          </p>
          {loading && options.length === 0 && (
            <p className="text-xs text-fg-subtle">Loading providers…</p>
          )}
          <div role="radiogroup" aria-label="Provider" className="space-y-2">
            {options.map((o) => (
              <div
                key={o.preset.provider}
                data-testid={`predict-structure-option-${o.preset.provider}`}
                className={`${UI_CARD_CLASS} flex items-center justify-between gap-3`}
              >
                <label className="flex min-w-0 items-center gap-2 text-sm text-fg">
                  <input
                    type="radio"
                    name="predict-structure-provider"
                    disabled={!o.ready}
                    checked={picked === o.preset.provider}
                    onChange={() => setPicked(o.preset.provider)}
                  />
                  <span>{o.preset.model}</span>
                  <span className="truncate text-xs text-fg-subtle">
                    on {o.provider.displayName}
                  </span>
                </label>
                {o.ready ? (
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    Connected
                  </span>
                ) : (
                  <Button
                    type="button"
                    data-testid={`predict-structure-connect-${o.preset.provider}`}
                    onClick={() => openConnectDialog(o.preset.provider)}
                  >
                    Connect
                  </Button>
                )}
              </div>
            ))}
          </div>
          {options.length > 0 && !firstReady && (
            <p className="text-xs text-fg-muted" data-testid="predict-structure-needs-provider">
              Connect a provider to run a prediction.
            </p>
          )}
          {residues === 0 && (
            <p className="text-xs text-danger">
              This protein has no amino-acid sequence to predict.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="predict-structure-submit"
            onClick={predict}
            disabled={!chosen || residues === 0}
            variant="primary"
          >
            Predict
          </Button>
        </div>
      </div>
    </div>
  );
}
