import { MenuNativeSelect } from '@waypoint/ui-components';
import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useState } from 'react';
import type { ProteinExperimentWorkersApi } from '../../../../shared/protein-experiment-workers';
import {
  listMolecularFixtureCandidates,
  type MolecularFixtureCandidate,
} from '../../../../db/molecular-prompt-trials';
import {
  MOLECULAR_ACTIVE_BENCHMARK_CASES,
  molecularBenchmarkCase,
  readMolecularBenchmarkCase,
  writeMolecularBenchmarkCase,
  type MolecularBenchmarkCaseId,
} from '../../../ai/public/molecular-comparison-profiles';
import {
  readMolecularFixtureSelection,
  writeMolecularFixtureSelection,
} from '../../../ai/public/molecular-prompt-trials';
import {
  listMolecularPromptVariants,
  readSelectedMolecularPromptVariantIds,
  removeCustomMolecularPromptVariant,
  saveCustomMolecularPromptVariant,
  writeSelectedMolecularPromptVariantIds,
} from '../../../ai/public/molecular-prompt-variants';
import {
  runMolecularPromptBatch,
  prepareMolecularBatchRoundReview,
  molecularBatchAdmission,
  type MolecularBatchProgress,
} from '../../../ai/public/molecular-prompt-batch';

function sceneStructureSignature(scene: string): string {
  try {
    const modes = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.kind === 'structure') {
        const params = (node.params ?? {}) as Record<string, unknown>;
        modes.add(
          params.type === 'assembly'
            ? `assembly:${String(params.assembly_id ?? '')}`
            : String(params.type ?? 'unknown')
        );
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (typeof child === 'object') visit(child);
      }
    };
    visit(JSON.parse(scene));
    return JSON.stringify([...modes].sort());
  } catch {
    return '[]';
  }
}

function initialCaseId(): MolecularBenchmarkCaseId {
  const stored = readMolecularBenchmarkCase();
  return (
    MOLECULAR_ACTIVE_BENCHMARK_CASES.find((item) => item.id === stored)?.id ??
    (stored === 'pgt128' || stored === 'pgt128-recognition' || stored === 'sn101-muc1'
      ? 'sn101-muc1-recognition'
      : 'kcsa')
  );
}

