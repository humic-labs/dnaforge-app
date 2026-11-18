import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState } from 'react';
import { getEntityReference } from '../../../../db/entity-references';
import {
  listMolecularPromptTrialSiblingStructuresForSavedView,
  MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT,
  type MolecularPromptTrialSiblingStructure,
} from '../../../../db/molecular-prompt-trials';
import {
  applyProteinComparisonToTab,
  applyProteinSavedViewReferenceToTab,
  PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT,
} from './RunVersionSwitcher';

export function ProteinRunStructureSwitcher({
  panelId,
  tabId,
  savedViewId,
  isActive,
}: {
  panelId: string;
  tabId: string;
  savedViewId: string;
  isActive: boolean;
}) {
  const [structures, setStructures] = useState<MolecularPromptTrialSiblingStructure[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isActive || !savedViewId.startsWith('saved-view:')) return;
    let cancelled = false;
    const refresh = () => {
      void listMolecularPromptTrialSiblingStructuresForSavedView(savedViewId).then(
        (next) => {
          if (!cancelled) setStructures(next);
        },
        () => {
          if (!cancelled) setStructures([]);
        }
      );
    };
    refresh();
    window.addEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(MOLECULAR_PROMPT_TRIAL_CHANGE_EVENT, refresh);
    };
  }, [isActive, savedViewId]);

  const activeIndex = structures.findIndex((structure) => structure.savedViewId === savedViewId);
  if (structures.length < 2 || activeIndex < 0) return null;

  return (
    <div
      role="group"
      aria-label="Structures in this run"
      className="flex w-full flex-wrap items-center gap-1 border-t border-border bg-bg px-2 py-2"
    >
      <span className="mr-1 shrink-0 text-xs font-medium text-fg-muted">
        Structure {activeIndex + 1} of {structures.length}
      </span>
      <button
        type="button"
        disabled={busy}
        title="Open all pinned structures and their authored scenes as one comparison"
        onClick={() => {
          setBusy(true);
          setError(null);
          void applyProteinComparisonToTab(panelId, tabId, savedViewId, structures)
            .catch((cause: unknown) =>
              setError(toUserMessage(cause, 'failure.the-comparison-could-not-open'))
            )
            .finally(() => setBusy(false));
        }}
        className="shrink-0 rounded border border-accent px-2 py-1 text-xs font-medium text-accent disabled:opacity-50"
      >
        Open comparison
      </button>
      {structures.map((structure) => (
        <button
          key={structure.referenceId}
          type="button"
          aria-pressed={structure.savedViewId === savedViewId}
          disabled={busy}
          title={structure.label}
          onClick={() => {
            if (structure.savedViewId === savedViewId) return;
            setBusy(true);
            setError(null);
            void getEntityReference(structure.referenceId)
              .then(async (reference) => {
                if (!reference || reference.entity_type !== 'structure')
                  throw new Error('This recorded structure is missing.');
                await applyProteinSavedViewReferenceToTab(
                  panelId,
                  tabId,
                  savedViewId,
                  reference,
                  structure.coordinateSha256
                );
                window.dispatchEvent(
                  new CustomEvent(PROTEIN_RUN_STRUCTURE_NAVIGATED_EVENT, {
                    detail: { referenceId: structure.referenceId },
                  })
                );
              })
              .catch((cause: unknown) =>
                setError(toUserMessage(cause, 'failure.the-structure-could-not-open'))
              )
              .finally(() => setBusy(false));
          }}
          className={`max-w-full whitespace-normal rounded px-2 py-1 text-left text-xs disabled:opacity-50 ${
            structure.savedViewId === savedViewId
              ? 'bg-accent text-white'
              : 'bg-bg-subtle text-fg wp-interactive'
          }`}
        >
          {structure.label}
        </button>
      ))}
      {error && (
        <span role="alert" className="text-xs text-error">
          {toUserMessage(error, 'structure.failed')}
        </span>
      )}
    </div>
  );
}
