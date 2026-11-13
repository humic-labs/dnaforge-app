import { toUserMessage } from '@waypoint/user-messages';
import type { MolecularComparison } from '../../page/public/embeds/structure3d/molecularView';
import { useState } from 'react';
import { listSavedMolecularViews } from '../../../db/entity-references';
import { getCurrentWorkspaceScope } from '../../../stores/workspaceStore';
import {
  attachSavedInspectionStructure,
  compareInspectionProteins,
} from '../inspection-comparison';
import type { StructureInspection } from '../structure-inspection';
import { inspectionProteinKey } from '../structure-inspection';
import { selectInspectionProteinProduct } from '../inspection-allele';
import { usePredictStructureStore } from '../../compute/public/predict-structure';

export function InspectionProteinProducts({
  inspection,
  comparison,
}: {
  inspection: StructureInspection;
  comparison?: MolecularComparison;
}) {
  const [error, setError] = useState<string | null>(null);
  const [savedChoices, setSavedChoices] = useState<Awaited<
    ReturnType<typeof listSavedMolecularViews>
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const reference =
    inspection.request.comparisonOf ?? inspection.request.alleleOf ?? inspection.request;
  const product = reference.variantContext?.product;
  if (!product) return null;
  const choose = (choice: 'reference' | 'allele') => {
    try {
      selectInspectionProteinProduct(reference.entityId!, choice);
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    }
  };
  return (
    <div className="border-b border-border px-3 py-1 text-xs">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Protein product">
        <button
          type="button"
          aria-pressed={!inspection.request.alleleOf && !inspection.request.comparisonOf}
          className="rounded border border-border px-2 py-1 aria-pressed:bg-bg-muted"
          onClick={() => choose('reference')}
        >
          Reference protein · {reference.translation.length} aa
        </button>
        <button
          type="button"
          aria-pressed={!!inspection.request.alleleOf}
          className="rounded border border-border px-2 py-1 aria-pressed:bg-bg-muted disabled:opacity-50"
          disabled={product.status !== 'complete'}
          onClick={() => choose('allele')}
        >
          {product.status === 'complete'
            ? `Allele product · ${product.sequence.length} aa`
            : 'Allele product unresolved'}
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 disabled:opacity-50"
          disabled={busy || product.status !== 'complete'}
          aria-pressed={!!inspection.request.comparisonOf}
          onClick={() => {
            setBusy(true);
            setError(null);
            void compareInspectionProteins(reference.entityId!)
              .catch((cause) => setError(toUserMessage(cause, 'structure.failed')))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Loading structures…' : 'Compare structures'}
        </button>
        {!inspection.request.comparisonOf && (
          <button
            type="button"
            className="rounded border border-border px-2 py-1"
            disabled={busy}
            onClick={() => {
              setError(null);
              void listSavedMolecularViews(getCurrentWorkspaceScope())
                .then(setSavedChoices)
                .catch((cause) => setError(toUserMessage(cause, 'structure.failed')));
            }}
          >
            Use saved structure…
          </button>
        )}
      </div>
      {savedChoices && !inspection.request.comparisonOf && (
        <div className="mt-2">
          <label>
            Saved structure for this protein
            <select
              aria-label="Saved structure for this protein"
              value=""
              disabled={busy}
              className="ml-2 max-w-full rounded border border-border bg-bg p-1"
              onChange={(event) => {
                const id = event.target.value;
                if (!id) return;
                setBusy(true);
                setError(null);
                void attachSavedInspectionStructure(reference.entityId!, id)
                  .then(() => setSavedChoices(null))
                  .catch((cause) => setError(toUserMessage(cause, 'structure.failed')))
                  .finally(() => setBusy(false));
              }}
            >
              <option value="">
                {savedChoices.length
                  ? 'Choose a saved view'
                  : 'No saved structures in this workspace'}
              </option>
              {savedChoices.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.display_label}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-fg-muted">
            The structure must match this protein sequence. Open and save a structure to add it
            here.
          </p>
        </div>
      )}
      {inspection.comparison && (
        <details className="mt-1 text-fg-muted">
          <summary className="cursor-pointer">Comparison sources and alignment</summary>
          {comparison && (
            <p>
              Reference: {comparison.reference.title}, chain {comparison.reference.chainId}. Allele:{' '}
              {comparison.alternate.title}, chain {comparison.alternate.chainId}.{' '}
              {comparison.alignment.pairs.length} unchanged alpha-carbon pairs; fitted deviation{' '}
              {comparison.alignment.rmsd.toFixed(3)} Å.
            </p>
          )}
          <p>
            Initial colors: translucent gray reference side chains and opaque red allele side
            chains. Measurements or custom scenes can change these colors. Only deposited or
            computed atoms are shown; missing regions are not reconstructed. The view contains the
            chosen protein chains; other complex members are excluded.
          </p>
        </details>
      )}
      {error && <div role="alert">{toUserMessage(error, 'structure.failed')}</div>}
    </div>
  );
}

export function AlleleProteinAwaitingStructure({
  inspection,
}: {
  inspection: StructureInspection;
}) {
  const { request } = inspection;
  const context = request.variantContext!;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto p-3 text-sm"
      data-testid="allele-protein-awaiting-structure"
    >
      <p>
        {context.referenceBase || '∅'} → {context.alternateBase || '∅'} at DNA {context.position}:{' '}
        {request.translation.length} amino acids.
      </p>
      <p className="mt-2 text-fg-muted">
        Derived from this allele alone. Other calls are not combined into a clone. No coordinates
        have been loaded for this product.
      </p>
      <button
        type="button"
        className="my-3 rounded border border-border px-3 py-2"
        onClick={() =>
          usePredictStructureStore.getState().open({
            sequence: request.translation,
            name: request.cdsLabel ?? 'Allele protein',
            preferredRoot: request.sourceWorkspaceRoot ?? null,
            inspectionTarget: {
              document_id: request.entityId!,
              protein_key: inspectionProteinKey(request),
            },
          })
        }
      >
        Predict allele structure
      </button>
      <p className="text-xs text-fg-muted">Protein sequence submitted for prediction</p>
      <pre
        className="mt-1 whitespace-pre-wrap break-all rounded bg-bg-subtle p-2 text-xs"
        data-testid="allele-protein-sequence"
      >
        {request.translation}
      </pre>
    </div>
  );
}