export function MolecularPromptBatchControls({ notebookPageId }: { notebookPageId: string }) {
  const [caseId, setCaseId] = useState<MolecularBenchmarkCaseId>(initialCaseId);
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    readMolecularFixtureSelection(initialCaseId())
  );
  const [candidates, setCandidates] = useState<MolecularFixtureCandidate[]>([]);
  const [variants, setVariants] = useState(listMolecularPromptVariants);
  const [selectedIds, setSelectedIds] = useState(readSelectedMolecularPromptVariantIds);
  const [editorId, setEditorId] = useState('appearance-v1');
  const [draftLabel, setDraftLabel] = useState('Appearance experiment');
  const [draftInstructions, setDraftInstructions] = useState(
    () =>
      listMolecularPromptVariants().find((variant) => variant.id === 'appearance-v1')
        ?.instructions ?? ''
  );
  const [running, setRunning] = useState(false);
  const [roundDecisions, setRoundDecisions] = useState({
    systemPrompt: '',
    harness: '',
    guidance: '',
  });
  const reviewComplete = Object.values(roundDecisions).every((value) => value.trim().length > 0);
  const [progress, setProgress] = useState<MolecularBatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const benchmark = molecularBenchmarkCase(caseId)!;

  useEffect(() => {
    let cancelled = false;
    void listMolecularFixtureCandidates()
      .then((items) => {
        if (!cancelled) setCandidates(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(toUserMessage(cause, 'failure.could-not-list-saved-structures'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedVariants = useMemo(
    () => variants.filter((variant) => selectedIds.includes(variant.id)),
    [variants, selectedIds]
  );
  const allFixturesSelected = benchmark.fixtureIds.every((pdbId, index) =>
    candidates.some(
      (candidate) =>
        candidate.referenceId === selection[pdbId] &&
        candidate.pdbId === pdbId &&
        sceneStructureSignature(candidate.scene) ===
          JSON.stringify([benchmark.structureModes[index]])
    )
  );

  const chooseEditor = (id: string) => {
    const variant = variants.find((item) => item.id === id);
    if (!variant) return;
    setEditorId(id);
    setDraftLabel(id.startsWith('custom:') ? variant.label : `${variant.label} · edit`);
    setDraftInstructions(variant.instructions);
  };

  const saveVariant = () => {
    try {
      const saved = saveCustomMolecularPromptVariant({
        id: '',
        label: draftLabel,
        instructions: draftInstructions,
      });
      setVariants(listMolecularPromptVariants());
      setEditorId(saved.id);
      setDraftLabel(saved.label);
      setDraftInstructions(saved.instructions);
      const next = [...new Set([...selectedIds, saved.id])];
      setSelectedIds(next);
      writeSelectedMolecularPromptVariantIds(next);
      setNotice(`${saved.label} saved. Select its checkbox to include it in a batch.`);
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.could-not-save-prompt-variant'));
    }
  };

  const run = async () => {
    if (running || !allFixturesSelected || selectedVariants.length === 0 || !reviewComplete) return;
    setRunning(true);
    setProgress(null);
    setError(null);
    setNotice(null);
    try {
      const batch = {
        experimentId: crypto.randomUUID(),
        caseId,
        fixtureSelection: selection,
        variants: selectedVariants,
        notebookPageId,
        onProgress: setProgress,
      };
      const roundReview = await prepareMolecularBatchRoundReview(batch, roundDecisions);
      const admission = molecularBatchAdmission(
        batch,
        roundReview,
        batch.experimentId,
        selectedVariants.map((variant) => ({ caseId, variantId: variant.id, replicate: 1 }))
      );
      const workerApi = (
        window as Window & {
          electronAPI?: { proteinExperimentWorkers?: ProteinExperimentWorkersApi };
        }
      ).electronAPI?.proteinExperimentWorkers;
      if (!workerApi) throw new Error('Human round approval requires the desktop app.');
      await workerApi.requestApproval(admission);
      const result = await runMolecularPromptBatch({ ...batch, roundReview });
      setRoundDecisions({ systemPrompt: '', harness: '', guidance: '' });
      setNotice(
        `Round complete · ${result.completed}/${result.completed} required saved runs ready to inspect.`
      );
    } catch (cause) {
      setError(toUserMessage(cause, 'failure.the-prompt-batch-stopped'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      data-testid="protein-batch-controls"
      className="mt-2 rounded border border-border bg-bg-subtle p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span>Question</span>
          <span className="inline-block min-w-0 max-w-44">
            <MenuNativeSelect
              density="compact"
              data-testid="protein-batch-case"
              value={caseId}
              disabled={running}
              onChange={(event) => {
                const next = event.target.value as MolecularBenchmarkCaseId;
                setCaseId(next);
                setSelection(readMolecularFixtureSelection(next));
                writeMolecularBenchmarkCase(next);
              }}
            >
              {MOLECULAR_ACTIVE_BENCHMARK_CASES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </MenuNativeSelect>
          </span>
        </label>
        {benchmark.fixtureIds.map((pdbId, index) => (
          <label key={pdbId} className="flex min-w-0 items-center gap-1">
            <span>Pin {pdbId}</span>
            <span className="inline-block min-w-0 max-w-56">
              <MenuNativeSelect
                density="compact"
                aria-label={`Pinned ${pdbId} coordinates`}
                value={selection[pdbId] ?? ''}
                disabled={running}
                onChange={(event) => {
                  const next = { ...selection, [pdbId]: event.target.value };
                  setSelection(next);
                  writeMolecularFixtureSelection(caseId, pdbId, event.target.value);
                }}
              >
                <option value="">Choose saved view</option>
                {candidates
                  .filter(
                    (candidate) =>
                      candidate.pdbId === pdbId &&
                      sceneStructureSignature(candidate.scene) ===
                        JSON.stringify([benchmark.structureModes[index]])
                  )
                  .map((candidate) => (
                    <option key={candidate.referenceId} value={candidate.referenceId}>
                      {candidate.label} · {candidate.coordinateSha256.slice(0, 8)}
                    </option>
                  ))}
              </MenuNativeSelect>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-fg-muted">{benchmark.question}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Prompt variants</span>
        {variants.map((variant) => (
          <label key={variant.id} className="flex items-center gap-1">
            <input
              type="checkbox"
              data-testid={`protein-batch-variant-${variant.id}`}
              checked={selectedIds.includes(variant.id)}
              disabled={running}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selectedIds, variant.id]
                  : selectedIds.filter((id) => id !== variant.id);
                setSelectedIds(next);
                writeSelectedMolecularPromptVariantIds(next);
              }}
            />
            <span>{variant.label}</span>
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <details open className="w-full">
          <summary className="cursor-pointer">Review this round</summary>
          <p className="mt-1 text-fg-muted">
            Review the full trajectory before deciding what to keep or change. These notes are saved
            with the round.
          </p>
          <div className="mt-1 grid gap-2 md:grid-cols-3">
            {(
              [
                ['systemPrompt', 'System prompt review'],
                ['harness', 'Harness review'],
                ['guidance', 'Guidance review'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="grid gap-1">
                <span>{label}</span>
                <textarea
                  aria-label={label}
                  value={roundDecisions[key]}
                  disabled={running}
                  maxLength={8000}
                  onChange={(event) =>
                    setRoundDecisions((previous) => ({ ...previous, [key]: event.target.value }))
                  }
                  className="min-h-16 rounded border border-border bg-bg p-1"
                />
              </label>
            ))}
          </div>
        </details>
        <button
          type="button"
          data-testid="protein-batch-run"
          onClick={() => void run()}
          disabled={
            running || !allFixturesSelected || selectedVariants.length === 0 || !reviewComplete
          }
          className="rounded border border-accent bg-accent/10 px-2 py-1 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {running ? 'Running…' : `Run selected (${selectedVariants.length})`}
        </button>
        <details className="min-w-0">
          <summary className="cursor-pointer text-accent">Edit prompt variants</summary>
          <div className="mt-2 grid max-w-2xl gap-2 rounded border border-border bg-bg p-2">
            <label className="grid gap-1">
              <span>Start from</span>
              <span className="inline-block min-w-0">
                <MenuNativeSelect
                  density="compact"
                  aria-label="Prompt to copy or edit"
                  value={editorId}
                  disabled={running}
                  onChange={(event) => chooseEditor(event.target.value)}
                >
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.label}
                    </option>
                  ))}
                </MenuNativeSelect>
              </span>
            </label>
            <label className="grid gap-1">
              <span>Variant name</span>
              <input
                value={draftLabel}
                disabled={running}
                onChange={(event) => setDraftLabel(event.target.value)}
                className="rounded border border-border bg-bg px-2 py-1"
              />
            </label>
            <label className="grid gap-1">
              <span>Guidance added to the system prompt</span>
              <textarea
                value={draftInstructions}
                disabled={running}
                rows={8}
                onChange={(event) => setDraftInstructions(event.target.value)}
                className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={running}
                onClick={saveVariant}
                className="rounded border border-border px-2 py-1 wp-interactive"
              >
                Save as new
              </button>
              {editorId.startsWith('custom:') && (
                <>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => {
                      removeCustomMolecularPromptVariant(editorId);
                      setVariants(listMolecularPromptVariants());
                      setSelectedIds(readSelectedMolecularPromptVariantIds());
                      chooseEditor('appearance-v1');
                    }}
                    className="rounded border border-border px-2 py-1 wp-interactive"
                  >
                    Remove from choices
                  </button>
                </>
              )}
            </div>
          </div>
        </details>
        {progress && (
          <span role="status" className="text-fg-muted">
            {progress.index}/{progress.total} · {progress.label} · {progress.stage}
            {progress.status ? ` (${progress.status})` : ''}
          </span>
        )}
        {notice && (
          <span role="status" className="text-fg-muted">
            {notice}
          </span>
        )}
      </div>
      {!allFixturesSelected && (
        <p className="mt-1 text-fg-muted">Choose a saved coordinate view to run this question.</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-error">
          {toUserMessage(error, 'structure.failed')}
        </p>
      )}
    </div>
  );
}
